// ADR-0033 任务84(c) review P1-1 回归：用真实 handoff（真实 reconcileSessionTranscriptIndexes，
// 不 mock）验证"已登记 + mainKey 已是当前值"的冷库在后台准入里不会自己等自己。
// 这种库 open 阶段会跳过真正开库，开库动作落到 migrate 阶段的 handoff 里：
// reconcileSessionTranscriptIndexes → runProjectionWrite → withOpenClawAgentDatabaseAsync，
// 修复前这条间接调用链会拿到本员工尚未完成的准入 promise（也就是自己），永远等不到；
// 连 cancelAgentStartupAdmission 也打断不了，关闭 / 热重启 drain 会一直挂着。
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { isCanonicalSqliteSessionMainKeyCurrent } from "../config/sessions/session-canonical-key.js";
import { sessionTranscriptIndexNeedsReconcile } from "../config/sessions/session-transcript-index.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  cancelAgentStartupAdmission,
  resetAgentStartupAdmissionForTest,
  waitForAgentStartupAdmission,
} from "../state/agent-startup-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
  withOpenClawAgentDatabaseAsync,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  runStartupSessionMigration,
  scheduleBackgroundStartupSessionMigration,
} from "./server-startup-session-migration.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await cancelAgentStartupAdmission();
  resetAgentStartupAdmissionForTest();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

/** 把"不靠外部事件永远不会 settle"变成几秒内可判定的结果，不把测试进程真的挂死。 */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<string> {
  return await Promise.race([
    promise.then(
      () => "settled",
      (error: unknown) => `rejected: ${String(error)}`,
    ),
    new Promise<string>((resolve) => {
      setTimeout(() => resolve("timeout"), ms).unref();
    }),
  ]);
}

describe("scheduleBackgroundStartupSessionMigration（真实 handoff）", () => {
  it("已登记且 mainKey 正确的冷库：后台准入经真实 reconcile handoff 完成，关闭也能收尾，不自己等自己", async () => {
    const root = fs.realpathSync.native(tempDirs.make("openclaw-bg-real-handoff-"));
    const stateDir = path.join(root, "state");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const env = { ...process.env };
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      const scope = {
        agentId: "main",
        env,
        sessionId: "cold-session",
        sessionKey: "agent:main:cold",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
      await persistSessionTranscriptTurn(scope, {
        messages: [{ eventId: "cold-message", message: { role: "user", content: "retained" } }],
        touchSessionEntry: false,
      });
      const options = toDatabaseOptions(resolveSqliteReadScope(scope));
      await waitForSessionTranscriptIndexReconcile(options);
      closeOpenClawAgentDatabasesForTest();
      // 先跑一遍阻塞版：它负责登记库 + 写入当前 mainKey，跑完即"稳定安装"的常态。
      await runStartupSessionMigration({ cfg, env, log: { info: vi.fn(), warn: vi.fn() } });
      // 再造一个需要 reconcile 的会话，让 handoff 真正走 runProjectionWrite 的开库路径。
      openOpenClawAgentDatabase(options)
        .db.prepare(
          "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
        )
        .run(scope.sessionId);
      closeOpenClawAgentDatabasesForTest();
      // 前置条件自证：确实是"已登记 + mainKey 当前"的分支（open 阶段会跳过开库）。
      expect(
        listOpenClawRegisteredAgentDatabases({ env }).some((entry) => entry.agentId === "main"),
      ).toBe(true);
      expect(isCanonicalSqliteSessionMainKeyCurrent(options, cfg.session?.mainKey)).toBe(true);

      const log = { info: vi.fn(), warn: vi.fn() };
      await scheduleBackgroundStartupSessionMigration({ cfg, env, log });
      const admission = waitForAgentStartupAdmission("main");
      expect(admission).toBeDefined();

      expect(await settlesWithin(admission!, 5_000)).toBe("settled");
      expect(log.warn).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        "session: rebuilt 1 transcript projection(s) for agent main before serving its history",
      );
      expect(
        await settlesWithin(
          withOpenClawAgentDatabaseAsync(options, (database) =>
            sessionTranscriptIndexNeedsReconcile(database.db, scope.sessionId),
          ),
          5_000,
        ),
      ).toBe("settled");
      expect(await settlesWithin(cancelAgentStartupAdmission(), 5_000)).toBe("settled");
    });
  });
});
