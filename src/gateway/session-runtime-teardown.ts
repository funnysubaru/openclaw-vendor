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
import { loadSessionStore } from "../config/sessions.js";
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

  // 1. Stop all spawned subagents (recursive, engine-native kill).
  let stoppedSubagents = 0;
  await safeStep("stopSubagents", sessionKey, () => {
    const result = stopSubagentsForRequester({ cfg, requesterSessionKey: target.canonicalKey });
    stoppedSubagents = result?.stopped ?? 0;
  });

  // 2. Abort the controller's own embedded Pi run (if one is active).
  if (sessionId) {
    await safeStep("abortEmbedded", sessionKey, () => abortEmbeddedPiRun(sessionId!));
  }

  // 3. Clear any pending message queues for the controller and all related keys.
  // Pass raw tabKeys — clearSessionQueues accepts Array<string | undefined> and skips
  // falsy keys internally, same as closeTrackedBrowserTabsForSessions below.
  await safeStep("clearQueues", sessionKey, () => clearSessionQueues(tabKeys));

  // 4. Wait for the embedded run to fully stop before releasing browser resources.
  // Cap at 15 s to match session-reset-service's timeout constant.
  if (sessionId) {
    await safeStep("waitRunEnd", sessionKey, () => waitForEmbeddedPiRunEnd(sessionId!, 15_000));
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
