/**
 * Shell execution helpers.
 *
 * Resolves platform shell commands and sanitizes binary output.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AnsiSequenceStripper } from "../../packages/terminal-core/src/ansi-sequences.js";
import { stripAnsiForStreamChunk } from "../../packages/terminal-core/src/ansi.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getBinDir } from "./config.js";

// Yuiclaw fork（回搬自 openclaw-vendor #108，族 M-②，本条是当年"暂缓"的一件，
// 现补齐）：resolvePowerShellPath 落到 PS 5.1 兜底时会打日志，见下方
// resolvePowerShellPathUncached 末尾。
const log = createSubsystemLogger("agents/shell-utils");

type ShellConfig = {
  shell: string;
  args: string[];
} & ({ commandTransport: "argv" } | { commandTransport: "stdin" });

type ShellCommandInvocation =
  | { argv: [string, ...string[]]; input?: undefined; stdin: "ignore" }
  | { argv: [string, ...string[]]; input: string; stdin: "pipe" };

function createArgvShellConfig(shell: string, args: string[]): ShellConfig {
  return { shell, args, commandTransport: "argv" };
}

// Yuiclaw fork（回搬自 openclaw-vendor #108，族 M-②，本条是族 M 首轮"暂缓"的
// verify-then-fallback 一件，现补齐）：
//
// 真实观测到的坑（不是假设，PR #108 review 期间实测复现）：Microsoft Store /
// winget 发行的应用会在 %LOCALAPPDATA%\Microsoft\WindowsApps\ 下放一个 0 字节的
// "App Execution Alias"占位符（reparse point）——哪怕对应的应用**根本没有安装**，
// 这个占位文件也一直存在；一旦被直接 spawn，它会弹出 Microsoft Store 安装向导
// （或在无 GUI/CI 环境下报错退出），而不是真的运行 pwsh。已装好的真别名和未安装
// 的占位符在文件属性上完全无法区分（都是 Length=0、Attributes=Archive|
// ReparsePoint），唯一可靠的判别办法是真的尝试跑一次。下面这条候选链因此在
// "existsSync/accessSync 命中"与"最终采信"之间插了一层真实 spawn 验证
// （verifyPwshExecutable），验证失败就 continue 下一个候选，全部失败才落回
// Windows 自带的 PowerShell 5.1（系统内置组件，不是别名，不需要验证）。
// YUICLAW_BUNDLED_PWSH_PATH 是 Yuiclaw 自己随安装包校验过的真身二进制，同样
// 不需要验证。
//
// 阻塞成本（同步 spawnSync，会冻结整个 Node 事件循环，包括其他并发的
// gateway/IPC 处理，不是后台异步跑的）：单次 verify 最长
// PWSH_VERIFY_TIMEOUT_MS = 3000ms；固定 2 个会触发 verify 的候选位置
// （ProgramFiles pwsh7、ProgramW6432 pwsh7Alt）+ PATH 搜索命中数 N，
// worst_case_ms = (2 + N) × 3000（结构上无硬编码上限，取决于用户 PATH 里有
// 多少个候选）。解析结果因此做模块级缓存（同 windows-encoding.ts 的
// cachedWindowsConsoleEncoding 思路），只在首次 exec 付这笔成本一次。
//
// 缓存失败结果的取舍：全部候选验证失败也照常缓存（而非只缓存成功结果、失败
// 不缓存让下次重新探测）——多数 PS5.1 用户是"确实没装 pwsh7"的真实稳态而非
// 瞬时抖动，若失败不缓存，这部分用户会在**每次** exec 上都重付最坏
// (2+N)×3000ms；用日志弥补"静默"这一点：有候选但全部验证失败打 warn（真正的
// 退化信号，带上具体候选路径），压根没找到候选打 debug（机器上就是没装
// pwsh7 的正常状态）。未做"缓存 TTL 到期重试"：保持改动面最小，未来若发现
// 瞬时误判是高频问题再评估。
//
// 诚实边界（未实测场景，Windows 无法在本机验证，见 PR 描述）：本函数假设
// "未安装的占位别名会以非 0 退出码结束、或超时"是防御式设计，不是在真实的
// "别名存在但 pwsh 未安装"机器上验证过的结论；若发现占位别名被 spawn 时的
// 真实行为与这里的假设不符（比如它不退出、不报错，而是静默阻塞在别处而非
// 弹窗），需要重新评估这个探针。
const PWSH_VERIFY_TIMEOUT_MS = 3000;

let cachedResolvedPowerShellPath: string | undefined;

/**
 * 供测试重置 resolvePowerShellPath 的模块级缓存用（同款约定见
 * src/infra/shell-env.ts 的 resetShellPathCacheForTests /
 * src/agents/cli-credentials.ts 的 resetCliCredentialCachesForTest）。
 * 生产代码不应调用。
 */
