// Verifies shell selection, PATH lookup, and platform-specific shell helpers.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";

// Yuiclaw fork（回搬自 openclaw-vendor #108，族 M-②）：resolvePowerShellPath
// 落到 PS 5.1 兜底时会打日志（warn=候选存在但全部验证失败/debug=压根没找到
// 候选），用 vi.hoisted + vi.mock("../logging/subsystem.js") 捕获调用（同款
// 约定见 src/infra/restart-stale-pids.test.ts）——只在这个文件里 mock，不影响
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
  buildShellCommandInvocation,
  createStreamingBinaryOutputSanitizer,
  detectRuntimeShell,
  getBashShellConfig,
  getBashShellEnv,
  getShellConfig,
  resetPowerShellPathCacheForTests,
  resolveAllShellMatchesFromPath,
  resolvePowerShellPath,
  sanitizeBinaryOutput,
} from "./shell-utils.js";

const isWin = process.platform === "win32";

// 恒真的 verify()：下面 "getShellConfig on Windows" 描述块里绝大多数测试关心的
// 是"哪个候选赢了"（existsSync/accessSync 优先级逻辑），不是"verify 探针本身"
// （那部分在 describe("resolvePowerShellPath — verify-then-fallback") 里单独
// 测）。真实的 verifyPwshExecutable 会对这里创建的 0 字节占位文件真的 spawn
// 一次——那必然失败（不是合法可执行文件，包括在真实 Windows CI 主机上），会让
// 这些"优先级"测试全部落到 PS 5.1，测不出想验证的行为。所以显式注入一个恒真
// 的 verify，跳过真实 spawn。
const alwaysVerify = () => true;

describe("sanitizeBinaryOutput", () => {
  it("removes ANSI wrappers while retaining printable output", () => {
    expect(sanitizeBinaryOutput("\u001b[31mred\u001b[0m")).toBe("red");
    expect(sanitizeBinaryOutput("\u009b31mred\u009b0m")).toBe("red");
  });

  it("preserves unterminated OSC and pending CSI text at chunk boundaries", () => {
    expect(sanitizeBinaryOutput("\u001b]unterminated")).toBe("\\x1b]unterminated");
    expect(sanitizeBinaryOutput("before\u009b31;")).toBe("before\\x9b31;");
    expect(sanitizeBinaryOutput("\u001b[") + sanitizeBinaryOutput("Ksecret")).toBe("\\x1b[Ksecret");
  });

  it("applies caller control policy while CSI remains active", () => {
    // SOH executes independently, then "d" terminates CSI as its final byte.
    expect(sanitizeBinaryOutput("\u009b\u0001done")).toBe("\\x01one");
    expect(sanitizeBinaryOutput("\u009b31\u0018done")).toBe("done");
    expect(sanitizeBinaryOutput("\u001b[31\u001adone")).toBe("done");
  });

  it("escapes residual C0, DEL, and C1 controls", () => {
    expect(sanitizeBinaryOutput("a\u0000\u0007\u007f\u0080b\t\n")).toBe(
      "a\\x00\\x07\\x7f\\x80b\t\n",
    );
  });
});

describe("createStreamingBinaryOutputSanitizer", () => {
  it("carries ANSI state across process-output chunks", () => {
    const sanitize = createStreamingBinaryOutputSanitizer();

    expect(sanitize("A\u001b]0;title")).toBe("A");
    expect(sanitize("\u0007B\u001b[31")).toBe("B");
    expect(sanitize("mC")).toBe("C");
  });
});

function createTempCommandDir(
  tempDirs: string[],
  files: Array<{ name: string; executable?: boolean }>,
): string {
  // Temporary PATH entries model available shell binaries and permissions.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shell-"));
  tempDirs.push(dir);
  for (const file of files) {
    const filePath = path.join(dir, file.name);
    fs.writeFileSync(filePath, "");
    fs.chmodSync(filePath, file.executable === false ? 0o644 : 0o755);
  }
  return dir;
}

