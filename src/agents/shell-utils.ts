import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/shell-utils");

// Yuiclaw 补丁（Windows 兼容性修复 code review Important#1/#2 回应）：
// resolvePowerShellPath() 现在会真的 spawn 一次候选二进制做可执行性验证（见下方
// verifyPwshExecutable），实测成功路径耗时约 316ms。而 getShellConfig() 每次
// exec 都会调一次 resolvePowerShellPath()——不缓存的话，每条命令都要白付这笔延迟。
// 解析结果在进程生命周期内不会变（没有人会在 Yuiclaw 跑着的时候重装 PowerShell），
// 所以用模块级缓存只解析一次，与 windows-encoding.ts 的 cachedWindowsConsoleEncoding
// 是同一个思路。
let cachedResolvedPowerShellPath: string | undefined;

/**
 * 供测试重置缓存用（同款约定见 src/infra/shell-env.ts 的
 * resetShellPathCacheForTests / src/agents/cli-credentials.ts 的
 * resetCliCredentialCachesForTest）。生产代码不应调用。
 */
export function resetPowerShellPathCacheForTests(): void {
  cachedResolvedPowerShellPath = undefined;
}

// Yuiclaw 补丁（Windows 兼容性修复 code review Important#1/#2 回应）：
//
// 真实观测到的坑（不是假设）：Microsoft Store / winget 发行的应用会在
// %LOCALAPPDATA%\Microsoft\WindowsApps\ 下放一个 0 字节的 "App Execution Alias"
// 占位符（reparse point）——哪怕对应的应用**根本没有安装**，这个占位文件也一直
// 存在；一旦被直接 spawn，它会弹出 Microsoft Store 安装向导（或在无 GUI/CI 环境
// 下报错退出），而不是真的运行 pwsh。已装好的真别名和未安装的占位符在文件属性
// 上完全无法区分（实测都是 Length=0、Attributes=Archive|ReparsePoint），唯一可靠
// 的判别办法是真的尝试跑一次。
//
// 更麻烦的是：Node 的 fs.existsSync 内部走 fs.statSync，而 statSync 对这个别名
// 目录下的条目会抛 EACCES（访问被拒绝）——existsSync 遇到任何异常都按"不存在"
// 处理，也就是说 existsSync 对这个目录里的文件恒为 false，即使别名已经指向一个
// 真装好的 pwsh 也测不出来！只有 fs.accessSync(path, X_OK)（resolveShellFromPath
// 用的就是这个）或者真的 spawn 一次，才能拿到准确结果。这也是本 PR 最初版本里
// "LOCALAPPDATA + existsSync" 特判块从未生效过的原因——已删除；WindowsApps 目录
// 本就在系统 PATH 上，Fix A 修好 PATHEXT 后，下面的 PATH 搜索分支已经能通过
// accessSync 找到它，不需要重复的特判路径。
//
// 修法：找到的每一个"可能是占位符"的候选（Program Files / ProgramW6432 /
// PATH 搜索命中）在最终采信之前都真的 spawn 一次做验证；验证失败就继续尝试
// 下一个候选（PATH 搜索还可能命中多个目录，见 resolveAllShellMatchesFromPath），
// 全部失败才落回 Windows 自带的 PowerShell 5.1——那是系统内置组件、不是别名，
// 作为终极兜底不需要再验证。YUICLAW_BUNDLED_PWSH_PATH（Yuiclaw 自己校验过随
// 安装包分发的真身二进制，不是 App Execution Alias）同样不需要验证。
//
// code review Round2 Important#1（性能/阻塞成本必须写明具体数字，不能只写
// "若干"）：
// - verifyPwshExecutable 用的是**同步** spawnSync，会阻塞 Node 事件循环，
//   不是后台异步跑的——调用期间整个进程（包括其他并发的 gateway/IPC 处理）
//   都会被冻结，直到子进程退出或超时。
// - 单次调用最长阻塞 PWSH_VERIFY_TIMEOUT_MS = 3000ms（见下方常量）。
// - 当前实现里固定有 2 个会触发 verify() 的候选位置：Program Files 的
//   pwsh7、ProgramW6432 的 pwsh7Alt；此外 PATH 搜索分支
//   （resolveAllShellMatchesFromPath 返回的每一个匹配）也会各 verify 一次，
//   这一步在代码结构上**没有硬编码的数量上限**，实际次数取决于用户 PATH
//   环境变量里有多少个目录、其中又有多少个能通过 PATHEXT 匹配到 "pwsh" 的
//   候选（结构性无绝对上限，但现实中一台机器同时装多个相互冲突的 pwsh 极少见）。
// - **最坏情况的具体算式**：总 verify 调用次数 = 2（固定）+ N（PATH 命中数），
//   每次最长 3000ms，即 worst_case_ms = (2 + N) × 3000。以本次实测复现环境为例
//   （PATH 上只有 WindowsApps 这一个 pwsh 候选，N=1）：全部候选都验证失败时，
//   最坏总阻塞时长 = (2 + 1) × 3000ms = 9000ms ≈ 9 秒——且只发生在**首次**
//   resolvePowerShellPath() 调用时（下面的模块级缓存保证之后不会重复付出这
//   笔成本）。常见的单一候选场景（比如系统只装了 Store 版 pwsh、没有其他
//   冲突安装）通常只触发 1 次 verify，最坏 ≈ 3 秒。
//
// code review Round2 Important#2（首次 verify 失败——含瞬时超时——会被永久
// 缓存为 PS 5.1，静默退化，排查困难）：
// - 已评估两种方案：① 把"全部候选失败"这个结果也照常写入缓存（当前选择）；
//   ② 只缓存成功结果，失败不缓存，让下一次 exec 重新走一遍探测。
// - **选了①，理由**：这台机器上大概率有相当比例是"确实没装 pwsh7、只有
//   PS 5.1"的真实稳态（而不是瞬时抖动）——如果选②，这些机器会在**每一次**
//   exec 调用上都重新付出上面算出来的最坏 (2+N)×3000ms 阻塞成本，这比"一次
//   瞬时超时误判后，整个进程生命周期都停留在 PS 5.1（但至少能跑、有日志可查）"
//   更差：前者是对最常见场景（真的没装 pwsh）的持续性能伤害，后者是对少见
//   场景（AV 扫描/慢盘导致的一次性超时）的一次性、可诊断的体验降级。
// - 用日志弥补"静默"这个真正的问题（见 resolvePowerShellPathUncached 里落到
//   PS 5.1 分支时的 log.warn/log.debug）：全部候选存在但验证失败时打 warn
//   （这是真正的"退化"信号，值得关注）；压根没找到任何候选时打 debug（这是
//   机器上确实没装 pwsh7 的正常状态，不算异常）。这样即使结果被缓存，用户/
//   开发者也能从日志里查到"为什么这个进程生命周期里 && 一直不能用"，而不是
//   完全没有排查线索。
// - 没有做"缓存加 TTL 到期重试"这类折中方案：为了保持这次修复的改动面
//   最小（Karpathy 式"最少代码"原则），且 review 本身也明确说"非必须加重试"
//   ——如果未来发现瞬时超时误判确实是高频问题，再单独评估要不要引入 TTL。
const PWSH_VERIFY_TIMEOUT_MS = 3000;

