// src/agents/subagent-announce.guard.test.ts
//
// Task 3 TDD 失败测试（Step 1）：验证 deliverSubagentAnnouncement 在目标
// orchestrator 会话处于 abort 态时，丢弃 announce、不调 dispatch。
//
// 被测逻辑：
//   deliverSubagentAnnouncement（subagent-announce.ts）在函数体最前面
//   调 isSessionAborted 查闸，若已打标则 noteDroppedAnnounce + 直接返回
//   { delivered: false, path: "none" }，跳过 runSubagentAnnounceDispatch。
//
// 路径核对（均以真实 import 路径为准，mock 才能生效）：
//   isSessionAborted / noteDroppedAnnounce  → "./session-abort-guard.js"
//   runSubagentAnnounceDispatch             → "./subagent-announce-dispatch.js"
//   loadConfig                              → "../config/config.js"（已在
//                                             subagent-announce.ts 顶部 import，
//                                             实现里复用，不需额外 mock）

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------- vi.hoisted：在 vi.mock 工厂执行前先创建 mock 函数实例 ----------
const { isSessionAborted, noteDroppedAnnounce, runSubagentAnnounceDispatch } = vi.hoisted(() => ({
  isSessionAborted: vi.fn(() => false),
  noteDroppedAnnounce: vi.fn(() => 1),
  // 模拟正常投递的返回值（不是 abort 分支时的期望返回）
  runSubagentAnnounceDispatch: vi.fn(async () => ({ delivered: true, path: "direct" })),
}));

// ---------- mock session-abort-guard（abort 态查标 + 丢弃计数） ----------
vi.mock("./session-abort-guard.js", () => ({
  isSessionAborted,
  noteDroppedAnnounce,
  // clearSessionAbort / markSessionAborted 不被 deliverSubagentAnnouncement 直接调用，
  // 只需 stub 成空函数避免 "No X export is defined on mock" 报错
  markSessionAborted: vi.fn(),
  clearSessionAbort: vi.fn(),
  __testing: { reset: vi.fn() },
}));

// ---------- mock subagent-announce-dispatch（唯一 runtime 导出：runSubagentAnnounceDispatch） ----------
vi.mock("./subagent-announce-dispatch.js", () => ({
  runSubagentAnnounceDispatch,
  // mapQueueOutcomeToDeliveryResult 是该模块另一个 export，但 deliverSubagentAnnouncement
  // 不直接调用它；仍 stub 避免潜在 "no export" 报错
  mapQueueOutcomeToDeliveryResult: vi.fn(),
}));

// ---------- mock config（loadConfig 被实现里调用以传给 isSessionAborted） ----------
vi.mock("../config/config.js", () => ({
  loadConfig: () => ({}),
}));

// ---------- 被测函数：Step 3 完成之前它还未 export，此处 import 会失败 ----------
import { deliverSubagentAnnouncement } from "./subagent-announce.js";

// 最小合法参数集（as never 绕过额外字段的 TS 严格校验）
const baseParams = {
  requesterSessionKey: "agent:orch-1:user:u:panel",
  targetRequesterSessionKey: "agent:orch-1:user:u:panel",
  triggerMessage: "child done",
  steerMessage: "child done",
  directIdempotencyKey: "idem-1",
  requesterIsSubagent: false,
  expectsCompletionMessage: true,
} as never;

describe("deliverSubagentAnnouncement abort guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("drops announce (no dispatch) when controller session is aborted", async () => {
    // 模拟目标 orchestrator 会话处于 abort 态
    isSessionAborted.mockReturnValueOnce(true);

    const res = await deliverSubagentAnnouncement(baseParams);

    // 核心断言：dispatch 不应被调用（announce 被丢弃）
    expect(runSubagentAnnounceDispatch).not.toHaveBeenCalled();
    // 必须记录一次丢弃计数
    expect(noteDroppedAnnounce).toHaveBeenCalled();
    // 返回「未投递」形态
    expect(res.delivered).toBe(false);
  });

  it("dispatches normally when not aborted", async () => {
    // 未打标 → 走正常 dispatch
    isSessionAborted.mockReturnValue(false);

    await deliverSubagentAnnouncement(baseParams);

    // 正常路径：dispatch 必须被调用一次
    expect(runSubagentAnnounceDispatch).toHaveBeenCalledTimes(1);
  });
});
