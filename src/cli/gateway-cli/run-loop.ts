import { createInterface, type Interface } from "node:readline";
import {
  abortEmbeddedPiRun,
  getActiveEmbeddedRunCount,
  waitForActiveEmbeddedRuns,
} from "../../agents/pi-embedded-runner/runs.js";
import type { startGatewayServer } from "../../gateway/server.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import { restartGatewayProcessWithFreshPid } from "../../infra/process-respawn.js";
import {
  consumeGatewaySigusr1RestartAuthorization,
  isGatewaySigusr1RestartExternallyAllowed,
  markGatewaySigusr1RestartHandled,
} from "../../infra/restart.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getActiveTaskCount,
  markGatewayDraining,
  resetAllLanes,
  waitForActiveTasks,
} from "../../process/command-queue.js";
import { createRestartIterationHook } from "../../process/restart-recovery.js";
import type { defaultRuntime } from "../../runtime.js";

const gatewayLog = createSubsystemLogger("gateway");

type GatewayRunSignalAction = "stop" | "restart";

// Yuiclaw 防篡改加固块 A 第二批：Electron utilityProcess.fork() 派生的子进程会在
// 全局 process 对象上挂一个 Electron 专有的 parentPort（MessagePort 语义，用于
// 父子进程双向通信）。vendor 不依赖 electron 类型包（也不该依赖——这是纯 Node
// 引擎，Electron 集成是 Yuiclaw 壳层的事），所以这里按 Electron 官方
// MessagePortMain 文档手写一个只包含本文件用到的成员的最小接口，避免引入整个
// electron 类型依赖。普通 Node 进程 / Server Mode 下 process.parentPort 恒为
// undefined，下面的用法全部走可选链，对上游、对非 utilityProcess 运行方式零影响。
interface ElectronParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data?: unknown }) => void): void;
  removeListener(event: "message", listener: (event: { data?: unknown }) => void): void;
}

declare global {
  namespace NodeJS {
    interface Process {
      parentPort?: ElectronParentPort;
    }
  }
}

