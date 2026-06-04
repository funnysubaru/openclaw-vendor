// src/auto-reply/reply/commands-session-abort.guard.test.ts
//
// review #2 TDD 测试：handleAbortTrigger（文本触发的 abort，如 "stop"/"abort"）必须和
// handleStopCommand（/stop）一样，abort 成功后打 abort 闸 + 停子 agent。
//
// 背景：PR 声明「5 条 abort 路径都打标」，但 handleAbortTrigger 原本只 applyAbortTarget，
// 缺 markSessionAborted + stopSubagentsForRequester。主通道 tryFastAbortFromMessage 多数
// 场景已覆盖，但 getReplyFromConfig 直连（heartbeat 等）可能绕过 → 残留子 agent + 再生循环。
//
// mock 说明：handleAbortTrigger 内部依赖较多 leaf 模块（applyAbortTarget 会 persist、
// resolveAbortCutoffForTarget 会读 cutoff）。这里把它们 mock 成 no-op，只聚焦验证
// 「mark + stopSubagents 被以正确 key 调用」这个本次新增的行为。

import { beforeEach, describe, expect, it, vi } from "vitest";

const { markSessionAborted, stopSubagentsForRequester, isAbortTrigger, resolveSessionEntryForKey } =
  vi.hoisted(() => ({
    markSessionAborted: vi.fn(),
    stopSubagentsForRequester: vi.fn(() => ({ stopped: 2 })),
    isAbortTrigger: vi.fn(() => true),
    // 让 resolveAbortTarget 回退到 (sessionEntry + sessionKey) 分支 → abortTarget.key = sessionKey
    resolveSessionEntryForKey: vi.fn(() => ({ entry: undefined, key: undefined })),
  }));

vi.mock("../../agents/session-abort-guard.js", () => ({
  markSessionAborted,
  isSessionAborted: vi.fn(() => false),
  noteDroppedAnnounce: vi.fn(() => 0),
  clearSessionAbort: vi.fn(),
  __testing: { reset: vi.fn() },
}));

vi.mock("./abort.js", () => ({
  isAbortTrigger,
  stopSubagentsForRequester,
  resolveSessionEntryForKey,
  setAbortMemory: vi.fn(),
  formatAbortReplyText: (n: number) => `aborted:${n}`,
}));

vi.mock("./command-gates.js", () => ({
  rejectUnauthorizedCommand: vi.fn(() => undefined), // 一律授权通过
}));

vi.mock("./commands-session-store.js", () => ({
  persistAbortTargetEntry: vi.fn(async () => true),
}));

vi.mock("./abort-cutoff.js", () => ({
  resolveAbortCutoffFromContext: vi.fn(() => undefined),
  shouldPersistAbortCutoff: vi.fn(() => false),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn(),
}));

vi.mock("./queue.js", () => ({
  clearSessionQueues: vi.fn(() => ({ followupCleared: 0, laneCleared: 0, keys: [] })),
}));

vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: vi.fn(() => ({})),
  triggerInternalHook: vi.fn(async () => {}),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

import { handleAbortTrigger } from "./commands-session-abort.js";

const SK = "agent:orch-1:user:u:panel";

function makeParams() {
  return {
    cfg: { session: { mainKey: "main", scope: "per-sender" } },
    command: {
      rawBodyNormalized: "stop",
      commandBodyNormalized: "stop",
      abortKey: "ak",
      surface: "panel",
      senderId: "s",
    },
    ctx: {},
    sessionKey: SK,
    sessionEntry: {}, // 无 sessionId，applyAbortTarget 不触 abortEmbeddedPiRun
    sessionStore: {},
    storePath: "/tmp/store.json",
  } as never;
}

describe("handleAbortTrigger session-abort-guard parity with /stop", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks session aborted + stops subagents (aligns with handleStopCommand)", async () => {
    const res = await handleAbortTrigger(makeParams(), true);
    // 核心：本次新增的两步——打闸 + 停子，key 都用 abortTarget.key（= sessionKey）
    expect(markSessionAborted).toHaveBeenCalledWith(expect.anything(), SK);
    expect(stopSubagentsForRequester).toHaveBeenCalledWith({
      cfg: expect.anything(),
      requesterSessionKey: SK,
    });
    expect(res?.shouldContinue).toBe(false);
  });

  it("does nothing when text is not an abort trigger", async () => {
    isAbortTrigger.mockReturnValueOnce(false);
    const res = await handleAbortTrigger(makeParams(), true);
    expect(res).toBeNull();
    expect(markSessionAborted).not.toHaveBeenCalled();
    expect(stopSubagentsForRequester).not.toHaveBeenCalled();
  });
});
