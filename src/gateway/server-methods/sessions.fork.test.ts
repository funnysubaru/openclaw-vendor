// sessions.fork RPC 単体テスト（Yuiclaw 対話ブランチ真継承コンテキスト地基）
//
// 検証する 4 つのシナリオ（design §7 / tasks Task 1.3）：
//   1. 正常 fork 带历史：源会話ありで forkSessionFromParent が成功 → inheritedHistory=true
//   2. 源会話不存在 → エラー（静かに失敗しない）
//   3. トークン護衛：源 totalTokens > 上限 → 空白会話を作成、inheritedHistory=false
//   4. targetAgentId=B → 新 sessionFile は B の sessions ディレクトリに落ちる（targetAgentId パス）
//
// モック戦略：
//   - config.js の loadConfig をモック（テスト用の最小設定）
//   - config/sessions.js の loadSessionStore / updateSessionStore をモック
//   - session-utils.js の loadSessionEntry / resolveGatewaySessionStoreTarget をモック
//   - auto-reply/reply/session-fork.js の forkSessionFromParent / resolveParentForkMaxTokens をモック
//   handler 自体（sessionsHandlers["sessions.fork"]）は実物を使い、依存をモックで制御する

import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------- モック宣言（vi.hoisted で引き上げ） ----------

const {
  mockLoadSessionEntry,
  mockResolveGatewaySessionStoreTarget,
  mockForkSessionFromParent,
  mockResolveParentForkMaxTokens,
  mockUpdateSessionStore,
  mockLoadSessionStore,
} = vi.hoisted(() => ({
  mockLoadSessionEntry: vi.fn(),
  mockResolveGatewaySessionStoreTarget: vi.fn(),
  mockForkSessionFromParent: vi.fn(),
  mockResolveParentForkMaxTokens: vi.fn(),
  mockUpdateSessionStore: vi.fn(),
  mockLoadSessionStore: vi.fn(),
}));

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

vi.mock("../../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions.js")>();
  return {
    ...actual,
    loadSessionStore: mockLoadSessionStore,
    updateSessionStore: mockUpdateSessionStore,
    resolveMainSessionKey: () => "agent:main:main",
  };
});

// session-utils.js は他の多くのモジュールが依存するため部分モック
vi.mock("../session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...actual,
    loadSessionEntry: mockLoadSessionEntry,
    resolveGatewaySessionStoreTarget: mockResolveGatewaySessionStoreTarget,
  };
});

vi.mock("../../auto-reply/reply/session-fork.js", () => ({
  forkSessionFromParent: mockForkSessionFromParent,
  resolveParentForkMaxTokens: mockResolveParentForkMaxTokens,
}));

// agents/agent-scope.js の resolveDefaultAgentId
vi.mock("../../agents/agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/agent-scope.js")>();
  return { ...actual, resolveDefaultAgentId: () => "main" };
});

// モック後にインポート（vi.mock がホイストされるため順序に依存しない）
import { sessionsHandlers } from "./sessions.js";

// ---------- テストヘルパー ----------

/** 最小限の respond モックを作成するユーティリティ */
function makeRespond() {
  return vi.fn();
}

/** sessionsHandlers["sessions.fork"] を呼び出すユーティリティ（引数の繰り返しを省く） */
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

/** 共通のデフォルト sessions.json storePath */
const STORE_PATH = "/tmp/openclaw-test/agents/main/sessions/sessions.json";

// ---------- テスト ----------

describe("sessions.fork — schema validation", () => {
  it("sourceKey が空文字の場合は拒否（NonEmptyString 制約）", async () => {
    const { validateSessionsForkParams } = await import("../protocol/index.js");
    expect(validateSessionsForkParams({ sourceKey: "" })).toBe(false);
  });

  it("sourceKey 必須（フィールド省略も拒否）", async () => {
    const { validateSessionsForkParams } = await import("../protocol/index.js");
    expect(validateSessionsForkParams({})).toBe(false);
  });

  it("sourceKey のみで有効（targetAgentId / newSessionKey は省略可）", async () => {
    const { validateSessionsForkParams } = await import("../protocol/index.js");
    expect(validateSessionsForkParams({ sourceKey: "agent:main:user:abc" })).toBe(true);
  });

  it("additionalProperties が false（余分なフィールドは拒否）", async () => {
    const { validateSessionsForkParams } = await import("../protocol/index.js");
    expect(validateSessionsForkParams({ sourceKey: "agent:main:user:abc", unknown: "x" })).toBe(
      false,
    );
  });
});

