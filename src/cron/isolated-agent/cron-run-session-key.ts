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
 * 安全/授权契约（High 1，PR #39 review）：
 *   本函数对 sessionKey 字面量**不做主体匹配校验**，只检测前缀。这意味着：任何能写入
 *   cron job 的 caller 都可以指定一个跨用户/跨 agent 的 `agent:<other-agent>:user:<other-uid>:...`
 *   key，使 cron 的 assistant 输出落进别人的 jsonl。
 *
 *   当前 Yuiclaw 部署模型下这是可接受的：cron.add / cron.update 走 panel-server →
 *   gateway WebSocket，host 单租户单用户 (Desktop Mode) 或可信内网 + Supabase Auth
 *   网关代理 (Server Mode)，sessionKey 由 host 受信代码段（panel CronJobForm + cron-tool
 *   from chat context）填写，外部多租户客户端**无法**直接调用 cron.add。
 *
 *   后续若 vendor 暴露给多租户/非受信 JSON-RPC 客户端，必须在 gateway 鉴权层增加
 *   "sessionKey owner 必须等于当前 caller subject" 的强约束，或要求 host 把 caller
 *   subject 透传到 cron 服务这一层做匹配。当前 vendor 不假设有这层上下文，因此把
 *   契约写在这里：**sessionKey 必须由受信方填入**。
 *
 * canonical 形式（Medium 3，PR #39 review）：
 *   返回的 sessionKey trim 后**全文 lowercase**，与 vendor 其它地方
 *   (`toAgentStoreSessionKey` / `resolveCronAgentSessionKey` 见
 *   run.session-key.test.ts:17 "normalizes canonical keys to lowercase before reuse")
 *   保持一致，避免同一逻辑会话出现两套 key（大小写敏感的存储路径会让 jsonl 写到不同
 *   目录、bootstrap 不复用）。
 *
 * 抽出纯函数让测试不需要 mock 整个 cron service / isolated agent runtime。
 */
export function resolveCronRunSessionKey(job: { id: string; sessionKey?: string | null }): string {
  const trimmed = typeof job.sessionKey === "string" ? job.sessionKey.trim() : "";
  if (trimmed && trimmed.toLowerCase().startsWith("agent:")) {
    // 与 vendor 其它路径（toAgentStoreSessionKey 等）的 canonical 形式对齐 —— 全文 lowercase。
    return trimmed.toLowerCase();
  }
  return `cron:${job.id}`;
}
