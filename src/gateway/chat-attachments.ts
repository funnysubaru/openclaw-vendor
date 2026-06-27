import { estimateBase64DecodedBytes } from "../media/base64.js";
import { sniffMimeFromBase64 } from "../media/sniff-mime-from-base64.js";
import { saveMediaBuffer } from "../media/store.js";

export type ChatAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content?: unknown;
};

export type ChatImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

export type ParsedMessageWithImages = {
  message: string;
  images: ChatImageContent[];
};

type AttachmentLog = {
  warn: (message: string) => void;
};

type NormalizedAttachment = {
  label: string;
  mime: string;
  base64: string;
};

/**
 * 依赖注入接口：便于单测中替换 saveMediaBuffer，避免真实落盘。
 * 正常运行时使用 media/store.ts 的实现。
 */
export type SaveMediaBufferFn = typeof saveMediaBuffer;

function normalizeMime(mime?: string): string | undefined {
  if (!mime) {
    return undefined;
  }
  const cleaned = mime.split(";")[0]?.trim().toLowerCase();
  return cleaned || undefined;
}

function isImageMime(mime?: string): boolean {
  return typeof mime === "string" && mime.startsWith("image/");
}

function isValidBase64(value: string): boolean {
  // Minimal validation; avoid full decode allocations for large payloads.
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function normalizeAttachment(
  att: ChatAttachment,
  idx: number,
  opts: { stripDataUrlPrefix: boolean; requireImageMime: boolean },
): NormalizedAttachment {
  const mime = att.mimeType ?? "";
  const content = att.content;
  const label = att.fileName || att.type || `attachment-${idx + 1}`;

  if (typeof content !== "string") {
    throw new Error(`attachment ${label}: content must be base64 string`);
  }
  if (opts.requireImageMime && !mime.startsWith("image/")) {
    throw new Error(`attachment ${label}: only image/* supported`);
  }

  let base64 = content.trim();
  if (opts.stripDataUrlPrefix) {
    // Strip data URL prefix if present (e.g., "data:image/jpeg;base64,...").
    const dataUrlMatch = /^data:[^;]+;base64,(.*)$/.exec(base64);
    if (dataUrlMatch) {
      base64 = dataUrlMatch[1];
    }
  }
  return { label, mime, base64 };
}

function validateAttachmentBase64OrThrow(
  normalized: NormalizedAttachment,
  opts: { maxBytes: number },
): number {
  if (!isValidBase64(normalized.base64)) {
    throw new Error(`attachment ${normalized.label}: invalid base64 content`);
  }
  const sizeBytes = estimateBase64DecodedBytes(normalized.base64);
  if (sizeBytes <= 0 || sizeBytes > opts.maxBytes) {
    throw new Error(
      `attachment ${normalized.label}: exceeds size limit (${sizeBytes} > ${opts.maxBytes} bytes)`,
    );
  }
  return sizeBytes;
}

/**
 * Parse attachments and extract images as structured content blocks.
 *
 * 业务意图（Yuiclaw 扩展行为）：
 * 对每一张图片，除了保留原有的内联 base64 image 块（供多模态模型"看图"），
 * 还会同步把 buffer 落盘到 media/inbound/ 目录，并在消息文本末尾追加：
 *   [media attached: <absolutePath> (<mimeType>)]
 * 这样下游 skill / AI 员工在需要处理图片文件时，可以直接从文本拿到确切路径，
 * 无需自己搜索文件系统或上网下载错误图片。
 *
 * 政策差异（相对上游 openclaw）：
 * 上游只对超过 2MB 的图片 offload；我们对所有图片都同时落盘一份，小图也不例外。
 * 这是"既内联也存文件"策略，不是"大图才挪走"。
 *
 * 容错行为：
 * 落盘失败时记日志、跳过该图的 path 追加，内联 base64 照常发送，
 * 不因存盘失败而中断整条消息。
 *
 * 参考渠道（本仓库已有相同模式）：
 * - src/web/inbound/monitor.ts:292
 * - src/discord/monitor/message-utils.ts:290
 * - src/browser/proxy-files.ts:16
 *
 * Returns the message text (可能追加了 [media attached: ...] 行) 和内联 image content 数组。
 */
export async function parseMessageWithAttachments(
  message: string,
  attachments: ChatAttachment[] | undefined,
  opts?: {
    maxBytes?: number;
    log?: AttachmentLog;
    /** 仅供单测注入，正常运行时不传（走 saveMediaBuffer 默认实现） */
    saveMediaBufferFn?: SaveMediaBufferFn;
  },
): Promise<ParsedMessageWithImages> {
  const maxBytes = opts?.maxBytes ?? 5_000_000; // decoded bytes (5,000,000)
  const log = opts?.log;
  // 默认使用 media/store.ts 的 saveMediaBuffer；单测可注入 mock 避免真实 I/O。
  const saveMedia = opts?.saveMediaBufferFn ?? saveMediaBuffer;

  if (!attachments || attachments.length === 0) {
    return { message, images: [] };
  }

  const images: ChatImageContent[] = [];
  // 落盘成功的图片路径和类型，用于在消息末尾追加 [media attached: ...] 行。
  const savedPaths: Array<{ path: string; mimeType: string }> = [];

  for (const [idx, att] of attachments.entries()) {
    if (!att) {
      continue;
    }
    const normalized = normalizeAttachment(att, idx, {
      stripDataUrlPrefix: true,
      requireImageMime: false,
    });
    validateAttachmentBase64OrThrow(normalized, { maxBytes });
    const { base64: b64, label, mime } = normalized;

    const providedMime = normalizeMime(mime);
    const sniffedMime = normalizeMime(await sniffMimeFromBase64(b64));
    if (sniffedMime && !isImageMime(sniffedMime)) {
      log?.warn(`attachment ${label}: detected non-image (${sniffedMime}), dropping`);
      continue;
    }
    if (!sniffedMime && !isImageMime(providedMime)) {
      log?.warn(`attachment ${label}: unable to detect image mime type, dropping`);
      continue;
    }
    if (sniffedMime && providedMime && sniffedMime !== providedMime) {
      log?.warn(
        `attachment ${label}: mime mismatch (${providedMime} -> ${sniffedMime}), using sniffed`,
      );
    }

    const finalMime = sniffedMime ?? providedMime ?? mime;

    // 内联 base64 image 块——多模态模型 plan 阶段需要"看图"，不能去掉。
    images.push({
      type: "image",
      data: b64,
      mimeType: finalMime,
    });

    // 同步落盘到 media/inbound/，让下游 skill / AI 员工能拿到确切文件路径。
    // 策略：对所有图片都落盘（包括小图），这是 Yuiclaw 的业务需求。
    // 容错：落盘失败只记日志、不阻断消息发送。
    try {
      const buffer = Buffer.from(b64, "base64");
      // 第 4 参 maxBytes 与上方大小校验保持同源，第 5 参 originalFilename 传入
      // att.fileName（用户上传时的原始文件名），使落盘文件名形如 {sanitized}---{uuid}.ext，
      // 与 web 渠道（monitor.ts:292）的落盘策略一致，便于 skill 拿到可读文件名。
      // att.fileName 缺省时 originalFilename=undefined，saveMediaBuffer 自动退回纯 UUID 命名。
      const saved = await saveMedia(buffer, finalMime, "inbound", maxBytes, att.fileName);
      savedPaths.push({ path: saved.path, mimeType: finalMime });
    } catch (err) {
      // 落盘失败不中断消息，仅记日志。内联 base64 仍会发送。
      log?.warn(`attachment ${label}: failed to save to disk (${String(err)}), path skipped`);
    }
  }

  // 在消息文本末尾追加 [media attached: ...] 行，格式对齐本仓库其他渠道（media-note.ts）。
  // 单图：[media attached: <path> (<mimeType>)]
  // 多图：首行 [media attached: N files]，然后逐行 [media attached N/M: <path> (<mimeType>)]
  //
  // ⚠️ 格式字节必须与 src/auto-reply/media-note.ts 的 formatMediaAttachedLine 产出保持一致，
  //   因为 src/gateway/images.ts 的 mediaAttachedPattern 和 Yuiclaw extensions 的
  //   prependContext / SKILL.md 都锚定这个格式进行解析。
  //   （media-note.ts 的 formatMediaAttachedLine 是模块私有函数，且多图首行没有被它包装，
  //    故此处保留手拼；若将来抽取为公共 helper，须同步验证格式零变化。）
  //
  // 【部分失败时的格式退化】最终格式由**成功落盘的张数**决定，与原始附件数无关。
  //   例如：提交 2 张图，只有 1 张落盘成功 → 输出单图格式 [media attached: path (mime)]
  //   而非 N files 首行。agent 侧不应假设「多附件请求必有 N files 首行」。
  let finalMessage = message;
  if (savedPaths.length === 1) {
    // 此处 length === 1 已确认，index 0 存在，无需 ! 断言。
    const entry = savedPaths[0];
    const note = `[media attached: ${entry.path} (${entry.mimeType})]`;
    finalMessage = finalMessage ? `${finalMessage}\n${note}` : note;
  } else if (savedPaths.length > 1) {
    const count = savedPaths.length;
    const lines: string[] = [`[media attached: ${count} files]`];
    for (const [i, entry] of savedPaths.entries()) {
      lines.push(`[media attached ${i + 1}/${count}: ${entry.path} (${entry.mimeType})]`);
    }
    const note = lines.join("\n");
    finalMessage = finalMessage ? `${finalMessage}\n${note}` : note;
  }

  return { message: finalMessage, images };
}

/**
 * @deprecated Use parseMessageWithAttachments instead.
 * This function converts images to markdown data URLs which Claude API cannot process as images.
 */
export function buildMessageWithAttachments(
  message: string,
  attachments: ChatAttachment[] | undefined,
  opts?: { maxBytes?: number },
): string {
  const maxBytes = opts?.maxBytes ?? 2_000_000; // 2 MB
  if (!attachments || attachments.length === 0) {
    return message;
  }

  const blocks: string[] = [];

  for (const [idx, att] of attachments.entries()) {
    if (!att) {
      continue;
    }
    const normalized = normalizeAttachment(att, idx, {
      stripDataUrlPrefix: false,
      requireImageMime: true,
    });
    validateAttachmentBase64OrThrow(normalized, { maxBytes });
    const { base64, label, mime } = normalized;

    const safeLabel = label.replace(/\s+/g, "_");
    const dataUrl = `![${safeLabel}](data:${mime};base64,${base64})`;
    blocks.push(dataUrl);
  }

  if (blocks.length === 0) {
    return message;
  }
  const separator = message.trim().length > 0 ? "\n\n" : "";
  return `${message}${separator}${blocks.join("\n\n")}`;
}
