import { spawnSync } from "node:child_process";

// ── Yuiclaw 改动（PR-B / ppt-v3.1.0-windows-hardening 组件6）────────────────────
// 本文件从 src/node-host/invoke.ts 抽出（该文件原本自带 Windows 代码页解码逻辑，
// 只服务于 node-host 的"整段 buffer 一次性解码"场景）。抽成独立的无副作用底层模块，
// 是为了让 src/process/supervisor/adapters/child.ts 也能安全复用同一套解码逻辑，
// 而不必直接 `import ... from "../../node-host/invoke.js"`——invoke.ts 顶层还
// import 了 GatewayClient / exec-approvals / browser 路由等一整套重依赖且有模块级
// 副作用代码（读 process.env 等），直接跨模块引用会把这些重依赖也打包进
// supervisor adapter 的 bundle。抽到这个只含纯函数、无副作用的共享模块，
// node-host/invoke.ts 与 process/supervisor/adapters/child.ts 各自按需 import，
// 两边都不必承担对方的依赖面（调查结论见 openclaw-vendor PR 描述）。
// ──────────────────────────────────────────────────────────────────────────

// Windows 控制台代码页 → Web 标准 encoding label 映射表。覆盖简体中文(cp936→gbk)、
// GB18030(cp54936)、繁体中文(cp950→big5)、日文(cp932→shift_jis)、韩文(cp949→euc-kr)、
// 西欧(cp1252→windows-1252)与 UTF-8(cp65001)——即 chcp 在常见中日韩/西欧 Windows
// 出厂语言下可能报出的代码页。TextDecoder 认的是 Web 标准 encoding label，不是
// Windows 代码页数字，所以需要这张映射表做转换。
const WINDOWS_CODEPAGE_ENCODING_MAP: Record<number, string> = {
  65001: "utf-8",
  54936: "gb18030",
  936: "gbk",
  950: "big5",
  932: "shift_jis",
  949: "euc-kr",
  1252: "windows-1252",
};

// 进程内缓存一次探测结果：控制台代码页在进程生命周期内不会变化，避免每次 exec
// 都重新 spawn 一次 chcp（chcp 本身也是个子进程，频繁调用有实际开销）。
let cachedWindowsConsoleEncoding: string | null | undefined;

/**
 * 从 `chcp` 命令的原始输出文本里解析出代码页数字。
 * 兼容中英文两种 Windows 语言的输出措辞，如英文 "Active code page: 936"、
 * 中文 "活动代码页: 65001"——只依赖"提取一串 3~5 位数字"，不绑定具体语言文案。
 */
export function parseWindowsCodePage(raw: string): number | null {
  if (!raw) {
    return null;
  }
  const match = raw.match(/\b(\d{3,5})\b/);
  if (!match?.[1]) {
    return null;
  }
  const codePage = Number.parseInt(match[1], 10);
  if (!Number.isFinite(codePage) || codePage <= 0) {
    return null;
  }
  return codePage;
}

/**
 * 探测当前 Windows 控制台的活动代码页，转换成 TextDecoder 认识的 encoding label。
 * 用 `cmd.exe /c chcp` 探测——特意不用 PowerShell 起这条探测命令，因为 PS 5.1 与
 * pwsh7 都能跑 cmd.exe，探测本身不依赖"到底解析到了哪个 PowerShell 版本"这个
 * 尚待确定的结果，避免鸡生蛋蛋生鸡。非 win32 直接返回 null（早退，R4.4）。
 * spawnSync 失败（chcp 不存在 / 权限问题等）时不抛错，静默按"探测不到"处理，
 * 调用方会因此走 UTF-8 兜底而不是让整个 exec 流程崩溃。
 */
