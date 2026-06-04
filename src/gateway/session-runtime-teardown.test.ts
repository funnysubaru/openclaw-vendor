import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted ensures these fn refs are initialized before vi.mock hoisting runs,
// so factory functions can safely close over them.
const {
  stopSubagentsForRequester,
  abortEmbeddedPiRun,
  waitForEmbeddedPiRunEnd,
  clearSessionQueues,
  closeTrackedBrowserTabsForSessions,
  loadConfig,
  resolveGatewaySessionStoreTarget,
  loadSessionStore,
  listSubagentRunsForController,
  logInfo,
  createSubsystemLogger,
  // Task 5: session-abort-guard 打标函数 mock
  markSessionAborted,
  // 持久化 orchestrator abortedLastRun 标记的 store 写入函数 mock（面板 Stop 对齐文本 /stop）。
  updateSessionStoreEntry,
} = vi.hoisted(() => {
  const CTRL = "agent:main:user:u1:panel";
  const CHILD = "agent:main:user:u1:panel:subagent:stock-analyst";
  const GRANDCHILD = "agent:main:user:u1:panel:subagent:stock-analyst:subagent:news";

  const logInfo = vi.fn();
  // Task 5: markSessionAborted mock，用于验证 teardown 流程确实打了 abort 标
  const markSessionAborted = vi.fn();
  // 面板 Stop 持久化 orchestrator abortedLastRun 标记：默认成功返回一个非 null entry，
  // 表示 store 里确实存在 orchestrator entry 并被打了标。返回 null 表示 entry 不存在（不创建）。
  // 显式标注成「接 {storePath, sessionKey, update}、返回对象或 null」的函数，避免 vi.fn 把返回类型
  // 收窄成字面量 { abortedLastRun: true } 而导致 mockResolvedValueOnce(null) / mock.calls 取值类型报错。
  const updateSessionStoreEntry = vi.fn<
    (params: {
      storePath: string;
      sessionKey: string;
      update: (entry: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    }) => Promise<Record<string, unknown> | null>
  >(async () => ({ abortedLastRun: true }));
  return {
    logInfo,
    markSessionAborted,
    updateSessionStoreEntry,
    createSubsystemLogger: vi.fn(() => ({
      info: logInfo,
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    })),
    stopSubagentsForRequester: vi.fn(() => ({ stopped: 2 })),
    abortEmbeddedPiRun: vi.fn(() => true),
    waitForEmbeddedPiRunEnd: vi.fn(async () => true),
    clearSessionQueues: vi.fn(() => ({ followupCleared: 0, laneCleared: 0, keys: [] })),
    closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
    loadConfig: vi.fn(() => ({ session: { store: undefined } })),
    resolveGatewaySessionStoreTarget: vi.fn(() => ({
      agentId: "a",
      storePath: "/tmp/store.json",
      canonicalKey: CTRL,
      storeKeys: [CTRL],
    })),
    loadSessionStore: vi.fn(() => ({ [CTRL]: { sessionId: "sess-123" } })),
    listSubagentRunsForController: vi.fn((key: string) => {
      if (key === CTRL) {
        return [{ runId: "r-c", childSessionKey: CHILD, endedAt: undefined }];
      }
      if (key === CHILD) {
        return [{ runId: "r-g", childSessionKey: GRANDCHILD, endedAt: undefined }];
      }
      return [];
    }),
  };
});

vi.mock("../auto-reply/reply/abort.js", () => ({ stopSubagentsForRequester }));
vi.mock("../agents/pi-embedded.js", () => ({ abortEmbeddedPiRun, waitForEmbeddedPiRunEnd }));
vi.mock("../agents/subagent-registry.js", () => ({ listSubagentRunsForController }));
vi.mock("../auto-reply/reply/queue.js", () => ({ clearSessionQueues }));
vi.mock("../browser/session-tab-registry.js", () => ({ closeTrackedBrowserTabsForSessions }));
vi.mock("../config/config.js", () => ({ loadConfig }));
vi.mock("./session-utils.js", () => ({ resolveGatewaySessionStoreTarget }));
vi.mock("../config/sessions.js", () => ({ loadSessionStore, updateSessionStoreEntry }));
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger }));
// Task 5: mock session-abort-guard 以验证 teardown 调用了 markSessionAborted
vi.mock("../agents/session-abort-guard.js", () => ({ markSessionAborted }));

import { tearDownSessionRuntimeForAbort } from "./session-runtime-teardown.js";

// Session key fixtures used across all tests.
const CTRL = "agent:main:user:u1:panel";
const CHILD = "agent:main:user:u1:panel:subagent:stock-analyst";
const GRANDCHILD = "agent:main:user:u1:panel:subagent:stock-analyst:subagent:news";

