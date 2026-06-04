/**
 * Integration test proving that sessions_yield produces a clean end_turn exit
 * with no pending tool calls, so the parent session is idle when subagent
 * results arrive.
 */
import "./run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEmbeddedPiAgent } from "./run.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import { mockedGlobalHookRunner } from "./run.overflow-compaction.mocks.shared.js";
import {
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
} from "./run.overflow-compaction.shared-test.js";
import { isEmbeddedPiRunActive, queueEmbeddedPiMessage } from "./runs.js";

describe("sessions_yield orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
  });

  it("parent session is idle after yield — end_turn, no pendingToolCalls", async () => {
    const sessionId = "yield-parent-session";

    // Simulate an attempt where sessions_yield was called
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: null,
        sessionIdUsed: sessionId,
        yieldDetected: true,
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      sessionId,
      runId: "run-yield-orchestration",
    });

    // 1. Run completed with end_turn (yield causes clean exit)
    expect(result.meta.stopReason).toBe("end_turn");

    // 2. No pending tool calls (yield is NOT a client tool call)
    expect(result.meta.pendingToolCalls).toBeUndefined();

    // 3. Parent session is IDLE (not in ACTIVE_EMBEDDED_RUNS)
    expect(isEmbeddedPiRunActive(sessionId)).toBe(false);

    // 4. Steer would fail (message delivery must take direct path, not steer)
    expect(queueEmbeddedPiMessage(sessionId, "subagent result")).toBe(false);
  });

  it("clientToolCall takes precedence over yieldDetected", async () => {
    // Edge case: both flags set (shouldn't happen, but clientToolCall wins)
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: null,
        yieldDetected: true,
        clientToolCall: { name: "hosted_tool", params: { arg: "value" } },
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-yield-vs-client-tool",
    });

    // clientToolCall wins — tool_calls stopReason, pendingToolCalls populated
    expect(result.meta.stopReason).toBe("tool_calls");
    expect(result.meta.pendingToolCalls).toHaveLength(1);
    expect(result.meta.pendingToolCalls![0].name).toBe("hosted_tool");
  });

  it("normal attempt without yield has no stopReason override", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-no-yield",
    });

    // Neither clientToolCall nor yieldDetected → stopReason is undefined
    expect(result.meta.stopReason).toBeUndefined();
    expect(result.meta.pendingToolCalls).toBeUndefined();
  });

  // ⚠️ 承重转发回归（会话级 abort 闸两轮 live 复验失败的真正根因）：
  // 面板 chat.send 与 LINE auto-reply 都经 dispatchInboundMessage → get-reply-run →
  // buildEmbeddedRunBaseParams → runEmbeddedPiAgent，把 abortedLastRunBeforeReset / inputProvenance
  // 放进 RunEmbeddedPiAgentParams。但 runEmbeddedPiAgent → runEmbeddedAttempt 这一跳此前漏抄
  // abortedLastRunBeforeReset → attempt.ts 处的闸判据 #2 读到 undefined（对所有 run）→ 闸永不触发。
  // 历史 live 诊断 实测正是「prov 形态有值（这一跳本来就透传 inputProvenance）、abortedFlag=undefined」。
  // 本用例锁死「两者都透传到 attempt」，防回归。
  it("forwards abortedLastRunBeforeReset + inputProvenance from runEmbeddedPiAgent into runEmbeddedAttempt", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-forward-abort-flag",
      // 模拟 inbound 链早期捕获、透传下来的「上一轮被用户 abort」内存 flag。
      abortedLastRunBeforeReset: true,
      // 模拟面板 chat.send 普通用户：systemInputProvenance 仅 ACP 桥可设，普通用户为 undefined。
      // 这里显式给 inter_session 之外的一种值，确认透传链本身把对象原样带到 attempt。
      inputProvenance: { kind: "external_user" },
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    const attemptArg = mockedRunEmbeddedAttempt.mock.calls[0][0];
    // 修复前这里是 undefined（漏抄）→ 现在必须原样到达 attempt。
    expect(attemptArg.abortedLastRunBeforeReset).toBe(true);
    expect(attemptArg.inputProvenance).toEqual({ kind: "external_user" });
  });

  // 反证 / 锁死「无 abort flag 时透传 undefined，不凭空捏造 true」。
  it("forwards undefined abortedLastRunBeforeReset when the caller did not set it", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-forward-abort-flag-absent",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt.mock.calls[0][0].abortedLastRunBeforeReset).toBeUndefined();
  });
});
