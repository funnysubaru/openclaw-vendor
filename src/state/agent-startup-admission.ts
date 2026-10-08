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
// 调度器本身用全局单例 + 显式 resetAgentStartupAdmissionForTest()，不是上游那种按启动
// 序列的 AsyncLocalStorage 实例：本仓库对"一个进程一份全局运行期状态、测试用显式 reset
// 清空"这个模式已经有一大批先例（closeOpenClawAgentDatabasesForTest /
// closeOpenClawStateDatabaseForTest 等），生产环境里 Desktop/Server 两种模式都只在
// 一个进程里跑一个 gateway 实例；测试里多个 kernel 实例顺序跑，靠 reset 钩子隔离即可。
//
// 但"当前代码是不是正跑在某个员工自己的准入工作里"必须用 AsyncLocalStorage 判定
// （对齐上游 agent-database-admission.ts 的 preparation 作用域）：准入工作内部的整条
// 调用链（设置 mainKey、worktree 迁移、handoff → reconcileSessionTranscriptIndexes →
// runProjectionWrite → 开库……）都会间接回到 withOpenClawAgentDatabaseAsync / 同步开库
// 入口。只有按"异步上下文"豁免自己，才能一次性覆盖这些间接调用，不靠在每个调用点换
// 绕过入口（review P1-1：换了直接调用、漏了间接调用，冷库在真实 handoff 里自己等自己）。
import { AsyncLocalStorage } from "node:async_hooks";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
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
// 准入按数据库的物理 owner 登记（pendingByAgentId 的 key），请求入口拿到的却是逻辑员工。
// 共享库里两者不同（如 ops 的会话存在 main 名下的 shared.sqlite）。这张表由调度方用与准入
// 登记同一套真实存储目标解析填入：逻辑员工 → 实际存放它会话的库 owner（可能多个）。
const ownersByAgentId = new Map<string, Set<string>>();
// active 在该员工的准入工作结束时置 false：准入期间派生、但活得比准入久的后台任务
// 会继承这份上下文，结束后不能再拿它当豁免凭证（对齐上游 scope.active）。
const ownAdmission = new AsyncLocalStorage<{ agentId: string; active: boolean }>();

/** 同步打开员工库时撞上该员工的后台启动准入还没完成——调用方稍后重试即可。 */
export class AgentStartupAdmissionPendingError extends Error {
  constructor(readonly agentId: string) {
    super(`Agent ${agentId} database is still being prepared after gateway startup; retry shortly`);
    this.name = "AgentStartupAdmissionPendingError";
  }
}

