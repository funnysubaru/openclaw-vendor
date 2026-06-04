// Non-destructive session runtime teardown for chat.abort.
//
// Mirrors the runtime-stop portion of session-reset-service's
// ensureSessionRuntimeCleanup (WITHOUT the reset-only archive/bootstrap work).
// Used so a panel/RPC chat.abort tears down the engine-native subagent subtree
// (embedded Pi runs + exec/browser), matching fast-abort and /kill semantics.
//
// Why this exists: gateway chat.abort only aborts chatAbortControllers (chat.send
// runs). Spawned subagents are embedded Pi runs in a separate registry, so without
// this teardown they keep running after the user hits Stop.

import { abortEmbeddedPiRun, waitForEmbeddedPiRunEnd } from "../agents/pi-embedded.js";
import { markSessionAborted } from "../agents/session-abort-guard.js";
import { listSubagentRunsForController } from "../agents/subagent-registry.js";
import { stopSubagentsForRequester } from "../auto-reply/reply/abort.js";
import { clearSessionQueues } from "../auto-reply/reply/queue.js";
import { closeTrackedBrowserTabsForSessions } from "../browser/session-tab-registry.js";
import { loadConfig } from "../config/config.js";
import { loadSessionStore, updateSessionStoreEntry } from "../config/sessions.js";
import { logVerbose } from "../globals.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGatewaySessionStoreTarget } from "./session-utils.js";

// Always-on (info-level) logger so a Stop-triggered cascade is observable in
// production logs. logVerbose alone is silent unless verbose mode is enabled, which
// makes it impossible to confirm in the field whether chat.abort actually tore down
// the subagent subtree.
const log = createSubsystemLogger("gateway");

/**
 * Recursively collect descendant subagent session keys under `controllerKey`,
 * returning ONLY active (`!endedAt`) descendants — so the tab-close scope matches the
 * kill scope of stopSubagentsForRequester.
 *
 * CRITICAL: mirror stopSubagentsForRequester's traversal exactly — it gates the *kill*
 * on `!run.endedAt` but RECURSES INTO EVERY child regardless (abort.ts cascades
 * `stopSubagentsForRequester({ requesterSessionKey: childKey })` for ended children
 * too). So an ended parent can still have an ACTIVE grandchild that the kill reaches;
 * that grandchild's tab must therefore be closed. Hence: add only active children to
 * the close-set, but recurse into all children (with a cycle guard).
 *
 * Why explicit at all: stopSubagentsForRequester does NOT close browser tabs (only
 * clears queues + abortEmbeddedPiRun + marks terminated), and
 * closeTrackedBrowserTabsForSessions closes only the keys it is given.
 */
function collectActiveSubagentDescendantKeys(controllerKey: string): string[] {
  const out = new Set<string>();
  const seen = new Set<string>();
  const visit = (key: string) => {
    for (const run of listSubagentRunsForController(key)) {
      const child = run.childSessionKey?.trim();
      if (!child) {
        continue;
      }
      if (!run.endedAt) {
        // Only active runs need tab close; ended runs are already done.
        out.add(child);
      }
      // Recurse into all children (active or ended) to reach active grandchildren.
      if (!seen.has(child)) {
        seen.add(child);
        visit(child);
      }
    }
  };
  visit(controllerKey);
  return [...out];
}

/**
 * Run one cleanup step in isolation so a throw in step N never skips step N+1.
 * All teardown steps are best-effort; errors are logged but not propagated.
 */
async function safeStep(label: string, sessionKey: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logVerbose(`chat.abort teardown: ${label} failed for ${sessionKey}: ${String(err)}`);
  }
}

/**
 * Best-effort: abort the subagent subtree spawned by `sessionKey`, plus the
 * controller's own embedded run, clear queues, and close tracked browser tabs for the
 * controller AND all active descendant subagents. Never throws. Each primitive is
 * isolated so a throw in one does NOT prevent closeTrackedBrowserTabsForSessions.
 */
