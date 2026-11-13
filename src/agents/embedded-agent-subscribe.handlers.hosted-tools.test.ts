import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHostedToolHookRequester } from "./embedded-agent-subscribe.handlers.hosted-tools.js";
import {
  createMessageEndContext,
  endMessage,
} from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";

const searchCall = (overrides: Record<string, unknown> = {}) => ({
  type: "web_search",
  id: "ws_1",
  status: "completed",
  action: { type: "search", query: "nishikawaguchi yakiniku", queries: ["a", "b"] },
  sources: ["https://example.com/a", "https://example.com/b"],
  ...overrides,
});

const recordingHook = () =>
  vi.fn(async (_event: Record<string, unknown>, _ctx: Record<string, unknown>) => {});

const assistantMessage = (hostedToolCalls?: unknown[]) => ({
  role: "assistant",
  content: [{ type: "text", text: "Here are some places." }],
  ...(hostedToolCalls ? { hostedToolCalls } : {}),
});

function withHookRunner(
  ctx: EmbeddedAgentSubscribeContext,
  runAfterToolCall: ReturnType<typeof vi.fn>,
  hasHooks = true,
) {
  Object.assign(ctx, {
    hookRunner: {
      hasHooks: vi.fn((name: string) => hasHooks && name === "after_tool_call"),
      runAfterToolCall,
    },
  });
  Object.assign(ctx.params, {
    agentId: "agent-1",
    sessionKey: "agent:agent-1:main",
    sessionId: "session-1",
    requester: { channel: "web", senderId: "user-1" },
  });
  return ctx;
}

