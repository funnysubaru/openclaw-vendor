/**
 * cron/isolated-agent/cron-run-target —— 决定 cron isolated agent turn 实际跑在
 * 哪个 (agentId, sessionKey) 上，避免 `job.agentId` 与 `job.sessionKey` 不一致时
 * "运行 agent" 与"写入 jsonl 路径"分裂。
 *
 * **问题描述（Open Question，PR #39 follow-up review）**：
 * resolveCronRunSessionKey 只看 sessionKey 前缀，不校验 sessionKey 嵌入的 agentId
 * 与 `job.agentId` 是否一致。如果 `job.sessionKey = "agent:custom-x:..."` 但
 * `job.agentId = "main"`（或缺省），原 `runIsolatedAgentJob` 会用 main 跑 turn，
 * 但 reply 通过 sessionKey 落到 custom-x 的 agent-store 路径 → UI 看不到、agent
 * runtime 与 jsonl owner 错乱。
 *
 * **本模块契约**：
 *   - 如果 `job.sessionKey` 是 canonical `agent:<sid>:...`，**sessionKey 嵌入的
 *     agentId 是真相之源**（决定 jsonl 落到哪个 agent 目录）：返回
 *     `{ agentId: sid, sessionKey: <canonical lowercase> }`，**忽略** job.agentId。
 *   - 否则用 `cron:<jobId>` 派生 sessionKey + `requestedAgentId` (或缺省由
 *     resolveDefaultAgentId 兜底) 作为 agentId。
 *   - 若 sessionKey 嵌入 agentId 与 job.agentId 不一致，返回 `divergence`
 *     字段让 caller log warning 便于诊断（不抛错，避免破坏既有 cron 运行）。
 */

import {
  parseAgentSessionKey,
  type ParsedAgentSessionKey,
} from "../../sessions/session-key-utils.js";
import { resolveCronRunSessionKey } from "./cron-run-session-key.js";

export type CronRunTarget = {
  /** cron isolated turn 实际跑的 agentId（reply jsonl 落到该 agent 目录） */
  agentId: string;
  /** cron isolated turn 实际跑的 sessionKey（canonical lowercase） */
  sessionKey: string;
  /** 若 job.agentId 与 sessionKey 嵌入的 agentId 不一致，返回此结构，caller 应 log 警告 */
  divergence?: {
    jobAgentId: string;
    sessionKeyAgentId: string;
  };
};

export function resolveCronRunTarget(
  job: { id: string; agentId?: string | null; sessionKey?: string | null },
  requestedAgentId: string,
): CronRunTarget {
  const sessionKey = resolveCronRunSessionKey(job);
  const parsed: ParsedAgentSessionKey | null = parseAgentSessionKey(sessionKey);

  if (parsed) {
    // sessionKey 是 canonical agent: 前缀 —— 嵌入的 agentId 是真相之源
    const normalizedJobAgent =
      typeof job.agentId === "string" && job.agentId.trim()
        ? job.agentId.trim().toLowerCase()
        : "";
    const divergence =
      normalizedJobAgent && normalizedJobAgent !== parsed.agentId
        ? {
            jobAgentId: normalizedJobAgent,
            sessionKeyAgentId: parsed.agentId,
          }
        : undefined;
    return { agentId: parsed.agentId, sessionKey, divergence };
  }

  // 非 canonical（cron:<jobId> 派生）：照旧用 requestedAgentId 跑
  return { agentId: requestedAgentId, sessionKey };
}
