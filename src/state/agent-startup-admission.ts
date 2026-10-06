// ADR-0033 任务84(c)：gateway 启动后在后台逐个把员工库"打开 + 迁移"完成，不再在
// 监听之前串行等完所有员工库。手写等价实现，是上游 agent-database-startup.ts /
// agent-database-admission.ts 行为的子集——只做"后台 open+migrate、请求等待、关闭时
// 取消并等待收尾"，不引入上游那一套 secrets / model 的 per-agent 发布阶段耦合
// （那是上游更新的功能，我们现在的 pin 里本来就没有这层耦合，不在本次任务范围）。
// 并发数对齐上游常量：AGENT_DATABASE_PREFLIGHT_CONCURRENCY=2、
// AGENT_DATABASE_PREPARATION_CONCURRENCY=4（见 openclaw 上游
// src/state/openclaw-agent-db-contract.ts）。排队顺序对齐上游 createPermitPool：
// 纯 FIFO，不做插队——2026-10-06 owner 已拍板不做优先级，按上游行为的子集走。
//
// 作用域用全局单例 + 显式 resetAgentStartupAdmissionForTest()，不是 AsyncLocalStorage
// scope（跟上游不同）：本仓库对"一个进程一份全局运行期状态、测试用显式 reset 清空"
// 这个模式已经有一大批先例（closeOpenClawAgentDatabasesForTest /
// closeOpenClawStateDatabaseForTest 等），生产环境里 Desktop/Server 两种模式都只在
// 一个进程里跑一个 gateway 实例，不需要 AsyncLocalStorage 那种支持"同进程多个独立
// 启动序列并存"的开销；测试里多个 kernel 实例顺序跑，靠 reset 钩子隔离即可。
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createPermitPool } from "../shared/permit-pool.js";

const AGENT_STARTUP_OPEN_CONCURRENCY = 2;
const AGENT_STARTUP_MIGRATE_CONCURRENCY = 4;

const log = createSubsystemLogger("state/agent-startup-admission");

let controller: AbortController | undefined;
let opening = createPermitPool(AGENT_STARTUP_OPEN_CONCURRENCY);
let migrating = createPermitPool(AGENT_STARTUP_MIGRATE_CONCURRENCY);
const pendingByAgentId = new Map<string, Promise<void>>();
const failedByAgentId = new Map<string, Error>();
// 跟 pendingByAgentId 不同：这里的条目直到 settle 都不删，关闭时要等的是"所有调度过
// 的后台工作"，不只是"当前还没结束的那些"（两者在稳态下是同一批，但在关闭发生在
// settle 回调跑完之前的那一小段窗口里会不一致，用独立集合更不容易出 race）。
const tracked = new Set<Promise<unknown>>();

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * 为一批员工库在后台调度"打开 + 迁移"。每个员工各自：先排队进 open 并发池（上限2），
 * 跑完 openAgent；再排队进 migrate 并发池（上限4），跑完 migrateAgent。任何一步失败，
 * 只让这一个员工保持不可用（记下原因），不影响其它员工，也不让整个调用抛错——调用方
 * 本身是"fire and forget"，失败通过 waitForAgentStartupAdmission 在被请求时才浮现。
 */
export function scheduleAgentStartupAdmission(params: {
  agentIds: readonly string[];
  openAgent: (agentId: string, signal: AbortSignal) => Promise<void>;
  migrateAgent: (agentId: string, signal: AbortSignal) => Promise<void>;
}): void {
  controller ??= new AbortController();
  const signal = controller.signal;
  for (const rawAgentId of params.agentIds) {
    const agentId = normalizeAgentId(rawAgentId);
    // 同一个 agentId 不重复调度（例如热重载期间再调用一次）：已经在跑/跑完的不重来。
    if (pendingByAgentId.has(agentId) || failedByAgentId.has(agentId)) {
      continue;
    }
    const work = (async () => {
      const releaseOpen = await opening.acquire({ signal });
      if (!releaseOpen) {
        return;
      }
      try {
        signal.throwIfAborted();
        await params.openAgent(agentId, signal);
      } finally {
        releaseOpen();
      }
      const releaseMigrate = await migrating.acquire({ signal });
      if (!releaseMigrate) {
        return;
      }
      try {
        signal.throwIfAborted();
        await params.migrateAgent(agentId, signal);
      } finally {
        releaseMigrate();
      }
    })();
    // pendingByAgentId 存的是 work 本身（会 reject），不是记账用的派生 promise——
    // 这样任何在它 settle 之前就拿到这个 promise 去等的调用方，失败时真的会看到
    // reject，不会被下面这条记账链的 .catch() 吞成"看起来成功"。
    tracked.add(work);
    pendingByAgentId.set(agentId, work);
    work
      .catch((error: unknown) => {
        if (signal.aborted) {
          return;
        }
        const reason = toError(error);
        failedByAgentId.set(agentId, reason);
        log.warn("agent startup admission failed; agent stays unavailable", {
          agentId,
          reason: reason.message,
        });
      })
      .finally(() => {
        pendingByAgentId.delete(agentId);
        tracked.delete(work);
      });
  }
}

/**
 * 请求打到一个还没准入完成的员工时调用这个——等于上游的 waitForAgentPreparation：
 * 还在排队/跑的返回一个 promise 给调用方等；已经失败的立刻 reject 同一个原因（不重
 * 跑、不静默放行）；没在调度里（已经成功过，或者压根没被这套机制接管过的员工）返回
 * undefined，调用方照常走自己原来的路径。纯 FIFO，不支持插队——对齐上游
 * createPermitPool 的排队语义，2026-10-06 owner 已确认不做优先级。
 */
export function waitForAgentStartupAdmission(agentId: string): Promise<void> | undefined {
  const normalized = normalizeAgentId(agentId);
  const failure = failedByAgentId.get(normalized);
  if (failure) {
    return Promise.reject(failure);
  }
  return pendingByAgentId.get(normalized);
}

/** 关闭时取消还没跑完的后台准入，并等它们真正收尾（对齐上游 shutdown 语义）。 */
export async function cancelAgentStartupAdmission(): Promise<void> {
  controller?.abort(new Error("Gateway stopped during agent database startup admission"));
  while (tracked.size > 0) {
    await Promise.allSettled(tracked);
  }
}

/** 测试专用：清空全局单例状态，不走 AsyncLocalStorage 的理由见文件顶部注释。 */
export function resetAgentStartupAdmissionForTest(): void {
  controller = undefined;
  opening = createPermitPool(AGENT_STARTUP_OPEN_CONCURRENCY);
  migrating = createPermitPool(AGENT_STARTUP_MIGRATE_CONCURRENCY);
  pendingByAgentId.clear();
  failedByAgentId.clear();
  tracked.clear();
}
