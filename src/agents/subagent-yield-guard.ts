/**
 * 团队 orchestrator 的 sessions_yield 死锁守卫（窄 guard / Yuiclaw fork 自有）。
 *
 * 业务背景：团队 orchestrator 一轮里典型动作是「派活(sessions_spawn) + 挂起(sessions_yield)等子代理结果」。
 * 工具调用在引擎里严格串行执行（agent-loop 的 for + await），yield 在 spawn 之后才触发 onYield。
 *
 * 死锁场景（实测：orchestrator 把 agentId 填成模板名而非真实带哈希的 id，被引擎拒）：本轮所有
 * sessions_spawn 都返回 forbidden，一个子代理都没登记（registerSubagentRun 全仓只有 spawn 成功这一条路），
 * 但 sessions_yield 仍把会话钉在「等结果」挂起态 —— 没有任何子代理会来唤醒它 → 永远卡死，
 * Stop 时表现为 stoppedSubagents=0（没有真实子代理可杀）。
 *
 * 本模块只做窄范围保护：当「本轮发起过 spawn 且无一成功，且当前无任何活跃子代理」时，由 yield 工具
 * 边界拒绝挂起、把本轮 spawn 失败原因回传给模型，让它用正确 agentId 重试或直接作答。
 * 其余情况（纯空 yield、本轮有 spawn 成功、前轮子代理仍在跑）一律放行，保持引擎原行为不变。
 */

/**
 * 单个 attempt 内 sessions_spawn 结算累计（per-attempt）。
 *
 * 之所以按 attempt 累计就够：一个 attempt 内最多触发一次 yield（yield 会 abort 当前 attempt），
 * 所以「attempt 起手到 yield 之前的全部 spawn」恰好覆盖死锁判定所需窗口；工具集每个 attempt 重新构造，
 * tally 也随之新建，不会跨 attempt 泄漏。
 */
export interface TurnSpawnTally {
  /** 本轮（attempt 内）调用过几次 sessions_spawn —— 不论成败。 */
  attempted: number;
  /** 其中 status==="accepted"（真正登记了子代理）的次数。 */
  succeeded: number;
  /** 失败的错误文案，回传给模型便于其用真实 agentId 重试。 */
  errors: string[];
}

/** 新建一份空的 per-attempt spawn 结算累计。 */
export function createTurnSpawnTally(): TurnSpawnTally {
  return { attempted: 0, succeeded: 0, errors: [] };
}

/** 记录一次 sessions_spawn 结算到 tally。失败且带错误文案时收录，供拒绝时回传模型。 */
export function recordSpawnOutcome(
  tally: TurnSpawnTally,
  outcome: { ok: boolean; error?: string },
): void {
  tally.attempted += 1;
  if (outcome.ok) {
    tally.succeeded += 1;
  } else if (outcome.error) {
    tally.errors.push(outcome.error);
  }
}

/**
 * 窄 guard 判据：是否应在 yield 边界拒绝挂起（否则必死锁）。
 *
 * 三条全满足才拒：
 *   ① 本轮发起过 spawn（attempted>0）—— 只拦「想 spawn-then-yield 却全败」的场景，绝不碰纯空 yield；
 *   ② 本轮无一成功（succeeded===0）；
 *   ③ 当前无任何活跃子代理（activeSubagents===0）—— 必须由调用方实时用 countActiveRunsForSession 取，
 *      它覆盖「前轮 spawn 成功、子代理还在跑」的合法等待，避免误杀。
 */
export function shouldRefuseDeadlockYield(params: {
  spawnAttempted: number;
  spawnSucceeded: number;
  activeSubagents: number;
}): boolean {
  return params.spawnAttempted > 0 && params.spawnSucceeded === 0 && params.activeSubagents === 0;
}

/** 拒绝挂起时回传给模型的文案（含本轮 spawn 失败原因，引导其用真实 agentId 重试或直接作答）。 */
export function buildDeadlockYieldRefusalMessage(errors: string[]): string {
  const detail = errors.length > 0 ? ` Spawn errors this turn: ${errors.join("; ")}` : "";
  return (
    "sessions_yield refused: every sessions_spawn this turn failed and no subagents are running, " +
    "so yielding would hang forever waiting for results that will never arrive. " +
    "Do not yield now. Re-check the exact agentId from the team roster (use the real id, " +
    "not a template/placeholder name), fix the sessions_spawn call and retry — " +
    `or answer directly without yielding.${detail}`
  );
}
