import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function resolvePowerShellPath(): string {
  // Yuiclaw PR-B（R5/组件7）：优先读 Yuiclaw Windows 安装包 bundle 进来的 pwsh7 路径。
  // 为什么必须放在这里最前面、且必须是显式 env 候选（不能只往子进程 PATH 塞目录）：
  // 下面 resolveShellFromPath("pwsh") 的 PATH 搜索用的是字面量 "pwsh"（无 .exe 扩展名，
  // 见该函数实现），Windows 下 fs.accessSync 拼不出 "pwsh.exe"，所以纯粹把 bundle 目录
  // 加进子进程 PATH 对 Windows 无效——必须有一条显式指向完整可执行文件路径的候选。
  // YUICLAW_BUNDLED_PWSH_PATH 由 apps/desktop 的 main.ts 仅在 win32 且文件确实存在时设置
  // （PR-C 组件8⑤，照 YUICLAW_BUNDLED_SKILLS_DIR 先例），mac/Linux 不会设置该 env，
  // 对非 Windows 平台无副作用。env 未设置或指向的文件不存在（bundle 缺失/裁剪）时，
  // 落回下面的原有逻辑（找系统 pwsh7 → 退回 PS 5.1），不会导致解析失败或崩溃（R5.4/O1）。
  const bundledPwsh = process.env.YUICLAW_BUNDLED_PWSH_PATH;
  if (bundledPwsh && fs.existsSync(bundledPwsh)) {
    return bundledPwsh;
  }

  // Prefer PowerShell 7 when available; PS 5.1 lacks "&&" support.
  const programFiles = process.env.ProgramFiles || process.env.PROGRAMFILES || "C:\\Program Files";
  const pwsh7 = path.join(programFiles, "PowerShell", "7", "pwsh.exe");
  if (fs.existsSync(pwsh7)) {
    return pwsh7;
  }

  const programW6432 = process.env.ProgramW6432;
  if (programW6432 && programW6432 !== programFiles) {
    const pwsh7Alt = path.join(programW6432, "PowerShell", "7", "pwsh.exe");
    if (fs.existsSync(pwsh7Alt)) {
      return pwsh7Alt;
    }
  }

  // Yuiclaw 补丁（Windows 兼容性修复 Fix A 之二）：Microsoft Store / winget 安装的
  // pwsh7 不会落在 Program Files 下的固定路径，而是装在当前用户的 WindowsApps 别名
  // 目录（%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe）。该目录本身也在系统 PATH
  // 里，理论上下面 resolveShellFromPath("pwsh") 的 PATH 搜索也该能找到它——但由于
  // resolveShellFromPath 曾经的裸名不补扩展名 bug（见该函数注释），实测这条路径
  // 一直搜不到，只能落回 PS 5.1。这里补一条显式候选做双保险：即使 PATHEXT/PATH
  // 搜索逻辑将来又出岔子，Store/winget 版 pwsh 仍能被直接命中。
  // 实测环境：Windows 10、中文（chcp=936）、已装 Store 版 pwsh 7.6.3，此路径命中。
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const storePwshPath = path.join(localAppData, "Microsoft", "WindowsApps", "pwsh.exe");
    if (fs.existsSync(storePwshPath)) {
      return storePwshPath;
    }
  }

  const pwshInPath = resolveShellFromPath("pwsh");
  if (pwshInPath) {
    return pwshInPath;
  }

  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (systemRoot) {
    const candidate = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "powershell.exe";
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
  const envPath = process.env.PATH ?? "";
  if (!envPath) {
    return undefined;
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
  const candidateNames =
    process.platform === "win32" && !path.extname(name)
      ? [
          ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
            .split(";")
            .map((ext) => ext.trim())
            .filter(Boolean)
            .map((ext) => `${name}${ext.startsWith(".") ? ext : `.${ext}`}`),
          name,
        ]
      : [name];
  for (const entry of entries) {
    for (const candidateName of candidateNames) {
      const candidate = path.join(entry, candidateName);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // ignore missing or non-executable entries
      }
    }
  }
  return undefined;
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
