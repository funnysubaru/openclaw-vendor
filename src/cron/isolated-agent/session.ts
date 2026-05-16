import crypto from "node:crypto";
import { clearBootstrapSnapshotOnSessionRollover } from "../../agents/bootstrap-cache.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  evaluateSessionFreshness,
  loadSessionStore,
  resolveSessionResetPolicy,
  resolveStorePath,
  type SessionEntry,
} from "../../config/sessions.js";

/**
 * Panel UI 派生的 canonical sessionKey: `agent:<agentId>:user:<uid>:panel-<id>`.
 * 这类 sessionKey 是 host UI 用户对话的 stable 标识 (用户能切到 tab 看历史),
 * cron 写入必须 append 到当前 jsonl,不允许滚动 sessionId (Yuiclaw 2026-05-16
 * 实战 Ralph Lauren cron 投递断链根因 — cron forceNew=true 滚走 user 的 panel
 * sessionId, cron reply 落到孤儿 jsonl, panel UI 永远看不到)。
 *
 * 模式: `^agent:[a-z0-9_-]+:user:[a-f0-9-]+:panel-[a-z0-9_-]+` (大小写不敏感) —
 * `panel-` 前缀是 yuiclaw panel UI 创建 chat tab 时生成的 canonical 标识。
 * 其它 sessionKey (cron:<jobId> / line:* / direct:* / discord:* ...) 保持原有
 * freshness + forceNew 语义,不受影响。
 */
const PANEL_SESSION_KEY_RE = /^agent:[a-z0-9_-]+:user:[a-f0-9-]+:panel-[a-z0-9_-]+/i;

function isPanelSessionKey(sessionKey: string): boolean {
  return PANEL_SESSION_KEY_RE.test(sessionKey.trim());
}

export function resolveCronSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  nowMs: number;
  agentId: string;
  forceNew?: boolean;
}) {
  const sessionCfg = params.cfg.session;
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];

  // Check if we can reuse an existing session
  let sessionId: string;
  let isNewSession: boolean;
  let systemSent: boolean;

  // PR-B: panel-* sessionKey 强制 reuse,跳过 freshness eviction + 忽略 forceNew。
  // (Y) 方案承诺 cron reply 永远落到 user 的 panel tab — 必须不滚 sessionId。
  // 仅当 entry 不存在 (首次 cron 创建该 sessionKey) 时才走 fallthrough 生成新 sessionId。
  if (isPanelSessionKey(params.sessionKey) && entry?.sessionId) {
    sessionId = entry.sessionId;
    isNewSession = false;
    systemSent = entry.systemSent ?? false;
  } else if (!params.forceNew && entry?.sessionId) {
    // Evaluate freshness using the configured reset policy
    // Cron/webhook sessions use "direct" reset type (1:1 conversation style)
    const resetPolicy = resolveSessionResetPolicy({
      sessionCfg,
      resetType: "direct",
    });
    const freshness = evaluateSessionFreshness({
      updatedAt: entry.updatedAt,
      now: params.nowMs,
      policy: resetPolicy,
    });

    if (freshness.fresh) {
      // Reuse existing session
      sessionId = entry.sessionId;
      isNewSession = false;
      systemSent = entry.systemSent ?? false;
    } else {
      // Session expired, create new
      sessionId = crypto.randomUUID();
      isNewSession = true;
      systemSent = false;
    }
  } else {
    // No existing session or forced new
    sessionId = crypto.randomUUID();
    isNewSession = true;
    systemSent = false;
  }

  clearBootstrapSnapshotOnSessionRollover({
    sessionKey: params.sessionKey,
    previousSessionId: isNewSession ? entry?.sessionId : undefined,
  });

  const sessionEntry: SessionEntry = {
    // Preserve existing per-session overrides even when rolling to a new sessionId.
    ...entry,
    // Always update these core fields
    sessionId,
    updatedAt: params.nowMs,
    systemSent,
    // When starting a fresh session (forceNew / isolated), clear delivery routing
    // state inherited from prior sessions. Without this, lastThreadId leaks into
    // the new session and causes announce-mode cron deliveries to post as thread
    // replies instead of channel top-level messages.
    // deliveryContext must also be cleared because normalizeSessionEntryDelivery
    // repopulates lastThreadId from deliveryContext.threadId on store writes.
    ...(isNewSession && {
      lastChannel: undefined,
      lastTo: undefined,
      lastAccountId: undefined,
      lastThreadId: undefined,
      deliveryContext: undefined,
    }),
  };
  return { storePath, store, sessionEntry, systemSent, isNewSession };
}
