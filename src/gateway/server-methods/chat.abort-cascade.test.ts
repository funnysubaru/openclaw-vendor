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

// review 第2轮 P1：chat.send 的 /stop 分支也要级联 teardown。测它需要绕过 chat.send 进入
// stopCommand 分支前的两个 import 依赖：loadSessionEntry（读会话）+ resolveSendPolicy（发送策略）。
vi.mock("../session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...actual,
    loadSessionEntry: () => ({
      cfg: { session: { mainKey: "main", scope: "per-sender" } },
      entry: {},
      canonicalKey: "main", // = 下方 const SK；mock 工厂在 SK 声明前执行，故用字面量避免 TDZ
      storePath: "/tmp/sessions.json",
    }),
  };
});
vi.mock("../../sessions/send-policy.js", () => ({
  resolveSendPolicy: () => "allow",
}));

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
    // takes the !active path. The admin cascade (mark + teardown) fires in THIS !active
    // branch so lingering subagents are still stopped — while the mismatch branch
    // deliberately does NOT cascade (review P2: no side effects on a malformed request).
    await invokeChatAbort({
      context: createContext(),
      request: { sessionKey: SK, runId: "missing" },
      client: ADMIN,
    });
    expect(tearDownSessionRuntimeForAbort).toHaveBeenCalledWith({ sessionKey: SK });
  });

  it("explicit runId not found does NOT tear down for non-admin", async () => {
    // The isAdmin gate still holds in the !active (yield) branch: a non-admin hitting the
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

  // --- review 第2轮 P2：runId/sessionKey mismatch 是畸形请求，不应有任何会话级副作用 ---

  it("runId/sessionKey MISMATCH does NOT tear down or mark, even for admin (no side effects)", async () => {
    // active 存在但属于另一个 session（active.sessionKey !== 请求的 sessionKey）→ 走 mismatch
    // 分支返回 "runId does not match sessionKey"。此前 early-fire 会在判定 mismatch 之前就
    // teardown + 打标 sessionKey 的子树 → 畸形请求误伤指定 session。修复后 mismatch 零副作用。
    const context = createContext({
      chatAbortControllers: new Map([
        ["r1", createActiveRun("some-other-session", { deviceId: "d-other" })],
      ]),
    });
    const respond = await invokeChatAbort({
      context,
      request: { sessionKey: SK, runId: "r1" },
      client: ADMIN,
    });
    expect(tearDownSessionRuntimeForAbort).not.toHaveBeenCalled();
    expect(markSessionAborted).not.toHaveBeenCalled();
    // 仍返回 mismatch 错误
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("does not match") }),
    );
  });
});

// review 第2轮 P1：用户在 WebChat/TUI 输入 /stop 走的是 chat.send（不是 chat.abort），
// 其 stopCommand 分支原本只 abortChatRunsForSessionKeyWithPartials，缺级联 teardown → 子 agent
// / 队列 / tab 残留、复现自我再生。这里验证 chat.send 的 /stop 与 chat.abort 行为对齐。
describe("chat.send /stop cascades subagent teardown (review P1)", () => {
  beforeEach(() => vi.clearAllMocks());

  async function invokeChatStop(p: {
    context: ReturnType<typeof createContext>;
    client?: unknown;
  }) {
    const respond = vi.fn();
    await chatHandlers["chat.send"]({
      params: { sessionKey: SK, message: "/stop", idempotencyKey: "idem-stop" },
      respond: respond as never,
      context: p.context as never,
      req: {} as never,
      client: (p.client ?? null) as never,
      isWebchatConnect: () => false,
    });
    return respond;
  }

  it("admin /stop via chat.send tears down + marks (parity with chat.abort)", async () => {
    await invokeChatStop({ context: createContext(), client: ADMIN });
    expect(tearDownSessionRuntimeForAbort).toHaveBeenCalledWith({ sessionKey: SK });
    expect(markSessionAborted).toHaveBeenCalledWith(expect.anything(), SK);
  });

  it("non-admin /stop via chat.send does NOT tear down or mark", async () => {
    await invokeChatStop({ context: createContext(), client: USER1 });
    expect(tearDownSessionRuntimeForAbort).not.toHaveBeenCalled();
    expect(markSessionAborted).not.toHaveBeenCalled();
  });
});