/**
 * 真的 spawn 一次候选路径，确认它是一个能正常跑起来的 PowerShell，而不是
 * Microsoft Store 的占位别名。跑一个几乎零成本的表达式，只关心进程能否以
 * 0 退出码结束——不关心具体输出内容（stdio: "ignore"）。
 *
 * ⚠️ 阻塞警告：内部用的是**同步** spawnSync，会阻塞 Node 事件循环直到子进程
 * 退出或超时（最长 PWSH_VERIFY_TIMEOUT_MS = 3000ms）——具体成本核算与"为什么
 * 接受这个代价"见上方模块级注释（Round2 Important#1）。
 *
 * stdio: "ignore"：占位别名被 spawn 时可能弹出 Store 安装向导 UI，我们既不需要
 * 也不想捕获它的输出。
 * timeout：占位别名弹 GUI 或挂起时不能让 exec 管线一直卡住，超时按失败处理，
 * 落到下一个候选（终极兜底 PS 5.1）。
 *
 * ⚠️ 诚实边界（未实测场景）：本函数"未安装的占位别名会以非 0 退出码结束、或
 * 超时"这个假设，是防御式设计，不是在真实的"别名存在但 pwsh 未安装"机器上
 * 验证过的结论——实测环境是"真装了 pwsh7 Store 版"的机器，只验证了成功路径
 * （spawn 成功，耗时约 316ms）。若未来发现占位别名被 spawn 时的真实行为与这里
 * 的假设不符（比如它不退出、不报错，而是静默阻塞在其他地方而非弹窗），需要
 * 重新评估这个探针。
 */
