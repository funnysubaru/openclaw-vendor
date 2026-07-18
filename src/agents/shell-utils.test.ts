import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { getShellConfig, resolvePowerShellPath, resolveShellFromPath } from "./shell-utils.js";

const isWin = process.platform === "win32";

function createTempCommandDir(
  tempDirs: string[],
  files: Array<{ name: string; executable?: boolean }>,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shell-"));
  tempDirs.push(dir);
  for (const file of files) {
    const filePath = path.join(dir, file.name);
    fs.writeFileSync(filePath, "");
    fs.chmodSync(filePath, file.executable === false ? 0o644 : 0o755);
  }
  return dir;
}

describe("getShellConfig", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  const tempDirs: string[] = [];

  beforeEach(() => {
    envSnapshot = captureEnv(["SHELL", "PATH"]);
    if (!isWin) {
      process.env.SHELL = "/usr/bin/fish";
    }
  });

  afterEach(() => {
    envSnapshot.restore();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  if (isWin) {
    it("uses PowerShell on Windows", () => {
      const { shell } = getShellConfig();
      const normalized = shell.toLowerCase();
      expect(normalized.includes("powershell") || normalized.includes("pwsh")).toBe(true);
    });
    return;
  }

  it("prefers bash when fish is default and bash is on PATH", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "bash" }]);
    process.env.PATH = binDir;
    const { shell } = getShellConfig();
    expect(shell).toBe(path.join(binDir, "bash"));
  });

  it("falls back to sh when fish is default and bash is missing", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "sh" }]);
    process.env.PATH = binDir;
    const { shell } = getShellConfig();
    expect(shell).toBe(path.join(binDir, "sh"));
  });

  it("falls back to env shell when fish is default and no sh is available", () => {
    process.env.PATH = "";
    const { shell } = getShellConfig();
    expect(shell).toBe("/usr/bin/fish");
  });

  it("uses sh when SHELL is unset", () => {
    delete process.env.SHELL;
    process.env.PATH = "";
    const { shell } = getShellConfig();
    expect(shell).toBe("sh");
  });
});

describe("resolveShellFromPath", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  const tempDirs: string[] = [];

  beforeEach(() => {
    envSnapshot = captureEnv(["PATH"]);
  });

  afterEach(() => {
    envSnapshot.restore();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when PATH is empty", () => {
    process.env.PATH = "";
    expect(resolveShellFromPath("bash")).toBeUndefined();
  });

  if (isWin) {
    return;
  }

  it("returns the first executable match from PATH", () => {
    const notExecutable = createTempCommandDir(tempDirs, [{ name: "bash", executable: false }]);
    const executable = createTempCommandDir(tempDirs, [{ name: "bash", executable: true }]);
    process.env.PATH = [notExecutable, executable].join(path.delimiter);
    expect(resolveShellFromPath("bash")).toBe(path.join(executable, "bash"));
  });

  it("returns undefined when command does not exist", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shell-empty-"));
    tempDirs.push(dir);
    process.env.PATH = dir;
    expect(resolveShellFromPath("bash")).toBeUndefined();
  });
});

