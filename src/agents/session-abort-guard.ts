// src/agents/session-abort-guard.ts
//
// 会话级 abort 闸（进程内内存态）。
//
// 业务背景：
//   team orchestrator 被中止后，残留子 agent 的 announce 会唤醒它、它再 spawn
//   新子 agent，形成「自我再生循环」。引擎原本没有「会话级 abort 状态」（只能杀
//   此刻活跃的 run）。本模块补上该状态：abort 时打标、announce 唤醒/spawn 时查
//   标、用户真实新消息时清标。
//
// 为什么内存就够：
//   子 agent 是 in-process embedded run，gateway 重启即清空，无可唤醒的残留。
//   因此不需要持久化；重启后 abort 态自然消失，announce 也不可能再来。
//
// 使用方：
//   - abort 路径（pi-tools.abort.ts）：abort 成功后调 markSessionAborted
//   - announce 拦截（待实现）：唤醒前调 isSessionAborted，若已打标调 noteDroppedAnnounce
//   - spawn 拦截（待实现）：同上，拦截再生循环
//   - 用户新消息（待实现）：真实输入时调 clearSessionAbort 解除闸

import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { normalizeControllerSessionKey } from "./tools/sessions-helpers.js";

const log = createSubsystemLogger("gateway");

/** 单个会话的 abort 状态条目 */
type SessionAbortEntry = {
  /** unix ms，仅供调试/日志；不做定时过期（只被用户真实消息解除） */
  abortedAt: number;
  /** 中止期间因闸丢弃的 announce 条数，用于汇总日志 */
  droppedCount: number;
};

// 使用 Symbol.for 保证跨 bundle 单例（tsdown inlineOnly 可能产生多份模块实例）
const GUARD_STATE_KEY = Symbol.for("openclaw.sessionAbortGuard");

const guardState = resolveGlobalSingleton(GUARD_STATE_KEY, () => ({
  aborted: new Map<string, SessionAbortEntry>(),
}));

/** 内部 Map 引用，避免每次通过 guardState 间接访问 */
const ABORTED = guardState.aborted;

/**
 * 打标：该 controller 会话进入 abort 态。
 * 二次打标时刷新 abortedAt、但保留已有 droppedCount（避免计数丢失）。
 */
export function markSessionAborted(cfg: OpenClawConfig, sessionKey: string | undefined): void {
  const key = normalizeControllerSessionKey(cfg, sessionKey);
  // normalizeControllerSessionKey 对空/blank 返回 undefined，直接 no-op
  if (!key) {
    return;
  }
  const existing = ABORTED.get(key);
  ABORTED.set(key, {
    abortedAt: Date.now(),
    droppedCount: existing?.droppedCount ?? 0,
  });
}

/**
 * 查标：该 controller 会话是否处于 abort 态。
 * 供 announce/spawn 拦截点在决定是否放行前调用。
 */
export function isSessionAborted(cfg: OpenClawConfig, sessionKey: string | undefined): boolean {
  const key = normalizeControllerSessionKey(cfg, sessionKey);
  if (!key) {
    return false;
  }
  return ABORTED.has(key);
}

/**
 * 记一条「announce 因 abort 被丢弃」。
 * 仅在会话已打标时计数；未打标时返回 0（调用方无需提前 isSessionAborted）。
 * 返回值为当前累计丢弃数，供调用方写日志。
 */
export function noteDroppedAnnounce(cfg: OpenClawConfig, sessionKey: string | undefined): number {
  const key = normalizeControllerSessionKey(cfg, sessionKey);
  if (!key) {
    return 0;
  }
  const entry = ABORTED.get(key);
  if (!entry) {
    return 0;
  }
  entry.droppedCount += 1;
  return entry.droppedCount;
}

/**
 * 清标：用户产生真实新消息时调用，解除 abort 闸。
 * 若中止期间有 announce 被丢弃，记一条汇总 info 日志方便事后审计。
 */
export function clearSessionAbort(cfg: OpenClawConfig, sessionKey: string | undefined): void {
  const key = normalizeControllerSessionKey(cfg, sessionKey);
  if (!key) {
    return;
  }
  const entry = ABORTED.get(key);
  if (!entry) {
    return;
  }
  ABORTED.delete(key);
  if (entry.droppedCount > 0) {
    log.info(`[abort-guard] cleared sessionKey=${key} droppedAnnounces=${entry.droppedCount}`);
  }
}

/**
 * 仅供测试使用：重置内部状态。
 * 生产代码不得调用（通过命名约定 __testing 前缀强制隔离）。
 */
export const __testing = {
  reset(): void {
    ABORTED.clear();
  },
};