function verifyPwshExecutable(candidatePath: string): boolean {
  try {
    const result = spawnSync(
      candidatePath,
      ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"],
      {
        timeout: PWSH_VERIFY_TIMEOUT_MS,
        windowsHide: true,
        stdio: "ignore",
      },
    );
    return result.status === 0 && !result.error;
  } catch {
    return false;
  }
}

/**
 * code review Round2 Minor：`params.verify` 只在**缓存未命中**时才会被使用——
 * 一旦模块级缓存里已经有解析结果（见 cachedResolvedPowerShellPath），本函数会
 * 直接短路返回缓存值，完全不会调用这次传入的 `verify`，即使传了自定义实现也
 * 一样。测试如果需要每次都重新走 verify 逻辑，必须先调用
 * resetPowerShellPathCacheForTests()。
 */
export function resolvePowerShellPath(params?: {
  /** 测试注入用：跳过真实 spawn，模拟"候选可执行 / 是占位符"。生产代码不传，
   * 用真正的 verifyPwshExecutable。缓存命中时本参数会被忽略，见函数级注释。 */
  verify?: (candidatePath: string) => boolean;
}): string {
  if (cachedResolvedPowerShellPath !== undefined) {
    return cachedResolvedPowerShellPath;
  }
  const verify = params?.verify ?? verifyPwshExecutable;
  const resolved = resolvePowerShellPathUncached(verify);
  cachedResolvedPowerShellPath = resolved;
  return resolved;
}

