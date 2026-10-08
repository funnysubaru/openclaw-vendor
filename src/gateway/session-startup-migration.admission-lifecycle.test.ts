// 后台启动准入的关停与启动恢复（PR #132 审查项 U1 / U2 / U3）：
// - U2 / U3：gateway 关停（cancelAgentStartupAdmission）要立即打断 open / migrate 两个阶段里
//   进行中的完整性检查，不能干等大库检查自然跑完；
// - U1：启动孤儿会话标记遇到还在准入的员工库会等它完成，恢复语义（abortedLastRun）不丢。
// 真实临时 SQLite + 真实后台迁移调度，只把完整性 worker 换成会响应 signal 的慢检查。
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { markStartupOrphanedMainSessionsForRecovery } from "../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { scheduleBackgroundSessionStartupMigration } from "../config/sessions/startup-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import {
  cancelAgentStartupAdmission,
  resetAgentStartupAdmissionForTest,
  waitForAgentStartupAdmission,
} from "../state/agent-startup-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  runStartupSessionMigration,
  scheduleBackgroundStartupSessionMigration,
} from "./server-startup-session-migration.js";

afterEach(() => {
  resetAgentStartupAdmissionForTest();
});

async function tick(ms = 20) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("后台启动准入的关停与启动恢复", () => {
  // 审查项 U1：未接 helper 的启动后台任务：上次生命周期中断的 running 会话要在 post-attach 阶段（监听之后、
  // 渠道启动之前）被标记为待恢复。准入期间它对还在准入的员工库怎么表现？
  it("启动孤儿会话标记等员工准入完成，之后照常标记待恢复", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
        session: { mainKey: "work" },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      const target = { agentId: "main", sessionKey: "agent:main:chat1", sessionId: "main-run" };
      await upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        updatedAt: Date.now() - 10_000,
        status: "running",
      });
      await upsertSessionEntryCore(
        { agentId: "ops", sessionKey: "agent:ops:chat1", sessionId: "ops-1" },
        { sessionId: "ops-1", updatedAt: 1 },
      );
      const mainPath = openOpenClawAgentDatabase({ agentId: "main" }).path;
      closeOpenClawAgentDatabasesForTest();
      const release = createDeferred<void>();
      const actualCheck = integrityWorker.assertSqliteIntegrityInWorker;
      vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
        async (pathname, busyTimeoutMs, signal) => {
          if (pathname === mainPath) {
            await release.promise;
          }
          return await actualCheck(pathname, busyTimeoutMs, signal);
        },
      );
      await scheduleBackgroundSessionStartupMigration({
        cfg,
        log: { info: vi.fn(), warn: vi.fn() },
      });
      try {
        await waitForAgentStartupAdmission("ops");
        expect(waitForAgentStartupAdmission("main")).toBeDefined();
        const marking = markStartupOrphanedMainSessionsForRecovery({
          cfg,
          startupCheckedStorePaths: new Set<string>(),
        }).then(
          (value) => ({ kind: "resolved" as const, value }),
          (error: unknown) => ({ kind: "threw" as const, error: String(error) }),
        );
        const inWindow = await Promise.race([
          marking,
          tick(2_000).then(() => ({ kind: "blocked" as const })),
        ]);
        release.resolve();
        const final = await marking;
        // 观察项，只记录现状（owner 尚未决定是否改）：标记会等 main 准入完成（窗口内 blocked），
        // 但恢复语义不丢——准入完成后照常标记、abortedLastRun=true。
        expect(inWindow.kind).toBe("blocked");
        expect(final).toEqual({ kind: "resolved", value: expect.anything() });
        expect(loadSessionEntry(target)?.abortedLastRun).toBe(true);
      } finally {
        release.resolve();
        vi.restoreAllMocks();
        await cancelAgentStartupAdmission();
      }
    });
  });

  // 审查项 U2：关停顺序：准入 open 阶段正在跑完整性检查时 gateway 关闭。mock 的检查与真实 worker 一样会响应
  // 传进来的 abort signal——看调度器 cancel 能否打断它，还是只能干等检查自然结束。
  it("关停立即打断 open 阶段进行中的完整性检查", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        agents: { ownership: "explicit", entries: { main: {} } },
        session: { mainKey: "work" },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:chat1", sessionId: "main-1" },
        { sessionId: "main-1", updatedAt: 1 },
      );
      const mainPath = openOpenClawAgentDatabase({ agentId: "main" }).path;
      closeOpenClawAgentDatabasesForTest();
      const entered = createDeferred<void>();
      const slowCheckDone = createDeferred<void>();
      let checkAborted = false;
      vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
        async (pathname, _busyTimeoutMs, signal) => {
          if (pathname !== mainPath) {
            return;
          }
          entered.resolve();
          // 模拟一个大库的慢检查：10 秒，或被 signal 打断。
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 10_000);
            signal?.addEventListener("abort", () => {
              checkAborted = true;
              clearTimeout(timer);
              reject(signal.reason);
            });
          });
          slowCheckDone.resolve();
        },
      );
      await scheduleBackgroundSessionStartupMigration({
        cfg,
        log: { info: vi.fn(), warn: vi.fn() },
      });
      await entered.promise;
      const cancelled = cancelAgentStartupAdmission().then(() => "cancelled");
      const outcome = await Promise.race([cancelled, tick(2_000).then(() => "still-waiting")]);
      await cancelled;
      vi.restoreAllMocks();
      expect(outcome).toBe("cancelled");
      expect(checkAborted).toBe(true);
    });
  }, 30_000);

  // 审查项 U3：P2-1 的 migrate 阶段：库已登记且 mainKey 已是当前值时 open 阶段跳过开库，冷库在 handoff
  // （真实 reconcileSessionTranscriptIndexes → runProjectionWrite）里才开、才做完整性检查。
  // cancel 也必须立即打断这一步，而不是等检查自然跑完。
  it("关停立即打断 migrate 阶段（handoff reconcile 开库）进行中的完整性检查", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        agents: { ownership: "explicit", entries: { main: {} } },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:chat1", sessionId: "main-1" },
        { sessionId: "main-1", updatedAt: 1 },
      );
      const mainPath = openOpenClawAgentDatabase({ agentId: "main" }).path;
      closeOpenClawAgentDatabasesForTest();
      // 先跑一遍阻塞版：登记库并写入当前 mainKey，之后 open 阶段会跳过开库。
      await runStartupSessionMigration({ cfg, log: { info: vi.fn(), warn: vi.fn() } });
      closeOpenClawAgentDatabasesForTest();

      const entered = createDeferred<void>();
      let checkAborted = false;
      vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
        async (pathname, _busyTimeoutMs, signal) => {
          if (pathname !== mainPath) {
            return;
          }
          entered.resolve();
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 10_000);
            signal?.addEventListener("abort", () => {
              checkAborted = true;
              clearTimeout(timer);
              reject(signal.reason);
            });
          });
        },
      );
      await scheduleBackgroundStartupSessionMigration({
        cfg,
        log: { info: vi.fn(), warn: vi.fn() },
      });
      await entered.promise;
      const cancelled = cancelAgentStartupAdmission().then(() => "cancelled");
      const outcome = await Promise.race([cancelled, tick(2_000).then(() => "still-waiting")]);
      await cancelled;
      vi.restoreAllMocks();
      expect(outcome).toBe("cancelled");
      expect(checkAborted).toBe(true);
    });
  }, 30_000);
});
