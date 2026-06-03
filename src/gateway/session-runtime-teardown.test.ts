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
} = vi.hoisted(() => {
  const CTRL = "agent:main:user:u1:panel";
  const CHILD = "agent:main:user:u1:panel:subagent:stock-analyst";
  const GRANDCHILD = "agent:main:user:u1:panel:subagent:stock-analyst:subagent:news";

  return {
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
vi.mock("../config/sessions.js", () => ({ loadSessionStore }));

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
});