describe("sessions.fork — シナリオ 1：正常 fork 带历史", () => {
  // 源会話に 2 ターン存在し、forkSessionFromParent が成功する場合
  // 期待：inheritedHistory=true、store に新エントリ登録、返却値が正しい

  beforeEach(() => {
    vi.clearAllMocks();

    // 源エントリ：30k トークン（護衛上限 100k 以下）
    mockLoadSessionEntry.mockReturnValue({
      cfg: { session: { mainKey: "main", parentForkMaxTokens: 100_000 }, agents: [] },
      storePath: STORE_PATH,
      entry: {
        sessionId: "parent-sess-001",
        sessionFile: "/tmp/openclaw-test/agents/main/sessions/parent.jsonl",
        updatedAt: Date.now() - 1000,
        totalTokens: 30_000,
        model: "claude-opus-4-8",
        thinkingLevel: "medium",
      },
      canonicalKey: "agent:main:user:parent-abc",
      legacyKey: undefined,
    });

    // resolveGatewaySessionStoreTarget: 新 key のターゲット解決
    mockResolveGatewaySessionStoreTarget.mockReturnValue({
      agentId: "main",
      storePath: STORE_PATH,
      canonicalKey: "agent:main:user:forked-001",
      storeKeys: ["agent:main:user:forked-001"],
    });

    // トークン護衛：上限 100_000
    mockResolveParentForkMaxTokens.mockReturnValue(100_000);

    // forkSessionFromParent: 成功を返す
    const forkedFile = path.join(
      path.dirname(STORE_PATH),
      "2026-06-26T00-00-00-000Z_forked-sess-001.jsonl",
    );
    mockForkSessionFromParent.mockReturnValue({
      sessionId: "forked-sess-001",
      sessionFile: forkedFile,
    });

    // updateSessionStore: コールバックを即実行
    mockUpdateSessionStore.mockImplementation(
      async (_storePath: string, cb: (store: Record<string, unknown>) => unknown) => {
        const store: Record<string, unknown> = {};
        await cb(store);
      },
    );
  });

  it("inheritedHistory=true で新会話 3 つ組を返す", async () => {
    const respond = makeRespond();
    await callForkHandler({ sourceKey: "agent:main:user:parent-abc" }, respond);

    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, result] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(result.inheritedHistory).toBe(true);
    expect(result.sessionKey).toMatch(/^agent:main:user:/);
    expect(result.sessionId).toBe("forked-sess-001");
  });

  it("forkSessionFromParent が源エントリ + sessionsDir で呼ばれる", async () => {
    const respond = makeRespond();
    await callForkHandler({ sourceKey: "agent:main:user:parent-abc" }, respond);

    expect(mockForkSessionFromParent).toHaveBeenCalledTimes(1);
    const callArg = mockForkSessionFromParent.mock.calls[0][0];
    expect(callArg.agentId).toBe("main");
    // sessionsDir = path.dirname(storePath)
    expect(callArg.sessionsDir).toBe(path.dirname(STORE_PATH));
  });

  it("store に新エントリが登録される（updateSessionStore が呼ばれる）", async () => {
    const respond = makeRespond();
    await callForkHandler({ sourceKey: "agent:main:user:parent-abc" }, respond);

    expect(mockUpdateSessionStore).toHaveBeenCalledTimes(1);
  });

  it("targetAgentId 省略時は源 agentId（main）を使う", async () => {
    const respond = makeRespond();
    await callForkHandler({ sourceKey: "agent:main:user:parent-abc" }, respond);

    const [ok, result] = respond.mock.calls[0];
    expect(ok).toBe(true);
    // 生成された key は agent:main:... プレフィックスを持つ
    expect(result.sessionKey).toMatch(/^agent:main:/);
    expect(mockForkSessionFromParent.mock.calls[0][0].agentId).toBe("main");
  });
});

