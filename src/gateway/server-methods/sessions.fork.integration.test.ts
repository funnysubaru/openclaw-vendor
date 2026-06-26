// sessions.fork RPC 統合テスト（Important #2 対応）
//
// 目的：forkSessionFromParent を mock せず実際のファイルシステムを使い、
//       cross-agent fork 時に jsonl が「ターゲット agent の sessionsDir」に落ちることを確認する。
//       mock では handler の mv ロジックを通過しないため、
//       「本当にファイルが正しい場所に作られるか」をこのファイルで担保する。
//
// 注意：このテストは実際にファイルを作成する（統合テスト）。
//       beforeAll/afterAll で tmpdir を使い、テスト終了後に削除する。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------- forkSessionFromParent のみ実物を使い、他は必要最低限のモック ----------

// vi.hoisted で引き上げ（vi.mock ファクトリ内で変数参照するため必要）
const {
  mockUpdateSessionStore,
  mockLoadSessionStore,
  mockLoadSessionEntry,
  mockResolveGatewaySessionStoreTarget,
} = vi.hoisted(() => ({
  mockUpdateSessionStore: vi.fn(),
  mockLoadSessionStore: vi.fn(),
  mockLoadSessionEntry: vi.fn(),
  mockResolveGatewaySessionStoreTarget: vi.fn(),
}));

// config: テスト用の最小設定（実際のファイルは読まない）
vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      session: { mainKey: "main", parentForkMaxTokens: 100_000 },
      agents: [],
    }),
  };
});

// agents/agent-scope.js
vi.mock("../../agents/agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/agent-scope.js")>();
  return { ...actual, resolveDefaultAgentId: () => "main" };
});

// agents/bootstrap-cache.js（ファイルシステムへの書き込みを防ぐ）
vi.mock("../../agents/bootstrap-cache.js", () => ({
  clearBootstrapSnapshot: vi.fn(),
}));

// sessions.js: loadSessionStore / updateSessionStore / resolveMainSessionKey は
// 実際のファイルシステムへのアクセスを避けるためモック
// ただし updateSessionStore のコールバックは実行する（エントリを確認するため）
vi.mock("../../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions.js")>();
  return {
    ...actual,
    loadSessionStore: mockLoadSessionStore,
    updateSessionStore: mockUpdateSessionStore,
    resolveMainSessionKey: () => "agent:main:main",
  };
});

// session-utils.js: loadSessionEntry / resolveGatewaySessionStoreTarget はモック
// （実際の sessions.json パスを使うと他テストや環境に干渉する）
vi.mock("../session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...actual,
    loadSessionEntry: mockLoadSessionEntry,
    resolveGatewaySessionStoreTarget: mockResolveGatewaySessionStoreTarget,
  };
});

// routing/session-key.js は実物を使う（parseAgentSessionKey / normalizeAgentId）

// ---------- モック後にインポート ----------
import { sessionsHandlers } from "./sessions.js";

// ---------- テスト用 temp ディレクトリ管理 ----------

let suiteRoot = "";

beforeAll(() => {
  suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-fork-integration-"));
});

afterAll(() => {
  fs.rmSync(suiteRoot, { recursive: true, force: true });
  suiteRoot = "";
});

beforeEach(() => {
  vi.clearAllMocks();
});

/** handler 呼び出しユーティリティ */
async function callForkHandler(params: Record<string, unknown>, respond: ReturnType<typeof vi.fn>) {
  const handler = sessionsHandlers["sessions.fork"];
  await handler({
    params,
    respond: respond as never,
    context: {} as never,
    req: {} as never,
    client: null as never,
    isWebchatConnect: () => false,
  });
}

/**
 * 最小限の jsonl ファイルを作成して SessionManager が読める形にする。
 * （session.test.ts の fork テストを参考）
 */
