import fs from "node:fs";
import path from "node:path";
import { formatCliCommand } from "../../cli/command-format.js";
import { formatDoctorStateRepairFailure } from "../../infra/state-repair-message.js";
import { readAgentDeletionJournal } from "../../state/agent-deletion-journal.js";
import { scheduleAgentStartupAdmission } from "../../state/agent-startup-admission.js";
import { listOpenClawRegisteredAgentDatabases } from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPath,
  isOpenClawAgentDatabaseOpen,
  withOpenClawAgentDatabaseAsync,
  withOpenClawAgentDatabaseAsyncSkippingStartupAdmissionWait,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { resolveStateDir } from "../paths.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { migrateLegacyMainSessionKeys } from "./legacy-main-session-migration.js";
import { SessionStoreMigrationRequiredError } from "./migration-required.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  isCanonicalSqliteSessionMainKeyCurrent,
  setCanonicalSqliteSessionMainKey,
} from "./session-canonical-key.js";
import { resolveAllAgentSessionStoreTargetsSync } from "./targets.js";
import { migrateManagedWorktreeCanonicalWorkspaces } from "./worktree-workspace-migration.js";

export type SessionStartupMigrationLogger = Record<"info" | "warn", (message: string) => void>;

export function assertSessionStoreMigrationComplete(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  targets?: readonly { storePath: string }[];
  operation?: "doctor";
}): void {
  const env = params.env ?? process.env;
  const targets = params.targets ?? resolveAllAgentSessionStoreTargetsSync(params.cfg, { env });
  const legacyStore = [
    path.join(resolveStateDir(env), "sessions", "sessions.json"),
    ...targets.map((target) => target.storePath),
  ].find((storePath) => !storePath.endsWith(".sqlite") && fs.existsSync(storePath));
  if (legacyStore) {
    throw new SessionStoreMigrationRequiredError(
      params.operation === "doctor"
        ? formatDoctorStateRepairFailure(
            `Legacy session store requires migration at ${legacyStore}`,
            "Repair the retained source using the migration report's named file and validation error, preserving the original history.",
          )
        : `Legacy session store requires migration: ${legacyStore}. Run "${formatCliCommand("openclaw doctor --fix", env)}" against the same state/config before starting OpenClaw.`,
    );
  }
}

/** Maintains existing stores, optionally handing each live database to its runtime owner. */
export async function runSessionStartupMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: SessionStartupMigrationLogger;
  handoffDatabase?: (database: OpenClawAgentDatabaseOptions) => Promise<void>;
  deps?: {
    migrateLegacyMainSessionKeys?: typeof migrateLegacyMainSessionKeys;
    migrateManagedWorktreeCanonicalWorkspaces?: typeof migrateManagedWorktreeCanonicalWorkspaces;
    resolveAllAgentSessionStoreTargetsSync?: typeof resolveAllAgentSessionStoreTargetsSync;
  };
}): Promise<void> {
  const env = params.env ?? process.env;
  const resolveTargets =
    params.deps?.resolveAllAgentSessionStoreTargetsSync ?? resolveAllAgentSessionStoreTargetsSync;
  let targets = resolveTargets(params.cfg, { env });
  // Stable installations may still have file-backed history. Only Doctor imports it;
  // do not serve an empty SQLite history or rewrite those files during startup.
  assertSessionStoreMigrationComplete({ cfg: params.cfg, env, targets });
  const migrateLegacyMain =
    params.deps?.migrateLegacyMainSessionKeys ?? migrateLegacyMainSessionKeys;
  const result = await migrateLegacyMain({ cfg: params.cfg, env, mode: "automatic" });
  if (result.changes.length > 0) {
    params.log.info(
      `session: migrated retired main-agent session keys:\n${result.changes.map((change) => `- ${change}`).join("\n")}`,
    );
  }
  if (result.warnings.length > 0) {
    params.log.warn(
      `session: retired main-agent session migration warnings:\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}`,
    );
  }
  if (result.armed) {
    // A partial move can create the destination before source cleanup succeeds.
    targets = resolveTargets(params.cfg, { env });
  }

  const databases = new Set<string>();
  const migrateWorktreeSessions =
    params.deps?.migrateManagedWorktreeCanonicalWorkspaces ??
    migrateManagedWorktreeCanonicalWorkspaces;
  const registeredDatabases = new Set(
    listOpenClawRegisteredAgentDatabases({ env }).map((entry) => `${entry.agentId}\0${entry.path}`),
  );
  let migratedWorktreeSessions = 0;
  for (const target of targets) {
    const options = toDatabaseOptions(resolveSqliteReadScope({ ...target, env }));
    const databasePath = resolveOpenClawAgentSqlitePath(options);
    if (databases.has(databasePath) || !fs.existsSync(databasePath)) {
      continue;
    }
    databases.add(databasePath);
    // Retained stores remain discoverable, but only deletion cleanup may write them.
    // Check the physical owner so surviving shared stores still reach their runtime.
    const deletion = readAgentDeletionJournal(options.agentId, { env });
    if (deletion) {
      params.log.info(
        `session: skipping deleted agent database for ${options.agentId} (${deletion.cleanupCompleted ? "cleanup complete" : "cleanup pending; retry agent deletion"})`,
      );
      continue;
    }
    const alreadyOpen = isOpenClawAgentDatabaseOpen(databasePath);
    let handedOff = false;
    try {
      try {
        const mainKey = params.cfg.session?.mainKey;
        if (
          !registeredDatabases.has(`${options.agentId}\0${databasePath}`) ||
          !isCanonicalSqliteSessionMainKeyCurrent(options, mainKey)
        ) {
          await withOpenClawAgentDatabaseAsync(options, (database) =>
            setCanonicalSqliteSessionMainKey(database, mainKey),
          );
        }
        // Workspace metadata participates in claim matching. Preserve it during a
        // partial move so the next attempt can finish removing the source claim.
        if (!result.armed || result.complete) {
          migratedWorktreeSessions += await migrateWorktreeSessions({
            ...target,
            cfg: params.cfg,
            env,
          });
        }
      } catch (error) {
        params.log.warn(
          `session: SQLite startup maintenance failed for ${target.agentId}; continuing: ${String(error)}`,
        );
      }
      if (params.handoffDatabase) {
        // Runtime readiness failures must propagate; only successful handoff
        // transfers the cold connection beyond this maintenance operation.
        await params.handoffDatabase(options);
        handedOff = true;
      }
    } finally {
      if (!alreadyOpen && !handedOff && isOpenClawAgentDatabaseOpen(databasePath)) {
        closeOpenClawAgentDatabaseByPath(databasePath);
      }
    }
  }
  if (migratedWorktreeSessions > 0) {
    params.log.info(
      `session: recorded canonical workspaces for ${migratedWorktreeSessions} managed-worktree session(s)`,
    );
  }
}