export function resetPowerShellPathCacheForTests(): void {
  cachedResolvedPowerShellPath = undefined;
}

/**
 * 真的 spawn 一次候选路径，确认它是一个能正常跑起来的 PowerShell，而不是
 * Microsoft Store 的占位别名。跑一个几乎零成本的表达式，只关心进程能否以
 * 0 退出码结束——不关心具体输出内容（stdio: "ignore"，占位别名被 spawn 时
 * 可能弹出 Store 安装向导 UI，我们既不需要也不想捕获它）。
 * timeout：占位别名弹 GUI 或挂起时不能让 exec 管线一直卡住，超时按失败处理。
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
 * `params.verify` 只在**缓存未命中**时才会被使用——一旦模块级缓存里已经有
 * 解析结果，本函数会直接短路返回缓存值，完全不会调用这次传入的 `verify`，
 * 即使传了自定义实现也一样。测试如果需要每次都重新走 verify 逻辑，必须先
 * 调用 resetPowerShellPathCacheForTests()。
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
  // Yuiclaw fork（回搬自 openclaw-vendor #101/#108，族 M-①）：优先读 Yuiclaw
  // Windows 安装包 bundle 进来的 pwsh7 路径。Windows 10/11 出厂只有 PS 5.1
  // （不支持 "&&"），我们把 pwsh7 打进安装包分发，必须让引擎认得这个候选
  // ——纯粹把 bundle 目录塞进子进程 PATH 对 Windows 无效，必须是一条显式
  // 指向完整可执行文件路径的候选（CLAUDE.md §0.7 环境基线铁律）。
  // YUICLAW_BUNDLED_PWSH_PATH 由 apps/desktop 的 main.ts 仅在 win32 且文件
  // 确实存在时设置，mac/Linux 不会设置该 env，对非 Windows 平台无副作用；
  // env 未设置或指向的文件不存在（bundle 缺失/裁剪）时落回下面的原有逻辑。
  // 这是 Yuiclaw 自己随安装包校验过的真身二进制，不是 App Execution Alias，
  // 不需要像下面的系统候选那样做可执行性验证。
  const bundledPwsh = process.env.YUICLAW_BUNDLED_PWSH_PATH;
  if (bundledPwsh && fs.existsSync(bundledPwsh)) {
    return bundledPwsh;
  }

  // 只有这个列表非空，落到 PS 5.1 兜底才算是"真的发生了降级"（而不是这台
  // 机器压根没装 pwsh7 的正常状态）——日志级别据此区分，见函数末尾。
  const failedCandidates: string[] = [];

  // Prefer PowerShell 7 when available; PS 5.1 lacks "&&" support.
  // 每个候选找到后都先 verify() 过一遍才采信——只凭 fs.existsSync 找到文件
  // 不代表它真能跑（可能是占位别名 / 损坏的安装），验证失败就 continue
  // 尝试下一个候选，而不是直接采信或直接放弃。
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

  // Microsoft Store / winget 安装的 pwsh7 装在
  // %LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe，该目录本身就在系统 PATH 上，
  // resolveShellFromPath 的 PATHEXT 兼容逻辑已经能找到它。用
  // resolveAllShellMatchesFromPath 而不是只取第一个匹配：PATH 上可能同时
  // 存在一个占位别名（验证失败）和另一个目录里真正能跑的 pwsh（比如用户
  // 手动解压的 portable 版），逐个候选验证、失败就试下一个，才能覆盖到
  // 后面这个真身，而不是碰到第一个占位符就直接放弃。
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
  // 终极兜底：Windows 系统内置组件，不是别名，不存在"装了别名但没装真身"
  // 的问题，不需要再 verify。ps51Exists 为 false 时（SystemRoot 未设或系统
  // 目录下确实没有这个文件——极端环境）沿用改动前的行为，裸返回
  // "powershell.exe" 交给 PATH 解析，不视为额外的失败候选。
  const ps51Exists = systemRoot ? fs.existsSync(ps51Candidate) : false;
  const resolvedFallback = ps51Exists ? ps51Candidate : "powershell.exe";

  if (failedCandidates.length > 0) {
    // 曾经找到过候选、但真的 spawn 起来全部失败——这是值得关注的真实退化
    // （占位别名 / 损坏安装 / 瞬时超时），打 warn 并把具体候选路径带上。
    log.warn('Windows PowerShell 7 候选全部验证失败，降级为 PowerShell 5.1（不支持 "&&"）', {
      failedCandidates,
      fallback: resolvedFallback,
    });
  } else {
    // 压根没找到任何 pwsh7 候选——这台机器大概率就是只装了系统自带的
    // PS 5.1，是预期内的正常状态，不算异常，用 debug 级别留痕即可。
    log.debug('未找到任何 pwsh7 候选，使用 PowerShell 5.1（不支持 "&&"）', {
      fallback: resolvedFallback,
    });
  }
  return resolvedFallback;
}

// Non-interactive placeholder shells that reject "-c"-style invocations.
// macOS LaunchDaemon service users commonly use /usr/bin/false so login sessions
// cannot be opened; honoring SHELL in that case causes every exec to exit 1.
// See https://github.com/openclaw/openclaw/issues/69077.
const NON_INTERACTIVE_SHELLS = new Set(["false", "nologin"]);

function isNonInteractiveShell(shellPath: string): boolean {
  if (!shellPath) {
    return false;
  }
  return NON_INTERACTIVE_SHELLS.has(path.basename(shellPath));
}

function getPosixShellArgs(shellPath: string): string[] {
  switch (path.basename(shellPath)) {
    case "bash":
      return ["--noprofile", "--norc", "-c"];
    case "zsh":
      return ["-f", "-c"];
    case "fish":
      return ["--no-config", "-c"];
    default:
      return ["-c"];
  }
}

function resolveWindowsBashPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [env.ProgramFiles, env["ProgramFiles(x86)"]]
    .filter((dir): dir is string => Boolean(dir?.trim()))
    .map((dir) => path.join(dir, "Git", "bin", "bash.exe"));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return resolveShellFromPath("bash.exe", env) ?? resolveShellFromPath("bash", env);
}

const WINDOWS_GIT_BASH_CACHE_LIMIT = 16;
const windowsGitBashUsrBinCache = new Map<string, string | undefined>();
let defaultWindowsGitBashUsrBinResolved = false;
let defaultWindowsGitBashUsrBin: string | undefined;

function resolveWindowsGitBashUsrBin(shellPath: string): string | undefined {
  const cacheKey = path.resolve(shellPath).toLowerCase();
  if (windowsGitBashUsrBinCache.has(cacheKey)) {
    return windowsGitBashUsrBinCache.get(cacheKey);
  }

  const normalized = path.normalize(shellPath);
  const shellName = path.basename(normalized).toLowerCase();
  const binDir = path.dirname(normalized);
  let gitRoot: string | undefined;
  if (
    (shellName === "bash.exe" || shellName === "bash") &&
    path.basename(binDir).toLowerCase() === "bin"
  ) {
    const parent = path.dirname(binDir);
    gitRoot = path.basename(parent).toLowerCase() === "usr" ? path.dirname(parent) : parent;
  }

  const usrBin = gitRoot ? path.join(gitRoot, "usr", "bin") : undefined;
  const resolved =
    gitRoot &&
    fs.existsSync(path.join(gitRoot, "cmd", "git.exe")) &&
    usrBin &&
    fs.existsSync(usrBin)
      ? usrBin
      : undefined;
  pruneMapToMaxSize(windowsGitBashUsrBinCache, WINDOWS_GIT_BASH_CACHE_LIMIT - 1);
  windowsGitBashUsrBinCache.set(cacheKey, resolved);
  return resolved;
}

function getWindowsGitBashUsrBin(shellPath?: string): string | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }
  if (shellPath) {
    return resolveWindowsGitBashUsrBin(shellPath);
  }
  if (!defaultWindowsGitBashUsrBinResolved) {
    defaultWindowsGitBashUsrBinResolved = true;
    const resolvedShell = resolveWindowsBashPath();
    defaultWindowsGitBashUsrBin = resolvedShell
      ? resolveWindowsGitBashUsrBin(resolvedShell)
      : undefined;
  }
  return defaultWindowsGitBashUsrBin;
}

function isLegacyWslBashPath(shellPath: string): boolean {
  const normalized = shellPath.replace(/\//g, "\\").toLowerCase();
  return /(?:^|\\)windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function resolveBashCommandConfig(shell: string): ShellConfig {
  if (isLegacyWslBashPath(shell)) {
    return { shell, args: ["-s"], commandTransport: "stdin" };
  }
  return createArgvShellConfig(
    shell,
    process.platform === "win32" ? ["-c"] : getPosixShellArgs(shell),
  );
}

export function buildShellCommandInvocation(
  command: string,
  config: ShellConfig,
): ShellCommandInvocation {
  if (config.commandTransport === "stdin") {
    // The legacy WSL launcher mangles command argv, so its -s mode must read the command from stdin.
    return { argv: [config.shell, ...config.args], input: command, stdin: "pipe" };
  }
  return { argv: [config.shell, ...config.args, command], stdin: "ignore" };
}

export function getShellConfig(customShellPath?: string): ShellConfig {
  if (customShellPath) {
    if (!fs.existsSync(customShellPath)) {
      throw new Error(`Custom shell path not found: ${customShellPath}`);
    }
    return createArgvShellConfig(customShellPath, getPosixShellArgs(customShellPath));
  }

  if (process.platform === "win32") {
    // Use PowerShell instead of cmd.exe on Windows.
    // Problem: Many Windows system utilities (ipconfig, systeminfo, etc.) write
    // directly to the console via WriteConsole API, bypassing stdout pipes.
    // When Node.js spawns cmd.exe with piped stdio, these utilities produce no output.
    // PowerShell properly captures and redirects their output to stdout.
    return createArgvShellConfig(resolvePowerShellPath(), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
  }

  const rawEnvShell = process.env.SHELL?.trim();
  const envShell = rawEnvShell && !isNonInteractiveShell(rawEnvShell) ? rawEnvShell : undefined;
  const shellName = envShell ? path.basename(envShell) : "";
  // Fish rejects common bashisms used by tools, so prefer bash when detected.
  if (shellName === "fish") {
    const bash = resolveShellFromPath("bash");
    if (bash) {
      return createArgvShellConfig(bash, getPosixShellArgs(bash));
    }
    const sh = resolveShellFromPath("sh");
    if (sh) {
      return createArgvShellConfig(sh, getPosixShellArgs(sh));
    }
  }
  if (envShell) {
    return createArgvShellConfig(envShell, getPosixShellArgs(envShell));
  }
  // Placeholder SHELL (or unset): prefer a resolved sh/bash on PATH so we do not
  // re-invoke the placeholder and get a spurious exitCode=1.
  const shell = resolveShellFromPath("sh") ?? resolveShellFromPath("bash") ?? "sh";
  return createArgvShellConfig(shell, getPosixShellArgs(shell));
}

export function getBashShellConfig(customShellPath?: string): ShellConfig {
  if (customShellPath) {
    if (!fs.existsSync(customShellPath)) {
      throw new Error(`Custom shell path not found: ${customShellPath}`);
    }
    return resolveBashCommandConfig(customShellPath);
  }

  if (process.platform === "win32") {
    const bash = resolveWindowsBashPath();
    if (bash) {
      return resolveBashCommandConfig(bash);
    }
    throw new Error("No bash shell found. Install Git for Windows or add bash.exe to PATH.");
  }

  if (fs.existsSync("/bin/bash")) {
    return resolveBashCommandConfig("/bin/bash");
  }

  const shell =
    resolveShellFromPath("bash") ??
    resolveShellFromWhich("bash") ??
    resolveShellFromPath("sh") ??
    "sh";
  return resolveBashCommandConfig(shell);
}

function resolveShellFromPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveAllShellMatchesFromPath(name, env)[0];
}

/**
 * 和 resolveShellFromPath 一样按 PATH 目录逐个查找可执行文件，但返回**所有**
 * 命中的候选（按 PATH 顺序），而不是只返回第一个。
 *
 * Yuiclaw fork（回搬自 openclaw-vendor #108，族 M-②）：resolvePowerShellPath
 * 采信一个 PATH 命中的 pwsh 候选前会先真的 spawn 一次做可执行性验证（见该
 * 函数注释）——如果 PATH 上排在前面的是一个 Microsoft Store 占位别名
 * （文件存在但对应应用没真正安装，spawn 会失败），而 PATH 上更后面的目录里
 * 还有一个真正能跑的 pwsh（比如用户手动解压的 portable 版），只返回"第一个
 * 匹配"会让调用方错失这个能用的候选、直接放弃落到 PS 5.1。返回全部候选，
 * 让调用方逐个验证、验证失败就尝试下一个，才能覆盖"PATH 上既有占位符又有
 * 真身"的场景。
 */
export function resolveAllShellMatchesFromPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const envPath = env.PATH ?? "";
  if (!envPath) {
    return [];
  }
  const entries = envPath.split(path.delimiter).filter(Boolean);
  const executableNames =
    process.platform === "win32" && !path.extname(name) ? [`${name}.exe`, name] : [name];
  const matches: string[] = [];
  for (const executableName of executableNames) {
    for (const entry of entries) {
      const candidate = path.join(entry, executableName);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        matches.push(candidate);
      } catch {
        // Ignore missing or non-executable entries.
      }
    }
  }
  return matches;
}

function resolveShellFromWhich(name: string): string | undefined {
  if (process.platform === "win32") {
    return undefined;
  }
  try {
    const result = spawnSync("which", [name], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout) {
      return undefined;
    }
    const firstMatch = result.stdout.trim().split(/\r?\n/)[0]?.trim();
    return firstMatch || undefined;
  } catch {
    return undefined;
  }
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
  const overrideShell = process.env.OPENCLAW_SHELL?.trim();
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
  if (envShell && !isNonInteractiveShell(envShell)) {
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

export function sanitizeBinaryOutput(
  text: string,
  options?: { ansiMode?: "standard" | "compat" },
): string {
  // Output callbacks are stream chunks, not true EOF. Preserve a pending CSI
  // visibly so a split final byte cannot leak from the following chunk.
  return sanitizeStrippedBinaryOutput(
    stripAnsiForStreamChunk(text, {
      compatibilityGrammar: options?.ansiMode === "compat",
    }),
  );
}

/** Keep one ANSI parser per process stream so control sequences can span callbacks. */
export function createStreamingBinaryOutputSanitizer(
  onCsi?: (sequence: string) => void,
): (text: string) => string {
  const ansiStripper = new AnsiSequenceStripper(onCsi);
  return (text) => sanitizeStrippedBinaryOutput(ansiStripper.write(text));
}

function sanitizeStrippedBinaryOutput(text: string): string {
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
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      chunks.push(`\\x${code.toString(16).padStart(2, "0")}`);
      continue;
    }
    chunks.push(char);
  }
  return chunks.join("");
}