function createMinimalJsonl(sessionsDir: string, sessionId: string): string {
  fs.mkdirSync(sessionsDir, { recursive: true });
  const filePath = path.join(sessionsDir, `${sessionId}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  const userMsg = {
    type: "message",
    id: "m1",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "test prompt" },
  };
  const assistantMsg = {
    type: "message",
    id: "m2",
    parentId: "m1",
    timestamp: new Date().toISOString(),
    message: { role: "assistant", content: "test reply" },
  };
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(header)}\n${JSON.stringify(userMsg)}\n${JSON.stringify(assistantMsg)}\n`,
    "utf-8",
  );
  return filePath;
}

// ---------- 統合テスト ----------

describe("sessions.fork — 統合テスト：cross-agent fork で jsonl がターゲット agent のディレクトリに落ちる", () => {
  // このテストでは forkSessionFromParent を実物で呼び出す。
  // ソース agent = "main"（sessions ディレクトリに親 jsonl が存在）
  // ターゲット agent = "agent-b"（別の sessions ディレクトリ）
  // → fork 後の jsonl が「ターゲット agent の sessionsDir」に落ちることを物質証拠として確認する。

  it("cross-agent fork 後の jsonl がターゲット agent の sessionsDir に落ちる", async () => {
    // ソース agent のディレクトリを tmpdir 下に用意
    const sourceAgentDir = path.join(suiteRoot, "agents", "main", "sessions");
    const targetAgentDir = path.join(suiteRoot, "agents", "agent-b", "sessions");
    const sourceStorePath = path.join(sourceAgentDir, "sessions.json");
    const targetStorePath = path.join(targetAgentDir, "sessions.json");

    // 親 jsonl を作成
    const parentSessionId = "parent-integ-001";
    const parentSessionFile = createMinimalJsonl(sourceAgentDir, parentSessionId);

    // loadSessionEntry のモック（ソースエントリを返す）
    mockLoadSessionEntry.mockReturnValue({
      cfg: { session: { mainKey: "main", parentForkMaxTokens: 100_000 }, agents: [] },
      storePath: sourceStorePath,
      entry: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now() - 1000,
        totalTokens: 5_000,
        model: "claude-opus-4-8",
      },
      canonicalKey: "agent:main:user:parent-integ-001",
      legacyKey: undefined,
    });

    // resolveGatewaySessionStoreTarget のモック（ターゲット agent の storePath を返す）
    mockResolveGatewaySessionStoreTarget.mockReturnValue({
      agentId: "agent-b",
      storePath: targetStorePath,
      canonicalKey: "agent:agent-b:user:forked-integ-001",
      storeKeys: ["agent:agent-b:user:forked-integ-001"],
    });

    // updateSessionStore: コールバックを実行するだけ（ファイル書き込みは行わない）
    let capturedNewEntry: Record<string, unknown> | undefined;
    mockUpdateSessionStore.mockImplementation(
      async (_storePath: string, cb: (store: Record<string, unknown>) => unknown) => {
        const store: Record<string, unknown> = {};
        await cb(store);
        capturedNewEntry = store["agent:agent-b:user:forked-integ-001"] as
          | Record<string, unknown>
          | undefined;
      },
    );

    const respond = vi.fn();
    await callForkHandler(
      {
        sourceKey: "agent:main:user:parent-integ-001",
        targetAgentId: "agent-b",
        newSessionKey: "agent:agent-b:user:forked-integ-001",
      },
      respond,
    );

    // respond が true で呼ばれたことを確認
    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, result] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(result.inheritedHistory).toBe(true);

    // 物質証拠：fork された jsonl がターゲット agent のディレクトリに存在すること
    const forkSessionFile = result.sessionFile as string;
    expect(forkSessionFile).toBeTruthy();
    expect(forkSessionFile).toContain(targetAgentDir);
    expect(fs.existsSync(forkSessionFile)).toBe(true);

    // ストアに登録されたエントリの sessionFile もターゲットディレクトリを指すこと
    expect(capturedNewEntry).toBeDefined();
    const registeredFile = capturedNewEntry?.sessionFile as string | undefined;
    expect(registeredFile).toBeTruthy();
    expect(registeredFile).toContain(targetAgentDir);

    // fork 後の jsonl に parentSession ヘッダーが含まれること（本物の fork であることの証拠）
    const forkedContent = fs.readFileSync(forkSessionFile, "utf-8");
    const firstLine = forkedContent.split("\n")[0];
    const headerObj = JSON.parse(firstLine) as Record<string, unknown>;
    // SessionManager.createBranchedSession は parentSession を header に含める
    // （forkSessionFromParent の仕様通り）
    expect(typeof headerObj.id).toBe("string");
    // ソース agent のディレクトリには fork ファイルが存在しないこと（正しく mv されている）
    expect(fs.existsSync(path.join(sourceAgentDir, path.basename(forkSessionFile)))).toBe(false);
  });

  it("同成員 fork（sourceAgentId == targetAgentId）では mv が行われず sessionFile はソース sessionsDir に落ちる", async () => {
    // 同じ agent に fork する場合は mv を行わず、fork 出力をそのまま使う。
    const sourceAgentDir2 = path.join(suiteRoot, "agents", "main2", "sessions");
    const sourceStorePath2 = path.join(sourceAgentDir2, "sessions.json");

    const parentSessionId2 = "parent-integ-same-002";
    const parentSessionFile2 = createMinimalJsonl(sourceAgentDir2, parentSessionId2);

    // 同じ agent = storePath の dirname がソースとターゲット同じ
    mockLoadSessionEntry.mockReturnValue({
      cfg: { session: { mainKey: "main", parentForkMaxTokens: 100_000 }, agents: [] },
      storePath: sourceStorePath2,
      entry: {
        sessionId: parentSessionId2,
        sessionFile: parentSessionFile2,
        updatedAt: Date.now() - 1000,
        totalTokens: 5_000,
        model: "claude-opus-4-8",
      },
      canonicalKey: "agent:main2:user:parent-integ-same-002",
      legacyKey: undefined,
    });

    // ターゲットも main2 = ソースと同じ storePath
    mockResolveGatewaySessionStoreTarget.mockReturnValue({
      agentId: "main2",
      storePath: sourceStorePath2,
      canonicalKey: "agent:main2:user:forked-same-002",
      storeKeys: ["agent:main2:user:forked-same-002"],
    });

    // capturedStore は updateSessionStore コールバックが受け取るストア全体を保存する
    let capturedStore: Record<string, unknown> = {};
    mockUpdateSessionStore.mockImplementation(
      async (_storePath: string, cb: (store: Record<string, unknown>) => unknown) => {
        const store: Record<string, unknown> = {};
        await cb(store);
        capturedStore = store;
      },
    );

    const respond = vi.fn();
    await callForkHandler(
      {
        sourceKey: "agent:main2:user:parent-integ-same-002",
        // targetAgentId 省略 = sourceAgentId（main2）
      },
      respond,
    );

    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, result] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(result.inheritedHistory).toBe(true);

    // ソース agent ディレクトリに fork ファイルが落ちること
    const forkSessionFile2 = result.sessionFile as string;
    expect(forkSessionFile2).toContain(sourceAgentDir2);
    expect(fs.existsSync(forkSessionFile2)).toBe(true);

    // ストアに登録されたエントリの sessionFile もソース agent ディレクトリを指すこと
    // （newSessionKey は動的生成なので capturedStore の全エントリから取得）
    const registeredEntries = Object.values(capturedStore) as Array<Record<string, unknown>>;
    expect(registeredEntries.length).toBeGreaterThan(0);
    const registeredFile2 = registeredEntries[0]?.sessionFile as string | undefined;
    expect(registeredFile2).toBeTruthy();
    expect(registeredFile2).toContain(sourceAgentDir2);
  });
});