describe("sessions.fork — シナリオ 2：源会話不存在", () => {
  // sourceKey に対応する会話が store にない → エラーで返す
  // 期待：respond(false, undefined, errorShape(...)) が呼ばれる

  beforeEach(() => {
    vi.clearAllMocks();

    // entry が undefined = 存在しない
    mockLoadSessionEntry.mockReturnValue({
      cfg: { session: { mainKey: "main" }, agents: [] },
      storePath: STORE_PATH,
      entry: undefined,
      canonicalKey: "agent:main:user:nonexistent",
      legacyKey: undefined,
    });
  });

  it("存在しない sourceKey に対してエラーを返す（静かに失敗しない）", async () => {
    const respond = makeRespond();
    await callForkHandler({ sourceKey: "agent:main:user:nonexistent" }, respond);

    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, _result, error] = respond.mock.calls[0];
    expect(ok).toBe(false);
    expect(error).toBeDefined();
    expect(error.message).toContain("not found");
  });

  it("forkSessionFromParent は一切呼ばれない", async () => {
    const respond = makeRespond();
    await callForkHandler({ sourceKey: "agent:main:user:nonexistent" }, respond);

    expect(mockForkSessionFromParent).not.toHaveBeenCalled();
  });
});

describe("sessions.fork — シナリオ 3：トークン護衛（totalTokens > 上限）", () => {
  // 源会話のトークンが上限を超えている場合：fork しない、空白会話を作成
  // 期待：inheritedHistory=false、forkSessionFromParent は呼ばれない、store には空白エントリ

  beforeEach(() => {
    vi.clearAllMocks();

    // 源エントリ：150k トークン（護衛上限 100k を超える）
    mockLoadSessionEntry.mockReturnValue({
      cfg: { session: { mainKey: "main", parentForkMaxTokens: 100_000 }, agents: [] },
      storePath: STORE_PATH,
      entry: {
        sessionId: "large-parent-sess",
        sessionFile: "/tmp/openclaw-test/agents/main/sessions/large-parent.jsonl",
        updatedAt: Date.now() - 1000,
        totalTokens: 150_000, // 上限 100k を超える
        model: "claude-opus-4-8",
      },
      canonicalKey: "agent:main:user:large-parent",
      legacyKey: undefined,
    });

    mockResolveGatewaySessionStoreTarget.mockReturnValue({
      agentId: "main",
      storePath: STORE_PATH,
      canonicalKey: "agent:main:user:fallback-001",
      storeKeys: ["agent:main:user:fallback-001"],
    });

    // トークン護衛：上限 100_000（sources entry の 150k を超える）
    mockResolveParentForkMaxTokens.mockReturnValue(100_000);

    // updateSessionStore は空白エントリを作成
    const capturedStores: Record<string, unknown>[] = [];
    mockUpdateSessionStore.mockImplementation(
      async (_storePath: string, cb: (store: Record<string, unknown>) => unknown) => {
        const store: Record<string, unknown> = {};
        await cb(store);
        capturedStores.push(store);
      },
    );

    // loadSessionStore: updateSessionStore 後に空白エントリを返す
    mockLoadSessionStore.mockReturnValue({
      "agent:main:user:fallback-001": {
        sessionId: "fallback-sess-uuid",
        updatedAt: Date.now(),
        forkedFromParent: true,
      },
    });
  });

  it("inheritedHistory=false を返す", async () => {
    const respond = makeRespond();
    await callForkHandler({ sourceKey: "agent:main:user:large-parent" }, respond);

    const [ok, result] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(result.inheritedHistory).toBe(false);
  });

  it("forkSessionFromParent は呼ばれない（護衛が先に止める）", async () => {
    const respond = makeRespond();
    await callForkHandler({ sourceKey: "agent:main:user:large-parent" }, respond);

    expect(mockForkSessionFromParent).not.toHaveBeenCalled();
  });

  it("updateSessionStore は呼ばれる（空白会話が store に登録される）", async () => {
    const respond = makeRespond();
    await callForkHandler({ sourceKey: "agent:main:user:large-parent" }, respond);

    expect(mockUpdateSessionStore).toHaveBeenCalledTimes(1);
  });

  it("sessionKey が返される（空白フォールバックでも会話キーは提供される）", async () => {
    const respond = makeRespond();
    await callForkHandler({ sourceKey: "agent:main:user:large-parent" }, respond);

    const [ok, result] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(result.sessionKey).toBeTruthy();
    expect(typeof result.sessionKey).toBe("string");
  });
});