function resolvePowerShellPathUncached(verify: (candidatePath: string) => boolean): string {
  // Yuiclaw PR-B（R5/组件7）：优先读 Yuiclaw Windows 安装包 bundle 进来的 pwsh7 路径。
  // 为什么必须放在这里最前面、且必须是显式 env 候选（不能只往子进程 PATH 塞目录）：
  // 下面 resolveAllShellMatchesFromPath("pwsh") 的 PATH 搜索用的是字面量 "pwsh"
  // （补扩展名前无 .exe，见该函数实现），纯粹把 bundle 目录加进子进程 PATH 对
  // Windows 曾经无效——必须有一条显式指向完整可执行文件路径的候选。
  // YUICLAW_BUNDLED_PWSH_PATH 由 apps/desktop 的 main.ts 仅在 win32 且文件确实存在时设置
  // （PR-C 组件8⑤，照 YUICLAW_BUNDLED_SKILLS_DIR 先例），mac/Linux 不会设置该 env，
  // 对非 Windows 平台无副作用。env 未设置或指向的文件不存在（bundle 缺失/裁剪）时，
  // 落回下面的原有逻辑（找系统 pwsh7 → 退回 PS 5.1），不会导致解析失败或崩溃（R5.4/O1）。
  // 这是 Yuiclaw 自己随安装包校验过的真身二进制，不是 App Execution Alias，不需要
  // 像下面的系统候选那样做可执行性验证。
  const bundledPwsh = process.env.YUICLAW_BUNDLED_PWSH_PATH;
  if (bundledPwsh && fs.existsSync(bundledPwsh)) {
    return bundledPwsh;
  }

  // code review Round2 Important#2 回应：记录"存在但 verify 失败"的候选路径，
  // 只有这个列表非空时，落到 PS 5.1 兜底才算是"真的发生了降级"（而不是这台
  // 机器压根没装 pwsh7 的正常状态）——日志级别据此区分，见函数末尾。
  const failedCandidates: string[] = [];

  // Prefer PowerShell 7 when available; PS 5.1 lacks "&&" support.
  // 以下每个候选找到后都先 verify() 过一遍才采信——见上方模块注释：只凭
  // fs.existsSync 找到文件不代表它真能跑（可能是占位别名 / 损坏的安装），
  // 验证失败就 continue 尝试下一个候选，而不是直接采信或直接放弃。
  const programFiles = process.env.ProgramFiles || process.env.PROGRAMFILES || "C:\\Program Files";
  const pwsh7 = path.join(programFiles, "PowerShell", "7", "pwsh.exe");
  if (fs.existsSync(pwsh7)) {
    if (verify(pwsh7)) {
      return pwsh7;
    }
    failedCandidates.push(pwsh7);
  }

  const programW6432 = process.env.ProgramW6432;
  if (programW6432 && programW6432 !== programFiles) {
    const pwsh7Alt = path.join(programW6432, "PowerShell", "7", "pwsh.exe");
    if (fs.existsSync(pwsh7Alt)) {
      if (verify(pwsh7Alt)) {
        return pwsh7Alt;
      }
      failedCandidates.push(pwsh7Alt);
    }
  }

  // Yuiclaw 补丁（Windows 兼容性修复 review Important#4 回应）：Microsoft Store /
  // winget 安装的 pwsh7 装在 %LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe，
  // 该目录本身就在系统 PATH 上，Fix A 修好 PATHEXT 后 PATH 搜索已经能找到它，
  // 不需要（也不应该，见上方模块注释）再维护一条独立的 LOCALAPPDATA 特判路径。
  // 用 resolveAllShellMatchesFromPath 而不是只取第一个匹配：PATH 上可能同时存在
  // 一个占位别名（验证失败）和另一个目录里真正能跑的 pwsh（比如用户手动解压的
  // portable 版）——逐个候选验证、失败就试下一个，才能覆盖到后面这个真身，
  // 而不是碰到第一个占位符就直接放弃、错过后面本来能用的候选。
  for (const candidate of resolveAllShellMatchesFromPath("pwsh")) {
    if (verify(candidate)) {
      return candidate;
    }
    failedCandidates.push(candidate);
  }

  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  const ps51Candidate = systemRoot
    ? path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const ps51Exists = systemRoot ? fs.existsSync(ps51Candidate) : false;
  // 终极兜底：Windows 系统内置组件，不是别名，不存在"装了别名但没装真身"
  // 的问题，不需要再 verify。ps51Exists 为 false 时（SystemRoot 未设或系统
  // 目录下确实没有这个文件——极端环境）沿用改动前的行为，裸返回 "powershell.exe"
  // 交给 PATH 解析，不视为额外的失败候选。
  const resolvedFallback = ps51Exists ? ps51Candidate : "powershell.exe";

  // code review Round2 Important#2 回应：全部候选验证失败、静默落回 PS 5.1 是
  // 本次修复要解决的"排查困难"问题本身——用日志弥补"结果被缓存导致后续完全
  // 看不出来"这一点（缓存决策与为什么不做失败重试的完整论证见上方模块注释）。
  if (failedCandidates.length > 0) {
    // 曾经找到过候选、但真的 spawn 起来全部失败——这是值得关注的真实退化
    // （占位别名 / 损坏安装 / 瞬时超时），打 warn 并把具体候选路径带上，
    // 方便用户或开发者排查"为什么这个进程里 && 一直用不了"。
    log.warn('Windows PowerShell 7 候选全部验证失败，降级为 PowerShell 5.1（不支持 "&&"）', {
      failedCandidates,
      fallback: resolvedFallback,
    });
  } else {
    // 压根没找到任何 pwsh7 候选——这台机器大概率就是只装了系统自带的 PS 5.1，
    // 是预期内的正常状态，不算异常，用 debug 级别留痕即可（不打扰用户，但
    // 仍然可查）。
    log.debug('未找到任何 pwsh7 候选，使用 PowerShell 5.1（不支持 "&&"）', {
      fallback: resolvedFallback,
    });
  }
  return resolvedFallback;
}

