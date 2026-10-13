// 任务99 热点③：withSynchronousArtifactPreservingStateSnapshot 让一次同步操作内对同一个库只准备一份
// 私有只读快照（Windows 上每准备一次要同步起一个 SQLite 子进程，约 0.5～1 秒）。这里守住：
// 作用域内只准备一次、读到的数据一致；作用域外照旧每次准备；结束后快照被删掉；不在保留原文件模式时
// 不生效；作用域里返回 Promise 直接报错（共用表挂在进程级变量上，不能跨 await）。
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";

vi.mock("../infra/sqlite-snapshot-source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-snapshot-source.js")>();
  return {
    ...actual,
    prepareSqliteReadOnlyLocationSync: vi.fn(actual.prepareSqliteReadOnlyLocationSync),
  };
});

import * as snapshotSource from "../infra/sqlite-snapshot-source.js";
import {
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseReadOnly,
  withSynchronousArtifactPreservingStateSnapshot,
} from "./openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const prepare = vi.mocked(snapshotSource.prepareSqliteReadOnlyLocationSync);

afterEach(() => {
  prepare.mockClear();
  closeOpenClawStateDatabaseForTest();
});

async function withHeldDatabase(run: (options: { env: NodeJS.ProcessEnv; path: string }) => void) {
  await withTempDir("openclaw-state-readonly-shared-", async (stateDir) => {
    const options = {
      env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" },
      path: path.join(stateDir, "state", "openclaw.sqlite"),
    };
    await fsp.mkdir(path.dirname(options.path), { recursive: true });
    const writer = new DatabaseSync(options.path);
    writer.exec("CREATE TABLE held(value TEXT); INSERT INTO held VALUES ('committed');");
    writer.close();
    run(options);
  });
}

const readHeld = (options: { env: NodeJS.ProcessEnv; path: string }) =>
  withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) => db.prepare("SELECT value FROM held").all(),
    options,
  );

describe("withSynchronousArtifactPreservingStateSnapshot", () => {
  it("一次操作内同一个库只准备一份快照，结束后删除", async () => {
    await withHeldDatabase((options) => {
      const results = withArtifactPreservingStateReads(() =>
        withSynchronousArtifactPreservingStateSnapshot(() => [
          readHeld(options),
          readHeld(options),
          readHeld(options),
        ]),
      );
      expect(results).toEqual([
        [{ value: "committed" }],
        [{ value: "committed" }],
        [{ value: "committed" }],
      ]);
      expect(prepare).toHaveBeenCalledTimes(1);
      const location = prepare.mock.results[0]?.value.location as string;
      expect(location).not.toBe(options.path);
      expect(fs.existsSync(location)).toBe(false);
      // 原库旁边不能多出 WAL 等附属文件。
      expect(fs.readdirSync(path.dirname(options.path))).toEqual(["openclaw.sqlite"]);
    });
  });

  it("不包作用域时照旧每次读都准备快照", async () => {
    await withHeldDatabase((options) => {
      withArtifactPreservingStateReads(() => {
        readHeld(options);
        readHeld(options);
      });
      expect(prepare).toHaveBeenCalledTimes(2);
    });
  });

  it("不在保留原文件模式时不生效，也不准备快照", async () => {
    await withHeldDatabase((options) => {
      const result = withSynchronousArtifactPreservingStateSnapshot(() => readHeld(options));
      expect(result).toEqual([{ value: "committed" }]);
      expect(prepare).not.toHaveBeenCalled();
    });
  });

  it("作用域里返回 Promise 直接报错，并且已准备的快照照样清理", async () => {
    await withHeldDatabase((options) => {
      expect(() =>
        withArtifactPreservingStateReads(() =>
          withSynchronousArtifactPreservingStateSnapshot(() => {
            readHeld(options);
            return Promise.resolve();
          }),
        ),
      ).toThrow("SQLite metadata snapshot scope must remain synchronous");
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(prepare.mock.results[0]?.value.location as string)).toBe(false);
    });
  });
});