export function resolveWindowsConsoleEncoding(): string | null {
  if (process.platform !== "win32") {
    return null;
  }
  if (cachedWindowsConsoleEncoding !== undefined) {
    return cachedWindowsConsoleEncoding;
  }
  try {
    const result = spawnSync("cmd.exe", ["/d", "/s", "/c", "chcp"], {
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const codePage = parseWindowsCodePage(raw);
    cachedWindowsConsoleEncoding =
      codePage !== null ? (WINDOWS_CODEPAGE_ENCODING_MAP[codePage] ?? null) : null;
  } catch {
    cachedWindowsConsoleEncoding = null;
  }
  return cachedWindowsConsoleEncoding;
}

/**
 * 一次性把一整段**已经捕获完毕**的 Buffer 按 Windows 控制台代码页解码成字符串。
 * 适用场景：调用方先把子进程全部输出 Buffer.concat 完，进程退出后才解码一次
 * （如 node-host 的 app-exec：`await` 到 close 事件、拿到完整 stdout/stderr 才转字符串）。
 * 这种"整段一把梭"的用法不存在多字节字符被截断的问题（不同于流式场景，
 * 见下方 createWindowsStreamDecoder 的适用边界）。
 *
 * 非 win32：直接当 UTF-8（早返回，R4.4 非 win32 不受影响）。
 * win32 但探测不到代码页 / 代码页恰好就是 UTF-8：同样直接 UTF-8，不做多余转换。
 * TextDecoder 对目标 encoding 报错（环境未带对应 ICU 数据等极端情况）：兜底回退 UTF-8，
 * 不让"改进编码"这个加固动作本身变成新的崩溃点。
 */
export function decodeCapturedOutputBuffer(params: {
  buffer: Buffer;
  platform?: NodeJS.Platform;
  windowsEncoding?: string | null;
}): string {
  const utf8 = params.buffer.toString("utf8");
  const platform = params.platform ?? process.platform;
  if (platform !== "win32") {
    return utf8;
  }
  const encoding = params.windowsEncoding ?? resolveWindowsConsoleEncoding();
  if (!encoding || encoding.toLowerCase() === "utf-8") {
    return utf8;
  }
  try {
    return new TextDecoder(encoding).decode(params.buffer);
  } catch {
    return utf8;
  }
}

/** 按 chunk 增量喂给 supervisor adapter 的流式解码函数类型：每次喂一个 Buffer chunk，吐出这次能确定的字符串片段。 */
export type StreamingWindowsDecoder = (chunk: Buffer) => string;

/**
 * 为一条流式输出（supervisor/agent-shell 的 stdout 或 stderr，各自独立建一个实例）
 * 创建一个"跨 chunk 复用同一个解码器状态"的增量解码函数。
 *
 * 为什么不能直接复用 decodeCapturedOutputBuffer（B2.4 风险评估结论）：
 * decodeCapturedOutputBuffer 每次调用都 `new TextDecoder(encoding)` 独立解码一整段
 * Buffer，这在"整段 buffer 一次性 decode"场景没问题；但 supervisor adapter 是逐 chunk
 * 流式喂给 listener 的（Node `stream.on("data", chunk => ...)` 天然按操作系统 pipe buffer
 * 大小切块，不保证在字符边界切）——如果一个多字节字符（GBK/Shift_JIS 等双字节编码的
 * 汉字/假名）恰好横跨两个 chunk 的边界，每个 chunk 各自 new 一个全新 TextDecoder 解码，
 * 后半个 chunk 开头那半个字符会被当成"孤立的非法字节"解出替换符 U+FFFD 或错乱字符，
 * 而不是等到下一个 chunk 到达再和前半个字节拼起来续解。
 *
 * 修法：为这条流持有一个**跨调用复用**的 TextDecoder 实例，用 WHATWG Encoding 标准
 * 里专为流式场景设计的 `decode(chunk, { stream: true })`——解码器内部会自动缓存
 * "还不构成完整字符的尾部字节"，下一个 chunk 到达时自动拼接续解，这是 Encoding 规范
 * 对每种(包括多字节遗留)编码都强制要求实现的行为，不是我们自己拼凑的 hack。
 *
 * 调用方约束：必须给每条独立的流（如同一个子进程的 stdout 一个实例、stderr 另一个
 * 实例）各建一个，不能共用同一个解码器——否则 stdout/stderr 交替到达时会互相污染
 * 对方缓存的"未完成字节"状态，解出更离谱的乱码。
 *
 * 非 win32 / 探测不到代码页 / 代码页就是 UTF-8：直接走 `chunk.toString("utf8")`，
 * 与改动前的 `chunk.toString()` 行为等价（R4.4：非 win32 不受影响）。
 * 目标 encoding 不受 TextDecoder 支持：退回 `chunk.toString("utf8")`，与
 * decodeCapturedOutputBuffer 的兜底策略保持一致。
 */
export function createWindowsStreamDecoder(params?: {
  platform?: NodeJS.Platform;
  windowsEncoding?: string | null;
}): StreamingWindowsDecoder {
  const platform = params?.platform ?? process.platform;
  if (platform !== "win32") {
    return (chunk: Buffer) => chunk.toString("utf8");
  }
  const encoding = params?.windowsEncoding ?? resolveWindowsConsoleEncoding();
  if (!encoding || encoding.toLowerCase() === "utf-8") {
    return (chunk: Buffer) => chunk.toString("utf8");
  }
  let decoder: TextDecoder;
  try {
    // fatal:false（默认值）：遇到确实无法解码的孤立字节时用替换符而非抛错，
    // 保证 exec 输出管线不会因为一次解码失败整体崩掉。
    decoder = new TextDecoder(encoding);
  } catch {
    return (chunk: Buffer) => chunk.toString("utf8");
  }
  return (chunk: Buffer) => {
    try {
      return decoder.decode(chunk, { stream: true });
    } catch {
      return chunk.toString("utf8");
    }
  };
}
