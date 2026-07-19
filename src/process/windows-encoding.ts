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

// ── Yuiclaw 补丁（Windows 兼容性修复 Fix B）─────────────────────────────────
// 背景／根因：本模块的假设是"子进程输出按当前控制台代码页编码"，但这个假设
// 并非总是成立——如果子进程自己已经显式强制用 UTF-8 输出（比如 ppt-master skill
// 的 run_engine.py 用 configure_utf8_stdio() 强制 stdout/stderr 为 UTF-8），那么
// 不管控制台代码页探测到什么（如 chcp=936 简体中文），子进程写出来的字节实际上
// 是 UTF-8，而不是 GBK。此时如果本模块照旧按代码页解码，会把合法的 UTF-8 字节
// 误当 GBK 解码，产出乱码（实测：中文「确认页已启动…」被误解成
// 「纭椤靛凡鍚姩…」）。这不是假设性风险，是 ppt-master 在 Windows 上的真实观测结果。
//
// 修法：解码前先做一次"这段字节是否构成合法 UTF-8"的探测，UTF-8 优先——
// 用严格模式（fatal:true）的 TextDecoder 尝试解码；如果解码成功，且这段字节里
// 确实出现过非 ASCII 字节（纯 ASCII 在任何受支持编码下解读一致，没有可供判别的
// 信号，交给后续代码页路径处理即可，结果等价），就判定为 UTF-8 并直接用 UTF-8
// 结果，不再理会代码页探测结果。
// 依据：一段任意的 GBK / Shift_JIS / 等遗留编码字节序列"恰好"也同时是合法的
// UTF-8 多字节序列，这个概率随字节数增长指数级降低——"能被严格 UTF-8 解码器
// 完整接受"是一个足够强的编码判别信号，值得优先信任它而不是控制台代码页猜测。
// ────────────────────────────────────────────────────────────────────────────

/** 判断 buffer 里是否存在至少一个非 ASCII 字节（>=0x80）。纯 ASCII 字节在 UTF-8
 * 与本模块支持的所有 Windows 代码页下解读完全一致，不构成编码判别信号。 */
function bufferHasNonAscii(buffer: Buffer): boolean {
  for (const byte of buffer) {
    if (byte >= 0x80) {
      return true;
    }
  }
  return false;
}

/**
 * 探测一段**完整**字节序列是否应当被当作 UTF-8 处理——用于
 * decodeCapturedOutputBuffer 这种"一次性拿到完整 buffer"的场景。
 * 要求同时满足：①含有非 ASCII 字节（否则没有判别意义）；②严格模式
 * （fatal:true）TextDecoder 能无错解码整段字节。
 */
