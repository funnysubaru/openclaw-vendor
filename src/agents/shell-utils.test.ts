import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";

// code review Round2 Important#2 回应：resolvePowerShellPath 落到 PS 5.1 兜底时
// 会打日志（warn=候选存在但全部验证失败/debug=压根没找到候选），用同款
// vi.hoisted + vi.mock("../logging/subsystem.js") 约定捕获调用（参照
// src/infra/restart-stale-pids.test.ts 的写法）——只在这个文件里 mock，不影响
// 其它测试文件；本文件里其余不关心日志的测试完全不受影响（mock 只是把真实
// I/O 换成可断言的 spy，不改变 shell-utils.ts 本身的控制流）。
const mockShellUtilsLogWarn = vi.hoisted(() => vi.fn());
const mockShellUtilsLogDebug = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    warn: (...args: unknown[]) => mockShellUtilsLogWarn(...args),
    debug: (...args: unknown[]) => mockShellUtilsLogDebug(...args),
    info: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    isEnabled: vi.fn(() => true),
    child: vi.fn(),
  })),
}));

import {
  getShellConfig,
  resetPowerShellPathCacheForTests,
  resolveAllShellMatchesFromPath,
  resolvePowerShellPath,
  resolveShellFromPath,
} from "./shell-utils.js";

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

  // code review Minor#1：process.env.PATHEXT ?? 默认值 用的是空值合并（??），
  // 只在 null/undefined 时才回退默认值，PATHEXT 显式设成空字符串这个合法但反常
  // 的环境状态不会触发回退。已改用 ||（假值兜底），这条测试锁死修复后的行为。
  it("win32：PATHEXT 显式设为空字符串时仍回退默认扩展名列表（Minor#1）", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pwsh-emptypathext-"));
    tempDirs.push(binDir);
    const pwshExePath = path.join(binDir, "pwsh.exe");
    fs.writeFileSync(pwshExePath, "");
    fs.chmodSync(pwshExePath, 0o755);

    process.env.PATH = binDir;
    process.env.PATHEXT = "";

    // 大小写不敏感比较，理由同上一条测试（PATHEXT 空字符串回退到内置默认值
    // ".COM;.EXE;.BAT;.CMD"，拼出的候选串是大写 "pwsh.EXE"）。
    expect(resolveShellFromPath("pwsh")?.toLowerCase()).toBe(pwshExePath.toLowerCase());
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
  // 恒真的 verify()：这个 describe 块里大多数测试关心的是"哪个候选赢了"（优先级
  // 逻辑），不是"verify 探针本身"（那部分在下方专门的 describe 块）。真实的
  // verifyPwshExecutable 会对这里创建的 0 字节占位文件真的 spawn 一次——那必然
  // 失败（不是合法可执行文件），会让这些"优先级"测试全部落到 PS 5.1，测不出
  // 想验证的行为。所以默认注入一个恒真的 verify。
  const alwaysVerify = () => true;

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
    // code review Important#1/#2/#3 回应：resolvePowerShellPath() 现在有模块级
    // 缓存（见 shell-utils.ts 顶部注释），不重置的话上一条测试解析出的结果会
    // 一直沿用到后面所有测试。每条测试开始前都必须重置。
    resetPowerShellPathCacheForTests();
    // code review Round2 Important#2 回应：清空日志 spy 的调用记录，避免上一条
    // 测试残留的调用次数污染这一条的断言。
    mockShellUtilsLogWarn.mockClear();
    mockShellUtilsLogDebug.mockClear();
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

    expect(resolvePowerShellPath({ verify: alwaysVerify })).toBe(pwsh7Path);
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

    expect(resolvePowerShellPath({ verify: alwaysVerify })).toBe(pwsh7Path);
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

    expect(resolvePowerShellPath({ verify: alwaysVerify })).toBe(pwshPath);
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

    expect(resolvePowerShellPath({ verify: alwaysVerify })).toBe(systemPwsh7Path);
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

    expect(resolvePowerShellPath({ verify: alwaysVerify })).toBe(systemPwsh7Path);
  });

  // Yuiclaw 补丁：Microsoft Store / winget 版 pwsh7 装在
  // %LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe，该目录本身就在系统 PATH 上。
  //
  // code review Important#1 回应：本 PR 最初版本在这里加过一条独立的
  // "LOCALAPPDATA + fs.existsSync" 特判块，实测发现它是死代码——fs.existsSync
  // 内部走 fs.statSync，而 statSync 对 App Execution Alias 目录里的条目会抛
  // EACCES，existsSync 遇任何异常都按"不存在"处理，也就是说 existsSync 在这个
  // 目录下恒为 false，即使别名已经指向一个真装好的 pwsh 也测不出来。已删除该
  // 特判块——WindowsApps 目录本就在 PATH 上，Fix A 修好 PATHEXT 后，下面靠
  // resolveAllShellMatchesFromPath + fs.accessSync(X_OK) 的 PATH 搜索分支
  // 已经能找到它（accessSync 不受这个 EACCES-on-statSync 问题影响）。
  it("WindowsApps 别名目录在 PATH 上时，PATH 搜索能找到并通过 verify 后采信", () => {
    const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pfiles-nopw-"));
    const windowsAppsDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-windowsapps-"));
    tempDirs.push(programFiles, windowsAppsDir);

    const storePwshPath = path.join(windowsAppsDir, "pwsh.exe");
    fs.writeFileSync(storePwshPath, "");
    fs.chmodSync(storePwshPath, 0o755);

    process.env.ProgramFiles = programFiles; // 不含 PowerShell/7，跳过②③分支
    process.env.PATH = windowsAppsDir;
    delete process.env.YUICLAW_BUNDLED_PWSH_PATH;
    delete process.env.ProgramW6432;
    delete process.env.SystemRoot;
    delete process.env.WINDIR;

    // 大小写不敏感比较，理由同 "resolveShellFromPath — PATHEXT 兼容性" describe
    // 块里 "裸名搜索能命中 .exe" 测试的注释（PATHEXT 默认大写 ".EXE"，NTFS 大小写
    // 不敏感但保留大小写，不影响 Windows 上的可执行文件路径解析）。
    expect(resolvePowerShellPath({ verify: alwaysVerify })?.toLowerCase()).toBe(
      storePwshPath.toLowerCase(),
    );
  });

  // code review Important#1/#2 回应：候选存在（fs.existsSync / accessSync 都通过）
  // 但真的 spawn 起来会失败——模拟"未安装的 App Execution Alias 占位符"或
  // "损坏的安装"——不应该被直接采信，必须 continue 尝试下一个候选，而不是
  // 直接返回一个跑不起来的路径（那样比改动前的 PS 5.1 兜底还差）。
  describe("verify 失败时的降级行为（Important#1/#2：占位别名不应该被直接采信）", () => {
    it("ProgramFiles 候选存在但 verify 失败时，continue 到 PATH 搜索", () => {
      const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pfiles-stub-"));
      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bin-real-"));
      tempDirs.push(programFiles, binDir);

      const pwsh7Dir = path.join(programFiles, "PowerShell", "7");
      fs.mkdirSync(pwsh7Dir, { recursive: true });
      const stubPath = path.join(pwsh7Dir, "pwsh.exe");
      fs.writeFileSync(stubPath, ""); // 存在，但下面的 verify 会判它为"跑不起来"

      const realPath = path.join(binDir, "pwsh.exe");
      fs.writeFileSync(realPath, "");
      fs.chmodSync(realPath, 0o755);

      process.env.ProgramFiles = programFiles;
      process.env.PATH = binDir;
      delete process.env.ProgramW6432;
      delete process.env.SystemRoot;
      delete process.env.WINDIR;

      // 只对 ProgramFiles 里那个"stub"路径判失败，PATH 上的候选判成功——
      // 模拟"Program Files 装了个损坏/占位的 pwsh7，但 PATH 上还有个真身"。
      // 大小写不敏感比较（PATHEXT 默认大写 ".EXE"，见上面同款注释）：PATH 分支
      // 命中的候选串带 "pwsh.EXE"，若用严格 !== 比较 stubPath（"pwsh.exe"）
      // 会永远不相等，等于两个候选都被判定"不是 stub"，测不出真正的降级行为。
      const verify = (candidate: string) => candidate.toLowerCase() !== stubPath.toLowerCase();

      expect(resolvePowerShellPath({ verify })?.toLowerCase()).toBe(realPath.toLowerCase());
    });

    it("唯一候选 verify 失败时，落回 PS 5.1（而不是直接返回一个跑不起来的路径）", () => {
      const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pfiles-onlystub-"));
      const sysRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sysroot-fallback-"));
      tempDirs.push(programFiles, sysRoot);

      const pwsh7Dir = path.join(programFiles, "PowerShell", "7");
      fs.mkdirSync(pwsh7Dir, { recursive: true });
      const stubPath = path.join(pwsh7Dir, "pwsh.exe");
      fs.writeFileSync(stubPath, "");

      const ps51Dir = path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0");
      fs.mkdirSync(ps51Dir, { recursive: true });
      const ps51Path = path.join(ps51Dir, "powershell.exe");
      fs.writeFileSync(ps51Path, "");

      process.env.ProgramFiles = programFiles;
      process.env.SystemRoot = sysRoot;
      process.env.PATH = "";
      delete process.env.ProgramW6432;
      delete process.env.WINDIR;

      // 唯一候选（ProgramFiles 的 pwsh7）判失败——改动前的行为（existsSync 命中
      // 就直接返回）会把这个跑不起来的路径当结果返回给调用方；修复后必须
      // continue 并最终落到 PS 5.1，而不是"比改动前更差"。
      expect(resolvePowerShellPath({ verify: () => false })).toBe(ps51Path);
    });

    // code review Important#4 回应：PATH 上可能同时存在一个占位符（比如
    // WindowsApps 目录里未真正安装的别名）和另一个目录里真正能跑的 pwsh
    // （比如用户手动解压的 portable 版）。resolveAllShellMatchesFromPath 返回
    // 全部候选、resolvePowerShellPath 逐个 verify，这条测试证明"占位符排在
    // PATH 更前面"时仍然能继续找到后面那个真身，而不是找到第一个就放弃。
    it("PATH 上第一个候选是占位符（verify 失败）时，会继续尝试 PATH 上的下一个候选", () => {
      const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-path-stub-"));
      const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-path-real-"));
      tempDirs.push(stubDir, realDir);

      const stubPath = path.join(stubDir, "pwsh.exe");
      fs.writeFileSync(stubPath, "");
      fs.chmodSync(stubPath, 0o755);

      const realPath = path.join(realDir, "pwsh.exe");
      fs.writeFileSync(realPath, "");
      fs.chmodSync(realPath, 0o755);

      // stubDir 排在 realDir 前面：resolveAllShellMatchesFromPath 会先找到 stubPath。
      process.env.PATH = [stubDir, realDir].join(path.delimiter);
      delete process.env.ProgramFiles;
      delete process.env.PROGRAMFILES;
      delete process.env.ProgramW6432;
      delete process.env.SystemRoot;
      delete process.env.WINDIR;

      // 先用 resolveAllShellMatchesFromPath 独立确认：两个候选都被找到了、
      // 且顺序符合预期——这样下面 resolvePowerShellPath 选中 realPath 就确凿是
      // "verify 失败后 continue 到下一个"生效了，不是巧合只找到一个候选。
      // 大小写不敏感比较（PATHEXT 默认大写 ".EXE"，见上面同款注释）。
      expect(resolveAllShellMatchesFromPath("pwsh").map((p) => p.toLowerCase())).toEqual([
        stubPath.toLowerCase(),
        realPath.toLowerCase(),
      ]);

      const verify = (candidate: string) => candidate.toLowerCase() !== stubPath.toLowerCase();
      expect(resolvePowerShellPath({ verify })?.toLowerCase()).toBe(realPath.toLowerCase());
    });
  });

  // code review Round2 Important#2 回应：全部候选失败静默落回 PS 5.1、且结果
  // 被缓存到整个进程生命周期，排查困难——用日志弥补"静默"这一点。这里验证
  // 两种场景分别打对了日志级别：真的有候选但验证失败（warn，值得关注）vs
  // 压根没找到候选（debug，机器上就是没装 pwsh7 的正常状态）。
  describe("静默退化的日志留痕（code review Round2 Important#2 回应）", () => {
    it("有候选但全部验证失败时打 warn，日志带上具体失败的候选路径", () => {
      const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-log-warn-pfiles-"));
      tempDirs.push(programFiles);
      const pwsh7Dir = path.join(programFiles, "PowerShell", "7");
      fs.mkdirSync(pwsh7Dir, { recursive: true });
      const stubPath = path.join(pwsh7Dir, "pwsh.exe");
      fs.writeFileSync(stubPath, "");

      process.env.ProgramFiles = programFiles;
      process.env.PATH = "";
      delete process.env.ProgramW6432;
      delete process.env.SystemRoot;
      delete process.env.WINDIR;

      resolvePowerShellPath({ verify: () => false });

      expect(mockShellUtilsLogWarn).toHaveBeenCalledTimes(1);
      const [, meta] = mockShellUtilsLogWarn.mock.calls[0] as [
        string,
        { failedCandidates: string[] },
      ];
      expect(meta.failedCandidates).toEqual([stubPath]);
      expect(mockShellUtilsLogDebug).not.toHaveBeenCalled();
    });

    it("压根没找到任何候选时打 debug（正常状态，不算异常），不打 warn", () => {
      const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-log-debug-pfiles-"));
      tempDirs.push(programFiles); // 故意不创建 PowerShell/7 子目录——没有任何候选可找

      process.env.ProgramFiles = programFiles;
      process.env.PATH = "";
      delete process.env.ProgramW6432;
      delete process.env.SystemRoot;
      delete process.env.WINDIR;

      resolvePowerShellPath({ verify: alwaysVerify });

      expect(mockShellUtilsLogDebug).toHaveBeenCalledTimes(1);
      expect(mockShellUtilsLogWarn).not.toHaveBeenCalled();
    });
  });

  describe("结果缓存（code review Important#1/#2/#3 回应：spawn 探针实测耗时约 316ms，必须缓存）", () => {
    it("解析结果会被缓存，同一进程内第二次调用不会重新执行 verify", () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cache-"));
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

      let verifyCallCount = 0;
      const verify = () => {
        verifyCallCount += 1;
        return true;
      };

      const first = resolvePowerShellPath({ verify });
      // 第二次调用即便传了一个不同的 verify（这里刻意传会返回 false 的版本），
      // 缓存命中也应该直接短路返回第一次的结果，根本不会再调用它。
      const second = resolvePowerShellPath({ verify: () => false });

      expect(first).toBe(pwsh7Path);
      expect(second).toBe(pwsh7Path);
      expect(verifyCallCount).toBe(1);
    });

    it("resetPowerShellPathCacheForTests 后会重新解析（供测试用，不影响生产行为）", () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cache-reset-"));
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

      let verifyCallCount = 0;
      const verify = () => {
        verifyCallCount += 1;
        return true;
      };

      resolvePowerShellPath({ verify });
      resetPowerShellPathCacheForTests();
      resolvePowerShellPath({ verify });

      expect(verifyCallCount).toBe(2);
    });
  });
});
