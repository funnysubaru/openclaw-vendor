import fs from "node:fs";
import path from "node:path";
import { formatCliCommand } from "../../cli/command-format.js";
import { formatDoctorStateRepairFailure } from "../../infra/state-repair-message.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { readAgentDeletionJournal } from "../../state/agent-deletion-journal.js";
import { scheduleAgentStartupAdmission } from "../../state/agent-startup-admission.js";
import { listOpenClawRegisteredAgentDatabases } from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPath,
  isOpenClawAgentDatabaseOpen,
  withOpenClawAgentDatabaseAsync,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { resolveStateDir } from "../paths.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { migrateLegacyMainSessionKeys } from "./legacy-main-session-migration.js";
import { SessionStoreMigrationRequiredError } from "./migration-required.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  isCanonicalSqliteSessionMainKeyCurrent,
  setCanonicalSqliteSessionMainKey,
} from "./session-canonical-key.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import {
  listConfiguredSessionStoreAgentIds,
  resolveAllAgentSessionStoreTargetsSync,
} from "./targets.js";
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

type SessionStoreTarget = ReturnType<typeof resolveAllAgentSessionStoreTargetsSync>[number];

/**
 * 证明"请求里的逻辑员工就是要等的物理库 owner"（review2~4 收口）：配置中每个员工的配置存储、
 * 以及目标发现得到的每个库（含已移出配置员工的保留旧库），都必须解析成以该员工自己为
 * owner、且不是共享库（固定 .sqlite 路径会被多个员工共用）。另外配置了
 * agents.defaults.sessionStore.agentId（把退役 main 的行收归到别的员工库）也视为证明不了。
 * 任何一条不满足或解析抛错都返回 false，请求入口就对所有员工等待全部在途准入——宁可多等
 * 几秒，也不按一张可能残缺的"逻辑 → 物理"表收窄。
 */
function provesOneToOneAgentStorage(
  cfg: OpenClawConfig,
  targets: readonly SessionStoreTarget[],
  env: NodeJS.ProcessEnv,
): boolean {
  if (cfg.agents?.defaults?.sessionStore?.agentId) {
    return false;
  }
  try {
    const stores = [
      ...listConfiguredSessionStoreAgentIds(cfg).map((agentId) => ({
        agentId,
        storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId, env }),
      })),
      ...targets,
    ];
    return stores.every((store) => {
      const agentId = normalizeAgentId(store.agentId);
      if (resolveSqliteTargetFromSessionStorePath(store.storePath, { agentId, env }).shared) {
        return false;
      }
      return (
        normalizeAgentId(toDatabaseOptions(resolveSqliteReadScope({ ...store, env })).agentId) ===
        agentId
      );
    });
  } catch {
    return false;
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
 * - open 阶段故意不吞错误（只关掉本阶段开出的冷连接再重抛）：main-key 设置失败原样
 *   抛给调度器，调度器把这个 agentId 标记为失败（failedByAgentId），migrate 阶段（含 handoffDatabase）
 *   整段都不会跑——跟阻塞版"main-key 设置失败仍然尝试 handoff"的 best-effort 语义不
 *   同，这里选择"开都没开成功，就不要再假装能安全移交"的更保守语义。
 * - 两个阶段内部照常用 withOpenClawAgentDatabaseAsync：调度器把整个准入工作跑在该员工
 *   的异步上下文作用域里，作用域内（含 handoff → reconcile → runProjectionWrite 这类
 *   间接开库）对自己这个 agentId 不等待，不会自己等自己（见 agent-startup-admission.ts）。
 * - 同一个员工可能有多个物理库（配置的自定义库 + 默认目录里保留的库）：按员工聚合全部
 *   target，open / migrate 各自逐个处理完，员工准入才算完成（review P2：单值 Map 会让
 *   后遇到的库静默覆盖前一个，被覆盖的那份既不更新 mainKey 也不 handoff）。
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
  const itemsByAgentId = new Map<string, PreparedBackgroundSessionStartupMigrationTarget[]>();
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
    const item = {
      target,
      options,
      databasePath,
      alreadyOpen: isOpenClawAgentDatabaseOpen(databasePath),
    };
    const items = itemsByAgentId.get(options.agentId);
    if (items) {
      items.push(item);
    } else {
      itemsByAgentId.set(options.agentId, [item]);
    }
  }
  // 没 handoff 成功的冷连接不能留给运行期（调用方只在未 handoff 时调用）：跟阻塞版每个
  // target 的 finally 同一条规则。
  const closeColdConnection = (item: PreparedBackgroundSessionStartupMigrationTarget) => {
    if (!item.alreadyOpen && isOpenClawAgentDatabaseOpen(item.databasePath)) {
      closeOpenClawAgentDatabaseByPath(item.databasePath);
    }
  };
  if (itemsByAgentId.size === 0) {
    return;
  }

  scheduleAgentStartupAdmission({
    agentIds: [...itemsByAgentId.keys()],
    narrowRequestsToAgent: provesOneToOneAgentStorage(params.cfg, targets, env),
    openAgent: async (agentId) => {
      const items = itemsByAgentId.get(agentId) ?? [];
      try {
        for (const item of items) {
          if (
            !registeredDatabases.has(`${item.options.agentId}\0${item.databasePath}`) ||
            !isCanonicalSqliteSessionMainKeyCurrent(item.options, mainKey)
          ) {
            await withOpenClawAgentDatabaseAsync(item.options, (database) =>
              setCanonicalSqliteSessionMainKey(database, mainKey),
            );
          }
        }
      } catch (error) {
        // open 失败后 migrate 阶段不会再跑，这里就把本阶段开出来的冷连接收掉。
        items.forEach(closeColdConnection);
        throw error;
      }
    },
    migrateAgent: async (agentId) => {
      // 一份库 handoff 失败就不再 handoff 后面的库（失败原样抛给调度器，员工整体不可用），
      // 但每一份没 handoff 的冷连接都要关掉。
      let failure: { error: unknown } | undefined;
      for (const item of itemsByAgentId.get(agentId) ?? []) {
        let handedOff = false;
        try {
          if (failure) {
            continue;
          }
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
        } catch (error) {
          failure = { error };
        } finally {
          if (!handedOff) {
            closeColdConnection(item);
          }
        }
      }
      if (failure) {
        throw failure.error;
      }
    },
  });
}