type ShellConfig = ReturnType<typeof getBashShellConfig>;

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
      const { shell, args } = getShellConfig();
      const normalized = shell.toLowerCase();
      if (normalized.includes("powershell")) {
        expect(normalized).toContain("powershell");
      } else {
        expect(normalized).toContain("pwsh");
      }
      expect(args).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    });
    return;
  }

  it("prefers bash when fish is default and bash is on PATH", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "bash" }]);
    process.env.PATH = binDir;
    const { shell, args } = getShellConfig();
    expect(shell).toBe(path.join(binDir, "bash"));
    expect(args).toEqual(["--noprofile", "--norc", "-c"]);
  });

  it("falls back to sh when fish is default and bash is missing", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "sh" }]);
    process.env.PATH = binDir;
    const { shell, args } = getShellConfig();
    expect(shell).toBe(path.join(binDir, "sh"));
    expect(args).toEqual(["-c"]);
  });

  it("falls back to env shell when fish is default and no sh is available", () => {
    process.env.PATH = "";
    const { shell, args } = getShellConfig();
    expect(shell).toBe("/usr/bin/fish");
    expect(args).toEqual(["--no-config", "-c"]);
  });

  it("uses startup-suppressed args for zsh env shells", () => {
    process.env.SHELL = "/bin/zsh";
    process.env.PATH = "";
    const { shell, args } = getShellConfig();
    expect(shell).toBe("/bin/zsh");
    expect(args).toEqual(["-f", "-c"]);
  });

  it("uses startup-suppressed args for bash env shells", () => {
    process.env.SHELL = "/bin/bash";
    process.env.PATH = "";
    const { shell, args } = getShellConfig();
    expect(shell).toBe("/bin/bash");
    expect(args).toEqual(["--noprofile", "--norc", "-c"]);
  });

  it("uses sh when SHELL is unset", () => {
    delete process.env.SHELL;
    process.env.PATH = "";
    const { shell, args } = getShellConfig();
    expect(shell).toBe("sh");
    expect(args).toEqual(["-c"]);
  });

  it("uses an explicit custom shell path through the same resolver", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "zsh" }]);
    const shellPath = path.join(binDir, "zsh");

    expect(getShellConfig(shellPath)).toEqual({
      shell: shellPath,
      args: ["-f", "-c"],
      commandTransport: "argv",
    });
  });

  it("rejects a missing explicit custom shell path", () => {
    expect(() => getShellConfig(path.join(os.tmpdir(), "missing-openclaw-shell"))).toThrow(
      "Custom shell path not found",
    );
  });

  it("falls back to sh on PATH when SHELL is /usr/bin/false", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "sh" }]);
    process.env.SHELL = "/usr/bin/false";
    process.env.PATH = binDir;
    const { shell, args } = getShellConfig();
    expect(shell).toBe(path.join(binDir, "sh"));
    expect(args).toEqual(["-c"]);
  });

  it("falls back to sh on PATH when SHELL is /sbin/nologin", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "sh" }]);
    process.env.SHELL = "/sbin/nologin";
    process.env.PATH = binDir;
    const { shell, args } = getShellConfig();
    expect(shell).toBe(path.join(binDir, "sh"));
    expect(args).toEqual(["-c"]);
  });

  it("falls back to startup-suppressed bash on PATH when SHELL is a placeholder", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "bash" }]);
    process.env.SHELL = "/usr/bin/false";
    process.env.PATH = binDir;
    const { shell, args } = getShellConfig();
    expect(shell).toBe(path.join(binDir, "bash"));
    expect(args).toEqual(["--noprofile", "--norc", "-c"]);
  });

  it("falls back to bare sh when SHELL is a placeholder and no sh is on PATH", () => {
    process.env.SHELL = "/usr/bin/false";
    process.env.PATH = "";
    const { shell, args } = getShellConfig();
    expect(shell).toBe("sh");
    expect(args).toEqual(["-c"]);
  });
});

