import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "../infra/errors.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { hasNodeErrorCode } from "../infra/path-guards.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-snapshot-source.js";
import { assertCanonicalAgentPersistenceVersion } from "./openclaw-agent-db-schema-helpers.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";

/** 候选路径存在/缺失/读不了三态判定——原来是主文件里的本地闭包，没捕获任何外部状态，
 * 现在是 state 分支（主文件）与 agent 分支（candidate.ts）共用的同一份判定逻辑。 */
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

/**
 * ADR-0033 任务84(b)：为员工库 schema preflight 开一个只读连接，两条路径择一。
 * 默认：整库拷贝到临时快照再开（完整性扫描需要一份冻结的、长时间持有安全的副本）。
 * deferAgentIntegrityToAdmission 为 true 时：直接对活文件开普通只读连接，不整库
 * 拷贝——这一遍只读版本号/便宜元数据，完整性扫描推迟到真正打开这个库时（
 * session-migration 经 openclaw-agent-db-admission.ts 的 assertSqliteIntegrityInWorker
 * 本来就会做一次）。跟 sqlite-integrity.worker.ts 读活库同一手法，WAL 读者自带一致
 * 视图；{readOnly:true} 已经禁止了写入，不需要再额外加 PRAGMA query_only。
 *
 * 这个文件和 openclaw-agent-preflight-candidate.ts 都是从
 * openclaw-database-preflight.ts 拆出来的，纯粹是为了不让那个文件顶过 oxlint 的
 * max-lines 阈值（它本来就卡在上限），不是为了复用而抽象。
 */
export async function openAgentPreflightConnection(params: {
  realAgentPath: string;
  deferAgentIntegrityToAdmission: boolean | undefined;
  signal?: AbortSignal;
}): Promise<{
  agentDatabase: DatabaseSync;
  agentSnapshot?: Awaited<ReturnType<typeof prepareSqliteReadOnlyLocation>>;
}> {
  if (params.deferAgentIntegrityToAdmission) {
    const agentDatabase = openNodeSqliteDatabase(params.realAgentPath, { readOnly: true });
    agentDatabase.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    return { agentDatabase };
  }
  const agentSnapshot = await prepareSqliteReadOnlyLocation(params.realAgentPath, {
    signal: params.signal,
  });
  // 从这里开始，这份快照的清理责任在本函数手里：调用方只有在"成功拿到返回值"之后
  // 才会把 agentSnapshot 记进它自己的变量、靠它自己的 finally 去清理。如果下面任何
  // 一步（含 open 失败）在返回之前就抛错，调用方永远拿不到这个 agentSnapshot 引用，
  // 这里不自己清理就会在临时目录下漏一份快照（这正是 2026-10-06 抽取这段代码时
  // 引入又被 openclaw-database-preflight.artifacts.test.ts 的
  // "cleans the main snapshot when its private open fails" 测试抓出来的那个回归）。
  try {
    params.signal?.throwIfAborted();
    const agentDatabase = openNodeSqliteDatabase(agentSnapshot.location, { readOnly: true });
    agentDatabase.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    return { agentDatabase, agentSnapshot };
  } catch (error) {
    agentSnapshot.cleanup();
    throw error;
  }
}

/**
 * 完整性扫描（PRAGMA integrity_check + 外键检查）是这一遍里唯一真正昂贵的部分；
 * deferAgentIntegrityToAdmission 时交给后面真正打开这个库的那一步去做（本来就会做）。
 * 版本号/元数据的 assertCanonicalAgentPersistenceVersion 是几条 O(1) SELECT，照常做。
 */
export function assertAgentSchemaReadinessForPreflight(
  agentDatabase: DatabaseSync,
  agentPath: string,
  agentVersion: number,
  deferAgentIntegrityToAdmission: boolean | undefined,
): void {
  if (!deferAgentIntegrityToAdmission) {
    assertSqliteIntegrity(agentDatabase, agentPath);
  }
  assertCanonicalAgentPersistenceVersion(agentDatabase, agentPath, agentVersion);
}
