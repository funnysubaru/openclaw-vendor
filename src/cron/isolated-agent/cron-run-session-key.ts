/**
 * cron/isolated-agent/cron-run-session-key —— 决定 cron isolated agent turn 跑在
 * 哪个 sessionKey 上。
 *
 * 业务意图（详见 Yuiclaw 项目 (Y) 方案）：
 *   - 当 job.sessionKey 已经是合法的 `agent:<...>` 前缀 session key（host 显式指定——
 *     Yuiclaw panel 在 cron form 选"目的地 session"后写入此字段；或 vendor cron-tool
 *     创建 cron 时从 chat 上下文继承 LINE/Telegram session key），**复用**该 sessionKey
 *     跑 agentTurn。agent reply 作为下一条 assistant message 自然落入该 session 的
 *     jsonl，host UI 切到对应 tab 即可查看结果。
 *   - 否则回退原行为，用 `cron:<jobId>` 让 isolated session 派生为独立 sessionKey。
 *
 * 抽出纯函数让测试不需要 mock 整个 cron service / isolated agent runtime。
 */
export function resolveCronRunSessionKey(job: { id: string; sessionKey?: string | null }): string {
  const trimmed = typeof job.sessionKey === "string" ? job.sessionKey.trim() : "";
  if (trimmed && trimmed.toLowerCase().startsWith("agent:")) {
    return trimmed;
  }
  return `cron:${job.id}`;
}