// Yuiclaw 补丁（Windows 兼容性修复 Fix A 之一）：resolveShellFromPath 曾经的裸名
// 不补扩展名 bug 的回归测试。用 Object.defineProperty 直接 stub process.platform，
// 而不依赖"当前跑测试的真实机器是不是 Windows"——这样无论 CI 跑在
// blacksmith-32vcpu-windows-2025 还是 ubuntu/macos 的 runner 上，这几条 win32 分支
// 的断言都能确定性地跑到（vendor CI 矩阵里 win32/非 win32 runner 都有，见
// .github/workflows/ci.yml 的 checks-windows / checks 两个 job）。
describe("resolveShellFromPath — PATHEXT 兼容性（Windows Fix A，与真实主机 OS 无关）", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  const tempDirs: string[] = [];
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  beforeEach(() => {
    envSnapshot = captureEnv(["PATH", "PATHEXT"]);
  });

  afterEach(() => {
    envSnapshot.restore();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("win32：裸名搜索能命中带 .exe 扩展名的可执行文件（真实 bug 的回归护栏）", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pwsh-pathext-"));
    tempDirs.push(binDir);
    const pwshExePath = path.join(binDir, "pwsh.exe");
    fs.writeFileSync(pwshExePath, "");
    fs.chmodSync(pwshExePath, 0o755);

    process.env.PATH = binDir;
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";

    // 改动前：resolveShellFromPath("pwsh") 只会尝试拼出裸文件名 "pwsh"（不存在），
    // 永远找不到 "pwsh.exe"。这条断言就是复现并锁死这个真实 bug 的修复。
    // 用大小写不敏感比较——PATHEXT 默认值是大写 ".EXE"，拼出的候选串是
    // "pwsh.EXE"；NTFS 对路径大小写不敏感（只保留大小写、不区分），
    // fs.accessSync 能命中磁盘上真实的 "pwsh.exe"，但函数返回的是我们拼出来的
    // 候选串本身（"pwsh.EXE"），不是磁盘上的原始大小写。这不影响功能正确性——
    // 后续拿这个路径去 spawn 子进程，Windows 对可执行文件路径大小写同样不敏感。
    expect(resolveShellFromPath("pwsh")?.toLowerCase()).toBe(pwshExePath.toLowerCase());
  });

  it("win32：PATHEXT 未覆盖到的场景仍保留裸名兜底", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pwsh-bareext-"));
    tempDirs.push(binDir);
    // 只放一个没有扩展名的可执行文件（模拟 PATH 目录里就是放了裸文件名 shim 的场景）。
    const bareShimPath = path.join(binDir, "pwsh");
    fs.writeFileSync(bareShimPath, "");
    fs.chmodSync(bareShimPath, 0o755);

    process.env.PATH = binDir;
    // 故意只配一个跟目标文件无关的扩展名，确保"命中"来自兜底的裸名尝试，
    // 而不是巧合命中了某个 PATHEXT 变体。
    process.env.PATHEXT = ".XYZ";

    expect(resolveShellFromPath("pwsh")).toBe(bareShimPath);
  });

  it("非 win32：即使设置了 PATHEXT，也不补扩展名（跨平台行为必须逐字不变）", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pwsh-posix-"));
    tempDirs.push(binDir);
    // 只放 pwsh.exe（Windows 味的文件名），POSIX 分支不应该因为设置了 PATHEXT
    // 就去尝试 "pwsh.exe" 这个候选——这是改动前后必须完全一致的行为（R4.4 同款约束）。
    const pwshExePath = path.join(binDir, "pwsh.exe");
    fs.writeFileSync(pwshExePath, "");
    fs.chmodSync(pwshExePath, 0o755);

    process.env.PATH = binDir;
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";

    expect(resolveShellFromPath("pwsh")).toBeUndefined();
  });
});

