// ADR-0033 任务84(c)：员工库后台启动准入未完成时，cron 运行先写入 runningAtMs（面板显示
// "运行中"），再在真正执行前等待准入；准入完成后照常成功；等待中关闭 / 热重启（cancel）
// 时本次运行按中断结束、runningAtMs 被清掉，不会卡在"运行中"；准入已失败的员工立即按
// 同一原因记为失败。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import {
  cancelAgentStartupAdmission,
  resetAgentStartupAdmissionForTest,
  scheduleAgentStartupAdmission,
  waitForAgentStartupAdmission,
} from "../state/agent-startup-admission.js";
import { CronService } from "./service.js";

const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const tempDirs: string[] = [];

afterEach(async () => {
  resetAgentStartupAdmissionForTest();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
  }
});

/** open 阶段卡在 gate 上，但响应调度器 abort（模拟真实准入工作在关闭时收尾）。 */
function scheduleGatedAdmission() {
  const gate = createDeferred<void>();
  scheduleAgentStartupAdmission({
    agentIds: ["main"],
    openAgent: async (_agentId, signal) => await racePromiseWithAbortSignal(gate.promise, signal),
    migrateAgent: async () => {},
  });
  return gate;
}

async function startCron() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-admission-"));
  tempDirs.push(dir);
  const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
  const cron = new CronService({
    storePath: path.join(dir, "cron", "jobs.json"),
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob,
  });
  await cron.start();
  const job = await cron.add({
    name: "admission",
    enabled: true,
    deleteAfterRun: false,
    schedule: { kind: "at", at: new Date("2030-01-01T00:00:00.000Z").toISOString() },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "run" },
    delivery: { mode: "none" },
  });
  const readJob = async () => (await cron.list({ includeDisabled: true }))[0];
  return { cron, job, runIsolatedAgentJob, readJob };
}

describe("cron run waits for agent startup admission", () => {
  it("准入中触发运行 → runningAtMs 先写入 → 等待 → 准入完成后成功", async () => {
    const { cron, job, runIsolatedAgentJob, readJob } = await startCron();
    const gate = scheduleGatedAdmission();
    try {
      const run = cron.run(job.id, "force");
      await vi.waitFor(async () => {
        expect((await readJob())?.state.runningAtMs).toBeTypeOf("number");
      });
      // 给足时间：不等待的实现此时早已执行完。
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect((await readJob())?.state.runningAtMs).toBeTypeOf("number");

      gate.resolve();
      await expect(run).resolves.toEqual({ ok: true, ran: true });
      expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
      const finished = await readJob();
      expect(finished?.state.lastStatus).toBe("ok");
      expect(finished?.state.runningAtMs).toBeUndefined();
    } finally {
      gate.resolve();
      cron.stop();
      await cancelAgentStartupAdmission();
    }
  });

  it("等待中 cancel（关闭 / 热重启）→ 本次运行按中断结束，不卡在运行中", async () => {
    const { cron, job, runIsolatedAgentJob, readJob } = await startCron();
    scheduleGatedAdmission();
    try {
      const run = cron.run(job.id, "force");
      await vi.waitFor(async () => {
        expect((await readJob())?.state.runningAtMs).toBeTypeOf("number");
      });

      await cancelAgentStartupAdmission();
      await run;
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      const finished = await readJob();
      expect(finished?.state.runningAtMs).toBeUndefined();
      expect(finished?.state.lastStatus).toBe("error");
      expect(finished?.state.lastError).toContain(
        "Gateway stopped during agent database startup admission",
      );
    } finally {
      cron.stop();
    }
  });

  it("员工准入已失败 → 立即按同一原因记为失败", async () => {
    const { cron, job, runIsolatedAgentJob, readJob } = await startCron();
    scheduleAgentStartupAdmission({
      agentIds: ["main"],
      openAgent: async () => {
        throw new Error("main integrity failed");
      },
      migrateAgent: async () => {},
    });
    try {
      await expect(waitForAgentStartupAdmission("main")).rejects.toThrow("main integrity failed");
      await cron.run(job.id, "force");
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      const finished = await readJob();
      expect(finished?.state.runningAtMs).toBeUndefined();
      expect(finished?.state.lastStatus).toBe("error");
      expect(finished?.state.lastError).toContain("main integrity failed");
    } finally {
      cron.stop();
      await cancelAgentStartupAdmission();
    }
  });
});