export function getShellConfig(): { shell: string; args: string[] } {
  if (process.platform === "win32") {
    // Use PowerShell instead of cmd.exe on Windows.
    // Problem: Many Windows system utilities (ipconfig, systeminfo, etc.) write
    // directly to the console via WriteConsole API, bypassing stdout pipes.
    // When Node.js spawns cmd.exe with piped stdio, these utilities produce no output.
    // PowerShell properly captures and redirects their output to stdout.
    return {
      shell: resolvePowerShellPath(),
      args: ["-NoProfile", "-NonInteractive", "-Command"],
    };
  }

  const envShell = process.env.SHELL?.trim();
  const shellName = envShell ? path.basename(envShell) : "";
  // Fish rejects common bashisms used by tools, so prefer bash when detected.
  if (shellName === "fish") {
    const bash = resolveShellFromPath("bash");
    if (bash) {
      return { shell: bash, args: ["-c"] };
    }
    const sh = resolveShellFromPath("sh");
    if (sh) {
      return { shell: sh, args: ["-c"] };
    }
  }
  const shell = envShell && envShell.length > 0 ? envShell : "sh";
  return { shell, args: ["-c"] };
}

export function resolveShellFromPath(name: string): string | undefined {
  return resolveAllShellMatchesFromPath(name)[0];
}

/**
 * 和 resolveShellFromPath 一样按 PATH 目录逐个查找可执行文件，但返回**所有**
 * 命中的候选（按 PATH 顺序），而不是只返回第一个。
 *
 * Yuiclaw 补丁（Windows 兼容性修复 code review Important#4 回应）：
 * resolvePowerShellPath() 采信一个 PATH 命中的 pwsh 候选前会先真的 spawn 一次
 * 做可执行性验证（见该函数注释）——如果 PATH 上排在前面的是一个 Microsoft
 * Store 占位别名（文件存在但对应应用没真正安装，spawn 会失败），而 PATH 上
 * 更后面的目录里还有一个真正能跑的 pwsh（比如用户手动解压的 portable 版），
 * 只返回"第一个匹配"会让调用方错失这个能用的候选、直接放弃落到 PS 5.1。
 * 返回全部候选，让调用方逐个验证、验证失败就尝试下一个，才能覆盖"PATH 上
 * 既有占位符又有真身"的场景。
 */
