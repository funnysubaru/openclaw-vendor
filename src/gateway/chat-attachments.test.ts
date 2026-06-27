import { describe, expect, it, vi } from "vitest";
import {
  buildMessageWithAttachments,
  type ChatAttachment,
  type SaveMediaBufferFn,
  parseMessageWithAttachments,
} from "./chat-attachments.js";

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

async function parseWithWarnings(
  message: string,
  attachments: ChatAttachment[],
  saveMediaBufferFn?: SaveMediaBufferFn,
) {
  const logs: string[] = [];
  const parsed = await parseMessageWithAttachments(message, attachments, {
    log: { warn: (warning) => logs.push(warning) },
    saveMediaBufferFn,
  });
  return { parsed, logs };
}

/**
 * 构造一个 saveMediaBuffer mock，返回指定的 path。
 * 用于避免单测中真实写磁盘，同时验证调用行为。
 * calls 记录所有参数（含 maxBytes / originalFilename），方便断言 Important 1 的传参对齐。
 */
function makeSaveMediaMock(fixedPath: string): {
  fn: SaveMediaBufferFn;
  calls: Array<{
    buffer: Buffer;
    contentType?: string;
    subdir?: string;
    maxBytes?: number;
    originalFilename?: string;
  }>;
} {
  const calls: Array<{
    buffer: Buffer;
    contentType?: string;
    subdir?: string;
    maxBytes?: number;
    originalFilename?: string;
  }> = [];
  const fn: SaveMediaBufferFn = async (buffer, contentType, subdir, maxBytes, originalFilename) => {
    calls.push({ buffer, contentType, subdir, maxBytes, originalFilename });
    return {
      id: "test-id",
      path: fixedPath,
      size: buffer.byteLength,
      contentType,
    };
  };
  return { fn, calls };
}

/**
 * 构造一个总是抛错的 saveMediaBuffer mock，用于测试容错降级。
 */
function makeSaveMediaFailMock(): SaveMediaBufferFn {
  return async () => {
    throw new Error("disk full");
  };
}

describe("buildMessageWithAttachments", () => {
  it("embeds a single image as data URL", () => {
    const msg = buildMessageWithAttachments("see this", [
      {
        type: "image",
        mimeType: "image/png",
        fileName: "dot.png",
        content: PNG_1x1,
      },
    ]);
    expect(msg).toContain("see this");
    expect(msg).toContain(`data:image/png;base64,${PNG_1x1}`);
    expect(msg).toContain("![dot.png]");
  });

  it("rejects non-image mime types", () => {
    const bad: ChatAttachment = {
      type: "file",
      mimeType: "application/pdf",
      fileName: "a.pdf",
      content: "AAA",
    };
    expect(() => buildMessageWithAttachments("x", [bad])).toThrow(/image/);
  });
});

describe("parseMessageWithAttachments", () => {
  it("strips data URL prefix", async () => {
    const { fn } = makeSaveMediaMock("/mock/inbound/img.png");
    const parsed = await parseMessageWithAttachments(
      "see this",
      [
        {
          type: "image",
          mimeType: "image/png",
          fileName: "dot.png",
          content: `data:image/png;base64,${PNG_1x1}`,
        },
      ],
      { log: { warn: () => {} }, saveMediaBufferFn: fn },
    );
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(parsed.images[0]?.data).toBe(PNG_1x1);
  });

  it("sniffs mime when missing", async () => {
    const { fn } = makeSaveMediaMock("/mock/inbound/img.png");
    const { parsed, logs } = await parseWithWarnings(
      "see this",
      [
        {
          type: "image",
          fileName: "dot.png",
          content: PNG_1x1,
        },
      ],
      fn,
    );
    // message 末尾会有 [media attached] 标记，所以用 toContain 而非 toBe
    expect(parsed.message).toContain("see this");
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(parsed.images[0]?.data).toBe(PNG_1x1);
    expect(logs).toHaveLength(0);
  });

  it("drops non-image payloads and logs", async () => {
    const { fn } = makeSaveMediaMock("/mock/inbound/img.pdf");
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64");
    const { parsed, logs } = await parseWithWarnings(
      "x",
      [
        {
          type: "file",
          mimeType: "image/png",
          fileName: "not-image.pdf",
          content: pdf,
        },
      ],
      fn,
    );
    expect(parsed.images).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/non-image/i);
  });

  it("prefers sniffed mime type and logs mismatch", async () => {
    const { fn } = makeSaveMediaMock("/mock/inbound/img.png");
    const { parsed, logs } = await parseWithWarnings(
      "x",
      [
        {
          type: "image",
          mimeType: "image/jpeg",
          fileName: "dot.png",
          content: PNG_1x1,
        },
      ],
      fn,
    );
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/mime mismatch/i);
  });

  it("drops unknown mime when sniff fails and logs", async () => {
    const { fn } = makeSaveMediaMock("/mock/inbound/unknown.bin");
    const unknown = Buffer.from("not an image").toString("base64");
    const { parsed, logs } = await parseWithWarnings(
      "x",
      [{ type: "file", fileName: "unknown.bin", content: unknown }],
      fn,
    );
    expect(parsed.images).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/unable to detect image mime type/i);
  });

  it("keeps valid images and drops invalid ones", async () => {
    const { fn } = makeSaveMediaMock("/mock/inbound/img.png");
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64");
    const { parsed, logs } = await parseWithWarnings(
      "x",
      [
        {
          type: "image",
          mimeType: "image/png",
          fileName: "dot.png",
          content: PNG_1x1,
        },
        {
          type: "file",
          mimeType: "image/png",
          fileName: "not-image.pdf",
          content: pdf,
        },
      ],
      fn,
    );
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(parsed.images[0]?.data).toBe(PNG_1x1);
    expect(logs.some((l) => /non-image/i.test(l))).toBe(true);
  });
});