/** One per-agent row prepared by scheduleBackgroundSessionStartupMigration below. */
interface PreparedBackgroundSessionStartupMigrationTarget {
  target: ReturnType<typeof resolveAllAgentSessionStoreTargetsSync>[number];
  options: OpenClawAgentDatabaseOptions;
  databasePath: string;
  alreadyOpen: boolean;
}

/**
 * ADR-0033 任务84(c)：gateway 冷启动专用的后台准入路径——跟上面的
 * runSessionStartupMigration 是两个独立入口，不是同一个函数的新模式开关。那个函数
 * 一大批既有测试（src/gateway/session-startup-migration.test.ts 等）验证的就是
 * "await 它等于等到迁移 + 移交全部完成，失败原样 reject" 这个阻塞契约，改不得；这里
 * 是新增的平行路径，专给"gateway 正常启动、不想被逐员工检查卡住监听"这个场景用。
 *
 * 行为差异（刻意，不是疏漏）：
 * - 返回的 promise 只覆盖"算出要处理哪些员工 + 登记进后台调度器"这一段（几次
 *   fs.existsSync 快速检查 + 一次 migrateLegacyMainSessionKeys，不是真正慢的那部分）。
 *   调用方 await 它不会被逐员工的 open+migrate 卡住——那部分在后台继续跑。
 * - 真正的 open（设置 canonical main key，会触发 openclaw-agent-db-admission.ts 里
 *   的完整性扫描——这是真正慢的部分）与 migrate（worktree 迁移 + handoff）分别排进
 *   scheduleAgentStartupAdmission 的 open/migrate 两个并发池（上限对齐上游
 *   AGENT_DATABASE_PREFLIGHT_CONCURRENCY=2 / AGENT_DATABASE_PREPARATION_CONCURRENCY=4）
 *   在后台跑。请求如果在后台任务跑完前摸到同一个 agentId，会在
 *   withOpenClawAgentDatabaseAsync 里被 waitForAgentStartupAdmission 挡住等它，
 *   不会跟后台任务抢着并发开同一个 sqlite 文件。
 * - open 阶段内部故意不自己 try/catch：main-key 设置失败会原样抛给调度器，调度器把
 *   这个 agentId 标记为失败（failedByAgentId），migrate 阶段（含 handoffDatabase）
 *   整段都不会跑——跟阻塞版"main-key 设置失败仍然尝试 handoff"的 best-effort 语义不
 *   同，这里选择"开都没开成功，就不要再假装能安全移交"的更保守语义。
 * - 两个阶段内部改用 withOpenClawAgentDatabaseAsyncSkippingStartupAdmissionWait
 *   （绕过等待检查的内部入口）——因为这段代码本身就是在处理"自己被调度器登记为正在
 *   准入"的那个 agentId，如果还调普通 withOpenClawAgentDatabaseAsync，会撞上
 *   waitForAgentStartupAdmission 返回的正是自己这个 work promise，变成自己等自己的
 *   死锁。
 */
export async function scheduleBackgroundSessionStartupMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: SessionStartupMigrationLogger;
  handoffDatabase?: (options: OpenClawAgentDatabaseOptions) => Promise<void>;
  deps?: {
    migrateLegacyMainSessionKeys?: typeof migrateLegacyMainSessionKeys;
    migrateManagedWorktreeCanonicalWorkspaces?: typeof migrateManagedWorktreeCanonicalWorkspaces;
    resolveAllAgentSessionStoreTargetsSync?: typeof resolveAllAgentSessionStoreTargetsSync;
  };
}): Promise<void> {
  const env = params.env ?? process.env;
  const resolveTargets =
    params.deps?.resolveAllAgentSessionStoreTargetsSync ?? resolveAllAgentSessionStoreTargetsSync;
  let targets = resolveTargets(params.cfg, { env });
  // Stable installations may still have file-backed history. Only Doctor imports it;
  // do not serve an empty SQLite history or rewrite those files during startup.
  assertSessionStoreMigrationComplete({ cfg: params.cfg, env, targets });
  const migrateLegacyMain =
    params.deps?.migrateLegacyMainSessionKeys ?? migrateLegacyMainSessionKeys;
  const result = await migrateLegacyMain({ cfg: params.cfg, env, mode: "automatic" });
  if (result.changes.length > 0) {
    params.log.info(
      `session: migrated retired main-agent session keys:\n${result.changes.map((change) => `- ${change}`).join("\n")}`,
    );
  }
  if (result.warnings.length > 0) {
    params.log.warn(
      `session: retired main-agent session migration warnings:\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}`,
    );
  }
  if (result.armed) {
    // A partial move can create the destination before source cleanup succeeds.
    targets = resolveTargets(params.cfg, { env });
  }

  const mainKey = params.cfg.session?.mainKey;
  const worktreeEligible = !result.armed || result.complete;
  const migrateWorktreeSessions =
    params.deps?.migrateManagedWorktreeCanonicalWorkspaces ??
    migrateManagedWorktreeCanonicalWorkspaces;
  const registeredDatabases = new Set(
    listOpenClawRegisteredAgentDatabases({ env }).map((entry) => `${entry.agentId}\0${entry.path}`),
  );

  const databases = new Set<string>();
  const itemsByAgentId = new Map<string, PreparedBackgroundSessionStartupMigrationTarget>();
  for (const target of targets) {
    const options = toDatabaseOptions(resolveSqliteReadScope({ ...target, env }));
    const databasePath = resolveOpenClawAgentSqlitePath(options);
    if (databases.has(databasePath) || !fs.existsSync(databasePath)) {
      continue;
    }
    databases.add(databasePath);
    // Retained stores remain discoverable, but only deletion cleanup may write them.
    // Check the physical owner so surviving shared stores still reach their runtime.
    const deletion = readAgentDeletionJournal(options.agentId, { env });
    if (deletion) {
      params.log.info(
        `session: skipping deleted agent database for ${options.agentId} (${deletion.cleanupCompleted ? "cleanup complete" : "cleanup pending; retry agent deletion"})`,
      );
      continue;
    }
    // Key by the (normalized, via options.agentId) agent id — scheduleAgentStartupAdmission
    // normalizes the same way, so openAgent/migrateAgent below always find their target.
    itemsByAgentId.set(options.agentId, {
      target,
      options,
      databasePath,
      alreadyOpen: isOpenClawAgentDatabaseOpen(databasePath),
    });
  }
  if (itemsByAgentId.size === 0) {
    return;
  }

  scheduleAgentStartupAdmission({
    agentIds: [...itemsByAgentId.keys()],
    openAgent: async (agentId) => {
      const item = itemsByAgentId.get(agentId);
      if (!item) {
        return;
      }
      if (
        !registeredDatabases.has(`${item.options.agentId}\0${item.databasePath}`) ||
        !isCanonicalSqliteSessionMainKeyCurrent(item.options, mainKey)
      ) {
        await withOpenClawAgentDatabaseAsyncSkippingStartupAdmissionWait(item.options, (database) =>
          setCanonicalSqliteSessionMainKey(database, mainKey),
        );
      }
    },
    migrateAgent: async (agentId) => {
      const item = itemsByAgentId.get(agentId);
      if (!item) {
        return;
      }
      let handedOff = false;
      try {
        try {
          // Workspace metadata participates in claim matching. Preserve it during a
          // partial move so the next attempt can finish removing the source claim.
          if (worktreeEligible) {
            const migratedWorktreeSessions = await migrateWorktreeSessions({
              ...item.target,
              cfg: params.cfg,
              env,
            });
            if (migratedWorktreeSessions > 0) {
              params.log.info(
                `session: recorded canonical workspace for ${migratedWorktreeSessions} managed-worktree session(s) (agent ${item.options.agentId})`,
              );
            }
          }
        } catch (error) {
          params.log.warn(
            `session: SQLite startup maintenance failed for ${item.options.agentId}; continuing: ${String(error)}`,
          );
        }
        if (params.handoffDatabase) {
          // Runtime readiness failures must propagate; only successful handoff
          // transfers the cold connection beyond this maintenance operation.
          await params.handoffDatabase(item.options);
          handedOff = true;
        }
      } finally {
        if (!item.alreadyOpen && !handedOff && isOpenClawAgentDatabaseOpen(item.databasePath)) {
          closeOpenClawAgentDatabaseByPath(item.databasePath);
        }
      }
    },
  });
}