describe("tearDownSessionRuntimeForAbort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listSubagentRunsForController.mockImplementation((key: string) => {
      if (key === CTRL) {
        return [{ runId: "r-c", childSessionKey: CHILD, endedAt: undefined }];
      }
      if (key === CHILD) {
        return [{ runId: "r-g", childSessionKey: GRANDCHILD, endedAt: undefined }];
      }
      return [];
    });
    loadSessionStore.mockImplementation(() => ({ [CTRL]: { sessionId: "sess-123" } }));
    resolveGatewaySessionStoreTarget.mockImplementation(() => ({
      agentId: "a",
      storePath: "/tmp/store.json",
      canonicalKey: CTRL,
      storeKeys: [CTRL],
    }));
    updateSessionStoreEntry.mockImplementation(async () => ({ abortedLastRun: true }));
  });

  it("kills subtree + controller embedded run + clears queues + waits + closes tabs for controller AND recursive descendants", async () => {
    await tearDownSessionRuntimeForAbort({ sessionKey: CTRL });
    expect(stopSubagentsForRequester).toHaveBeenCalledWith(
      expect.objectContaining({ requesterSessionKey: CTRL }),
    );
    expect(abortEmbeddedPiRun).toHaveBeenCalledWith("sess-123");
    expect(waitForEmbeddedPiRunEnd).toHaveBeenCalledWith("sess-123", 15_000);
    expect(closeTrackedBrowserTabsForSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKeys: expect.arrayContaining([CTRL, "sess-123", CHILD, GRANDCHILD]),
      }),
    );
    // Observability: a single info-level summary line with the cascade counts.
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining("stoppedSubagents=2"));
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining("activeDescendants=2"));
    // Task 5: 验证 teardown 向 abort-guard 打了标，以便 announce/spawn 闸生效。
    // key 用 target.canonicalKey（CTRL），cfg 是任意对象（loadConfig() 返回值）。
    expect(markSessionAborted).toHaveBeenCalledWith(expect.anything(), CTRL);
  });

  it("面板 Stop 必须把 orchestrator(target.canonicalKey) 的 abortedLastRun 持久化进 store —— 对齐文本 /stop", async () => {
    // 根因回归测试：面板 chat.abort（teardown）此前只调 markSessionAborted（内存闸），
    // 没有把 abortedLastRun=true 写进 store。于是下一轮 run 在 session.ts 读 entry.abortedLastRun
    // 恒为 false → 会话级 abort 闸判据 #2 恒 false → 闸永不触发（live 验证失败的直接根因）。
    // 这里断言 teardown 调用 updateSessionStoreEntry 对 canonicalKey 打了 abortedLastRun=true。
    await tearDownSessionRuntimeForAbort({ sessionKey: CTRL });

    expect(updateSessionStoreEntry).toHaveBeenCalledTimes(1);
    const call = updateSessionStoreEntry.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    if (!call) {
      throw new Error("updateSessionStoreEntry 未被调用，前面断言应已失败");
    }
    // 必须打在 orchestrator 的 canonicalKey 上（不是子 agent），store 路径与 target 一致。
    expect(call.sessionKey).toBe(CTRL);
    expect(call.storePath).toBe("/tmp/store.json");
    // update 回调返回的 patch 必须把 abortedLastRun 置 true（下一轮 session.ts:370 据此读出真值）。
    const patch = await call.update({ sessionId: "sess-123" });
    expect(patch).toMatchObject({ abortedLastRun: true });
  });

  it("orchestrator entry 不存在时 updateSessionStoreEntry 返回 null → 不抛错、不影响其余 teardown", async () => {
    // updateSessionStoreEntry 在 entry 不存在时返回 null（不凭空创建 entry）。teardown 必须容忍。
    updateSessionStoreEntry.mockResolvedValueOnce(null);
    await expect(tearDownSessionRuntimeForAbort({ sessionKey: CTRL })).resolves.toBeUndefined();
    // 其余 teardown 步骤照常执行。
    expect(stopSubagentsForRequester).toHaveBeenCalled();
    expect(closeTrackedBrowserTabsForSessions).toHaveBeenCalled();
  });

  it("P2-a: 持久化 abortedLastRun 抛错也不影响后续 teardown（best-effort 隔离）", async () => {
    // store 写入失败（如盘满/锁竞争）不能阻断 stop/close tabs —— 与其它 teardown 步骤一致 best-effort。
    updateSessionStoreEntry.mockRejectedValueOnce(new Error("disk full"));
    await tearDownSessionRuntimeForAbort({ sessionKey: CTRL });
    expect(stopSubagentsForRequester).toHaveBeenCalled();
    expect(closeTrackedBrowserTabsForSessions).toHaveBeenCalled();
  });

  it("P2-a: still closes tabs even if an earlier primitive throws", async () => {
    stopSubagentsForRequester.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await tearDownSessionRuntimeForAbort({ sessionKey: CTRL });
    expect(closeTrackedBrowserTabsForSessions).toHaveBeenCalled();
  });

  it("P1-c: resolves sessionId from a legacy/variant storeKey when canonicalKey has none", async () => {
    resolveGatewaySessionStoreTarget.mockReturnValueOnce({
      agentId: "a",
      storePath: "/tmp/store.json",
      canonicalKey: CTRL,
      storeKeys: [CTRL, "legacy:key"],
    });
    loadSessionStore.mockReturnValueOnce({
      "legacy:key": { sessionId: "sess-legacy" },
    } as unknown as ReturnType<typeof loadSessionStore>);
    await tearDownSessionRuntimeForAbort({ sessionKey: CTRL });
    expect(abortEmbeddedPiRun).toHaveBeenCalledWith("sess-legacy");
  });

  it("does not throw / does not abort embedded when there is no sessionId", async () => {
    loadSessionStore.mockReturnValueOnce({} as unknown as ReturnType<typeof loadSessionStore>);
    await expect(tearDownSessionRuntimeForAbort({ sessionKey: CTRL })).resolves.toBeUndefined();
    expect(abortEmbeddedPiRun).not.toHaveBeenCalled();
    expect(stopSubagentsForRequester).toHaveBeenCalled();
  });

  it("P2-a: loadSessionStore throwing still stops subagents and closes tabs", async () => {
    loadSessionStore.mockImplementationOnce(() => {
      throw new Error("store gone");
    });
    await tearDownSessionRuntimeForAbort({ sessionKey: CTRL });
    expect(stopSubagentsForRequester).toHaveBeenCalled();
    expect(closeTrackedBrowserTabsForSessions).toHaveBeenCalled();
    expect(abortEmbeddedPiRun).not.toHaveBeenCalled();
  });

  it("P1: ended parent is NOT closed but its ACTIVE grandchild still is (recurse-through-ended)", async () => {
    const ENDED = `${CTRL}:subagent:ended-parent`;
    const GC = `${ENDED}:subagent:active-gc`;
    (listSubagentRunsForController as ReturnType<typeof vi.fn>).mockImplementation(
      (key: string) => {
        if (key === CTRL) {
          return [{ runId: "r-e", childSessionKey: ENDED, endedAt: Date.now() }];
        }
        if (key === ENDED) {
          return [{ runId: "r-gc", childSessionKey: GC, endedAt: undefined }];
        }
        return [];
      },
    );
    await tearDownSessionRuntimeForAbort({ sessionKey: CTRL });
    const calls = closeTrackedBrowserTabsForSessions.mock.calls as unknown as Array<
      [{ sessionKeys: string[] }]
    >;
    const arg = calls.at(-1)?.[0] ?? { sessionKeys: [] };
    expect(arg.sessionKeys).not.toContain(ENDED);
    expect(arg.sessionKeys).toContain(GC);
  });

  it("P1: closes an active sibling's tab but NOT an ended sibling's (per-run filter)", async () => {
    // 同一 controller 的 run 列表里同时有「活跃 sibling」和「已结束 sibling」，
    // 验证 per-run 的 !endedAt 过滤——活跃 sibling 的 tab 要关、已结束 sibling 的不关。
    // 这跟 recurse-through-ended（已结束 parent → 活跃 grandchild）是两条不同的路径：
    // 这里两个 run 是平级 sibling，纯靠 collectActive... 内部 `if (!run.endedAt)` 那一关来区分。
    const ENDED = `${CTRL}:subagent:done`;
    (listSubagentRunsForController as ReturnType<typeof vi.fn>).mockImplementation((key: string) =>
      key === CTRL
        ? [
            { runId: "r-active", childSessionKey: CHILD, endedAt: undefined },
            { runId: "r-done", childSessionKey: ENDED, endedAt: Date.now() },
          ]
        : [],
    );
    await tearDownSessionRuntimeForAbort({ sessionKey: CTRL });
    const calls = closeTrackedBrowserTabsForSessions.mock.calls as unknown as Array<
      [{ sessionKeys: string[] }]
    >;
    const arg = calls.at(-1)?.[0] ?? { sessionKeys: [] };
    expect(arg.sessionKeys).toContain(CHILD);
    expect(arg.sessionKeys).not.toContain(ENDED);
  });
});
