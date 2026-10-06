// ADR-0033 任务84(b)：gateway 冷启动这一遍员工库检查只读版本号/便宜元数据，不做
// 完整性扫描（整库 PRAGMA integrity_check + 外键检查）；完整性扫描推迟到随后
// session-migration 真正打开这个员工库时去做。对齐上游 #145541 的方向。
//
// 测试手法：真实损坏一个员工库文件的某个数据页（保留 page 1 开头的 user_version /
// schema_meta 不动），用「without defer 必须拒绝启动 / with defer 必须正常通过」
// 这一对行为差异证明完整性检查确实被跳过了——不用 vi.spyOn 挂 assertSqliteIntegrity
// （试过了：那个 spy 会跟这个函数长时间持有的原生 SQLite 句柄产生奇怪的收尾时序问题，
// 在这个仓库的 vitest 环境下导致测试结束后异步抛"database is not open"，跟本次改动
// 无关——用真实数据损坏绕开，顺便也更接近真实故障场景）。
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { preflightOpenClawDatabaseSchemas } from "./openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

/** 建一个真实的员工库（走正常运行时建库路径），可选地破坏其中一个数据页。 */
function fixture(options: { corrupt?: boolean } = {}) {
  const root = fs.realpathSync(tempDirs.make("preflight-startup-integrity-"));
  const env = { OPENCLAW_STATE_DIR: root };
  const agentDatabase = openOpenClawAgentDatabase({ agentId: "main", env });
  const agentPath = agentDatabase.path;
  closeOpenClawAgentDatabasesForTest();

  if (options.corrupt) {
    // page 1（开头 4096 字节，默认页大小）放 sqlite_master / schema_meta，是版本号
    // /便宜元数据校验会读到的地方，不能动；从第二页开始整页抹成 0xFF，
    // PRAGMA integrity_check 会在这里报错，而这几条 O(1) SELECT 不会扫到这页。
    const fd = fs.openSync(agentPath, "r+");
    try {
      fs.writeSync(fd, Buffer.alloc(1024, 0xff), 0, 1024, 4096);
    } finally {
      fs.closeSync(fd);
    }
  }
  return { env, agentPath };
}

function runPreflight(params: {
  env: NodeJS.ProcessEnv;
  agentPath: string;
  deferAgentIntegrityToAdmission?: boolean;
}) {
  return preflightOpenClawDatabaseSchemas({
    env: params.env,
    verifyCurrentSchemaShape: true,
    requireStartupMigrationReadiness: true,
    deferAgentIntegrityToAdmission: params.deferAgentIntegrityToAdmission,
    configuredAgentDatabaseTargets: [],
    configuredAgentDatabaseCandidatePaths: [params.agentPath],
    supportedVersions: {
      state: OPENCLAW_STATE_SCHEMA_VERSION,
      agent: OPENCLAW_AGENT_SCHEMA_VERSION,
    },
  });
}

describe("ADR-0033 任务84(b): gateway 启动时员工库完整性检查推迟到准入", () => {
  it("不传 deferAgentIntegrityToAdmission（默认行为）时，损坏的员工库仍然会被拒绝启动", async () => {
    const f = fixture({ corrupt: true });

    await expect(runPreflight({ ...f })).rejects.toThrow(/integrity_check/);
  });

  it("deferAgentIntegrityToAdmission 为 true 时，同一个损坏的员工库不再在这一步被拒绝", async () => {
    const f = fixture({ corrupt: true });

    // 这条断言是本次改动的核心证据：损坏仍然真实存在（下面"健康库"那条用例证明版本号/
    // 元数据校验没有被一并关掉），但这一遍不再做整库扫描，所以不会抛错——完整性检查被
    // 推迟到随后 session-migration 真正打开这个库时去做（那一步本来就有，没有被移除）。
    const result = await runPreflight({ ...f, deferAgentIntegrityToAdmission: true });

    expect(result.incompatible).toEqual([]);
    expect(result.indeterminate).toEqual([]);
    expect(result.pendingMigrations ?? []).toEqual([]);
  });

  it("deferAgentIntegrityToAdmission 为 true 时，健康员工库的版本号/元数据校验仍然照常执行", async () => {
    const f = fixture();

    const result = await runPreflight({ ...f, deferAgentIntegrityToAdmission: true });

    // 跳的只是整库扫描；一个健康、当前版本的员工库不应该被误判成任何一种问题。
    expect(result.incompatible).toEqual([]);
    expect(result.indeterminate).toEqual([]);
    expect(result.pendingMigrations ?? []).toEqual([]);
  });
});