describe("getBashShellConfig", () => {
  const tempDirs: string[] = [];
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["ProgramFiles", "ProgramFiles(x86)", "PATH", "Path"]);
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    envSnapshot.restore();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds Git Bash under ProgramFiles", () => {
    const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-git-bash-"));
    tempDirs.push(programFiles);
    const bashDir = path.join(programFiles, "Git", "bin");
    fs.mkdirSync(bashDir, { recursive: true });
    const bashPath = path.join(bashDir, "bash.exe");
    fs.writeFileSync(bashPath, "");

    process.env.ProgramFiles = programFiles;
    process.env.PATH = "";

    expect(getBashShellConfig()).toEqual({
      shell: bashPath,
      args: ["-c"],
      commandTransport: "argv",
    });
  });

  it("prepends coreutils for a standard Git for Windows install", () => {
    const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-git-bash-env-"));
    tempDirs.push(programFiles);
    const gitRoot = path.join(programFiles, "Git");
    const bashPath = path.join(gitRoot, "bin", "bash.exe");
    const usrBin = path.join(gitRoot, "usr", "bin");
    fs.mkdirSync(path.dirname(bashPath), { recursive: true });
    fs.mkdirSync(path.join(gitRoot, "cmd"), { recursive: true });
    fs.mkdirSync(usrBin, { recursive: true });
    fs.writeFileSync(bashPath, "");
    fs.writeFileSync(path.join(gitRoot, "cmd", "git.exe"), "");
    process.env.PATH = path.join(programFiles, "OtherBin");

    const env = getBashShellEnv(bashPath);

    expect(env.PATH?.split(path.delimiter)[0]).toBe(usrBin);
    expect(env.PATH).toContain(process.env.PATH);
    expect(Object.keys(env).filter((key) => key.toLowerCase() === "path")).toEqual(["PATH"]);
  });

  it("recognizes portable Git for Windows installs", () => {
    const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-portable-git-"));
    tempDirs.push(gitRoot);
    const bashPath = path.join(gitRoot, "usr", "bin", "bash.exe");
    const usrBin = path.dirname(bashPath);
    fs.mkdirSync(usrBin, { recursive: true });
    fs.mkdirSync(path.join(gitRoot, "cmd"), { recursive: true });
    fs.writeFileSync(bashPath, "");
    fs.writeFileSync(path.join(gitRoot, "cmd", "git.exe"), "");

    expect(getBashShellEnv(bashPath).PATH?.split(path.delimiter)[0]).toBe(usrBin);
  });

  it("leaves unrelated MSYS2 installs unchanged", () => {
    const msysRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-msys2-"));
    tempDirs.push(msysRoot);
    const bashPath = path.join(msysRoot, "usr", "bin", "bash.exe");
    fs.mkdirSync(path.dirname(bashPath), { recursive: true });
    fs.writeFileSync(bashPath, "");
    process.env.PATH = path.join(msysRoot, "ucrt64", "bin");

    const env = getBashShellEnv(bashPath);

    expect(env.PATH?.split(path.delimiter)[0]).not.toBe(path.dirname(bashPath));
    expect(env.PATH).toContain(process.env.PATH);
  });

  it.each(["System32", "Sysnative"])(
    "uses stdin transport for the legacy %s WSL launcher",
    (systemDirectory) => {
      const shellPath = `C:\\Windows\\${systemDirectory}\\bash.exe`;
      vi.spyOn(fs, "existsSync").mockImplementation((candidate) => String(candidate) === shellPath);

      expect(getBashShellConfig(shellPath)).toEqual({
        shell: shellPath,
        args: ["-s"],
        commandTransport: "stdin",
      });
    },
  );

  it("builds a stdin invocation for the legacy WSL launcher", () => {
    const config: ShellConfig = {
      shell: "C:\\Windows\\System32\\bash.exe",
      args: ["-s"],
      commandTransport: "stdin",
    };

    expect(buildShellCommandInvocation("printf ready", config)).toEqual({
      argv: [config.shell, "-s"],
      input: "printf ready",
      stdin: "pipe",
    });
  });

  it("builds an argv invocation for regular shells", () => {
    const config: ShellConfig = {
      shell: "/bin/bash",
      args: ["-c"],
      commandTransport: "argv",
    };

    expect(buildShellCommandInvocation("printf ready", config)).toEqual({
      argv: [config.shell, "-c", "printf ready"],
      stdin: "ignore",
    });
  });
});

