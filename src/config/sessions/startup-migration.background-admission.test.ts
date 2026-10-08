// ADR-0033 任务84(c)：scheduleBackgroundSessionStartupMigration 端到端行为测试——
// 跟 ../../gateway/session-startup-migration.test.ts 测的阻塞版 runStartupSessionMigration
// 不是同一个契约，这里验证的是"调度调用本身很快返回"、"请求路径摸到还在后台准入的
// agentId 会透明等待、不抢跑"、"handoffDatabase 最终真的会被调用"。
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as integrityWorker from "../../infra/sqlite-integrity-worker.js";
import {
  AgentStartupAdmissionPendingError,
  cancelAgentStartupAdmission,
  resetAgentStartupAdmissionForTest,
  waitForAgentStartupAdmission,
} from "../../state/agent-startup-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseAsync,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { readRecentSessionTranscriptHistoryEvents } from "./session-accessor.sqlite-history-events.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  isCanonicalSqliteSessionMainKeyCurrent,
  setCanonicalSqliteSessionMainKey,
} from "./session-canonical-key.js";
import { scheduleBackgroundSessionStartupMigration } from "./startup-migration.js";
import { resolveAllAgentSessionStoreTargetsSync } from "./targets.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  vi.restoreAllMocks();
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

  // review P1-2 回归：历史读取（chat.history 的生产调用链 readRecentSessionTranscriptHistoryEvents
  // → withCurrentProjectionSnapshot）走同步开库。修复前它会在后台准入的 worker 完整性
  // 检查期间 revokePendingAgentDatabaseOpen，调度器把 revoked 错误永久记进失败表，之后
  // 健康库的异步请求一直被拒到重启。这里用受控的 worker 时序复现那个交错窗口。
  it("历史读取撞上后台完整性检查时不撤销后台准入；准入照常完成、handoff 发生、之后请求正常", async () => {
    const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-bg-admission-history-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    // mainKey 与配置不一致 → open 阶段必须真正异步开库，触发 worker 完整性检查。
    setCanonicalSqliteSessionMainKey(
      openOpenClawAgentDatabase({ agentId: "main", env }),
      "previous",
    );
    closeOpenClawAgentDatabasesForTest();

    const workerEntered = deferred();
    const releaseWorker = deferred();
    const actualCheck = integrityWorker.assertSqliteIntegrityInWorker;
    vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
      async (pathname, busyTimeoutMs, signal) => {
        workerEntered.resolve();
        await releaseWorker.promise;
        return await actualCheck(pathname, busyTimeoutMs, signal);
      },
    );
    const handoffDatabase = vi.fn(async () => undefined);
    await scheduleBackgroundSessionStartupMigration({
      cfg: { agents: { entries: { main: {} } }, session: { mainKey: "work" } },
      env,
      log: makeLog(),
      handoffDatabase,
    });
    const admission = waitForAgentStartupAdmission("main");
    expect(admission).toBeDefined();
    await workerEntered.promise;

    let historyError: unknown;
    try {
      readRecentSessionTranscriptHistoryEvents(
        { agentId: "main", env, sessionId: "history-during-admission" },
        { maxBytes: 1024 * 1024, maxLines: 20, maxMessages: 20 },
      );
    } catch (error) {
      historyError = error;
    } finally {
      releaseWorker.resolve();
    }

    // 后台准入不受历史读取影响：照常完成、handoff 一次、之后健康库的请求正常。
    await expect(admission).resolves.toBeUndefined();
    expect(handoffDatabase).toHaveBeenCalledOnce();
    await expect(
      withOpenClawAgentDatabaseAsync({ agentId: "main", env }, () => "healthy"),
    ).resolves.toBe("healthy");
    // 同步历史读取不能等待，只能在准入窗口内被明确拒绝（可重试）。
    expect(historyError).toBeInstanceOf(AgentStartupAdmissionPendingError);
  });

  // review P2 回归：同一个员工可以同时有配置的自定义库和默认目录下保留的库。修复前按
  // agentId 单值 Map 存 target，后遇到的默认库覆盖自定义库，只处理其中一份。
  it("同一员工的多个物理库全部处理：每份都更新 mainKey 并 handoff", async () => {
    const root = fs.realpathSync.native(tempDirs.make("openclaw-bg-admission-multi-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    // 先建默认库，再把 session.store 指向自定义库并把它也建出来（真实目标解析会两份都返回）。
    openOpenClawAgentDatabase({ agentId: "main", env });
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      session: { store: path.join(root, "custom", "custom.sqlite"), mainKey: "work" },
    };
    const targets = resolveAllAgentSessionStoreTargetsSync(cfg, { env });
    const databaseOptions = targets.map((target) =>
      toDatabaseOptions(resolveSqliteReadScope({ ...target, env })),
    );
    for (const options of databaseOptions) {
      openOpenClawAgentDatabase(options);
    }
    closeOpenClawAgentDatabasesForTest();
    const paths = databaseOptions.map((options) => resolveOpenClawAgentSqlitePath(options));
    // 前置条件自证：同一员工、两个不同的真实物理库。
    expect(targets.map((target) => target.agentId)).toEqual(["main", "main"]);
    expect(new Set(paths).size).toBe(2);

    const handedOff: string[] = [];
    await scheduleBackgroundSessionStartupMigration({
      cfg,
      env,
      log: makeLog(),
      handoffDatabase: async (options) => {
        handedOff.push(resolveOpenClawAgentSqlitePath(options));
      },
    });
    await waitForAgentStartupAdmission("main");

    expect(handedOff.toSorted()).toEqual(paths.toSorted());
    for (const options of databaseOptions) {
      expect(isCanonicalSqliteSessionMainKeyCurrent(options, "work")).toBe(true);
    }
  });
});
