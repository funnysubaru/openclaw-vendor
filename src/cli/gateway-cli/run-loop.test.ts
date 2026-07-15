import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBonjourBeacon } from "../../infra/bonjour-discovery.js";
import { pickBeaconHost, pickGatewayPort } from "./discover.js";

const acquireGatewayLock = vi.fn(async (_opts?: { port?: number }) => ({
  release: vi.fn(async () => {}),
}));
const consumeGatewaySigusr1RestartAuthorization = vi.fn(() => true);
const isGatewaySigusr1RestartExternallyAllowed = vi.fn(() => false);
const markGatewaySigusr1RestartHandled = vi.fn();
const getActiveTaskCount = vi.fn(() => 0);
const markGatewayDraining = vi.fn();
const waitForActiveTasks = vi.fn(async (_timeoutMs: number) => ({ drained: true }));
const resetAllLanes = vi.fn();
const restartGatewayProcessWithFreshPid = vi.fn<
  () => { mode: "spawned" | "supervised" | "disabled" | "failed"; pid?: number; detail?: string }
>(() => ({ mode: "disabled" }));
const abortEmbeddedPiRun = vi.fn(
  (_sessionId?: string, _opts?: { mode?: "all" | "compacting" }) => false,
);
const getActiveEmbeddedRunCount = vi.fn(() => 0);
const waitForActiveEmbeddedRuns = vi.fn(async (_timeoutMs: number) => ({ drained: true }));
const DRAIN_TIMEOUT_LOG = "drain timeout reached; proceeding with restart";
const gatewayLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock("../../infra/gateway-lock.js", () => ({
  acquireGatewayLock: (opts?: { port?: number }) => acquireGatewayLock(opts),
}));

vi.mock("../../infra/restart.js", () => ({
  consumeGatewaySigusr1RestartAuthorization: () => consumeGatewaySigusr1RestartAuthorization(),
  isGatewaySigusr1RestartExternallyAllowed: () => isGatewaySigusr1RestartExternallyAllowed(),
  markGatewaySigusr1RestartHandled: () => markGatewaySigusr1RestartHandled(),
}));

vi.mock("../../infra/process-respawn.js", () => ({
  restartGatewayProcessWithFreshPid: () => restartGatewayProcessWithFreshPid(),
}));

vi.mock("../../process/command-queue.js", () => ({
  getActiveTaskCount: () => getActiveTaskCount(),
  markGatewayDraining: () => markGatewayDraining(),
  waitForActiveTasks: (timeoutMs: number) => waitForActiveTasks(timeoutMs),
  resetAllLanes: () => resetAllLanes(),
}));

vi.mock("../../agents/pi-embedded-runner/runs.js", () => ({
  abortEmbeddedPiRun: (sessionId?: string, opts?: { mode?: "all" | "compacting" }) =>
    abortEmbeddedPiRun(sessionId, opts),
  getActiveEmbeddedRunCount: () => getActiveEmbeddedRunCount(),
  waitForActiveEmbeddedRuns: (timeoutMs: number) => waitForActiveEmbeddedRuns(timeoutMs),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => gatewayLog,
}));

// Yuiclaw B组：Windows 优雅关闭通道测试用的可控 readline mock。真实
// createInterface 会挂在 process.stdin 上一直等输入，测试里换成手动可触发的假
// Interface，通过 capturedLineHandler 直接喂"行"进去，不依赖真实 stdin 流。
let capturedLineHandler: ((line: string) => void) | null = null;
const fakeRl = {
  on: vi.fn((ev: string, cb: (line: string) => void) => {
    if (ev === "line") {
      capturedLineHandler = cb;
    }
    return fakeRl;
  }),
  close: vi.fn(),
};
vi.mock("node:readline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:readline")>()),
  createInterface: vi.fn(() => fakeRl),
}));