describe("getBashShellEnv", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["PATH", "Path"]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    envSnapshot.restore();
  });

  it("returns an env object with the OpenClaw bin dir on PATH", () => {
    process.env.PATH = "/usr/bin";
    const env = getBashShellEnv();

    expect(env.PATH).toContain("/usr/bin");
    expect(env.PATH).toContain(".openclaw");
  });

  it("collapses case-insensitive PATH duplicates before Windows spawn", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    const env = getBashShellEnv(undefined, { PATH: "/selected", Path: "/discarded" });

    expect(Object.keys(env).filter((key) => key.toLowerCase() === "path")).toEqual(["PATH"]);
    expect(env.PATH).toContain("/selected");
    expect(env.PATH).not.toContain("/discarded");
  });

  it.runIf(isWin)("passes one canonical PATH entry to a child process", () => {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify(Object.keys(process.env).filter((key) => key.toLowerCase() === 'path')))",
      ],
      { encoding: "utf8", env: getBashShellEnv() },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["PATH"]);
  });
});

describe("detectRuntimeShell", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "OPENCLAW_SHELL",
      "SHELL",
      "POWERSHELL_DISTRIBUTION_CHANNEL",
      "BASH_VERSION",
      "ZSH_VERSION",
      "FISH_VERSION",
      "KSH_VERSION",
      "NU_VERSION",
      "NUSHELL_VERSION",
    ]);
    delete process.env.OPENCLAW_SHELL;
    delete process.env.POWERSHELL_DISTRIBUTION_CHANNEL;
    delete process.env.BASH_VERSION;
    delete process.env.ZSH_VERSION;
    delete process.env.FISH_VERSION;
    delete process.env.KSH_VERSION;
    delete process.env.NU_VERSION;
    delete process.env.NUSHELL_VERSION;
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  if (!isWin) {
    it("ignores non-interactive SHELL placeholders and falls through to runtime hints", () => {
      process.env.SHELL = "/usr/bin/false";
      process.env.BASH_VERSION = "5.2.0";

      expect(detectRuntimeShell()).toBe("bash");
    });
  }
});

