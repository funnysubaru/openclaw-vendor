// ADR-0033 任务84(b)：逐个检查一个候选员工库路径的 schema preflight 逻辑，从
// openclaw-database-preflight.ts 搬过来——纯粹是为了不让那个文件顶过 oxlint 的
// max-lines 阈值（它本来就卡在上限），不是为了复用而抽象，调用方只有一个。
import { realpathSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "../infra/errors.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-snapshot-source.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { assertOpenClawAgentDatabaseForMaintenance } from "./openclaw-agent-db-maintenance.js";
import { readExistingAgentSchemaMeta } from "./openclaw-agent-db-schema-helpers.js";
import {
  assertAgentSchemaReadinessForPreflight,
  inspectPreflightCandidatePresence,
  openAgentPreflightConnection,
} from "./openclaw-agent-preflight-connection.js";
import type { OpenClawDatabaseSchemaPreflight } from "./openclaw-database-preflight.types.js";

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
    // 完整性检查推迟时怎么开连接见 openclaw-agent-preflight-connection.ts 的注释。
    ({ agentDatabase, agentSnapshot } = await openAgentPreflightConnection({
      realAgentPath,
      deferAgentIntegrityToAdmission: options.deferAgentIntegrityToAdmission,
      signal: options.signal,
    }));
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
        assertAgentSchemaReadinessForPreflight(
          agentDatabase,
          agentPath,
          agentVersion,
          options.deferAgentIntegrityToAdmission,
        );
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