// Yuiclaw 防篡改加固块 A 第二批：parentPort 优雅关闭接收端测试用的可控 mock。
// process.parentPort 在真实 utilityProcess 子进程里是 Electron 运行时注入的
// 全局对象，普通 Node 测试进程里天然不存在；测试通过直接给 process 挂一个假
// parentPort（postMessage / on / removeListener 全打桩）来模拟 utilityProcess
// 环境，用 capturedParentPortListener 拿到 run-loop 注册的 message 回调后手动
// 触发，不依赖真实 Electron MessagePort。
let capturedParentPortListener: ((event: { data?: unknown }) => void) | null = null;
const fakeParentPort = {
  postMessage: vi.fn(),
  on: vi.fn((ev: string, cb: (event: { data?: unknown }) => void) => {
    if (ev === "message") {
      capturedParentPortListener = cb;
    }
  }),
  removeListener: vi.fn(),
};

const LOOP_SIGNALS = ["SIGTERM", "SIGINT", "SIGUSR1"] as const;
type LoopSignal = (typeof LOOP_SIGNALS)[number];

function removeNewSignalListeners(signal: LoopSignal, existing: Set<(...args: unknown[]) => void>) {
  for (const listener of process.listeners(signal)) {
    const fn = listener as (...args: unknown[]) => void;
    if (!existing.has(fn)) {
      process.removeListener(signal, fn);
    }
  }
}

function addedSignalListener(
  signal: LoopSignal,
  existing: Set<(...args: unknown[]) => void>,
): (() => void) | null {
  const listeners = process.listeners(signal) as Array<(...args: unknown[]) => void>;
  for (let i = listeners.length - 1; i >= 0; i -= 1) {
    const listener = listeners[i];
    if (listener && !existing.has(listener)) {
      return listener as () => void;
    }
  }
  return null;
}

async function withIsolatedSignals(
  run: (helpers: { captureSignal: (signal: LoopSignal) => () => void }) => Promise<void>,
) {
  const existingListeners = Object.fromEntries(
    LOOP_SIGNALS.map((signal) => [
      signal,
      new Set(process.listeners(signal) as Array<(...args: unknown[]) => void>),
    ]),
  ) as Record<LoopSignal, Set<(...args: unknown[]) => void>>;
  const captureSignal = (signal: LoopSignal) => {
    const listener = addedSignalListener(signal, existingListeners[signal]);
    if (!listener) {
      throw new Error(`expected new ${signal} listener`);
    }
    return () => listener();
  };
  try {
    await run({ captureSignal });
  } finally {
    for (const signal of LOOP_SIGNALS) {
      removeNewSignalListeners(signal, existingListeners[signal]);
    }
  }
}

function createRuntimeWithExitSignal(exitCallOrder?: string[]) {
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      exitCallOrder?.push("exit");
      resolveExit(code);
    }),
  };
  return { runtime, exited };
}

type GatewayCloseFn = (...args: unknown[]) => Promise<void>;
type LoopRuntime = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
};

function createSignaledStart(close: GatewayCloseFn) {
  let resolveStarted: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const start = vi.fn(async () => {
    resolveStarted?.();
    return { close };
  });
  return { start, started };
}

async function runLoopWithStart(params: {
  start: ReturnType<typeof vi.fn>;
  runtime: LoopRuntime;
  lockPort?: number;
}) {
  vi.resetModules();
  const { runGatewayLoop } = await import("./run-loop.js");
  const loopPromise = runGatewayLoop({
    start: params.start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
    runtime: params.runtime,
    lockPort: params.lockPort,
  });
  return { loopPromise };
}