describe("provider-hosted tool calls at message end", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports each hosted call to after_tool_call before the reply is finalized", async () => {
    const order: string[] = [];
    const runAfterToolCall = vi.fn(async () => {
      order.push("hook");
    });
    const finalizeAssistantTexts = vi.fn(() => {
      order.push("finalize");
    });
    const ctx = withHookRunner(
      createMessageEndContext({ finalizeAssistantTexts }),
      runAfterToolCall,
    );

    await endMessage(ctx, { message: assistantMessage([searchCall()]) });

    expect(order).toEqual(["hook", "finalize"]);
    expect(runAfterToolCall).toHaveBeenCalledTimes(1);
    expect(runAfterToolCall).toHaveBeenCalledWith(
      {
        toolName: "web_search",
        params: { query: "nishikawaguchi yakiniku", queries: ["a", "b"] },
        runId: "run-1",
        toolCallId: "ws_1",
        result: {
          content: [
            {
              type: "text",
              text: "status: completed\nsources:\nhttps://example.com/a\nhttps://example.com/b",
            },
          ],
          details: {
            status: "completed",
            sources: ["https://example.com/a", "https://example.com/b"],
          },
        },
        error: undefined,
      },
      {
        toolName: "web_search",
        toolKind: "provider_hosted",
        agentId: "agent-1",
        sessionKey: "agent:agent-1:main",
        sessionId: "session-1",
        runId: "run-1",
        toolCallId: "ws_1",
        requester: { channel: "web", senderId: "user-1" },
      },
    );
  });

  it("reports a non-completed hosted call as an error", async () => {
    const runAfterToolCall = recordingHook();
    const ctx = withHookRunner(createMessageEndContext(), runAfterToolCall);

    await endMessage(ctx, {
      message: assistantMessage([searchCall({ status: "failed", sources: undefined })]),
    });

    expect(runAfterToolCall.mock.calls[0]?.[0]).toMatchObject({
      error: "web_search failed",
      result: { content: [{ type: "text", text: "status: failed" }] },
    });
  });

  it("reports hosted calls carried by an error message with their params and sources", async () => {
    const runAfterToolCall = recordingHook();
    const ctx = withHookRunner(createMessageEndContext(), runAfterToolCall);

    await endMessage(ctx, {
      message: {
        ...assistantMessage([searchCall()]),
        stopReason: "error",
        errorMessage: "server_error: boom",
      },
    });

    expect(runAfterToolCall).toHaveBeenCalledTimes(1);
    expect(runAfterToolCall.mock.calls[0]?.[0]).toMatchObject({
      toolName: "web_search",
      toolCallId: "ws_1",
      params: { query: "nishikawaguchi yakiniku", queries: ["a", "b"] },
      result: {
        details: {
          status: "completed",
          sources: ["https://example.com/a", "https://example.com/b"],
        },
      },
    });
  });

  it("reports a call id only once across repeated message ends", async () => {
    const runAfterToolCall = recordingHook();
    const ctx = withHookRunner(createMessageEndContext(), runAfterToolCall);

    await endMessage(ctx, { message: assistantMessage([searchCall()]) });
    const repeated = endMessage(ctx, {
      message: assistantMessage([searchCall(), searchCall({ id: "ws_2" })]),
    });
    await repeated;

    expect(runAfterToolCall.mock.calls.map(([event]) => event.toolCallId)).toEqual([
      "ws_1",
      "ws_2",
    ]);
  });

  it("keeps message end synchronous when there are no hosted calls", () => {
    const runAfterToolCall = vi.fn(async () => {});
    const ctx = withHookRunner(createMessageEndContext(), runAfterToolCall);

    const result = endMessage(ctx, { message: assistantMessage() });

    expect(result).toBeUndefined();
    expect(runAfterToolCall).not.toHaveBeenCalled();
  });

  it("skips observers when no after_tool_call hook is registered", async () => {
    const runAfterToolCall = vi.fn(async () => {});
    const finalizeAssistantTexts = vi.fn();
    const ctx = withHookRunner(
      createMessageEndContext({ finalizeAssistantTexts }),
      runAfterToolCall,
      false,
    );

    await endMessage(ctx, { message: assistantMessage([searchCall()]) });

    expect(runAfterToolCall).not.toHaveBeenCalled();
    expect(finalizeAssistantTexts).toHaveBeenCalled();
  });

  it("does not hold the reply when an observer fails", async () => {
    const warn = vi.fn();
    const runAfterToolCall = vi.fn(async () => {
      throw new Error("observer down");
    });
    const finalizeAssistantTexts = vi.fn();
    const ctx = withHookRunner(
      createMessageEndContext({ finalizeAssistantTexts, warn }),
      runAfterToolCall,
    );

    await endMessage(ctx, { message: assistantMessage([searchCall()]) });

    expect(finalizeAssistantTexts).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tool=web_search"));
  });

  it("finalizes the reply after the wait bound when an observer hangs", async () => {
    vi.useFakeTimers();
    const runAfterToolCall = vi.fn(() => new Promise<void>(() => {}));
    const finalizeAssistantTexts = vi.fn();
    const ctx = withHookRunner(
      createMessageEndContext({ finalizeAssistantTexts }),
      runAfterToolCall,
    );

    const pending = endMessage(ctx, { message: assistantMessage([searchCall()]) });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(finalizeAssistantTexts).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(finalizeAssistantTexts).toHaveBeenCalled();
  });
});

describe("buildHostedToolHookRequester", () => {
  it("mirrors the local tool hook requester facts", () => {
    expect(
      buildHostedToolHookRequester({
        messageProvider: "telegram",
        agentAccountId: "acct-1",
        senderId: "user-1",
        senderIsOwner: false,
        memberRoleIds: ["role-a"],
      }),
    ).toEqual({
      requester: {
        channel: "telegram",
        accountId: "acct-1",
        senderId: "user-1",
        senderIsOwner: false,
        roleIds: ["role-a"],
      },
    });
  });

  it("prefers the message channel and omits an empty requester", () => {
    expect(
      buildHostedToolHookRequester({ messageChannel: "web", messageProvider: "telegram" }),
    ).toEqual({ requester: { channel: "web" } });
    expect(buildHostedToolHookRequester({ senderId: null, memberRoleIds: [] })).toEqual({});
  });
});
