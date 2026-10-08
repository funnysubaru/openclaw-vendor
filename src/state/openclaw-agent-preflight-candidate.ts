// ADR-0033 任务84(b)：逐个检查一个候选员工库路径的 schema preflight 逻辑，从
// openclaw-database-preflight.ts 搬过来——纯粹是为了不让那个文件顶过 oxlint 的
// max-lines 阈值（它本来就卡在上限），不是为了复用而抽象，调用方只有一个。
import { realpathSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "../infra/errors.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { hasNodeErrorCode } from "../infra/path-guards.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-snapshot-source.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { assertOpenClawAgentDatabaseForMaintenance } from "./openclaw-agent-db-maintenance.js";
import {
  assertCanonicalAgentPersistenceVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-helpers.js";
import type { OpenClawDatabaseSchemaPreflight } from "./openclaw-database-preflight.types.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";

/** 候选路径存在/缺失/读不了三态判定；state 分支（主文件）与 agent 分支（本文件）共用。 */
export function inspectPreflightCandidatePresence(
  databasePath: string,
): { status: "present" | "absent" } | { status: "indeterminate"; reason: string } {
  try {
    statSync(databasePath);
    return { status: "present" };
  } catch (error) {
    return hasNodeErrorCode(error, "ENOENT")
      ? { status: "absent" }
      : { status: "indeterminate", reason: formatErrorMessage(error) };
  }
}

/** 读数据库写者的 app 版本号，仅用于丰富报错信息；读不到不算故障。 */
export function readWriterAppVersion(database: DatabaseSync): string | undefined {
  try {
    const row = database
      .prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1")
      .get() as { app_version?: unknown } | undefined;
    return typeof row?.app_version === "string" && row.app_version.length > 0
      ? row.app_version
      : undefined;
  } catch {
    return undefined;
  }
}

/** 检查 inspectionTargets 里的一个候选员工库路径；所有结果通过改写 result 传回。 */
export async function inspectAgentDatabaseCandidateForPreflight(params: {
  row: { agentId?: string; path: string };
  options: {
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    supportedVersions: { agent: number };
    requireStartupMigrationReadiness?: boolean;
    verifyCurrentSchemaShape?: boolean;
    deferAgentIntegrityToAdmission?: boolean;
  };
  result: OpenClawDatabaseSchemaPreflight;
  inspectedAgentPaths: Set<string>;
  inspectedAgentTargets: Set<string>;
}): Promise<void> {
  const { row, options, result, inspectedAgentPaths, inspectedAgentTargets } = params;
  const agentPath = row.path;
  const presence = inspectPreflightCandidatePresence(agentPath);
  if (presence.status === "absent") {
    return;
  }
  if (presence.status === "indeterminate") {
    result.indeterminate.push({ kind: "agent", path: agentPath, reason: presence.reason });
    return;
  }
  let agentDatabase: DatabaseSync | undefined;
  let agentSnapshot: Awaited<ReturnType<typeof prepareSqliteReadOnlyLocation>> | undefined;
  try {
    // Preserve SQLite's filesystem traversal through symlink/.. locators.
    const realAgentPath = realpathSync.native(agentPath);
    const inspectionKey = `${realAgentPath}\0${row.agentId ?? ""}`;
    if (
      inspectedAgentTargets.has(inspectionKey) ||
      (row.agentId === undefined && inspectedAgentPaths.has(realAgentPath))
    ) {
      return;
    }
    inspectedAgentPaths.add(realAgentPath);
    inspectedAgentTargets.add(inspectionKey);
    if (options.deferAgentIntegrityToAdmission) {
      // 任务84(b)：这一遍只读版本号/便宜元数据，不整库拷贝，直接对活文件开普通只读连接；
      // 完整性扫描推迟到 session-migration 经 openclaw-agent-db-admission.ts 的
      // assertSqliteIntegrityInWorker 真正打开这个库时（本来就会做一次）。跟
      // sqlite-integrity.worker.ts 读活库同一手法：WAL 读者自带一致视图，readOnly 已禁止写入。
      agentDatabase = openNodeSqliteDatabase(realAgentPath, { readOnly: true });
    } else {
      // Live agents keep committing during inspection. Online backup preserves
      // database/WAL contents while allowing SQLite to update SHM read marks.
      agentSnapshot = await prepareSqliteReadOnlyLocation(realAgentPath, {
        signal: options.signal,
      });
      options.signal?.throwIfAborted();
      agentDatabase = openNodeSqliteDatabase(agentSnapshot.location, { readOnly: true });
    }
    agentDatabase.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    const agentVersion = readSqliteUserVersion(agentDatabase);
    if (agentVersion < options.supportedVersions.agent) {
      (result.pendingMigrations ??= []).push({
        kind: "agent",
        path: agentPath,
        ...(row.agentId !== undefined ? { agentId: row.agentId } : {}),
        foundVersion: agentVersion,
        supportedVersion: options.supportedVersions.agent,
      });
    }
    if (agentVersion <= options.supportedVersions.agent) {
      if (options.requireStartupMigrationReadiness) {
        // 完整性扫描（integrity_check + 外键检查）是这一遍唯一昂贵的部分，推迟时交给准入去做；
        // 版本号/元数据校验是几条 O(1) SELECT，照常做。
        if (!options.deferAgentIntegrityToAdmission) {
          assertSqliteIntegrity(agentDatabase, agentPath);
        }
        assertCanonicalAgentPersistenceVersion(agentDatabase, agentPath, agentVersion);
      }
      const agentId =
        row.agentId ??
        (options.requireStartupMigrationReadiness
          ? readExistingAgentSchemaMeta(agentDatabase)?.agentId
          : undefined);
      if (
        options.verifyCurrentSchemaShape === true &&
        agentId != null &&
        (!options.requireStartupMigrationReadiness || agentVersion > 0)
      ) {
        assertOpenClawAgentDatabaseForMaintenance(agentDatabase, { agentId, pathname: agentPath });
      }
      return;
    }
    const writerAppVersion = readWriterAppVersion(agentDatabase);
    result.incompatible.push({
      kind: "agent",
      path: agentPath,
      ...(row.agentId !== undefined ? { agentId: row.agentId } : {}),
      foundVersion: agentVersion,
      supportedVersion: options.supportedVersions.agent,
      ...(writerAppVersion ? { writerAppVersion } : {}),
    });
  } catch (error) {
    if (options.signal?.aborted || options.requireStartupMigrationReadiness) {
      throw error;
    }
    result.indeterminate.push({
      kind: "agent",
      path: agentPath,
      reason: formatErrorMessage(error),
    });
  } finally {
    try {
      agentDatabase?.close();
    } finally {
      agentSnapshot?.cleanup();
    }
  }
}
