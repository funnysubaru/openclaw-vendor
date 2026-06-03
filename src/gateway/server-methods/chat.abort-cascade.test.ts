import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted ensures these fn refs are initialized before vi.mock hoisting runs,
// so the factory function can safely close over them.
const { tearDownSessionRuntimeForAbort } = vi.hoisted(() => ({
  tearDownSessionRuntimeForAbort: vi.fn(async () => {}),
}));

vi.mock("../session-runtime-teardown.js", () => ({ tearDownSessionRuntimeForAbort }));

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

  it("explicit runId not found does NOT tear down", async () => {
    // Early-return path: when the runId is not found, no teardown fires.
    // (The early-return happens before the insertion point.)
    await invokeChatAbort({
      context: createContext(),
      request: { sessionKey: SK, runId: "missing" },
      client: ADMIN,
    });
    expect(tearDownSessionRuntimeForAbort).not.toHaveBeenCalled();
  });
});