export function resolveAllShellMatchesFromPath(name: string): string[] {
  const envPath = process.env.PATH ?? "";
  if (!envPath) {
    return [];
  }
  const entries = envPath.split(path.delimiter).filter(Boolean);
  // Yuiclaw 修复（Windows 兼容性 Fix A 之一，真实 bug，非假设）：
  // Windows 上可执行文件在磁盘上必须带扩展名（.exe/.cmd/.bat 等），下面用
  // path.join(entry, name) 拼出的裸文件名（如 "pwsh"）加上 fs.accessSync 几乎
  // 不可能命中——即使 PATH 目录里确实躺着 pwsh.exe。
  // 实测复现（Windows 10、中文 chcp=936、已装 Microsoft Store 版 pwsh 7.6.3）：
  // resolveShellFromPath("pwsh") 对该机 PATH 上的每一个目录都不命中，把搜索名从
  // "pwsh" 换成 "pwsh.exe" 后立刻在 WindowsApps 别名目录命中——证实问题就在"没补
  // 扩展名"，而不是候选目录本身找错了。这导致 resolvePowerShellPath() 永远落回
  // 系统自带的 PowerShell 5.1（不支持 "&&"）。
  // 修法：win32 且传入的 name 本身不带扩展名时，按 PATHEXT（缺省
  // ".COM;.EXE;.BAT;.CMD"，与 cmd.exe 实际使用的默认值一致）逐个尝试
  // name+ext；仍把裸名本身也留在候选列表最后作为兜底（万一 PATH 目录里就是
  // 放了一个没有扩展名的可执行文件，比如某些 shim）。
  // 非 win32 分支（darwin/linux）此逻辑不生效，candidateNames 恒为 [name]，
  // 与改动前逐字节一致的行为——不能影响已有的 bash/sh/fish 解析。
  //
  // code review Minor#1：process.env.PATHEXT ?? 默认值 用的是 ??（空值合并），
  // 只在 PATHEXT 是 null/undefined 时才回退默认值——但 PATHEXT 显式设成空字符串
  // ""（一个合法的、虽然反常的环境状态）时 ?? 不会触发，会把 "" 拆成 [""]，
  // 过滤掉空串后 candidateNames 只剩裸名兜底，等于没有任何 PATHEXT 候选。
  // cmd.exe 的实际行为是 PATHEXT 为空也当作"没设置"、退回内置默认扩展名列表，
  // 这里改用 ||（假值兜底）对齐这个行为——"" 是 falsy，会正确触发默认值。
  const candidateNames =
    process.platform === "win32" && !path.extname(name)
      ? [
          ...(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
            .split(";")
            .map((ext) => ext.trim())
            .filter(Boolean)
            .map((ext) => `${name}${ext.startsWith(".") ? ext : `.${ext}`}`),
          name,
        ]
      : [name];
  const matches: string[] = [];
  for (const entry of entries) {
    for (const candidateName of candidateNames) {
      const candidate = path.join(entry, candidateName);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        matches.push(candidate);
      } catch {
        // ignore missing or non-executable entries
      }
    }
  }
  return matches;
}

function normalizeShellName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return path
    .basename(trimmed)
    .replace(/\.(exe|cmd|bat)$/i, "")
    .replace(/[^a-zA-Z0-9_-]/g, "");
}

export function detectRuntimeShell(): string | undefined {
  const overrideShell = process.env.CLAWDBOT_SHELL?.trim();
  if (overrideShell) {
    const name = normalizeShellName(overrideShell);
    if (name) {
      return name;
    }
  }

  if (process.platform === "win32") {
    if (process.env.POWERSHELL_DISTRIBUTION_CHANNEL) {
      return "pwsh";
    }
    return "powershell";
  }

  const envShell = process.env.SHELL?.trim();
  if (envShell) {
    const name = normalizeShellName(envShell);
    if (name) {
      return name;
    }
  }

  if (process.env.POWERSHELL_DISTRIBUTION_CHANNEL) {
    return "pwsh";
  }
  if (process.env.BASH_VERSION) {
    return "bash";
  }
  if (process.env.ZSH_VERSION) {
    return "zsh";
  }
  if (process.env.FISH_VERSION) {
    return "fish";
  }
  if (process.env.KSH_VERSION) {
    return "ksh";
  }
  if (process.env.NU_VERSION || process.env.NUSHELL_VERSION) {
    return "nu";
  }

  return undefined;
}

export function sanitizeBinaryOutput(text: string): string {
  const scrubbed = text.replace(/[\p{Format}\p{Surrogate}]/gu, "");
  if (!scrubbed) {
    return scrubbed;
  }
  const chunks: string[] = [];
  for (const char of scrubbed) {
    const code = char.codePointAt(0);
    if (code == null) {
      continue;
    }
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      chunks.push(char);
      continue;
    }
    if (code < 0x20) {
      continue;
    }
    chunks.push(char);
  }
  return chunks.join("");
}

export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
      });
    } catch {
      // ignore errors if taskkill fails
    }
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // process already dead
    }
  }
}