describe("getShellConfig on Windows", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  const tempDirs: string[] = [];

  beforeEach(() => {
    envSnapshot = captureEnv([
      "ProgramFiles",
      "PROGRAMFILES",
      "ProgramW6432",
      "SystemRoot",
      "WINDIR",
      "PATH",
      "YUICLAW_BUNDLED_PWSH_PATH",
    ]);
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    // Yuiclaw fork（回搬自 openclaw-vendor #108，族 M-②）：resolvePowerShellPath
    // 现在有模块级缓存（见 shell-utils.ts 顶部注释），不重置的话上一条测试解析
    // 出的结果会一直沿用到后面所有测试。每条测试开始前都必须重置。
    resetPowerShellPathCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    envSnapshot.restore();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Yuiclaw fork（回搬自 openclaw-vendor #101，族 M-①）：验证 bundle 进安装包
  // 的 pwsh7 候选优先级最高，即使系统 Program Files 里也装了一份 pwsh7。
  //
  // 这里及以下大部分"哪个候选赢了"测试改用 resolvePowerShellPath({ verify:
  // alwaysVerify }) 而不是 getShellConfig().shell（回搬自 openclaw-vendor
  // #108，族 M-②，同款调整）：族 M-②给 resolvePowerShellPath 加了 verify-
  // then-fallback，创建的 0 字节占位文件在真的 spawn 时必然失败——不注入恒真
  // verify 的话，这些测试会全部落到 PS 5.1 兜底，测不出候选优先级本身。
  it("prefers YUICLAW_BUNDLED_PWSH_PATH over system PowerShell 7", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pfiles-"));
    tempDirs.push(base);
    const pwsh7Dir = path.join(base, "PowerShell", "7");
    fs.mkdirSync(pwsh7Dir, { recursive: true });
    const pwsh7Path = path.join(pwsh7Dir, "pwsh.exe");
    fs.writeFileSync(pwsh7Path, "");

    const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-pwsh-"));
    tempDirs.push(bundleDir);
    const bundledPwshPath = path.join(bundleDir, "pwsh.exe");
    fs.writeFileSync(bundledPwshPath, "");

    process.env.ProgramFiles = base;
    process.env.PATH = "";
    process.env.YUICLAW_BUNDLED_PWSH_PATH = bundledPwshPath;
    delete process.env.ProgramW6432;
    delete process.env.SystemRoot;
    delete process.env.WINDIR;

    expect(resolvePowerShellPath({ verify: alwaysVerify })).toBe(bundledPwshPath);
  });

  // 未安装（bundle 缺失/裁剪）或 env 未设置时不影响原有解析，落回系统候选。
  it("falls back to system PowerShell 7 when bundled pwsh path is missing", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pfiles-"));
    tempDirs.push(base);
    const pwsh7Dir = path.join(base, "PowerShell", "7");
    fs.mkdirSync(pwsh7Dir, { recursive: true });
    const pwsh7Path = path.join(pwsh7Dir, "pwsh.exe");
    fs.writeFileSync(pwsh7Path, "");

    process.env.ProgramFiles = base;
    process.env.PATH = "";
    process.env.YUICLAW_BUNDLED_PWSH_PATH = path.join(os.tmpdir(), "does-not-exist-pwsh.exe");
    delete process.env.ProgramW6432;
    delete process.env.SystemRoot;
    delete process.env.WINDIR;

    expect(resolvePowerShellPath({ verify: alwaysVerify })).toBe(pwsh7Path);
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

  it("finds pwsh.exe on PATH when PowerShell 7 is not in ProgramFiles", () => {
    const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pfiles-"));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bin-"));
    tempDirs.push(programFiles, binDir);
    const pwshPath = path.join(binDir, "pwsh.exe");
    fs.writeFileSync(pwshPath, "");
    fs.chmodSync(pwshPath, 0o755);

    process.env.ProgramFiles = programFiles;
    process.env.PATH = binDir;
    delete process.env.ProgramW6432;
    delete process.env.SystemRoot;
    delete process.env.WINDIR;

    expect(resolvePowerShellPath({ verify: alwaysVerify })).toBe(pwshPath);
  });

  it("prefers a native pwsh.exe over earlier bare shims, batch wrappers, and PowerShell 5.1", () => {
    const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pfiles-"));
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shim-"));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bin-"));
    const systemRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sysroot-"));
    tempDirs.push(programFiles, shimDir, binDir, systemRoot);
    const bareShimPath = path.join(shimDir, "pwsh");
    const pwshPath = path.join(binDir, "pwsh.exe");
    const batchPath = path.join(binDir, "pwsh.cmd");
    const powershellDir = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0");
    fs.mkdirSync(powershellDir, { recursive: true });
    fs.writeFileSync(bareShimPath, "");
    fs.writeFileSync(pwshPath, "");
    fs.writeFileSync(batchPath, "");
    fs.writeFileSync(path.join(powershellDir, "powershell.exe"), "");
    fs.chmodSync(bareShimPath, 0o755);
    fs.chmodSync(pwshPath, 0o755);
    fs.chmodSync(batchPath, 0o755);

    process.env.ProgramFiles = programFiles;
    process.env.SystemRoot = systemRoot;
    process.env.PATH = [shimDir, binDir].join(path.delimiter);
    delete process.env.ProgramW6432;
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

    expect(resolvePowerShellPath({ verify: alwaysVerify })).toBe(ps51Path);
  });
});