export async function tearDownSessionRuntimeForAbort(params: {
  sessionKey: string;
}): Promise<void> {
  const { sessionKey } = params;

  // Resolve config and store target first — these are required for everything else.
  // If either fails, bail early; there is nothing useful we can do without them.
  let cfg: ReturnType<typeof loadConfig>;
  let target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  try {
    cfg = loadConfig();
    target = resolveGatewaySessionStoreTarget({ cfg, key: sessionKey });
  } catch (err) {
    logVerbose(`chat.abort teardown: resolve target failed for ${sessionKey}: ${String(err)}`);
    return;
  }

  // Attempt to resolve the controller's sessionId from the store.
  // loadSessionStore failure must NOT skip the rest — it only costs the embedded-run abort.
  // Walk all storeKeys (canonicalKey first) to handle legacy/variant key scenarios (P1-c).
  let sessionId: string | undefined;
  try {
    const store = loadSessionStore(target.storePath) as Record<
      string,
      { sessionId?: string } | undefined
    >;
    for (const k of [target.canonicalKey, ...target.storeKeys]) {
      const sid = store[k]?.sessionId;
      if (sid) {
        sessionId = sid;
        break;
      }
    }
  } catch (err) {
    // Best-effort: log and continue without sessionId; embedded abort will be skipped.
    logVerbose(`chat.abort teardown: loadSessionStore failed for ${sessionKey}: ${String(err)}`);
  }

  // Collect active descendant session keys for tab-close scope.
  // Failures here only affect which tabs get closed — not the kill itself.
  let descendantKeys: string[] = [];
  try {
    descendantKeys = collectActiveSubagentDescendantKeys(target.canonicalKey);
  } catch (err) {
    logVerbose(`chat.abort teardown: collect descendants failed for ${sessionKey}: ${String(err)}`);
  }

  // Build the full set of keys for tab close: controller + sessionId + all active descendants.
  // Undefined/empty sessionId is intentionally included; closeTrackedBrowserTabsForSessions
  // filters invalid keys internally.
  // Note: unlike session-reset-service's ensureSessionRuntimeCleanup, we do NOT inject the
  // raw incoming `sessionKey` separately — it is covered transitively via target.storeKeys.
  const tabKeys = [target.canonicalKey, ...target.storeKeys, sessionId, ...descendantKeys];

  // 打标：本会话进入 abort 态，阻断后续 announce 唤醒 / spawn（session-abort-guard）。
  // 在第一个 teardown 动作（stop subagents）之前打标，保证闸在 abort 流程开始时即生效，
  // 不给 announce 趁虚而入的窗口。key 用 target.canonicalKey（已归一），cfg 同一份 loadConfig。
  markSessionAborted(cfg, target.canonicalKey);

  // 持久化 orchestrator 的 abortedLastRun=true（与文本 /stop 的 persistAbortTargetEntry 对齐）。
  //
  // 为什么必须有这步（会话级 abort 闸的承重根因）：面板 chat.abort 走的是本 teardown，而文本 /stop
  // 走 commands-session-abort.ts 的 applyAbortTarget→persistAbortTargetEntry。后者会把 orchestrator
  // entry 的 abortedLastRun 写进 store；前者此前只打了内存闸（markSessionAborted），从不写盘。
  // 于是面板 Stop 后，下一轮真实用户消息进入 get-reply 时，session.ts 从 store 读出的
  // entry.abortedLastRun 恒为 false → 透传给嵌入式运行器的 abortedLastRunBeforeReset 恒 false →
  // 「会话级 abort 闸」判据 #2 恒 false → 闸永不触发（live 复验失败的直接原因）。
  //
  // 这里对 target.canonicalKey（=orchestrator/controller，已归一，绝非子 agent）打标，
  // 用 updateSessionStoreEntry：它在 entry 不存在时返回 null（不会凭空创建空 entry，避免把
  // 一个无 sessionId 的 entry 塞进 store 害下一轮误判为新会话），存在则 merge 后写盘并刷新 updatedAt
  // （刷新是必要的：下一轮 session.ts 的 freshEntry 判定依赖 updatedAt，刚写的标必然 fresh，读得到）。
  //
  // best-effort：包在 safeStep 里，store 写入失败（盘满/锁竞争）不能阻断后续 stop/closeTabs，
  // 与其它 teardown 步骤一致的隔离语义。
  //
  // ⚠️ 已知限制（review I1，书面接受）：本 teardown 被调用方 void（fire-and-forget，见
  // chat.ts 的 cascadeSessionTeardownForAdmin），这步 persist 是异步的。理论上若用户在 persist
  // 落盘前的极短窗口内（毫秒级）发「继续」，闸判据 #2 可能仍读到 false → 闸不触发（退化为旧 bug，
  // 但概率远低于「永不写盘」）。实践中人手「Stop → 看结果 → 打字继续」是秒级，远大于一次文件写，
  // 竞态几乎不可达。不在此处改同步持久化：会把 chat.ts 那条对 mismatch 很敏感的 cascade 闭包改成
  // 异步 + 重复 target 解析，得不偿失。若未来真观测到该竞态，再在 chat.ts cascade 路径补同步写盘。
  await safeStep("persistAbortedFlag", sessionKey, () =>
    updateSessionStoreEntry({
      storePath: target.storePath,
      sessionKey: target.canonicalKey,
      update: async () => ({ abortedLastRun: true }),
    }),
  );

  // 1. Stop all spawned subagents (recursive, engine-native kill).
  let stoppedSubagents = 0;
  await safeStep("stopSubagents", sessionKey, () => {
    const result = stopSubagentsForRequester({ cfg, requesterSessionKey: target.canonicalKey });
    stoppedSubagents = result?.stopped ?? 0;
  });

  // 2. Abort the controller's own embedded Pi run (if one is active).
  if (sessionId) {
    await safeStep("abortEmbedded", sessionKey, () => abortEmbeddedPiRun(sessionId));
  }

  // 3. Clear any pending message queues for the controller and all related keys.
  // Pass raw tabKeys — clearSessionQueues accepts Array<string | undefined> and skips
  // falsy keys internally, same as closeTrackedBrowserTabsForSessions below.
  await safeStep("clearQueues", sessionKey, () => clearSessionQueues(tabKeys));

  // 4. Wait for the embedded run to fully stop before releasing browser resources.
  // Cap at 15 s to match session-reset-service's timeout constant.
  if (sessionId) {
    await safeStep("waitRunEnd", sessionKey, () => waitForEmbeddedPiRunEnd(sessionId, 15_000));
  }

  // 5. Close all tracked browser tabs for the controller and active descendants.
  // This must always run regardless of what happened above (P2-a requirement).
  let tabsClosed = 0;
  await safeStep("closeTabs", sessionKey, async () => {
    tabsClosed =
      (await closeTrackedBrowserTabsForSessions({
        sessionKeys: tabKeys,
        onWarn: (message) => logVerbose(message),
      })) ?? 0;
  });

  // Observability: one always-on summary line so a Stop cascade is auditable in logs.
  // Example: [chat.abort] cascade teardown sessionKey=... stoppedSubagents=2 activeDescendants=3 tabsClosed=2
  log.info(
    `[chat.abort] cascade teardown sessionKey=${sessionKey} ` +
      `stoppedSubagents=${stoppedSubagents} activeDescendants=${descendantKeys.length} tabsClosed=${tabsClosed}`,
  );
}
