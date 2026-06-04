import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted ensures these fn refs are initialized before vi.mock hoisting runs,
// so the factory function can safely close over them.
const { tearDownSessionRuntimeForAbort } = vi.hoisted(() => ({
  tearDownSessionRuntimeForAbort: vi.fn(async () => {}),
}));

vi.mock("../session-runtime-teardown.js", () => ({ tearDownSessionRuntimeForAbort }));

// review #1：chat.abort handler 内对 admin 路径「同步」打 abort 闸（belt-and-suspenders），
// 与 fire-and-forget 的 teardown 解耦——即使 teardown 的 resolveGatewaySessionStoreTarget
// 抛错早退、mark 被跳过，handler 这层也已经把闸打上。这里 spy markSessionAborted 验证该行为。
const { markSessionAborted } = vi.hoisted(() => ({ markSessionAborted: vi.fn() }));
vi.mock("../../agents/session-abort-guard.js", () => ({
  markSessionAborted,
  isSessionAborted: vi.fn(() => false),
  noteDroppedAnnounce: vi.fn(() => 0),
  clearSessionAbort: vi.fn(),
  __testing: { reset: vi.fn() },
}));
// handler 新增 loadConfig() 以拿 cfg 传给 markSessionAborted；mock 成最小 config 避免真读盘/env。
vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({ session: { mainKey: "main", scope: "per-sender" } }),
  };
});

import { chatHandlers } from "./chat.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SK = "main";

// Admin client: has operator.admin scope.
const ADMIN = {
  connId: "c-admin",
  connect: { device: { id: "d-admin" }, scopes: ["operator.admin"] },
};

// Non-admin client: only has operator.write scope.
const USER1 = {
  connId: "c1",
  connect: { device: { id: "d1" }, scopes: ["operator.write"] },
};

function createActiveRun(sessionKey: string, owner?: { connId?: string; deviceId?: string }) {
  const now = Date.now();
  return {
    controller: new AbortController(),
    sessionId: `${sessionKey}-session`,
    sessionKey,
    startedAtMs: now,
    expiresAtMs: now + 30_000,
    ownerConnId: owner?.connId,
    ownerDeviceId: owner?.deviceId,
  };
}

