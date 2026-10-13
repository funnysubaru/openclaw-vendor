import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWindowsPowerShellExePath, getWindowsWmicExePath } from "./windows-install-roots.js";
import { readWindowsProcessStartTimeSync } from "./windows-process-start.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const nativeKoffiMock = vi.hoisted(() => vi.fn());

vi.mock("node:module", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:module")>();
  return {
    createRequire: (url: string | URL) => {
      const require = original.createRequire(url);
      return (id: string) => (id === "koffi" ? nativeKoffiMock() : require(id));
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: spawnSyncMock,
}));

describe("readWindowsProcessStartTimeSync", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("reads an ISO creation time through PowerShell", () => {
    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: "2026-07-13T07:20:49.1234567Z",
    } as never);

    expect(readWindowsProcessStartTimeSync(123, 1000)).toBe(Date.parse("2026-07-13T07:20:49.123Z"));
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe(getWindowsPowerShellExePath());
  });

  it("falls back to WMIC DMTF creation time output", () => {
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "" } as never).mockReturnValueOnce({
      status: 0,
      stdout: Buffer.from("CreationDate=20260713092049.123456+120\r\n"),
    } as never);

    expect(readWindowsProcessStartTimeSync(456, 1000)).toBe(Date.parse("2026-07-13T07:20:49.123Z"));
    expect(spawnSyncMock.mock.calls[1]?.[0]).toBe(getWindowsWmicExePath());
  });

  it("projects supplied native context with Windows key precedence for both queries", () => {
    const env = {
      SYSTEMROOT: "D:\\Native",
      SystemRoot: "E:\\Ignored",
      WINDIR: "F:\\Ignored",
      PATH: "native-path",
      PSModuleAnalysisCachePath: "D:\\NativeCache",
      DIAGNOSTIC_NEUTRAL_CANARY: "synthetic",
      NODE_OPTIONS: "--synthetic-injection-must-not-be-inherited",
    };
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "" }).mockReturnValueOnce({
      status: 0,
      stdout: Buffer.from("CreationDate=20260713092049.123456+120\r\n"),
    });
    expect(readWindowsProcessStartTimeSync(456, 1000, env)).toBe(
      Date.parse("2026-07-13T07:20:49.123Z"),
    );
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe(
      "D:\\Native\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(spawnSyncMock.mock.calls[1]?.[0]).toBe("D:\\Native\\System32\\wbem\\wmic.exe");
    for (const call of spawnSyncMock.mock.calls) {
      expect(call[2].env).toEqual({
        SYSTEMROOT: "D:\\Native",
        WINDIR: "F:\\Ignored",
        PATH: "native-path",
        PSModuleAnalysisCachePath: "D:\\NativeCache",
      });
      expect(call[2].timeout).toBeLessThanOrEqual(1000);
    }
    expect(env.SystemRoot).toBe("E:\\Ignored");
    expect(env.DIAGNOSTIC_NEUTRAL_CANARY).toBe("synthetic");
  });

  it("does not start WMIC once PowerShell has spent the whole budget", () => {
    vi.useFakeTimers();
    try {
      spawnSyncMock.mockImplementationOnce(() => {
        vi.advanceTimersByTime(1000);
        return { status: 1, stdout: "" };
      });

      expect(readWindowsProcessStartTimeSync(321, 1000)).toBeNull();
      // A second full-budget probe here would block a synchronous caller for
      // twice the timeout it asked for before returning this same null.
      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives WMIC only the time left on the caller's budget", () => {
    vi.useFakeTimers();
    try {
      spawnSyncMock
        .mockImplementationOnce(() => {
          vi.advanceTimersByTime(600);
          return { status: 1, stdout: "" };
        })
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from("CreationDate=20260713092049.123456+120\r\n"),
        } as never);

      expect(readWindowsProcessStartTimeSync(654, 1000)).toBe(
        Date.parse("2026-07-13T07:20:49.123Z"),
      );
      expect(spawnSyncMock.mock.calls[1]?.[2]).toMatchObject({ timeout: 400 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the default WMIC fallback after PowerShell spends five seconds", () => {
    vi.useFakeTimers();
    try {
      spawnSyncMock
        .mockImplementationOnce(() => {
          vi.advanceTimersByTime(5000);
          return { status: 1, stdout: "" };
        })
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from("CreationDate=20260713092049.123456+120\r\n"),
        } as never);

      expect(readWindowsProcessStartTimeSync(987)).toBe(Date.parse("2026-07-13T07:20:49.123Z"));
      expect(spawnSyncMock.mock.calls[0]?.[2]).toMatchObject({ timeout: 5000 });
      expect(spawnSyncMock.mock.calls[1]?.[2]).toMatchObject({ timeout: 5000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null when process creation time is unavailable", () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "" } as never)
      .mockReturnValueOnce({ status: 1, stdout: Buffer.alloc(0) } as never);

    expect(readWindowsProcessStartTimeSync(789, 1000)).toBeNull();
    expect(readWindowsProcessStartTimeSync(0, 1000)).toBeNull();
  });
});

describe("native Windows process start identity", () => {
  const openProcess = vi.fn();
  const getProcessTimes = vi.fn();
  const closeHandle = vi.fn();
  const load = vi.fn();
  const expectedTime = Date.parse("2026-07-13T07:20:49.123Z");

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("process", { ...process, platform: "win32" });
    spawnSyncMock.mockReset().mockReturnValue({ status: 0, stdout: "2026-07-13T07:20:49.123Z" });
    openProcess.mockReset().mockReturnValue(17n);
    closeHandle.mockReset().mockReturnValue(1);
    getProcessTimes.mockReset().mockImplementation((_handle: bigint, creation: Buffer) => {
      creation.writeBigUInt64LE(116444736000000000n + BigInt(expectedTime) * 10000n + 9999n);
      return 1;
    });
    load.mockReset().mockReturnValue({
      func: (signature: string) => {
        if (signature.includes("OpenProcess(")) {
          return openProcess;
        }
        if (signature.includes("GetProcessTimes(")) {
          return getProcessTimes;
        }
        if (signature.includes("CloseHandle(")) {
          return closeHandle;
        }
        throw new Error(`Unexpected native function: ${signature}`);
      },
    });
    nativeKoffiMock.mockReset().mockReturnValue({ load });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reads fresh kernel identities without shell startup and closes every query handle", async () => {
    const { readWindowsProcessStartTimeSync: read } = await import("./windows-process-start.js");
    expect(read(123)).toBe(expectedTime);
    getProcessTimes.mockImplementationOnce((_handle: bigint, creation: Buffer) => {
      creation.writeBigUInt64LE(116444736000000000n + BigInt(expectedTime + 1) * 10000n);
      return 1;
    });
    expect(read(123)).toBe(expectedTime + 1);
    getProcessTimes.mockImplementationOnce((_handle: bigint, creation: Buffer) => {
      creation.writeBigUInt64LE(116444735999999999n);
      return 1;
    });
    expect(read(123)).toBe(-1);
    expect(openProcess.mock.calls).toEqual([
      [0x1000, 0, 123],
      [0x1000, 0, 123],
      [0x1000, 0, 123],
    ]);
    expect(closeHandle.mock.calls).toEqual([[17n], [17n], [17n]]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "throws", "zero timestamp", "open denied"])(
    "falls back after a native query is %s without leaking its handle",
    async (failure) => {
      if (failure === "open denied") {
        openProcess.mockReturnValue(null);
      } else {
        getProcessTimes.mockImplementation(() => {
          if (failure === "throws") {
            throw new Error("native query failed");
          }
          return failure === "zero timestamp" ? 1 : 0;
        });
      }
      const { readWindowsProcessStartTimeSync: read } = await import("./windows-process-start.js");
      expect(read(123)).toBe(expectedTime);
      expect(closeHandle.mock.calls).toEqual(failure === "open denied" ? [] : [[17n]]);
      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps sealed helpers independent of installed native packages", async () => {
    vi.stubGlobal("SEALED_RUNTIME_BUILD", true);
    const { readWindowsProcessStartTimeSync: read } = await import("./windows-process-start.js");
    expect(read(123)).toBe(expectedTime);
    expect(nativeKoffiMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, 0x1_0000_0000, Number.MAX_SAFE_INTEGER, Number.NaN, Infinity])(
    "rejects PID %s before native DWORD conversion or a shell query",
    async (pid) => {
      const { readWindowsProcessStartTimeSync: read } = await import("./windows-process-start.js");
      expect(read(pid)).toBeNull();
      expect(nativeKoffiMock).not.toHaveBeenCalled();
      expect(spawnSyncMock).not.toHaveBeenCalled();
    },
  );

  it.each([600, 1000])(
    "charges %sms native initialization to the fallback deadline",
    async (elapsed) => {
      vi.useFakeTimers();
      nativeKoffiMock.mockImplementationOnce(() => {
        vi.advanceTimersByTime(elapsed);
        throw new Error("native loader unavailable");
      });
      const { readWindowsProcessStartTimeSync: read } = await import("./windows-process-start.js");
      expect(read(123, 1000)).toBe(elapsed === 1000 ? null : expectedTime);
      if (elapsed === 1000) {
        expect(spawnSyncMock).not.toHaveBeenCalled();
      } else {
        expect(spawnSyncMock.mock.calls[0]?.[2]).toMatchObject({ timeout: 400 });
      }
      // A failed load must not make later lock-owner identity reads permanently unavailable.
      expect(read(123, 1000)).toBe(expectedTime);
      expect(getProcessTimes).toHaveBeenCalledTimes(1);
    },
  );
});