describe("sessions.fork — シナリオ 4：targetAgentId 指定（跨成員分岐）", () => {
  // targetAgentId=B の場合、新 sessionFile は B の sessions ディレクトリに落ちる
  // 期待：forkSessionFromParent の agentId 引数が "b" になる、
  //         resolveGatewaySessionStoreTarget が B の storePath を返す

  const AGENT_B_STORE_PATH = "/tmp/openclaw-test/agents/b/sessions/sessions.json";

  beforeEach(() => {
    vi.clearAllMocks();

    mockLoadSessionEntry.mockReturnValue({
      cfg: { session: { mainKey: "main", parentForkMaxTokens: 100_000 }, agents: [] },
      storePath: STORE_PATH,
      entry: {
        sessionId: "parent-sess-cross",
        sessionFile: "/tmp/openclaw-test/agents/main/sessions/parent-cross.jsonl",
        updatedAt: Date.now() - 1000,
        totalTokens: 20_000, // 護衛上限以下
        model: "claude-opus-4-8",
      },
      canonicalKey: "agent:main:user:parent-cross",
      legacyKey: undefined,
    });

    // B エージェントの storePath を返す
    mockResolveGatewaySessionStoreTarget.mockReturnValue({
      agentId: "b",
      storePath: AGENT_B_STORE_PATH,
      canonicalKey: "agent:b:user:forked-cross",
      storeKeys: ["agent:b:user:forked-cross"],
    });

    mockResolveParentForkMaxTokens.mockReturnValue(100_000);

    // B のsessionsDir にファイルを作成
    const forkedFileInB = path.join(
      path.dirname(AGENT_B_STORE_PATH),
      "2026-06-26T00-00-00-000Z_forked-cross.jsonl",
    );
    mockForkSessionFromParent.mockReturnValue({
      sessionId: "forked-cross-sess",
      sessionFile: forkedFileInB,
    });

    mockUpdateSessionStore.mockImplementation(
      async (_storePath: string, cb: (store: Record<string, unknown>) => unknown) => {
        const store: Record<string, unknown> = {};
        await cb(store);
      },
    );
  });

  it("forkSessionFromParent が targetAgentId=b + ソース sessionsDir で呼ばれる", async () => {
    // sessionsDir はソース agent の sessions ディレクトリを渡す必要がある——
    // forkSessionFromParent が親ファイルを「探す」ためのパスであり、
    // ターゲット agent のディレクトリを渡すと containment check に失敗する。
    // fork 後の jsonl 移動先（ターゲット sessionsDir）は handler 内で mv により対処する。
    const respond = makeRespond();
    await callForkHandler(
      { sourceKey: "agent:main:user:parent-cross", targetAgentId: "b" },
      respond,
    );

    expect(mockForkSessionFromParent).toHaveBeenCalledTimes(1);
    const callArg = mockForkSessionFromParent.mock.calls[0][0];
    expect(callArg.agentId).toBe("b");
    // sessionsDir はソース agent（main）の sessions ディレクトリ
    expect(callArg.sessionsDir).toBe(path.dirname(STORE_PATH));
  });

  it("返却された sessionKey が agent:b: プレフィックスを持つ", async () => {
    const respond = makeRespond();
    await callForkHandler(
      { sourceKey: "agent:main:user:parent-cross", targetAgentId: "b" },
      respond,
    );

    const [ok, result] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(result.sessionKey).toMatch(/^agent:b:/);
    expect(result.inheritedHistory).toBe(true);
  });

  it("updateSessionStore が B の storePath で呼ばれる（B の sessions に登録）", async () => {
    const respond = makeRespond();
    await callForkHandler(
      { sourceKey: "agent:main:user:parent-cross", targetAgentId: "b" },
      respond,
    );

    expect(mockUpdateSessionStore).toHaveBeenCalledWith(AGENT_B_STORE_PATH, expect.any(Function));
  });

  it("sessionFile が B の sessionsDir パスに落ちる", async () => {
    const respond = makeRespond();
    await callForkHandler(
      { sourceKey: "agent:main:user:parent-cross", targetAgentId: "b" },
      respond,
    );

    const [ok, result] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(result.sessionFile).toContain(path.dirname(AGENT_B_STORE_PATH));
  });
});