function getShellEnv(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const binDir = getBinDir();
  const pathKeys = Object.keys(sourceEnv).filter((key) => key.toLowerCase() === "path");
  // Node sorts Windows environment keys and passes only the first case-insensitive match.
  // Collapse duplicates before spawning so callers and child processes see the same PATH.
  const sourcePathKey = process.platform === "win32" ? pathKeys.toSorted()[0] : pathKeys[0];
  const pathKey = process.platform === "win32" ? "PATH" : (sourcePathKey ?? "PATH");
  const currentPath = sourcePathKey ? (sourceEnv[sourcePathKey] ?? "") : "";
  const pathEntries = currentPath.split(path.delimiter).filter(Boolean);
  const updatedPath = pathEntries.includes(binDir)
    ? currentPath
    : [binDir, currentPath].filter(Boolean).join(path.delimiter);
  const env = { ...sourceEnv };
  if (process.platform === "win32") {
    for (const key of pathKeys) {
      delete env[key];
    }
  }
  env[pathKey] = updatedPath;
  return env;
}

export function getBashShellEnv(
  shellPath?: string,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = getShellEnv(sourceEnv);
  const usrBin = getWindowsGitBashUsrBin(shellPath);
  if (!usrBin) {
    return env;
  }

  const currentPath = env.PATH ?? "";
  const pathEntries = currentPath.split(path.delimiter).filter(Boolean);
  const normalizedUsrBin = usrBin.toLowerCase();
  env.PATH = [
    usrBin,
    ...pathEntries.filter((entry) => entry.toLowerCase() !== normalizedUsrBin),
  ].join(path.delimiter);
  return env;
}
