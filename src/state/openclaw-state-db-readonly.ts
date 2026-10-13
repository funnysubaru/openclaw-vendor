import { AsyncLocalStorage } from "node:async_hooks";
import { statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { SqliteCoordinatorError } from "../infra/sqlite-coordinator.js";
import type { PreparedSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.js";
import {
  prepareSqliteReadOnlyLocation,
  prepareSqliteReadOnlyLocationSync,
} from "../infra/sqlite-snapshot-source.js";
import { withSqliteSourceHandle } from "../infra/sqlite-source-handle.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import { openDanglingWorkshopIndexReadAdmission } from "./openclaw-state-db-dangling-workshop-index.js";
import { assertSupportedStateSchemaVersion } from "./openclaw-state-db-schema-version.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const artifactPreservingReads = resolveGlobalSingleton(
  Symbol.for("openclaw.artifactPreservingStateReads"),
  () => new AsyncLocalStorage<boolean>(),
);

/** Admission scopes every nested reader without changing normal live-read semantics. */
export function withArtifactPreservingStateReads<T>(operation: () => T): T {
  return artifactPreservingReads.run(true, operation);
}

export function isArtifactPreservingStateRead(): boolean {
  return artifactPreservingReads.getStore() === true;
}

// 任务99 热点③（与上游 #147861 同一思路，按本仓库现有函数实现）：
// 「保留原文件」模式的只读访问（gateway 启动预检期间）每读一次共享状态库，都要先同步起一个
// SQLite 子进程把库复制成私有快照再读，避免只读打开也在原库旁边生成 WAL 等附属文件。
// 一次「全员读配置」里要读好几次（持久化插件索引、配置机器状态……），每次各起一个子进程；
// Windows 上起一个要 0.5～1 秒。这里让一次同步操作内对同一个库只准备一份快照、各次读取共用，
// 操作结束立即删除。边界：
// - 只在调用方显式包了 withSynchronousArtifactPreservingStateSnapshot、且处于保留原文件模式时生效；
// - 操作必须是同步的（快照表挂在进程级变量上，跨 await 会被别的操作看到），返回 Promise 直接报错；
// - 同一次操作内看到的是同一时刻的库内容，操作期间别处提交的新数据要到下一次操作才可见
//   （这次操作本来就是一个时间点的视图，上游同样如此）。
const synchronousReadSnapshots = resolveGlobalSingleton(
  Symbol.for("openclaw.synchronousStateReadSnapshots"),
  (): { current: Map<string, PreparedSqliteReadOnlyLocation> | undefined } => ({
    current: undefined,
  }),
);

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** One synchronous metadata operation shares one private snapshot per database. */
export function withSynchronousArtifactPreservingStateSnapshot<T>(operation: () => T): T {
  if (!isArtifactPreservingStateRead() || synchronousReadSnapshots.current) {
    return operation();
  }
  const snapshots = new Map<string, PreparedSqliteReadOnlyLocation>();
  synchronousReadSnapshots.current = snapshots;
  let result!: T;
  let failed = false;
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    result = operation();
    if (isPromiseLike(result)) {
      throw new SqliteCoordinatorError("SQLite metadata snapshot scope must remain synchronous");
    }
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    synchronousReadSnapshots.current = undefined;
    for (const prepared of snapshots.values()) {
      try {
        if (!prepared.cleanup()) {
          cleanupErrors.push(new Error("Shared-state metadata snapshot cleanup is incomplete."));
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    snapshots.clear();
  }
  if (cleanupErrors.length) {
    throw new AggregateError(
      failed ? [failure, ...cleanupErrors] : cleanupErrors,
      "Shared-state metadata snapshot cleanup failed.",
    );
  }
  if (failed) {
    throw failure;
  }
  return result;
}

type OpenClawStateReadOnlyDatabase = {
  db: DatabaseSync;
  path: string;
};

type ReusedOpenClawStateReadOnlyDatabase<T> = { reused: false } | { reused: true; value: T };

/** Missing runtime tables are empty only before state grows beyond checkpoint bootstrap. */
export function hasOpenClawStateTablesBeyondStartupCheckpoint(db: DatabaseSync): boolean {
  return (
    /* sqlite-allow-raw -- Read-only startup-checkpoint schema discriminator. */ db
      .prepare(
        "SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name NOT IN ('schema_meta', 'state_leases') LIMIT 1",
      )
      .get() !== undefined
  );
}

function resolveReadOnlyPath(options: OpenClawStateDatabaseOptions): string {
  return path.resolve(options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env));
}

function existingPathOrUndefined(pathname: string): string | undefined {
  try {
    statSync(pathname);
    return pathname;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function withOpenClawStateDatabaseReadOnlyIfOpen<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  pathname: string,
): ReusedOpenClawStateReadOnlyDatabase<T> {
  const opened = openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(pathname);
  if (!opened || opened.db.isTransaction) {
    return { reused: false };
  }
  try {
    const closeSchemaReadAdmission = openDanglingWorkshopIndexReadAdmission(opened.db);
    try {
      // Process-local terminal failures evict this handle. Persisted quarantine
      // is checked on the next physical open so hot reads do not poll metadata.
      // A newer build can migrate this file while the handle stays open, so the
      // forward-compatibility gate still runs before any reused read.
      assertSupportedStateSchemaVersion(opened.db, pathname);
      return { reused: true, value: operation(opened) };
    } finally {
      closeSchemaReadAdmission?.();
    }
  } catch (error) {
    openClawStateDatabaseCache.evictOpenClawStateDatabaseAfterCorruption(opened, error);
    throw error;
  }
}

function withFreshOpenClawStateDatabaseReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions,
  pathname: string,
): T {
  const env = options.env ?? process.env;
  openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
  // Even read-only SQLite opens can create a missing WAL. The existing worker
  // snapshots committed WAL pages without touching source sidecars or caller-held locks.
  // 任务99：处于共用快照的同步操作内时，同一个库只准备一次快照，由操作结束时统一清理。
  const shared = synchronousReadSnapshots.current;
  if (shared && isArtifactPreservingStateRead()) {
    let snapshot = shared.get(pathname);
    if (!snapshot) {
      snapshot = prepareSqliteReadOnlyLocationSync(pathname);
      shared.set(pathname, snapshot);
    }
    const result = withOpenClawStateReadOnlyLocation(operation, pathname, snapshot.location);
    if (isPromiseLike(result)) {
      throw new SqliteCoordinatorError("SQLite metadata snapshot read must remain synchronous");
    }
    return result;
  }
  const prepared = isArtifactPreservingStateRead()
    ? prepareSqliteReadOnlyLocationSync(pathname)
    : undefined;
  try {
    return withOpenClawStateReadOnlyLocation(operation, pathname, prepared?.location ?? pathname);
  } finally {
    prepared?.cleanup();
  }
}

function withOpenClawStateReadOnlyLocation<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  pathname: string,
  location: string,
): T {
  const read = () => {
    const db = openNodeSqliteDatabase(location, { readOnly: true });
    let closeSchemaReadAdmission: (() => void) | undefined;
    try {
      db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
      closeSchemaReadAdmission = openDanglingWorkshopIndexReadAdmission(db);
      assertSupportedStateSchemaVersion(db, pathname);
      return operation({ db, path: pathname });
    } finally {
      try {
        closeSchemaReadAdmission?.();
      } finally {
        clearNodeSqliteKyselyCacheForDatabase(db);
        db.close();
      }
    }
  };
  // Only live-source descriptors join handle custody; snapshots remain private.
  return location === pathname ? withSqliteSourceHandle(pathname, read) : read();
}

/** Read shared state without joining writers; admission inherits artifact preservation. */
export function withOpenClawStateDatabaseReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T {
  const pathname = resolveReadOnlyPath(options);
  // Reusing a handle this process already holds keeps row loops cheap: opening
  // and closing a connection per call made shared-state reads scale with row
  // count. An in-flight transaction is skipped so callers never observe
  // uncommitted rows a fresh read-only connection could not have seen.
  // 任务99：同一次共用快照的操作内保持读同一份快照，不中途改读进程里刚打开的活句柄。
  if (synchronousReadSnapshots.current?.has(pathname)) {
    return withFreshOpenClawStateDatabaseReadOnly(operation, options, pathname);
  }
  const reused = withOpenClawStateDatabaseReadOnlyIfOpen(operation, pathname);
  if (reused.reused) {
    return reused.value;
  }
  return withFreshOpenClawStateDatabaseReadOnly(operation, options, pathname);
}

/** Read existing shared state while preserving non-missing filesystem failures. */
export function withExistingOpenClawStateDatabaseReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T | undefined {
  const pathname = resolveReadOnlyPath(options);
  // 任务99：同一次共用快照的操作内保持读同一份快照，不中途改读进程里刚打开的活句柄。
  if (synchronousReadSnapshots.current?.has(pathname)) {
    return withFreshOpenClawStateDatabaseReadOnly(operation, options, pathname);
  }
  const reused = withOpenClawStateDatabaseReadOnlyIfOpen(operation, pathname);
  if (reused.reused) {
    return reused.value;
  }
  const existingPath = existingPathOrUndefined(pathname);
  return existingPath === undefined
    ? undefined
    : withFreshOpenClawStateDatabaseReadOnly(operation, options, existingPath);
}

/** Read existing shared state without creating or updating its SQLite sidecars. */
export function withExistingOpenClawStateDatabaseArtifactPreservingReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T | undefined {
  return withArtifactPreservingStateReads(() =>
    withExistingOpenClawStateDatabaseReadOnly(operation, options),
  );
}

/** Preserve source artifacts while allowing the caller to progress during snapshot preparation. */
export function withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): Promise<T | undefined> {
  return withArtifactPreservingStateReads(async () => {
    const pathname = resolveReadOnlyPath(options);
    const reused = withOpenClawStateDatabaseReadOnlyIfOpen(operation, pathname);
    if (reused.reused) {
      return reused.value;
    }
    if (existingPathOrUndefined(pathname) === undefined) {
      return undefined;
    }
    const env = options.env ?? process.env;
    openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
    const prepared = await prepareSqliteReadOnlyLocation(pathname, {
      preserveSourceArtifacts: true,
    });
    try {
      // Verification can quarantine the live path while the snapshot child is running.
      openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
      return withOpenClawStateReadOnlyLocation(operation, pathname, prepared.location);
    } finally {
      prepared.cleanup();
    }
  });
}