describe("sessions.fork — シナリオ 5：forkSessionFromParent が null を返す", () => {
  // forkSessionFromParent が null を返した場合（親ファイルが見つからない等）の挙動を検証。
  // 期待：inheritedHistory=false、updateSessionStore は呼ばれる、sessionKey は提供される。
  // （design §4.2 step 4「黒洞を避ける」。エラーにしないのは意図通り。）

  beforeEach(() => {
    vi.clearAllMocks();

    mockLoadSessionEntry.mockReturnValue({
      cfg: { session: { mainKey: "main", parentForkMaxTokens: 100_000 }, agents: [] },
      storePath: STORE_PATH,
      entry: {
        sessionId: "parent-sess-nullfork",
        sessionFile: "/tmp/openclaw-test/agents/main/sessions/parent-null.jsonl",
        updatedAt: Date.now() - 1000,
        totalTokens: 10_000,
        model: "claude-opus-4-8",
      },
      canonicalKey: "agent:main:user:parent-null",
      legacyKey: undefined,
    });

    mockResolveGatewaySessionStoreTarget.mockReturnValue({
      agentId: "main",
      storePath: STORE_PATH,
      canonicalKey: "agent:main:user:null-fork-result",
      storeKeys: ["agent:main:user:null-fork-result"],
    });

    mockResolveParentForkMaxTokens.mockReturnValue(100_000);

    // forkSessionFromParent が null を返す（親ファイル不存在等の想定外エラー）
    mockForkSessionFromParent.mockReturnValue(null);

    // updateSessionStore はコールバックを実行する
    mockUpdateSessionStore.mockImplementation(
      async (_storePath: string, cb: (store: Record<string, unknown>) => unknown) => {
        const store: Record<string, unknown> = {};
        await cb(store);
      },
    );

    // loadSessionStore: 空白フォールバックのエントリを返す
    mockLoadSessionStore.mockReturnValue({
      "agent:main:user:null-fork-result": {
        sessionId: "null-fork-fallback-uuid",
        updatedAt: Date.now(),
        forkedFromParent: true,
      },
    });
  });

  it("inheritedHistory=false を返す（null fork はフォールバック扱い）", async () => {
    const respond = makeRespond();
    await callForkHandler({ sourceKey: "agent:main:user:parent-null" }, respond);

    const [ok, result] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(result.inheritedHistory).toBe(false);
  });

  it("updateSessionStore は呼ばれる（空白会話を作成する）", async () => {
    const respond = makeRespond();
    await callForkHandler({ sourceKey: "agent:main:user:parent-null" }, respond);

    expect(mockUpdateSessionStore).toHaveBeenCalledTimes(1);
  });

  it("sessionKey が返される（null fork でも会話キーは使える）", async () => {
    const respond = makeRespond();
    await callForkHandler({ sourceKey: "agent:main:user:parent-null" }, respond);

    const [ok, result] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(result.sessionKey).toBeTruthy();
    expect(typeof result.sessionKey).toBe("string");
  });
});

describe("sessions.fork — シナリオ 6：newSessionKey の agentId がtargetAgentId と不一致", () => {
  // targetAgentId=b + newSessionKey が agent:main:... の場合、
  // 異なる agent に別 agent の key を割り当てようとしている → INVALID_REQUEST エラー。

  beforeEach(() => {
    vi.clearAllMocks();

    mockLoadSessionEntry.mockReturnValue({
      cfg: { session: { mainKey: "main", parentForkMaxTokens: 100_000 }, agents: [] },
      storePath: STORE_PATH,
      entry: {
        sessionId: "parent-sess-mismatch",
        sessionFile: "/tmp/openclaw-test/agents/main/sessions/parent-mismatch.jsonl",
        updatedAt: Date.now() - 1000,
        totalTokens: 10_000,
        model: "claude-opus-4-8",
      },
      canonicalKey: "agent:main:user:parent-mismatch",
      legacyKey: undefined,
    });
  });

  it("targetAgentId=b + newSessionKey=agent:main:... は INVALID_REQUEST エラー", async () => {
    const respond = makeRespond();
    await callForkHandler(
      {
        sourceKey: "agent:main:user:parent-mismatch",
        targetAgentId: "b",
        newSessionKey: "agent:main:user:conflicting-key",
      },
      respond,
    );

    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, _result, error] = respond.mock.calls[0];
    expect(ok).toBe(false);
    expect(error).toBeDefined();
    // エラーコードは INVALID_REQUEST
    expect(error.code).toBe("INVALID_REQUEST");
  });

  it("不一致の場合は forkSessionFromParent は呼ばれない", async () => {
    const respond = makeRespond();
    await callForkHandler(
      {
        sourceKey: "agent:main:user:parent-mismatch",
        targetAgentId: "b",
        newSessionKey: "agent:main:user:conflicting-key",
      },
      respond,
    );

    expect(mockForkSessionFromParent).not.toHaveBeenCalled();
  });
});
