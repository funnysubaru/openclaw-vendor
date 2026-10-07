// ADR-0033 任务84(c)：scheduleBackgroundSessionStartupMigration 端到端行为测试——
// 跟 ../../gateway/session-startup-migration.test.ts 测的阻塞版 runStartupSessionMigration
// 不是同一个契约，这里验证的是"调度调用本身很快返回"、"请求路径摸到还在后台准入的
// agentId 会透明等待、不抢跑"、"handoffDatabase 最终真的会被调用"。
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  cancelAgentStartupAdmission,
  resetAgentStartupAdmissionForTest,
} from "../../state/agent-startup-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  withOpenClawAgentDatabaseAsync,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { scheduleBackgroundSessionStartupMigration } from "./startup-migration.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  // 每个用例结束前把这一轮调度出的后台工作真正收尾，不留着跑进下一个用例。
  await cancelAgentStartupAdmission();
  resetAgentStartupAdmissionForTest();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function makeLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("scheduleBackgroundSessionStartupMigration", () => {
  it("调度本身很快返回；后台 open+migrate 跑完后才 handoff；同一个 agentId 的请求路径会透明等待，不抢跑", async () => {
    const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-bg-admission-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    // 必须先有真实的员工库文件：函数用 fs.existsSync 过滤掉还没创建过数据库的员工。
    openOpenClawAgentDatabase({ agentId: "main", env });
    closeOpenClawAgentDatabasesForTest();

    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    const log = makeLog();
    let handedOffAgentId: string | undefined;
    const handoffGate = deferred();

    await scheduleBackgroundSessionStartupMigration({
      cfg,
      env,
      log,
      handoffDatabase: async (options) => {
        handedOffAgentId = options.agentId;
        handoffGate.resolve();
      },
    });

    // 调度调用自己已经返回了——这正是"不阻塞 HTTP 监听"的那部分；真正的迁移此刻
    // 大概率还没跑完，不能假设 handoff 已经发生。
    expect(handedOffAgentId).toBeUndefined();

    // 请求路径摸到同一个 agentId，必须被挡住等后台准入完成，不能跟后台任务抢跑。
    let requestRan = false;
    const requestPromise = withOpenClawAgentDatabaseAsync({ agentId: "main", env }, () => {
      requestRan = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(requestRan).toBe(false);

    await handoffGate.promise;
    await requestPromise;
    expect(handedOffAgentId).toBe("main");
    expect(requestRan).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("没有任何员工库文件时什么都不登记、什么都不做", async () => {
    const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-bg-admission-empty-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const cfg: OpenClawConfig = { agents: { entries: { main: {}, ops: {} } } };
    const handoffDatabase = vi.fn(async () => undefined);

    await scheduleBackgroundSessionStartupMigration({ cfg, env, log: makeLog(), handoffDatabase });

    expect(handoffDatabase).not.toHaveBeenCalled();
  });
});