async function waitForStart(started: Promise<void>) {
  await started;
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function createSignaledLoopHarness(exitCallOrder?: string[]) {
  const close = vi.fn(async () => {});
  const { start, started } = createSignaledStart(close);
  const { runtime, exited } = createRuntimeWithExitSignal(exitCallOrder);
  const { loopPromise } = await runLoopWithStart({ start, runtime });
  await waitForStart(started);
  return { close, start, runtime, exited, loopPromise };
}

describe("runGatewayLoop", () => {
  it("exits 0 on SIGTERM after graceful close", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, runtime, exited } = await createSignaledLoopHarness();
      const sigterm = captureSignal("SIGTERM");

      sigterm();

      await expect(exited).resolves.toBe(0);
      expect(close).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
      expect(runtime.exit).toHaveBeenCalledWith(0);
    });
  });

  it("restarts after SIGUSR1 even when drain times out, and resets lanes for the new iteration", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      getActiveTaskCount.mockReturnValueOnce(2).mockReturnValueOnce(0);
      getActiveEmbeddedRunCount.mockReturnValueOnce(1).mockReturnValueOnce(0);
      waitForActiveTasks.mockResolvedValueOnce({ drained: false });
      waitForActiveEmbeddedRuns.mockResolvedValueOnce({ drained: true });

      type StartServer = () => Promise<{
        close: (opts: { reason: string; restartExpectedMs: number | null }) => Promise<void>;
      }>;

      const closeFirst = vi.fn(async () => {});
      const closeSecond = vi.fn(async () => {});
      const closeThird = vi.fn(async () => {});
      const { runtime, exited } = createRuntimeWithExitSignal();

      const start = vi.fn<StartServer>();
      let resolveFirst: (() => void) | null = null;
      const startedFirst = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      start.mockImplementationOnce(async () => {
        resolveFirst?.();
        return { close: closeFirst };
      });

      let resolveSecond: (() => void) | null = null;
      const startedSecond = new Promise<void>((resolve) => {
        resolveSecond = resolve;
      });
      start.mockImplementationOnce(async () => {
        resolveSecond?.();
        return { close: closeSecond };
      });

      let resolveThird: (() => void) | null = null;
      const startedThird = new Promise<void>((resolve) => {
        resolveThird = resolve;
      });
      start.mockImplementationOnce(async () => {
        resolveThird?.();
        return { close: closeThird };
      });

      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });

      await startedFirst;
      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");
      expect(start).toHaveBeenCalledTimes(1);
      await new Promise<void>((resolve) => setImmediate(resolve));

      sigusr1();

      await startedSecond;
      expect(start).toHaveBeenCalledTimes(2);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(abortEmbeddedPiRun).toHaveBeenCalledWith(undefined, { mode: "compacting" });
      expect(waitForActiveTasks).toHaveBeenCalledWith(90_000);
      expect(waitForActiveEmbeddedRuns).toHaveBeenCalledWith(90_000);
      expect(abortEmbeddedPiRun).toHaveBeenCalledWith(undefined, { mode: "all" });
      expect(markGatewayDraining).toHaveBeenCalledTimes(1);
      expect(gatewayLog.warn).toHaveBeenCalledWith(DRAIN_TIMEOUT_LOG);
      expect(closeFirst).toHaveBeenCalledWith({
        reason: "gateway restarting",
        restartExpectedMs: 1500,
      });
      expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(1);
      expect(resetAllLanes).toHaveBeenCalledTimes(1);

      sigusr1();

      await startedThird;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closeSecond).toHaveBeenCalledWith({
        reason: "gateway restarting",
        restartExpectedMs: 1500,
      });
      expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(2);
      expect(markGatewayDraining).toHaveBeenCalledTimes(2);
      expect(resetAllLanes).toHaveBeenCalledTimes(2);
      expect(acquireGatewayLock).toHaveBeenCalledTimes(3);

      sigterm();
      await expect(exited).resolves.toBe(0);
      expect(closeThird).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
    });
  });

  it("releases the lock before exiting on spawned restart", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const lockRelease = vi.fn(async () => {});
      acquireGatewayLock.mockResolvedValueOnce({
        release: lockRelease,
      });

      // Override process-respawn to return "spawned" mode
      restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "spawned",
        pid: 9999,
      });

      const exitCallOrder: string[] = [];
      const { runtime, exited } = await createSignaledLoopHarness(exitCallOrder);
      const sigusr1 = captureSignal("SIGUSR1");
      lockRelease.mockImplementation(async () => {
        exitCallOrder.push("lockRelease");
      });

      sigusr1();

      await exited;
      expect(lockRelease).toHaveBeenCalled();
      expect(runtime.exit).toHaveBeenCalledWith(0);
      expect(exitCallOrder).toEqual(["lockRelease", "exit"]);
    });
  });

  it("forwards lockPort to initial and restart lock acquisitions", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const closeFirst = vi.fn(async () => {});
      const closeSecond = vi.fn(async () => {});
      const closeThird = vi.fn(async () => {});
      const { runtime, exited } = createRuntimeWithExitSignal();

      const start = vi
        .fn()
        .mockResolvedValueOnce({ close: closeFirst })
        .mockResolvedValueOnce({ close: closeSecond })
        .mockResolvedValueOnce({ close: closeThird });
      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
        lockPort: 18789,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const sigusr1 = captureSignal("SIGUSR1");
      const sigterm = captureSignal("SIGTERM");

      sigusr1();
      await new Promise<void>((resolve) => setImmediate(resolve));
      sigusr1();

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(acquireGatewayLock).toHaveBeenNthCalledWith(1, { port: 18789 });
      expect(acquireGatewayLock).toHaveBeenNthCalledWith(2, { port: 18789 });
      expect(acquireGatewayLock).toHaveBeenNthCalledWith(3, { port: 18789 });

      sigterm();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("exits when lock reacquire fails during in-process restart fallback", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const lockRelease = vi.fn(async () => {});
      acquireGatewayLock
        .mockResolvedValueOnce({
          release: lockRelease,
        })
        .mockRejectedValueOnce(new Error("lock timeout"));

      restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "disabled",
      });

      const { start, exited } = await createSignaledLoopHarness();
      const sigusr1 = captureSignal("SIGUSR1");
      sigusr1();

      await expect(exited).resolves.toBe(1);
      expect(acquireGatewayLock).toHaveBeenCalledTimes(2);
      expect(start).toHaveBeenCalledTimes(1);
      expect(gatewayLog.error).toHaveBeenCalledWith(
        expect.stringContaining("failed to reacquire gateway lock for in-process restart"),
      );
    });
  });

  // Yuiclaw B组：Windows 上父进程管不了子进程的 POSIX 信号，改用 stdin 暗号
  // 触发同一条 request("stop") 优雅关闭路径。下面四个用例覆盖：①暗号生效
  // ②非暗号行不触发 ③env 未开启时压根不装 readline ④env 非严格 "1" 值同样不装
  // readline（对上游/其它运行方式零影响）。
  it("shuts down on stdin sentinel when OPENCLAW_STDIN_CONTROL=1", async () => {
    vi.clearAllMocks();
    process.env.OPENCLAW_STDIN_CONTROL = "1";
    capturedLineHandler = null;
    try {
      await withIsolatedSignals(async () => {
        const { close, runtime, exited } = await createSignaledLoopHarness();
        expect(capturedLineHandler).toBeTypeOf("function");
        capturedLineHandler!("__openclaw_stdin_shutdown__");
        await expect(exited).resolves.toBe(0);
        expect(close).toHaveBeenCalledWith({
          reason: "gateway stopping",
          restartExpectedMs: null,
        });
        expect(runtime.exit).toHaveBeenCalledWith(0);
        // cleanupSignals 应把 stdin readline 一并拆掉，避免退出后悬挂监听。
        expect(fakeRl.close).toHaveBeenCalled();
      });
    } finally {
      delete process.env.OPENCLAW_STDIN_CONTROL;
    }
  });

  it("ignores non-sentinel stdin lines", async () => {
    vi.clearAllMocks();
    process.env.OPENCLAW_STDIN_CONTROL = "1";
    capturedLineHandler = null;
    try {
      await withIsolatedSignals(async () => {
        const { close } = await createSignaledLoopHarness();
        capturedLineHandler!("hello");
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(close).not.toHaveBeenCalled();
      });
    } finally {
      delete process.env.OPENCLAW_STDIN_CONTROL;
    }
  });

  it("does not install stdin control when env unset", async () => {
    vi.clearAllMocks();
    delete process.env.OPENCLAW_STDIN_CONTROL;
    const readline = await import("node:readline");
    await withIsolatedSignals(async () => {
      await createSignaledLoopHarness();
      expect(readline.createInterface).not.toHaveBeenCalled();
    });
  });

  it("does not install stdin control for non-'1' env value", async () => {
    vi.clearAllMocks();
    // 严格 === "1" 判定：不能把任何 truthy 字符串（如 "0" / "true"）都当开启，
    // 防止环境变量误传非 "1" 值时意外装上 stdin 控制通道。
    process.env.OPENCLAW_STDIN_CONTROL = "0";
    const readline = await import("node:readline");
    try {
      await withIsolatedSignals(async () => {
        await createSignaledLoopHarness();
        expect(readline.createInterface).not.toHaveBeenCalled();
      });
    } finally {
      delete process.env.OPENCLAW_STDIN_CONTROL;
    }
  });

  // Yuiclaw 防篡改加固块 A 第二批（gateway-utilityprocess-migration 任务 6）：
  // parentPort 优雅关闭接收端测试。utilityProcess.fork() 派生的子进程 stdin
  // 恒为 ignore，上面的 stdin 通道够不着，这里换 MessagePort 语义的 parentPort
  // 通道。覆盖：①双守卫都满足才装监听 ②缺 env 不装 ③缺 parentPort 不装
  // ④装监听后主动发就绪握手（type+protocolVersion）⑤收到暗号复用 request("stop")
  // 完整优雅路径 ⑥double-stop 幂等（shuttingDown 闸门挡住第二次）⑦cleanup 摘监听。
  describe("parentPort graceful shutdown channel", () => {
    afterEach(() => {
      // 每个用例后都摘掉假 parentPort，避免污染后续用例（尤其是"缺 parentPort
      // 不装"这类依赖 process.parentPort 为 undefined 的用例）。
      delete (process as { parentPort?: unknown }).parentPort;
      capturedParentPortListener = null;
    });

    it("installs listener and sends ready handshake when both guards satisfied", async () => {
      vi.clearAllMocks();
      process.env.OPENCLAW_PARENTPORT_CONTROL = "1";
      (process as { parentPort?: unknown }).parentPort = fakeParentPort;
      try {
        await withIsolatedSignals(async () => {
          await createSignaledLoopHarness();
          expect(fakeParentPort.on).toHaveBeenCalledWith("message", expect.any(Function));
          expect(capturedParentPortListener).toBeTypeOf("function");
          // 握手：装好监听后立刻主动上报就绪 + 协议版本，父进程据此确认新通道可用。
          expect(fakeParentPort.postMessage).toHaveBeenCalledWith({
            type: "__openclaw_parentport_ready__",
            protocolVersion: 1,
          });
        });
      } finally {
        delete process.env.OPENCLAW_PARENTPORT_CONTROL;
      }
    });

    it("does not install listener when OPENCLAW_PARENTPORT_CONTROL is unset", async () => {
      vi.clearAllMocks();
      delete process.env.OPENCLAW_PARENTPORT_CONTROL;
      (process as { parentPort?: unknown }).parentPort = fakeParentPort;
      await withIsolatedSignals(async () => {
        await createSignaledLoopHarness();
        expect(fakeParentPort.on).not.toHaveBeenCalled();
        expect(fakeParentPort.postMessage).not.toHaveBeenCalled();
      });
    });

    it("does not install listener when process.parentPort is absent (plain Node / Server Mode)", async () => {
      vi.clearAllMocks();
      process.env.OPENCLAW_PARENTPORT_CONTROL = "1";
      delete (process as { parentPort?: unknown }).parentPort;
      try {
        await withIsolatedSignals(async () => {
          // 没有真实/假 parentPort 时不应抛错，只是静默跳过安装。
          await createSignaledLoopHarness();
          expect(capturedParentPortListener).toBeNull();
        });
      } finally {
        delete process.env.OPENCLAW_PARENTPORT_CONTROL;
      }
    });

    it("shuts down via full request('stop') path on shutdown message", async () => {
      vi.clearAllMocks();
      process.env.OPENCLAW_PARENTPORT_CONTROL = "1";
      (process as { parentPort?: unknown }).parentPort = fakeParentPort;
      try {
        await withIsolatedSignals(async () => {
          const { close, runtime, exited } = await createSignaledLoopHarness();
          expect(capturedParentPortListener).toBeTypeOf("function");
          // Electron MessageEvent 语义：payload 挂在 event.data 上。
          capturedParentPortListener!({ data: { type: "__openclaw_parentport_shutdown__" } });
          await expect(exited).resolves.toBe(0);
          // 复用了 request("stop") 完整优雅路径：server.close 走 stopping 分支、
          // 退出码为 0——而不是 process.exit() 之类绕过 lock 释放的强杀。
          expect(close).toHaveBeenCalledWith({
            reason: "gateway stopping",
            restartExpectedMs: null,
          });
          expect(runtime.exit).toHaveBeenCalledWith(0);
        });
      } finally {
        delete process.env.OPENCLAW_PARENTPORT_CONTROL;
      }
    });

    it("ignores non-matching parentport message payloads", async () => {
      vi.clearAllMocks();
      process.env.OPENCLAW_PARENTPORT_CONTROL = "1";
      (process as { parentPort?: unknown }).parentPort = fakeParentPort;
      try {
        await withIsolatedSignals(async () => {
          const { close } = await createSignaledLoopHarness();
          capturedParentPortListener!({ data: { type: "some-other-message" } });
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(close).not.toHaveBeenCalled();
        });
      } finally {
        delete process.env.OPENCLAW_PARENTPORT_CONTROL;
      }
    });

    it("is idempotent against double-stop (second shutdown message ignored while shutting down)", async () => {
      vi.clearAllMocks();
      process.env.OPENCLAW_PARENTPORT_CONTROL = "1";
      (process as { parentPort?: unknown }).parentPort = fakeParentPort;
      try {
        await withIsolatedSignals(async () => {
          const { close, exited } = await createSignaledLoopHarness();
          // 两次收到关闭暗号（模拟父进程重复 postMessage 或与信号通道竞态），
          // 靠 request() 顶部现成的 shuttingDown 闸门天然去重，不需要额外互斥锁。
          capturedParentPortListener!({ data: { type: "__openclaw_parentport_shutdown__" } });
          capturedParentPortListener!({ data: { type: "__openclaw_parentport_shutdown__" } });
          await expect(exited).resolves.toBe(0);
          expect(close).toHaveBeenCalledTimes(1);
        });
      } finally {
        delete process.env.OPENCLAW_PARENTPORT_CONTROL;
      }
    });

    it("removes the parentport listener on cleanup", async () => {
      vi.clearAllMocks();
      process.env.OPENCLAW_PARENTPORT_CONTROL = "1";
      (process as { parentPort?: unknown }).parentPort = fakeParentPort;
      try {
        await withIsolatedSignals(async () => {
          const { close, exited } = await createSignaledLoopHarness();
          const sigterm = () => {
            capturedParentPortListener!({ data: { type: "__openclaw_parentport_shutdown__" } });
          };
          sigterm();
          await exited;
          expect(close).toHaveBeenCalled();
          // cleanupSignals() 与 stdinControl?.close() 对称，退出后应把 parentPort
          // 的 message 监听一并摘掉，避免悬挂引用。
          expect(fakeParentPort.removeListener).toHaveBeenCalledWith(
            "message",
            expect.any(Function),
          );
        });
      } finally {
        delete process.env.OPENCLAW_PARENTPORT_CONTROL;
      }
    });
  });
});

describe("gateway discover routing helpers", () => {
  it("prefers resolved service host over TXT hints", () => {
    const beacon: GatewayBonjourBeacon = {
      instanceName: "Test",
      host: "10.0.0.2",
      lanHost: "evil.example.com",
      tailnetDns: "evil.example.com",
    };
    expect(pickBeaconHost(beacon)).toBe("10.0.0.2");
  });

  it("prefers resolved service port over TXT gatewayPort", () => {
    const beacon: GatewayBonjourBeacon = {
      instanceName: "Test",
      host: "10.0.0.2",
      port: 18789,
      gatewayPort: 12345,
    };
    expect(pickGatewayPort(beacon)).toBe(18789);
  });

  it("falls back to TXT host/port when resolve data is missing", () => {
    const beacon: GatewayBonjourBeacon = {
      instanceName: "Test",
      lanHost: "test-host.local",
      gatewayPort: 18789,
    };
    expect(pickBeaconHost(beacon)).toBe("test-host.local");
    expect(pickGatewayPort(beacon)).toBe(18789);
  });
});