export async function runGatewayLoop(params: {
  start: () => Promise<Awaited<ReturnType<typeof startGatewayServer>>>;
  runtime: typeof defaultRuntime;
  lockPort?: number;
}) {
  let lock = await acquireGatewayLock({ port: params.lockPort });
  let server: Awaited<ReturnType<typeof startGatewayServer>> | null = null;
  let shuttingDown = false;
  let restartResolver: (() => void) | null = null;

  // Yuiclaw B组：Windows 优雅关闭通道。Windows 上 Node 子进程收不到别的进程
  // 发来的 POSIX 信号（taskkill /F 是无信号强杀），所以下面 SIGTERM→request("stop")
  // 的优雅路径够不着。父进程（Yuiclaw launcher）改从 stdin 写一行暗号来触发同一条
  // 路径。暗号常量必须与 Yuiclaw 侧 packages/gateway/src/launcher.ts 的
  // STDIN_SHUTDOWN_SENTINEL 保持一致——改一侧必须同改另一侧。
  const STDIN_SHUTDOWN_SENTINEL = "__openclaw_stdin_shutdown__";
  let stdinControl: Interface | null = null;

  // Yuiclaw 防篡改加固块 A 第二批（gateway-utilityprocess-migration 任务 6）：
  // parentPort 优雅关闭接收端。Electron utilityProcess.fork() 派生的子进程
  // stdin 恒为 "ignore"（Electron 官方限制），上面那条 stdin 暗号通道在
  // utilityProcess 模式下物理不存在。utilityProcess 父子官方通信通道是
  // MessagePort：父进程 child.postMessage(msg) → 子进程
  // process.parentPort.on("message", ...)。这里新增一条 parentPort 接收端，
  // 与 stdin 接收端并列共存（不是替换）：
  //   - Desktop/utilityProcess 场景走 parentPort（本段）
  //   - Windows child_process/Server Mode 回滚场景仍走 stdin（上面那段）
  // 两条通道各自靠独立的 env 开关激活，互不干扰、互不依赖。
  const PARENTPORT_SHUTDOWN_TYPE = "__openclaw_parentport_shutdown__";
  const GATEWAY_CONTROL_READY_TYPE = "__openclaw_parentport_ready__";
  const GATEWAY_CONTROL_PROTOCOL_VERSION = 1;
  // 契约红线：以上三个常量必须与 Yuiclaw 侧 packages/gateway/src/process-tree.ts
  // 的同名常量字面量完全一致（Yuiclaw 有单测 grep 本文件断言一致）。改一侧必须
  // 同改另一侧，否则父子进程握手/关闭消息互相认不出。
  let parentPortListener: ((event: { data?: unknown }) => void) | null = null;

  const cleanupSignals = () => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGUSR1", onSigusr1);
    // stdin 控制通道随信号 handler 一起拆，避免退出后悬挂 readline 监听。
    stdinControl?.close();
    stdinControl = null;
    // parentPort 监听同样要在退出时摘掉，避免子进程虽已进入关闭流程、
    // 但 MessagePort 监听仍悬挂导致事件循环拖着不退。与上面 stdinControl?.close()
    // 对称处理。process.parentPort 在非 utilityProcess 运行时（如普通 Node /
    // Server Mode）本就是 undefined，可选链天然跳过。
    if (parentPortListener) {
      process.parentPort?.removeListener("message", parentPortListener);
      parentPortListener = null;
    }
  };
  const exitProcess = (code: number) => {
    cleanupSignals();
    params.runtime.exit(code);
  };
  const releaseLockIfHeld = async (): Promise<boolean> => {
    if (!lock) {
      return false;
    }
    await lock.release();
    lock = null;
    return true;
  };
  const reacquireLockForInProcessRestart = async (): Promise<boolean> => {
    try {
      lock = await acquireGatewayLock({ port: params.lockPort });
      return true;
    } catch (err) {
      gatewayLog.error(`failed to reacquire gateway lock for in-process restart: ${String(err)}`);
      exitProcess(1);
      return false;
    }
  };
  const handleRestartAfterServerClose = async () => {
    const hadLock = await releaseLockIfHeld();
    // Release the lock BEFORE spawning so the child can acquire it immediately.
    const respawn = restartGatewayProcessWithFreshPid();
    if (respawn.mode === "spawned" || respawn.mode === "supervised") {
      const modeLabel =
        respawn.mode === "spawned"
          ? `spawned pid ${respawn.pid ?? "unknown"}`
          : "supervisor restart";
      gatewayLog.info(`restart mode: full process restart (${modeLabel})`);
      exitProcess(0);
      return;
    }
    if (respawn.mode === "failed") {
      gatewayLog.warn(
        `full process restart failed (${respawn.detail ?? "unknown error"}); falling back to in-process restart`,
      );
    } else {
      gatewayLog.info(
        `restart mode: in-process restart (${respawn.detail ?? "OPENCLAW_NO_RESPAWN"})`,
      );
    }
    if (hadLock && !(await reacquireLockForInProcessRestart())) {
      return;
    }
    shuttingDown = false;
    restartResolver?.();
  };
  const handleStopAfterServerClose = async () => {
    await releaseLockIfHeld();
    exitProcess(0);
  };

  const DRAIN_TIMEOUT_MS = 90_000;
  const SHUTDOWN_TIMEOUT_MS = 5_000;

  const request = (action: GatewayRunSignalAction, signal: string) => {
    if (shuttingDown) {
      gatewayLog.info(`received ${signal} during shutdown; ignoring`);
      return;
    }
    shuttingDown = true;
    const isRestart = action === "restart";
    gatewayLog.info(`received ${signal}; ${isRestart ? "restarting" : "shutting down"}`);

    // Allow extra time for draining active turns on restart.
    const forceExitMs = isRestart ? DRAIN_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS : SHUTDOWN_TIMEOUT_MS;
    const forceExitTimer = setTimeout(() => {
      gatewayLog.error("shutdown timed out; exiting without full cleanup");
      // Exit non-zero on restart timeout so launchd/systemd treats it as a
      // failure and triggers a clean process restart instead of assuming the
      // shutdown was intentional. Stop-timeout stays at 0 (graceful). (#36822)
      exitProcess(isRestart ? 1 : 0);
    }, forceExitMs);

    void (async () => {
      try {
        // On restart, wait for in-flight agent turns to finish before
        // tearing down the server so buffered messages are delivered.
        if (isRestart) {
          // Reject new enqueues immediately during the drain window so
          // sessions get an explicit restart error instead of silent task loss.
          markGatewayDraining();
          const activeTasks = getActiveTaskCount();
          const activeRuns = getActiveEmbeddedRunCount();

          // Best-effort abort for compacting runs so long compaction operations
          // don't hold session write locks across restart boundaries.
          if (activeRuns > 0) {
            abortEmbeddedPiRun(undefined, { mode: "compacting" });
          }

          if (activeTasks > 0 || activeRuns > 0) {
            gatewayLog.info(
              `draining ${activeTasks} active task(s) and ${activeRuns} active embedded run(s) before restart (timeout ${DRAIN_TIMEOUT_MS}ms)`,
            );
            const [tasksDrain, runsDrain] = await Promise.all([
              activeTasks > 0
                ? waitForActiveTasks(DRAIN_TIMEOUT_MS)
                : Promise.resolve({ drained: true }),
              activeRuns > 0
                ? waitForActiveEmbeddedRuns(DRAIN_TIMEOUT_MS)
                : Promise.resolve({ drained: true }),
            ]);
            if (tasksDrain.drained && runsDrain.drained) {
              gatewayLog.info("all active work drained");
            } else {
              gatewayLog.warn("drain timeout reached; proceeding with restart");
              // Final best-effort abort to avoid carrying active runs into the
              // next lifecycle when drain time budget is exhausted.
              abortEmbeddedPiRun(undefined, { mode: "all" });
            }
          }
        }

        await server?.close({
          reason: isRestart ? "gateway restarting" : "gateway stopping",
          restartExpectedMs: isRestart ? 1500 : null,
        });
      } catch (err) {
        gatewayLog.error(`shutdown error: ${String(err)}`);
      } finally {
        clearTimeout(forceExitTimer);
        server = null;
        if (isRestart) {
          await handleRestartAfterServerClose();
        } else {
          await handleStopAfterServerClose();
        }
      }
    })();
  };

  const onSigterm = () => {
    gatewayLog.info("signal SIGTERM received");
    request("stop", "SIGTERM");
  };
  const onSigint = () => {
    gatewayLog.info("signal SIGINT received");
    request("stop", "SIGINT");
  };
  const onSigusr1 = () => {
    gatewayLog.info("signal SIGUSR1 received");
    const authorized = consumeGatewaySigusr1RestartAuthorization();
    if (!authorized && !isGatewaySigusr1RestartExternallyAllowed()) {
      gatewayLog.warn(
        "SIGUSR1 restart ignored (not authorized; commands.restart=false or use gateway tool).",
      );
      return;
    }
    markGatewaySigusr1RestartHandled();
    request("restart", "SIGUSR1");
  };

  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  process.on("SIGUSR1", onSigusr1);

  // 仅当父进程（Yuiclaw launcher, Windows）显式开启才读 stdin。默认不装，对上游
  // 及其它运行方式零影响。收到暗号行即复用现成 request("stop") 走完整优雅关闭。
  if (process.env.OPENCLAW_STDIN_CONTROL === "1") {
    // terminal:false 明确按非交互管道处理（父进程写一行就走，不需要 TTY 行编辑/回显）。
    stdinControl = createInterface({ input: process.stdin, terminal: false });
    stdinControl.on("line", (line) => {
      if (line.trim() === STDIN_SHUTDOWN_SENTINEL) {
        gatewayLog.info("received stdin shutdown request; shutting down");
        request("stop", "stdin");
      }
    });
    // stdin 不单独 ref 住事件循环（gateway 靠 server 保活），进程该退还是退。
    process.stdin.unref();
  }

  // Yuiclaw 防篡改加固块 A 第二批：parentPort 优雅关闭接收端。双守卫都要满足才
  // 装监听——① process.parentPort 存在（普通 Node / Server Mode 下天然为
  // undefined，这是运行时环境守卫）；② OPENCLAW_PARENTPORT_CONTROL === "1"
  // 显式开关（类比上面 OPENCLAW_STDIN_CONTROL，即使将来某天 Node 原生 process
  // 也长出了同名字段，没有这个显式开关也不会误装）。两个条件缺一都不装，对上游
  // openclaw、对 Server Mode（走 child_process，没有 parentPort）零副作用。
  if (process.parentPort && process.env.OPENCLAW_PARENTPORT_CONTROL === "1") {
    parentPortListener = (event) => {
      // Electron parentPort 的 message 事件 payload 挂在 event.data 上（同
      // MessageEvent 语义），不是事件对象本身；这里防御性地同时接受
      // { data: {...} } 与裸对象，避免 Electron 版本间字段位置差异导致悄悄失灵。
      const payload = (
        event && typeof event === "object" && "data" in event
          ? (event as { data?: unknown }).data
          : event
      ) as { type?: unknown } | undefined;
      if (payload?.type === PARENTPORT_SHUTDOWN_TYPE) {
        gatewayLog.info("received parentport shutdown request; shutting down");
        // 必须复用现成 request("stop") 完整优雅路径——它负责释放 gateway lock、
        // drain 在途任务、按 exitProcess 走统一退出码。这里绝不能 process.exit()
        // 或直接杀进程绕过这条路径，否则会导致 lock 文件残留、下次启动误判
        // "gateway 仍在运行" 而拒绝启动。
        request("stop", "parentport");
      }
    };
    process.parentPort.on("message", parentPortListener);
    // 启动握手：装好监听后立刻主动上报「新关闭通道已就绪」，附带协议版本号。
    // 父进程（Yuiclaw GatewayLauncher）收到这条消息才能确认可以安全地改用
    // postMessage 触发关闭，而不是继续走旧的强杀路径；协议版本号让父进程在
    // 未来协议变更时能做兼容性判断，而不是盲目假设子进程支持当前协议。
    process.parentPort.postMessage({
      type: GATEWAY_CONTROL_READY_TYPE,
      protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
    });
  }

  // 说明：double-stop 幂等不需要在这里额外加互斥锁。parentPort 通道与 stdin /
  // 信号通道最终都汇聚到同一个 request() 入口，其顶部的 `if (shuttingDown) return;`
  // 闸门已经保证了无论从哪条通道、触发几次关闭请求，优雅关闭流程只会真正执行一次。

  try {
    const onIteration = createRestartIterationHook(() => {
      // After an in-process restart (SIGUSR1), reset command-queue lane state.
      // Interrupted tasks from the previous lifecycle may have left `active`
      // counts elevated (their finally blocks never ran), permanently blocking
      // new work from draining. This must happen here — at the restart
      // coordinator level — rather than inside individual subsystem init
      // functions, to avoid surprising cross-cutting side effects.
      resetAllLanes();
    });

    // Keep process alive; SIGUSR1 triggers an in-process restart (no supervisor required).
    // SIGTERM/SIGINT still exit after a graceful shutdown.
    let isFirstStart = true;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      onIteration();
      try {
        server = await params.start();
        isFirstStart = false;
      } catch (err) {
        // On initial startup, let the error propagate so the outer handler
        // can report "Gateway failed to start" and exit non-zero. Only
        // swallow errors on subsequent in-process restarts to keep the
        // process alive (a crash would lose macOS TCC permissions). (#35862)
        if (isFirstStart) {
          throw err;
        }
        server = null;
        // Release the gateway lock so that `daemon restart/stop` (which
        // discovers PIDs via the gateway port) can still manage the process.
        // Without this, the process holds the lock but is not listening,
        // forcing manual cleanup. (#35862)
        await releaseLockIfHeld();
        const errMsg = err instanceof Error ? err.message : String(err);
        const errStack = err instanceof Error && err.stack ? `\n${err.stack}` : "";
        gatewayLog.error(
          `gateway startup failed: ${errMsg}. ` +
            `Process will stay alive; fix the issue and restart.${errStack}`,
        );
      }
      await new Promise<void>((resolve) => {
        restartResolver = resolve;
      });
    }
  } finally {
    await releaseLockIfHeld();
    cleanupSignals();
  }
}