function looksLikeUtf8(buffer: Buffer): boolean {
  if (!bufferHasNonAscii(buffer)) {
    return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
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
  // Fix B：子进程可能已经自行强制 UTF-8 输出（与"按控制台代码页解码"的假设打架，
  // 见上方模块级注释）。整段 buffer 已经完整拿到手，可以直接严格校验一次，
  // UTF-8 优先于代码页猜测。
  if (looksLikeUtf8(params.buffer)) {
    return utf8;
  }
  try {
    return new TextDecoder(encoding).decode(params.buffer);
  } catch {
    return utf8;
  }
}

/**
 * 按 chunk 增量喂给 supervisor adapter 的流式解码器接口。
 * `decode`：每次喂一个 Buffer chunk，吐出这次能确定的字符串片段（可能为空——
 * 多字节字符尚未凑齐，被解码器缓存在内部状态里等下一个 chunk）。
 * `flush`：流结束时调用一次（PR-B review Minor#1/F1），把内部缓存的、
 * 尚未凑成完整字符的尾部字节按"数据流已经结束"的语义强制吐出来，避免
 * 进程被杀/管道意外关闭等场景下截断在缓冲区里的最后半个多字节字符被静默丢弃。
 * 没有可 flush 的缓冲状态时返回空字符串（不是 undefined，调用方判空即可）。
 */
export interface StreamingWindowsDecoder {
  decode(chunk: Buffer): string;
  flush(): string;
}

/** 非 win32 / UTF-8 / 不支持的 encoding 场景下的兜底实现：逐 chunk 直接 toString，flush 恒为空——没有跨 chunk 状态可 flush。 */
function createPassthroughStreamDecoder(): StreamingWindowsDecoder {
  return {
    decode: (chunk: Buffer) => chunk.toString("utf8"),
    flush: () => "",
  };
}

/**
 * 为一条流式输出（supervisor/agent-shell 的 stdout 或 stderr，各自独立建一个实例）
 * 创建一个"跨 chunk 复用同一个解码器状态"的增量解码器。
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
 * 对方缓存的"未完成字节"状态，解出更离谱的乱码。且流结束时必须调用一次 `flush()`
 * （见接口注释 / F1），否则最后一个被截断在缓冲区里的多字节字符会静默丢失。
 *
 * 非 win32 / 探测不到代码页 / 代码页就是 UTF-8：直接走 `chunk.toString("utf8")`，
 * 与改动前的 `chunk.toString()` 行为等价（R4.4：非 win32 不受影响），`flush()` 恒为空。
 * 目标 encoding 不受 TextDecoder 支持：退回 `chunk.toString("utf8")`，与
 * decodeCapturedOutputBuffer 的兜底策略保持一致。
 *
 * Yuiclaw 补丁（Windows 兼容性修复 Fix B，流式路径）：与 decodeCapturedOutputBuffer
 * 面临同一个"子进程可能已强制 UTF-8 输出、与代码页假设打架"的问题（见模块级注释），
 * 但流式场景不能像整段 buffer 那样一次性拿到完整字节再判断——必须在还没收全数据时
 * 就吐出已解码内容，且不能破坏既有的跨 chunk 续解 / flush() 契约。
 *
 * 做法：维持一个"未判定 / 已判定 UTF-8 / 已判定代码页"的三态机。判定阶段
 * 同时跑两个 TextDecoder（细节见函数体内注释）——严格模式（fatal:true）的
 * 一个只当"探测器"用来判断这段字节合不合法，非严格模式的另一个才是真正对外
 * 输出、且供 flush() 收尾的那个（这样 flush() 遇到截断的尾部字节时吐 U+FFFD
 * 而不是抛错，与既有的 codepageDecoder / F1 flush 契约保持一致）。
 * WHATWG 流式解码规范里，`decode(chunk, {stream:true})` 遇到"字节不完整（多字节
 * 字符被切在 chunk 边界）"时不会报错，只会把尾部字节缓存起来等下一个 chunk，
 * 只有遇到"字节确实不合法"才会在 fatal:true 下抛错——这正好是我们需要的信号：
 * 探测器不抛错 = 目前为止的字节都与合法 UTF-8 兼容（可能还不完整），
 * 抛错 = 这不是 UTF-8（八成是代码页编码）。
 *
 * - 未判定阶段：每个 chunk 同时喂给两个解码器。
 *   - 探测成功：用非严格解码器产出的文本作为正确的解码结果返回。
 *     若这个 chunk 里出现过非 ASCII 字节（纯 ASCII 无判别意义，各编码解读一致），
 *     判定为 UTF-8 并转入"已判定 UTF-8"状态，之后的 chunk 只需要继续喂非严格
 *     解码器（其内部续解状态从流的第一个字节起就没断过，不会丢字节）。
 *   - 探测失败（抛错）：这不是 UTF-8，转入"已判定代码页"状态，把*当前这个* chunk
 *     交给代码页解码器处理。安全性依据：未判定阶段之前吐出的内容全部来自纯 ASCII
 *     chunk（否则早就判定过了），而 ASCII 字节在所有受支持的 Windows 代码页下
 *     单字节、解读一致，代码页解码器此前没被喂过任何字节也不影响正确性。
 * - 判定之后（UTF-8 或代码页）：行为等价于改动前的"单一解码器 + stream:true"逻辑，
 *   不再重新判断——一次判定，全程复用，不会出现"判定结果中途反悔"的抖动。
 *
 * 已知的可接受风险（与整段 buffer 版本的 looksLikeUtf8 同源、同等级）：某些真正的
 * 代码页字节序列理论上有极小概率"恰好"也是合法的 UTF-8 序列而被误判——这是启发式
 * 检测的固有取舍，字节越多误判概率越低（论证同 decodeCapturedOutputBuffer 顶部
 * 模块注释），实践中子进程一次性输出的通常是完整的一行文本而非孤立 1-2 个字节，
 * 风险可接受。
 */
export function createWindowsStreamDecoder(params?: {
  platform?: NodeJS.Platform;
  windowsEncoding?: string | null;
}): StreamingWindowsDecoder {
  const platform = params?.platform ?? process.platform;
  if (platform !== "win32") {
    return createPassthroughStreamDecoder();
  }
  const encoding = params?.windowsEncoding ?? resolveWindowsConsoleEncoding();
  if (!encoding || encoding.toLowerCase() === "utf-8") {
    return createPassthroughStreamDecoder();
  }
  let codepageDecoder: TextDecoder;
  try {
    // fatal:false（默认值）：遇到确实无法解码的孤立字节时用替换符而非抛错，
    // 保证 exec 输出管线不会因为一次解码失败整体崩掉。
    codepageDecoder = new TextDecoder(encoding);
  } catch {
    return createPassthroughStreamDecoder();
  }

  // 双解码器协同（缺一不可，别简化成一个）：
  // - utf8Validator（fatal:true）：只用来"探测"——遇到真正非法的字节序列会抛错，
  //   借此判断这段流是否兼容 UTF-8；本身产出的文本不对外使用。
  // - utf8Real（fatal:false，与 codepageDecoder 同款默认非严格模式）：真正对外
  //   输出、且在 flush() 时收尾的那个解码器。
  // 为什么需要两个而不是直接拿 utf8Validator 当输出用：fatal:true 的解码器在
  // flush()（数据流真正结束、stream:false）时如果还残留"不完整的尾部字节"
  // （比如子进程被 SIGKILL，UTF-8 多字节字符写到一半就断了），会直接抛错而不是
  // 像 codepageDecoder 那样吐出 U+FFFD 替换符——这会破坏既有的 F1 flush() 契约
  // （"截断的尾部字符必须被替换成 U+FFFD 吐出，不能静默丢弃/报错"）。
  // 解法：unresolved 阶段每个 chunk 同时喂给两个解码器（字节完全相同，两者内部
  // 续解状态始终同步），只用 utf8Validator 的成功/失败判断"这是不是 UTF-8"，
  // 实际返回给调用方的文本、以及最终 flush() 的收尾，都用 utf8Real（非 fatal）
  // ——这样 utf8Real 从流的第一个字节起就没有缺过状态，可以安全地在委定为 UTF-8
  // 之后单独继续使用，flush() 语义也和 codepageDecoder 保持一致（非 fatal，
  // 遇到截断尾部吐 U+FFFD 而不是抛错）。
  const utf8Validator = new TextDecoder("utf-8", { fatal: true });
  const utf8Real = new TextDecoder("utf-8");
  let resolvedMode: "unresolved" | "utf8" | "codepage" = "unresolved";

  return {
    decode: (chunk: Buffer) => {
      if (resolvedMode === "codepage") {
        try {
          return codepageDecoder.decode(chunk, { stream: true });
        } catch {
          return chunk.toString("utf8");
        }
      }
      if (resolvedMode === "utf8") {
        try {
          return utf8Real.decode(chunk, { stream: true });
        } catch {
          return chunk.toString("utf8");
        }
      }
      // resolvedMode === "unresolved"：用严格 UTF-8 探测这个 chunk 是否兼容。
      try {
        utf8Validator.decode(chunk, { stream: true }); // 只用于判断是否抛错，产出的文本不使用
        // 探测没抛错：这段字节（含之前已喂过的历史字节）与合法 UTF-8 兼容。
        // 用非 fatal 的 utf8Real 同步解码同一份字节，作为真正要返回的文本——
        // 对合法 UTF-8 输入，fatal:true 与 fatal:false 的解码结果逐字节一致，
        // 这里用 utf8Real 只是为了让它持续保有与 utf8Validator 同步的续解状态。
        const decoded = utf8Real.decode(chunk, { stream: true });
        if (bufferHasNonAscii(chunk)) {
          // 拿到了足以判别编码的信号（非 ASCII 字节 + 严格解码未报错）——
          // 之后全程按 UTF-8 处理，不再走代码页分支，utf8Validator 不再需要。
          //
          // code review Minor#3：这个提交是**单向、不可逆**的 deliberate trade-off
          // ——一旦某个 chunk 含非 ASCII 字节且通过严格 UTF-8 校验，后续所有
          // chunk 都会被当作 UTF-8 处理，即使后面来的其实是货真价实的 GBK 字节
          // 也不会被重新识别、切回 GBK 解码（会被非 fatal 的 utf8Real 当无效
          // 序列解出 U+FFFD 替换符，见 windows-encoding.test.ts 的 Minor#3/#4
          // 回归测试）。不做"中途切换检测"是有意为之：真实场景里同一个子进程
          // 中途切换输出编码本身就极其反常，不值得为这种边缘情况增加状态机
          // 复杂度（可能引入新的误判/抖动）。
          resolvedMode = "utf8";
        }
        // 纯 ASCII chunk：resolvedMode 保持 unresolved，但 decoded 本身已经
        // 正确（ASCII 在任何编码下解读一致），可以安全立即返回。
        return decoded;
      } catch {
        // 严格 UTF-8 解码失败 = 这不是合法 UTF-8，判定为代码页编码。
        // 安全性依据：unresolved 阶段此前吐出的内容全部来自纯 ASCII chunk
        // （否则早就判定过了），ASCII 字节在所有受支持代码页下单字节、解读一致，
        // codepageDecoder 此前没被喂过任何字节也不影响正确性。
        resolvedMode = "codepage";
        try {
          return codepageDecoder.decode(chunk, { stream: true });
        } catch {
          return chunk.toString("utf8");
        }
      }
    },
    // F1：不传 { stream: true }（等价于 stream:false）—— 告诉解码器"数据流已经
    // 结束"，把内部缓存的、尚未凑成完整字符的尾部字节按最终语义 flush 出来
    // （WHATWG Encoding 规范：流终止时的不完整多字节序列会被替换成 U+FFFD 吐出，
    // 而不是继续悬空等待一个永远不会到达的续传 chunk）。只应在进程/流确认结束后
    // 调用一次；重复调用是安全的（TextDecoder 内部状态已清空，会返回空字符串）。
    flush: () => {
      if (resolvedMode === "codepage") {
        try {
          return codepageDecoder.decode();
        } catch {
          return "";
        }
      }
      // "utf8" 或流全程都是纯 ASCII（含从未收到任何 chunk）而始终停在 unresolved：
      // 两种情况 utf8Real 从头到尾都被正确喂过所有字节，用它收尾即可，非 fatal
      // 语义与 codepageDecoder 对称——截断的尾部字符吐 U+FFFD，不抛错。
      try {
        return utf8Real.decode();
      } catch {
        return "";
      }
    },
  };
}
