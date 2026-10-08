// reconcile 在后台启动准入里被关停中止后（PR #132 审查项"关停中止 reconcile"），走
// "worker 未正常结束"收尾（terminate planner + 另起 release worker 释放租约）。以前只有崩溃走，
// 现在关停常规走。真实 worker + 真实 SQLite + 真实准入调度器。
import { Worker, type WorkerOptions } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  cancelAgentStartupAdmission,
  resetAgentStartupAdmissionForTest,
  scheduleAgentStartupAdmission,
} from "../../state/agent-startup-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  reconcileSessionTranscriptIndexes,
  waitForSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";
import type {
  SessionTranscriptReconcileWorkerInput,
  SessionTranscriptReconcileWorkerMessage,
} from "./session-transcript-reconcile.worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  resetAgentStartupAdmissionForTest();
});
const options = { agentId: "main" };
const scope = { ...options, sessionId: "abort-fixture", sessionKey: "agent:main:abort-fixture" };

it.each(["on-create", "plan-start"] as const)(
  "关停在 %s 时中止准入内的 reconcile：租约释放、worker 全部退出、cancel 不卡、之后可正常 reconcile",
  async (trigger) => {
    const stateDir = tempDirs.make("openclaw-reconcile-admission-abort-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const workers: Worker[] = [];
      const modes: SessionTranscriptReconcileWorkerInput["mode"][] = [];
      try {
        await persistSessionTranscriptTurn(scope, {
          messages: [{ eventId: "seed", message: { role: "user", content: "abort fixture" } }],
          touchSessionEntry: false,
        });
        await waitForSessionTranscriptIndexReconcile(options);
        const database = openOpenClawAgentDatabase(options);
        database.db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
        const state = openOpenClawStateDatabase();
        const readLeases = () =>
          state.db.prepare("SELECT lease_id FROM agent_database_leases ORDER BY lease_id").all();
        const baseline = readLeases();

        let cancelling: Promise<void> | undefined;
        let cancelStartedAt = 0;
        const startCancel = () => {
          cancelStartedAt = Date.now();
          cancelling ??= cancelAgentStartupAdmission();
        };
        const createWorker = (filename: string | URL, workerOptions: WorkerOptions) => {
          const input = workerOptions.workerData as SessionTranscriptReconcileWorkerInput;
          modes.push(input.mode);
          const worker = new Worker(filename, workerOptions);
          workers.push(worker);
          if (input.mode === "disk") {
            if (trigger === "on-create") {
              startCancel();
            } else {
              worker.on("message", (message: SessionTranscriptReconcileWorkerMessage) => {
                if (message.type === "plan-start") {
                  startCancel();
                }
              });
            }
          }
          return worker;
        };

        let reconcileOutcome: { status: string; error?: unknown } | undefined;
        scheduleAgentStartupAdmission({
          agentIds: ["main"],
          openAgent: async () => {},
          migrateAgent: async () => {
            reconcileOutcome = await reconcileSessionTranscriptIndexes({
              ...options,
              createWorker,
            }).then(
              () => ({ status: "fulfilled" }),
              (error: unknown) => ({ status: "rejected", error }),
            );
          },
        });
        await vi.waitFor(
          () => {
            expect(cancelling).toBeDefined();
          },
          { timeout: 15_000, interval: 10 },
        );
        await cancelling;
        const cancelMs = Date.now() - cancelStartedAt;
        expect(reconcileOutcome?.status).toBe("rejected");
        expect(String(reconcileOutcome?.error)).not.toContain("cleanup incomplete");
        expect(modes).toEqual(["disk", "release"]);
        expect(workers.every((worker) => worker.threadId === -1)).toBe(true);
        expect(readLeases()).toEqual(baseline);
        expect(cancelMs).toBeLessThan(5_000);

        // 关停之后（模拟热重启后的下一轮）同一个库能正常 reconcile，残留的半截投影不卡住。
        const again = await reconcileSessionTranscriptIndexes(options);
        expect(again.reconciledSessions).toBe(1);
        expect(readLeases()).toEqual(baseline);
      } finally {
        await Promise.all(workers.map((worker) => worker.terminate()));
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
      }
    });
  },
  30_000,
);