// ── 以下为 Yuiclaw saveMediaBuffer 落盘新增测试 ──────────────────────────────

describe("parseMessageWithAttachments - 落盘到 media/inbound（Yuiclaw 扩展）", () => {
  it("单图：既保留内联 base64，又调用 saveMediaBuffer 落盘，消息末尾有 [media attached] 标记", async () => {
    // 业务意图：面板上传的图片应该既送给模型看（内联），又落盘给 skill 用（文件路径）。
    const fixedPath = "/home/yuiclaw/.yuiclaw/openclaw/media/inbound/abc123.png";
    const { fn, calls } = makeSaveMediaMock(fixedPath);

    const { parsed, logs } = await parseWithWarnings(
      "请看这张图",
      [{ type: "image", mimeType: "image/png", fileName: "upload.png", content: PNG_1x1 }],
      fn,
    );

    // 内联 image 块仍存在，多模态模型能"看图"。
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.data).toBe(PNG_1x1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");

    // saveMediaBuffer 被调用了一次，传入的是 base64 decode 后的 buffer。
    expect(calls).toHaveLength(1);
    expect(calls[0]?.subdir).toBe("inbound");
    expect(calls[0]?.contentType).toBe("image/png");
    // buffer 内容应等于 base64 decode 结果。
    expect(calls[0]?.buffer).toEqual(Buffer.from(PNG_1x1, "base64"));
    // maxBytes 应与 opts.maxBytes 一致（默认 5_000_000），originalFilename 应透传 att.fileName。
    expect(calls[0]?.maxBytes).toBe(5_000_000);
    expect(calls[0]?.originalFilename).toBe("upload.png");

    // 消息文本末尾出现了 [media attached: <path> (<mimeType>)] 标记。
    expect(parsed.message).toContain("请看这张图");
    expect(parsed.message).toContain(`[media attached: ${fixedPath} (image/png)]`);

    // 没有多余的警告日志。
    expect(logs).toHaveLength(0);
  });

  it("多图：消息末尾出现多行 [media attached N/M: ...] 格式", async () => {
    // 两张图各有独立路径，格式与 media-note.ts 的多附件格式一致。
    let callIdx = 0;
    const paths = ["/media/inbound/img1.png", "/media/inbound/img2.png"];
    const mockFn: SaveMediaBufferFn = async (buffer, contentType) => {
      const p = paths[callIdx++] ?? "/media/inbound/fallback.png";
      return { id: "id", path: p, size: buffer.byteLength, contentType };
    };

    const { parsed } = await parseWithWarnings(
      "两张图",
      [
        { type: "image", mimeType: "image/png", content: PNG_1x1 },
        { type: "image", mimeType: "image/png", content: PNG_1x1 },
      ],
      mockFn,
    );

    expect(parsed.images).toHaveLength(2);
    expect(parsed.message).toContain("[media attached: 2 files]");
    expect(parsed.message).toContain("[media attached 1/2: /media/inbound/img1.png (image/png)]");
    expect(parsed.message).toContain("[media attached 2/2: /media/inbound/img2.png (image/png)]");
  });

  it("落盘失败时降级：内联 base64 照常发送，消息无 [media attached] 追加，记录警告日志", async () => {
    // 业务意图：落盘失败（磁盘满、权限问题等）不应中断消息发送。
    const failFn = makeSaveMediaFailMock();
    const { parsed, logs } = await parseWithWarnings(
      "一张图",
      [{ type: "image", mimeType: "image/png", content: PNG_1x1 }],
      failFn,
    );

    // 内联 image 仍在。
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.data).toBe(PNG_1x1);

    // 消息文本不含 [media attached]（因为路径没有）。
    expect(parsed.message).not.toContain("[media attached:");

    // 但有警告日志说明落盘失败原因。
    expect(logs.some((l) => /failed to save to disk/i.test(l))).toBe(true);
    expect(logs.some((l) => /disk full/i.test(l))).toBe(true);
  });

  it("部分图落盘失败时：成功的图有路径，失败的图跳过路径追加", async () => {
    // 两张图，第一张成功，第二张失败。
    let callIdx = 0;
    const mockFn: SaveMediaBufferFn = async (buffer, contentType) => {
      callIdx++;
      if (callIdx === 2) {
        throw new Error("network error");
      }
      return { id: "id", path: "/media/inbound/img1.png", size: buffer.byteLength, contentType };
    };

    const { parsed, logs } = await parseWithWarnings(
      "消息",
      [
        { type: "image", mimeType: "image/png", content: PNG_1x1 },
        { type: "image", mimeType: "image/png", content: PNG_1x1 },
      ],
      mockFn,
    );

    // 两个内联 image 都在。
    expect(parsed.images).toHaveLength(2);

    // 只有第一张图有路径（单图格式，因为只有 1 个成功路径）。
    expect(parsed.message).toContain("[media attached: /media/inbound/img1.png (image/png)]");

    // 有关于第二张图落盘失败的警告。
    expect(logs.some((l) => /failed to save to disk/i.test(l))).toBe(true);
  });

  it("空附件列表时不落盘、消息原样返回", async () => {
    // 边界情况：空附件列表不应触发任何落盘操作。
    const spy = vi.fn();
    const result = await parseMessageWithAttachments("hello", [], {
      saveMediaBufferFn: spy as unknown as SaveMediaBufferFn,
    });
    expect(result.message).toBe("hello");
    expect(result.images).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("无文本消息但有图片时，message 直接是 [media attached] 标记（无前置换行）", async () => {
    // 边界情况：用户只发了图片没有文字时，message 为空串。
    const { fn } = makeSaveMediaMock("/media/inbound/img.png");
    const { parsed } = await parseWithWarnings(
      "",
      [{ type: "image", mimeType: "image/png", content: PNG_1x1 }],
      fn,
    );
    // 不该在空字符串前加换行，直接从标记开始。
    expect(parsed.message).toBe("[media attached: /media/inbound/img.png (image/png)]");
  });

  it("originalFilename 透传：att.fileName 有值时传给 saveMediaBuffer；缺省时传 undefined", async () => {
    // Important 1：落盘时应传入原始文件名，使落盘文件名形如 {sanitized}---{uuid}.ext（与 web 渠道一致）。
    // 这让电商设计师等 skill 把图 cp 进 inputs/ 时能拿到可读文件名（如「正面.jpg」而非纯 UUID）。
    const { fn: fnWithName, calls: callsWithName } = makeSaveMediaMock("/media/inbound/img.png");
    await parseWithWarnings(
      "有文件名",
      [{ type: "image", mimeType: "image/png", fileName: "正面.jpg", content: PNG_1x1 }],
      fnWithName,
    );
    // fileName 非空时，originalFilename 应等于 att.fileName。
    expect(callsWithName[0]?.originalFilename).toBe("正面.jpg");

    // att.fileName 缺省（undefined）时，originalFilename 应为 undefined，
    // saveMediaBuffer 内部会退回纯 UUID 命名。
    const { fn: fnNoName, calls: callsNoName } = makeSaveMediaMock("/media/inbound/uuid.png");
    await parseWithWarnings(
      "无文件名",
      [{ type: "image", mimeType: "image/png", content: PNG_1x1 }],
      fnNoName,
    );
    expect(callsNoName[0]?.originalFilename).toBeUndefined();
  });
});

describe("shared attachment validation", () => {
  it("rejects invalid base64 content for both builder and parser", async () => {
    const bad: ChatAttachment = {
      type: "image",
      mimeType: "image/png",
      fileName: "dot.png",
      content: "%not-base64%",
    };

    expect(() => buildMessageWithAttachments("x", [bad])).toThrow(/base64/i);
    await expect(
      parseMessageWithAttachments("x", [bad], { log: { warn: () => {} } }),
    ).rejects.toThrow(/base64/i);
  });

  it("rejects images over limit for both builder and parser without decoding base64", async () => {
    const big = "A".repeat(10_000);
    const att: ChatAttachment = {
      type: "image",
      mimeType: "image/png",
      fileName: "big.png",
      content: big,
    };

    const fromSpy = vi.spyOn(Buffer, "from");
    try {
      expect(() => buildMessageWithAttachments("x", [att], { maxBytes: 16 })).toThrow(
        /exceeds size limit/i,
      );
      await expect(
        parseMessageWithAttachments("x", [att], { maxBytes: 16, log: { warn: () => {} } }),
      ).rejects.toThrow(/exceeds size limit/i);
      const base64Calls = fromSpy.mock.calls.filter((args) => (args as unknown[])[1] === "base64");
      expect(base64Calls).toHaveLength(0);
    } finally {
      fromSpy.mockRestore();
    }
  });
});