function createContext(overrides: Record<string, unknown> = {}) {
  return {
    chatAbortControllers: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatAbortedRuns: new Map<string, number>(),
    removeChatRun: vi
      .fn()
      .mockImplementation((run: string) => ({ sessionKey: SK, clientRunId: run })),
    agentRunSeq: new Map<string, number>(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    logGateway: { warn: vi.fn() },
    ...overrides,
  };
}

async function invokeChatAbort(p: {
  context: ReturnType<typeof createContext>;
  request: { sessionKey: string; runId?: string };
  client?: unknown;
}) {
  const respond = vi.fn();
  await chatHandlers["chat.abort"]({
    params: p.request,
    respond: respond as never,
    context: p.context as never,
    req: {} as never,
    client: (p.client ?? null) as never,
    isWebchatConnect: () => false,
  });
  return respond;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("chat.abort cascades subagent teardown", () => {
  beforeEach(() => vi.clearAllMocks());

  // --- no-runId branch ---

  it("no-runId admin with no matched run still tears down (yield case)", async () => {
    // Admin aborts a session even when there are no active runs (the main chat run
    // may have already ended naturally — the "yield" case). Teardown must still fire
    // to stop any lingering subagent processes.
    await invokeChatAbort({ context: createContext(), request: { sessionKey: SK }, client: ADMIN });
    expect(tearDownSessionRuntimeForAbort).toHaveBeenCalledWith({ sessionKey: SK });
  });

  it("no-runId non-admin with no matched run does NOT tear down", async () => {
    // Non-admin clients only abort their own chat run; they must not trigger
    // session-wide subagent teardown (which is a session-wide blast radius).
    await invokeChatAbort({ context: createContext(), request: { sessionKey: SK }, client: USER1 });
    expect(tearDownSessionRuntimeForAbort).not.toHaveBeenCalled();
  });

  it("no-runId non-admin authorized abort does NOT tear down (no session-wide cascade)", async () => {
    // Even when a non-admin successfully aborts their own run, no cascade fires.
    const context = createContext({
      chatAbortControllers: new Map([["run-mine", createActiveRun(SK, { deviceId: "d1" })]]),
    });
    await invokeChatAbort({ context, request: { sessionKey: SK }, client: USER1 });
    expect(tearDownSessionRuntimeForAbort).not.toHaveBeenCalled();
  });

  it("no-runId admin with matched run tears down", async () => {
    // Admin aborting a session that has an active run: teardown fires after the
    // run-level abort, cascading into subagent subtrees.
    const context = createContext({
      chatAbortControllers: new Map([["run-x", createActiveRun(SK, { deviceId: "d-other" })]]),
    });
    await invokeChatAbort({ context, request: { sessionKey: SK }, client: ADMIN });
    expect(tearDownSessionRuntimeForAbort).toHaveBeenCalledWith({ sessionKey: SK });
  });

  // --- explicit runId branch ---

  it("explicit runId admin success tears down", async () => {
    // Admin explicitly aborting a run by ID: teardown must cascade.
    const context = createContext({
      chatAbortControllers: new Map([
        ["r1", createActiveRun(SK, { connId: "c-owner", deviceId: "d-owner" })],
      ]),
    });
    await invokeChatAbort({
      context,
      request: { sessionKey: SK, runId: "r1" },
      client: ADMIN,
    });
    expect(tearDownSessionRuntimeForAbort).toHaveBeenCalledWith({ sessionKey: SK });
  });

  it("explicit runId non-admin success does NOT tear down", async () => {
    // Non-admin successfully aborting their own run by ID: no session-wide cascade.
    const context = createContext({
      chatAbortControllers: new Map([["r1", createActiveRun(SK, { deviceId: "d1" })]]),
    });
    await invokeChatAbort({
      context,
      request: { sessionKey: SK, runId: "r1" },
      client: USER1,
    });
    expect(tearDownSessionRuntimeForAbort).not.toHaveBeenCalled();
  });

  it("explicit runId not found STILL tears down for admin (yield case)", async () => {
    // The yield case: the panel sends an explicit runId for a main chat run that already
    // ended naturally, so chatAbortControllers has no entry and the explicit-runId branch
    // early-returns (!active). Teardown is now fired EARLY (before runId branching), so it
    // must still cascade for an admin even when the run is gone — this is the whole point
    // of moving the teardown out of the per-branch tail.
    await invokeChatAbort({
      context: createContext(),
      request: { sessionKey: SK, runId: "missing" },
      client: ADMIN,
    });
    expect(tearDownSessionRuntimeForAbort).toHaveBeenCalledWith({ sessionKey: SK });
  });

  it("explicit runId not found does NOT tear down for non-admin", async () => {
    // The isAdmin gate still holds in the early-fire position: a non-admin hitting the
    // not-found path triggers no session-wide cascade.
    await invokeChatAbort({
      context: createContext(),
      request: { sessionKey: SK, runId: "missing" },
      client: USER1,
    });
    expect(tearDownSessionRuntimeForAbort).not.toHaveBeenCalled();
  });

  // --- review #1：handler 同步打 abort 闸（belt-and-suspenders，独立于 teardown） ---

  it("admin abort marks the session aborted synchronously (independent of teardown)", async () => {
    // teardown 内的 markSessionAborted 在 resolveGatewaySessionStoreTarget 抛错时会被跳过；
    // handler 这层同步打标兜底，保证即使 teardown 早退、闸也已生效。
    await invokeChatAbort({ context: createContext(), request: { sessionKey: SK }, client: ADMIN });
    expect(markSessionAborted).toHaveBeenCalledWith(expect.anything(), SK);
  });

  it("non-admin abort does NOT mark the session aborted", async () => {
    // 与 teardown 同样的 isAdmin 闸：非 admin 不触发会话级打标。
    await invokeChatAbort({ context: createContext(), request: { sessionKey: SK }, client: USER1 });
    expect(markSessionAborted).not.toHaveBeenCalled();
  });
});
