import {
  runSessionStartupMigration,
  scheduleBackgroundSessionStartupMigration,
  type SessionStartupMigrationLogger,
} from "../config/sessions/startup-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type SessionMigrationDeps = Parameters<typeof runSessionStartupMigration>[0]["deps"] & {
  reconcileSessionTranscriptIndexes?: typeof import("../config/sessions/session-transcript-reconcile.js").reconcileSessionTranscriptIndexes;
};

/**
 * Await SQLite maintenance and projection repair before serving session history.
 *
 * Blocking contract — kept exactly as-is for existing callers/tests
 * (src/gateway/session-startup-migration.test.ts asserts that awaiting this
 * resolves only once every target has been migrated and handed off, and that a
 * handoff failure rejects this promise). Gateway's own normal startup no longer
 * calls this; it calls scheduleBackgroundStartupSessionMigration below instead
 * (ADR-0033 任务84(c)) so a slow agent database can't hold up the HTTP listener.
 */
export async function runStartupSessionMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: SessionStartupMigrationLogger;
  deps?: SessionMigrationDeps;
}): Promise<void> {
  let reconcile = params.deps?.reconcileSessionTranscriptIndexes;
  let reconciledSessions = 0;
  await runSessionStartupMigration({
    ...params,
    handoffDatabase: async (database) => {
      reconcile ??= (await import("../config/sessions/session-transcript-reconcile.js"))
        .reconcileSessionTranscriptIndexes;
      reconciledSessions += (await reconcile(database)).reconciledSessions;
    },
  });
  if (reconciledSessions > 0) {
    params.log.info(
      `session: rebuilt ${reconciledSessions} transcript projection(s) before serving history`,
    );
  }
}

/**
 * ADR-0033 任务84(c)：gateway 冷启动用的非阻塞版本。跟上面的 runStartupSessionMigration
 * 不是同一个契约——这里返回的 promise 只代表"后台调度已经登记完成"，不代表迁移和
 * transcript 移交已经跑完，所以每个员工的"重建了几条 transcript 投影"改成在它自己
 * 完成的那一刻单独记一条日志，不再等全部跑完才汇总打一条。
 */
export async function scheduleBackgroundStartupSessionMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: SessionStartupMigrationLogger;
  deps?: SessionMigrationDeps;
}): Promise<void> {
  let reconcile = params.deps?.reconcileSessionTranscriptIndexes;
  await scheduleBackgroundSessionStartupMigration({
    ...params,
    handoffDatabase: async (options) => {
      reconcile ??= (await import("../config/sessions/session-transcript-reconcile.js"))
        .reconcileSessionTranscriptIndexes;
      const { reconciledSessions } = await reconcile(options);
      if (reconciledSessions > 0) {
        params.log.info(
          `session: rebuilt ${reconciledSessions} transcript projection(s) for agent ${options.agentId} before serving its history`,
        );
      }
    },
  });
}
