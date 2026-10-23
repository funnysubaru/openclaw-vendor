// 启动死锁回归（2026-10-23 live 实证）：gateway 启动时「中断会话恢复扫描」先占住某员工库的
// 写队列，在队列里异步开库时去等该员工的后台启动准入；而准入 migrate 阶段的转录对账也要进
// 同一条写队列，排在恢复扫描后面 → 两边互等，gateway 永远停在 starting。
// 修复语义：写入方在进入写队列之前先等完该库的启动准入，占着队列时不再等准入。
import { afterEach, expect, test } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  resetAgentStartupAdmissionForTest,
  scheduleAgentStartupAdmission,
  waitForAgentStartupAdmission,
} from "../../state/agent-startup-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  withOpenClawAgentDatabaseAsync,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import { drainSessionStoreWriterQueuesForTest } from "./store-writer-state.js";

afterEach(async () => {
  await drainSessionStoreWriterQueuesForTest();
  closeOpenClawAgentDatabasesForTest();
  resetAgentStartupAdmissionForTest();
});

/** 超时即判死锁：两边互等时不会 reject，只会永远 pending。 */
function within<T>(promise: Promise<T>, ms: number): Promise<T | "deadlock"> {
  return Promise.race([
    promise,
    new Promise<"deadlock">((resolve) => {
      setTimeout(() => resolve("deadlock"), ms).unref();
    }),
  ]);
}

test("准入未完成时，外部写入不占着写队列等准入（不与准入自己的写入互等）", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = { agentId: "worker", env: state.env };
    // 冷库：外部写入在队列里只能走异步开库 → 进 withOpenClawAgentDatabaseAsync 等准入。
    openOpenClawAgentDatabase({ agentId: "worker", env: state.env });
    closeOpenClawAgentDatabasesForTest();

    const migrateMayWrite = createDeferredCore();
    const admissionWrites: string[] = [];
    scheduleAgentStartupAdmission({
      agentIds: ["worker"],
      openAgent: async () => {},
      migrateAgent: async () => {
        await migrateMayWrite.promise;
        // 对应准入 handoff 里的转录对账 runProjectionWrite → runExclusiveSqliteSessionWrite。
        await runExclusiveSqliteSessionWrite(
          scope,
          async () => {
            admissionWrites.push("reconcile");
          },
          "session.transcript.batch",
        );
      },
    });
    expect(waitForAgentStartupAdmission("worker")).toBeDefined();

    // 对应恢复扫描：先进写队列，再在队列里异步开库。
    const recovery = runExclusiveSqliteSessionWrite(
      scope,
      async () =>
        await withOpenClawAgentDatabaseAsync(
          { agentId: "worker", env: state.env },
          (db) => db.path,
        ),
      "session.entry-replacements",
    );
    // 让恢复扫描先跑到「等准入」这一步，再放准入去写。
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    migrateMayWrite.resolve();

    const result = await within(recovery, 3_000);
    expect(result).not.toBe("deadlock");
    expect(admissionWrites).toEqual(["reconcile"]);
    expect(waitForAgentStartupAdmission("worker")).toBeUndefined();
  });
});