function isInsideOwnAdmission(agentId: string): boolean {
  const scope = ownAdmission.getStore();
  return scope?.active === true && scope.agentId === agentId;
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
  /** [逻辑员工, 实际库 owner]：请求入口据此把逻辑员工换成要等的物理 owner。 */
  owners?: ReadonlyArray<readonly [logicalAgentId: string, databaseAgentId: string]>;
}): void {
  controller ??= new AbortController();
  for (const [logicalAgentId, databaseAgentId] of params.owners ?? []) {
    const logical = normalizeAgentId(logicalAgentId);
    const owners = ownersByAgentId.get(logical) ?? new Set<string>();
    owners.add(normalizeAgentId(databaseAgentId));
    ownersByAgentId.set(logical, owners);
  }
  const signal = controller.signal;
  for (const rawAgentId of params.agentIds) {
    const agentId = normalizeAgentId(rawAgentId);
    // 同一个 agentId 不重复调度（例如热重载期间再调用一次）：已经在跑/跑完的不重来。
    if (pendingByAgentId.has(agentId) || failedByAgentId.has(agentId)) {
      continue;
    }
    const scope = { agentId, active: true };
    // 整个 work 跑在本员工的准入作用域里，内部任何间接开库都能认出"这是我自己"。
    const work = ownAdmission.run(scope, async () => {
      try {
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
      } catch (error) {
        if (!signal.aborted) {
          const reason = error instanceof Error ? error : new Error(String(error));
          failedByAgentId.set(agentId, reason);
          log.warn("agent startup admission failed; agent stays unavailable", {
            agentId,
            reason: reason.message,
          });
        }
        throw error;
      } finally {
        // 状态必须在 work settle 之前同步改完：等待方 await work 之后紧接着就会进开库
        // 入口再查一次状态，如果这里还挂着 pending，会被误判成"仍在准入"。
        // （第一句就是 await，所以执行到这里时 work 早已登记进 pendingByAgentId。）
        scope.active = false;
        pendingByAgentId.delete(agentId);
      }
    });
    // pendingByAgentId 存的是 work 本身（失败会 reject），等待方能真正看到失败原因。
    pendingByAgentId.set(agentId, work);
    // 失败已在上面记账 + 打日志；这里只防"没人等时"的未处理 rejection。
    work.catch(() => {});
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
  // 本员工自己的准入工作（含它间接调到的整条链）不能等自己，否则 work 永远 settle 不了。
  if (isInsideOwnAdmission(normalized)) {
    return undefined;
  }
  const failure = failedByAgentId.get(normalized);
  if (failure) {
    return Promise.reject(failure);
  }
  return pendingByAgentId.get(normalized);
}

/**
 * 请求入口（RPC 分发 / HTTP 用户路由 / 渠道入站）用的等待：入口后面往往是同步读员工库，
 * 同步入口自己没法等，所以在进入请求前先在这里等准入（owner 2026-10-08 选 B：透明等待，
 * 不让请求撞上同步开库入口的可重试错误）。
 * - 给了 agentId（逻辑员工）：换算成实际存放它会话的库 owner 后只等这些 owner；任一已失败
 *   就立即 reject 同一原因，不陪别的员工等；换算不了（不认识的员工）退回等全部。
 * - 没给 agentId（入口说不清要读哪个员工）：等当前所有在途准入结束（allSettled），失败的
 *   员工留给后续开库入口按员工报同一原因。
 * - 关闭 / 热重启：调度器的 abort（cancelAgentStartupAdmission）和调用方传入的 signals
 *   （请求入口租约关闭、请求自身中止）任一触发都立即以 AbortError 结束，不卡住关闭。
 * - 在任何员工自己的准入工作里调用直接放行：准入工作若绕回请求入口，等全部会等到自己。
 * 没有需要等的就返回 undefined，调用方不多付一个 await。
 */
export function waitForAgentStartupAdmissionBeforeRequest(
  params: { agentId?: string; signals?: ReadonlyArray<AbortSignal | undefined> } = {},
): Promise<void> | undefined {
  if (
    (pendingByAgentId.size === 0 && failedByAgentId.size === 0) ||
    ownAdmission.getStore()?.active
  ) {
    return undefined;
  }
  const owners = params.agentId ? resolveAdmissionOwners(params.agentId) : undefined;
  const target = owners
    ? waitForAgentOwners(owners)
    : pendingByAgentId.size > 0
      ? Promise.allSettled(pendingByAgentId.values()).then(() => undefined)
      : undefined;
  if (!target) {
    return undefined;
  }
  const signals = [controller?.signal, ...(params.signals ?? [])].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  // signal 已中止时竞速会直接返回、不再订阅 target；先挂一个空处理，免得失败原因变成
  // 未处理 rejection（等待方照样从竞速结果里拿到失败）。
  target.catch(() => {});
  return racePromiseWithAbortSignal(target, AbortSignal.any(signals));
}

/**
 * 逻辑员工 → 要等的物理库 owner：登记过映射的用映射（加上它自己若也是准入 key）；完全不认识
 * 的员工（映射里没有、自己也不是准入 key）说明解析不可靠，返回 undefined 让调用方等全部。
 */
function resolveAdmissionOwners(agentId: string): string[] | undefined {
  const normalized = normalizeAgentId(agentId);
  const owners = new Set(ownersByAgentId.get(normalized));
  if (pendingByAgentId.has(normalized) || failedByAgentId.has(normalized)) {
    owners.add(normalized);
  }
  return ownersByAgentId.has(normalized) || owners.size > 0 ? [...owners] : undefined;
}

/** 等这些 owner 的准入；任一已失败立即 reject 同一原因；都不在准入中则不等。 */
function waitForAgentOwners(owners: readonly string[]): Promise<void> | undefined {
  const waits = owners
    .map((owner) => waitForAgentStartupAdmission(owner))
    .filter((wait): wait is Promise<void> => wait !== undefined);
  return waits.length > 0 ? Promise.all(waits).then(() => undefined) : undefined;
}

/**
 * 同步开库入口用的检查（review P1-2）：同步调用方没法等，而它若在后台准入的完整性检查
 * 期间新建物理连接，会 revoke 掉准入正在进行的异步打开，准入因此永久失败。所以准入
 * 未完成时直接拒绝（可重试错误），已失败时抛同一个失败原因——跟异步入口"等待 / 同一
 * 失败原因"的结局一致，只是"等待"换成"稍后重试"。对齐上游：上游在
 * openOpenClawAgentDatabaseSteps 顶部 assertAgentDatabaseAdmitted，准入中的员工一律
 * 拒绝（retryable），准入自身经作用域豁免。
 */
export function assertAgentStartupAdmissionSettled(agentId: string): void {
  // 绝大多数时候调度器是空的；这条判断让热路径上的同步开库几乎零开销。
  if (pendingByAgentId.size === 0 && failedByAgentId.size === 0) {
    return;
  }
  const normalized = normalizeAgentId(agentId);
  if (isInsideOwnAdmission(normalized)) {
    return;
  }
  const failure = failedByAgentId.get(normalized);
  if (failure) {
    throw failure;
  }
  if (pendingByAgentId.has(normalized)) {
    throw new AgentStartupAdmissionPendingError(normalized);
  }
}

/**
 * 关闭时取消还没跑完的后台准入，并等它们真正收尾（对齐上游 shutdown 语义）。
 *
 * 收尾后顺带清空 pendingByAgentId / failedByAgentId：gateway 支持不退出进程的热
 * restart（"gateway-restart" 是独立于 "gateway-startup" 的操作），本模块的状态是
 * 模块级全局单例，如果不清，下一轮 scheduleAgentStartupAdmission 会被两处坑中：
 * ①某 agentId 上一轮已经成功过，pendingByAgentId 里早被删了，不清 failedByAgentId
 * 没问题，但调度器的 dedup 判据是"pendingByAgentId.has || failedByAgentId.has"，
 * 成功过的 agentId 两边都不在，下一轮会被重新调度一次——不算错但浪费；②更严重的是
 * 上一轮如果真的失败过，failedByAgentId 永久记着那个旧错误，下一轮同一个 agentId
 * 会被 dedup 直接跳过、永远不会重新尝试，waitForAgentStartupAdmission 对它则永远
 * reject 同一个陈旧原因。清空之后下一轮 scheduleAgentStartupAdmission 拿到的是
 * 干净状态，等价于重新评估一遍。
 */
export async function cancelAgentStartupAdmission(): Promise<void> {
  controller?.abort(new Error("Gateway stopped during agent database startup admission"));
  // work 自己在 settle 前就把条目删掉；循环到清空为止，等的是全部 work 真正收尾。
  while (pendingByAgentId.size > 0) {
    await Promise.allSettled(pendingByAgentId.values());
  }
  clearAgentStartupAdmissionState();
}

function clearAgentStartupAdmissionState(): void {
  controller = undefined;
  opening = createPermitPool(AGENT_STARTUP_OPEN_CONCURRENCY);
  migrating = createPermitPool(AGENT_STARTUP_MIGRATE_CONCURRENCY);
  pendingByAgentId.clear();
  failedByAgentId.clear();
  ownersByAgentId.clear();
}

/**
 * 测试专用：清空全局单例状态（不走 AsyncLocalStorage 的理由见文件顶部注释）。跟
 * cancelAgentStartupAdmission 不同，这里不 abort、不等收尾——测试场景里通常没有真正
 * 跑着的后台任务要等，直接清空即可。
 */
export const resetAgentStartupAdmissionForTest = clearAgentStartupAdmissionState;