// Yuiclaw fork（回搬自 openclaw-vendor #108，族 M-②，本条是族 M 首轮"暂缓"的
// verify-then-fallback 一件，现补齐）：候选存在（fs.existsSync / accessSync 都
// 通过）但真的 spawn 起来会失败——模拟"未安装的 App Execution Alias 占位符"或
// "损坏的安装"——不应该被直接采信，必须 continue 尝试下一个候选，而不是直接
// 返回一个跑不起来的路径（那样比改动前的 PS 5.1 兜底还差）。
describe("resolvePowerShellPath — verify-then-fallback（Microsoft Store 占位别名）", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  const tempDirs: string[] = [];

  beforeEach(() => {
    envSnapshot = captureEnv([
      "ProgramFiles",
      "PROGRAMFILES",
      "ProgramW6432",
      "SystemRoot",
      "WINDIR",
      "PATH",
      "YUICLAW_BUNDLED_PWSH_PATH",
    ]);
    // 与 "getShellConfig on Windows" 描述块同款约定：显式 stub 成 win32，保证
    // resolveAllShellMatchesFromPath 的 PATHEXT 兼容分支（裸名补 .exe）在任何
    // CI 主机（ubuntu/mac/windows）上都确定性生效，不依赖"当前跑测试的真实
    // 机器是不是 Windows"。
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    resetPowerShellPathCacheForTests();
    mockShellUtilsLogWarn.mockClear();
    mockShellUtilsLogDebug.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    envSnapshot.restore();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

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

    // 只对 ProgramFiles 里那个 "stub" 路径判失败，PATH 上的候选判成功——模拟
    // "Program Files 装了个损坏/占位的 pwsh7，但 PATH 上还有个真身"。
    const verify = (candidate: string) => candidate !== stubPath;

    expect(resolvePowerShellPath({ verify })).toBe(realPath);
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

  // PATH 上可能同时存在一个占位符（比如 WindowsApps 目录里未真正安装的别名）
  // 和另一个目录里真正能跑的 pwsh（比如用户手动解压的 portable 版）。
  // resolveAllShellMatchesFromPath 返回全部候选、resolvePowerShellPath 逐个
  // verify，这条测试证明"占位符排在 PATH 更前面"时仍然能继续找到后面那个
  // 真身，而不是找到第一个就放弃。
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

    // 标准安装目录也必须隔离到受控夹具（PR #123 review）：只删 ProgramFiles 不够——
    // 解析器会回落到默认 "C:\Program Files"，真实 Windows 机器 / runner 若在那装了
    // pwsh7，下面的 verify（只拒 stubPath）会接受系统 pwsh，解析器在走到临时 PATH
    // 之前就返回，测试结果取决于机器安装状态。指向一个不含 PowerShell/7/pwsh.exe 的
    // 空临时目录，让这条测试只考察 PATH 上的两个候选。
    // 顺序有讲究：Windows 环境变量名不区分大小写，先删大写别名 PROGRAMFILES 再设
    // ProgramFiles；反过来的话，删别名会把刚设好的值一起删掉。
    const emptyProgramFiles = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-path-nopfiles-"));
    tempDirs.push(emptyProgramFiles);
    delete process.env.PROGRAMFILES;
    process.env.ProgramFiles = emptyProgramFiles;
    delete process.env.ProgramW6432;
    delete process.env.SystemRoot;
    delete process.env.WINDIR;

    // stubDir 排在 realDir 前面：resolveAllShellMatchesFromPath 会先找到 stubPath。
    process.env.PATH = [stubDir, realDir].join(path.delimiter);

    // 先用 resolveAllShellMatchesFromPath 独立确认：两个候选都被找到了、
    // 且顺序符合预期——这样下面 resolvePowerShellPath 选中 realPath 就确凿是
    // "verify 失败后 continue 到下一个"生效了，不是巧合只找到一个候选。
    expect(resolveAllShellMatchesFromPath("pwsh")).toEqual([stubPath, realPath]);

    const verifiedCandidates: string[] = [];
    const verify = (candidate: string) => {
      verifiedCandidates.push(candidate);
      return candidate !== stubPath;
    };
    expect(resolvePowerShellPath({ verify })).toBe(realPath);
    // 被验证过的只能是 PATH 上这两个候选、且按顺序：证明解析器没有碰到夹具之外的
    // 任何标准目录候选，是「stub 失败后 continue 到下一个」选中了 realPath。
    expect(verifiedCandidates).toEqual([stubPath, realPath]);
  });

  // code review Round2 Important#2 回应：全部候选失败静默落回 PS 5.1、且结果
  // 被缓存到整个进程生命周期，排查困难——用日志弥补"静默"这一点。这里验证
  // 两种场景分别打对了日志级别：真的有候选但验证失败（warn，值得关注）vs
  // 压根没找到候选（debug，机器上就是没装 pwsh7 的正常状态）。
  describe("静默退化的日志留痕", () => {
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

  // spawn 探针实测耗时约 316ms（PR #108 原始 review 实测数字），必须缓存，
  // 否则 getShellConfig() 每次 exec 调用都要白付这笔延迟。
  describe("结果缓存", () => {
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