describe("resolvePowerShellPath", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  const tempDirs: string[] = [];
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  beforeEach(() => {
    envSnapshot = captureEnv([
      "ProgramFiles",
      "PROGRAMFILES",
      "ProgramW6432",
      "SystemRoot",
      "WINDIR",
      "PATH",
      "YUICLAW_BUNDLED_PWSH_PATH",
      "LOCALAPPDATA",
    ]);
  });

  afterEach(() => {
    envSnapshot.restore();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers PowerShell 7 in ProgramFiles", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pfiles-"));
    tempDirs.push(base);
    const pwsh7Dir = path.join(base, "PowerShell", "7");
    fs.mkdirSync(pwsh7Dir, { recursive: true });
    const pwsh7Path = path.join(pwsh7Dir, "pwsh.exe");
    fs.writeFileSync(pwsh7Path, "");

    process.env.ProgramFiles = base;
    process.env.PATH = "";
    delete process.env.ProgramW6432;
    delete process.env.SystemRoot;
    delete process.env.WINDIR;

    expect(resolvePowerShellPath()).toBe(pwsh7Path);
  });

  it("prefers ProgramW6432 PowerShell 7 when ProgramFiles lacks pwsh", () => {
    const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pfiles-"));
    const programW6432 = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pw6432-"));
    tempDirs.push(programFiles, programW6432);
    const pwsh7Dir = path.join(programW6432, "PowerShell", "7");
    fs.mkdirSync(pwsh7Dir, { recursive: true });
    const pwsh7Path = path.join(pwsh7Dir, "pwsh.exe");
    fs.writeFileSync(pwsh7Path, "");

    process.env.ProgramFiles = programFiles;
    process.env.ProgramW6432 = programW6432;
    process.env.PATH = "";
    delete process.env.SystemRoot;
    delete process.env.WINDIR;

    expect(resolvePowerShellPath()).toBe(pwsh7Path);
  });

  it("finds pwsh on PATH when not in standard install locations", () => {
    const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pfiles-"));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bin-"));
    tempDirs.push(programFiles, binDir);
    const pwshPath = path.join(binDir, "pwsh");
    fs.writeFileSync(pwshPath, "");
    fs.chmodSync(pwshPath, 0o755);

    process.env.ProgramFiles = programFiles;
    process.env.PATH = binDir;
    delete process.env.ProgramW6432;
    delete process.env.SystemRoot;
    delete process.env.WINDIR;

    expect(resolvePowerShellPath()).toBe(pwshPath);
  });

  it("falls back to Windows PowerShell 5.1 path when pwsh is unavailable", () => {
    const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pfiles-"));
    const sysRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sysroot-"));
    tempDirs.push(programFiles, sysRoot);
    const ps51Dir = path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0");
    fs.mkdirSync(ps51Dir, { recursive: true });
    const ps51Path = path.join(ps51Dir, "powershell.exe");
    fs.writeFileSync(ps51Path, "");

    process.env.ProgramFiles = programFiles;
    process.env.SystemRoot = sysRoot;
    process.env.PATH = "";
    delete process.env.ProgramW6432;
    delete process.env.WINDIR;

    expect(resolvePowerShellPath()).toBe(ps51Path);
  });

  // Yuiclaw PR-B（R5/组件7）：YUICLAW_BUNDLED_PWSH_PATH 候选必须排在所有分支最前面，
  // 且必须优先于系统里已装的 pwsh7——理由：bundle 版本是 Yuiclaw 自己校验过、保证存在的
  // 基线，而用户系统里"恰好装了"的 pwsh7 版本不可控（未测试过 / 可能被用户误删或损坏）。
  it("YUICLAW_BUNDLED_PWSH_PATH 指向存在的文件时优先于系统 PowerShell 7", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-pwsh-"));
    const pwsh7Dir = path.join(base, "PowerShell", "7");
    fs.mkdirSync(pwsh7Dir, { recursive: true });
    const systemPwsh7Path = path.join(pwsh7Dir, "pwsh.exe");
    fs.writeFileSync(systemPwsh7Path, "");

    const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-pwsh-bin-"));
    const bundledPwshPath = path.join(bundledDir, "pwsh.exe");
    fs.writeFileSync(bundledPwshPath, "");
    tempDirs.push(base, bundledDir);

    // 即便系统 ProgramFiles 下也确实装了 pwsh7（会被后续分支命中），
    // bundled 候选仍应该胜出——它排在函数最前面直接 return。
    process.env.ProgramFiles = base;
    process.env.PATH = "";
    process.env.YUICLAW_BUNDLED_PWSH_PATH = bundledPwshPath;
    delete process.env.ProgramW6432;
    delete process.env.SystemRoot;
    delete process.env.WINDIR;

    expect(resolvePowerShellPath()).toBe(bundledPwshPath);
  });

  it("YUICLAW_BUNDLED_PWSH_PATH 指向不存在的文件时落回原有逻辑（bundle 缺失/裁剪的降级，R5.4/O1）", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-pwsh-missing-"));
    const pwsh7Dir = path.join(base, "PowerShell", "7");
    fs.mkdirSync(pwsh7Dir, { recursive: true });
    const systemPwsh7Path = path.join(pwsh7Dir, "pwsh.exe");
    fs.writeFileSync(systemPwsh7Path, "");
    tempDirs.push(base);

    process.env.ProgramFiles = base;
    process.env.PATH = "";
    // 指向一个确实不存在的路径——模拟安装包裁剪/解压失败导致 bundle 缺失的场景。
    process.env.YUICLAW_BUNDLED_PWSH_PATH = path.join(base, "does-not-exist", "pwsh.exe");
    delete process.env.ProgramW6432;
    delete process.env.SystemRoot;
    delete process.env.WINDIR;

    expect(resolvePowerShellPath()).toBe(systemPwsh7Path);
  });

  it("未设置 YUICLAW_BUNDLED_PWSH_PATH 时行为与改动前完全一致", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-pwsh-unset-"));
    const pwsh7Dir = path.join(base, "PowerShell", "7");
    fs.mkdirSync(pwsh7Dir, { recursive: true });
    const systemPwsh7Path = path.join(pwsh7Dir, "pwsh.exe");
    fs.writeFileSync(systemPwsh7Path, "");
    tempDirs.push(base);

    process.env.ProgramFiles = base;
    process.env.PATH = "";
    delete process.env.YUICLAW_BUNDLED_PWSH_PATH;
    delete process.env.ProgramW6432;
    delete process.env.SystemRoot;
    delete process.env.WINDIR;

    expect(resolvePowerShellPath()).toBe(systemPwsh7Path);
  });

  // Yuiclaw 补丁（Windows 兼容性修复 Fix A 之二）：Microsoft Store / winget 版 pwsh7
  // 装在 %LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe，不在 Program Files 下。
  // 实测环境：Windows 10、中文（chcp=936）、Store 版 pwsh 7.6.3，此路径命中。
  it("LOCALAPPDATA 下的 Store/winget 版 pwsh 优先于 PATH 搜索命中", () => {
    const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pfiles-nopw-"));
    const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-localappdata-"));
    const decoyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pwsh-decoy-"));
    tempDirs.push(programFiles, localAppData, decoyBinDir);

    const storeAppsDir = path.join(localAppData, "Microsoft", "WindowsApps");
    fs.mkdirSync(storeAppsDir, { recursive: true });
    const storePwshPath = path.join(storeAppsDir, "pwsh.exe");
    fs.writeFileSync(storePwshPath, "");

    // PATH 上也放一个"看起来能被搜到"的诱饵 pwsh.exe——用来证明 LOCALAPPDATA
    // 候选确实排在 PATH 搜索（④）之前生效，而不是巧合命中同一个文件。
    const decoyPwshPath = path.join(decoyBinDir, "pwsh.exe");
    fs.writeFileSync(decoyPwshPath, "");
    fs.chmodSync(decoyPwshPath, 0o755);

    process.env.ProgramFiles = programFiles; // 不含 PowerShell/7，跳过②③分支
    process.env.PATH = decoyBinDir;
    process.env.LOCALAPPDATA = localAppData;
    delete process.env.YUICLAW_BUNDLED_PWSH_PATH;
    delete process.env.ProgramW6432;
    delete process.env.SystemRoot;
    delete process.env.WINDIR;

    expect(resolvePowerShellPath()).toBe(storePwshPath);
  });

  it("LOCALAPPDATA 未设置 / 指向的文件不存在时落回 PATH 搜索（降级不崩溃）", () => {
    // 这条断言要走到 resolveShellFromPath("pwsh") 的 PATHEXT 分支（用 "pwsh.exe"
    // 文件名验证 LOCALAPPDATA 缺失时端到端仍能落到修复后的 PATH 搜索），
    // 显式 stub 成 win32 以保证在任何 CI 主机（ubuntu/mac/windows）上都确定性通过
    // ——理由同上面 "resolveShellFromPath — PATHEXT 兼容性" describe 块的注释。
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pfiles-nopw2-"));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pwsh-onpath-"));
    tempDirs.push(programFiles, binDir);
    const pwshOnPathPath = path.join(binDir, "pwsh.exe");
    fs.writeFileSync(pwshOnPathPath, "");
    fs.chmodSync(pwshOnPathPath, 0o755);

    process.env.ProgramFiles = programFiles;
    process.env.PATH = binDir;
    delete process.env.LOCALAPPDATA;
    delete process.env.YUICLAW_BUNDLED_PWSH_PATH;
    delete process.env.ProgramW6432;
    delete process.env.SystemRoot;
    delete process.env.WINDIR;

    // 大小写不敏感比较，理由同上面 "resolveShellFromPath — PATHEXT 兼容性"
    // describe 块里 "裸名搜索能命中 .exe" 测试的注释（PATHEXT 默认大写 ".EXE"，
    // NTFS 大小写不敏感但保留大小写，不影响 Windows 上的可执行文件路径解析）。
    expect(resolvePowerShellPath().toLowerCase()).toBe(pwshOnPathPath.toLowerCase());
  });
});
