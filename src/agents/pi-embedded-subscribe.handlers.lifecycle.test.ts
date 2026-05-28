import { describe, expect, it, vi } from "vitest";
import { createInlineCodeState } from "../markdown/code-spans.js";
import { handleAgentEnd } from "./pi-embedded-subscribe.handlers.lifecycle.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
}));

function createContext(
  lastAssistant: unknown,
  overrides?: { onAgentEvent?: (event: unknown) => void },
): EmbeddedPiSubscribeContext {
  return {
    params: {
      runId: "run-1",
      config: {},
      sessionKey: "agent:main:main",
      onAgentEvent: overrides?.onAgentEvent,
    },
    state: {
      lastAssistant: lastAssistant as EmbeddedPiSubscribeContext["state"]["lastAssistant"],
      pendingCompactionRetry: 0,
      blockState: {
        thinking: true,
        final: true,
        inlineCode: createInlineCodeState(),
      },
    },
    log: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    flushBlockReplyBuffer: vi.fn(),
    resolveCompactionRetry: vi.fn(),
    maybeResolveCompactionWait: vi.fn(),
  } as unknown as EmbeddedPiSubscribeContext;
}

describe("handleAgentEnd", () => {
  it("logs the resolved error message when run ends with assistant error", () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "connection refused",
        content: [{ type: "text", text: "" }],
      },
      { onAgentEvent },
    );

    handleAgentEnd(ctx);

    const warn = vi.mocked(ctx.log.warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe("embedded run agent end");
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      event: "embedded_run_agent_end",
      runId: "run-1",
      error: "connection refused",
      rawErrorPreview: "connection refused",
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "error",
        error: "connection refused",
      },
    });
  });

  it("attaches raw provider error metadata and includes model/provider in console output", () => {
    const ctx = createContext({
      role: "assistant",
      stopReason: "error",
      provider: "anthropic",
      model: "claude-test",
      errorMessage: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      content: [{ type: "text", text: "" }],
    });

    handleAgentEnd(ctx);

    const warn = vi.mocked(ctx.log.warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe("embedded run agent end");
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      event: "embedded_run_agent_end",
      runId: "run-1",
      error: "The AI service is temporarily overloaded. Please try again in a moment.",
      failoverReason: "overloaded",
      providerErrorType: "overloaded_error",
      consoleMessage:
        "embedded run agent end: runId=run-1 isError=true model=claude-test provider=anthropic error=The AI service is temporarily overloaded. Please try again in a moment.",
    });
  });

  it("sanitizes model and provider before writing consoleMessage", () => {
    const ctx = createContext({
      role: "assistant",
      stopReason: "error",
      provider: "anthropic\u001b]8;;https://evil.test\u0007",
      model: "claude\tsonnet\n4",
      errorMessage: "connection refused",
      content: [{ type: "text", text: "" }],
    });

    handleAgentEnd(ctx);

    const warn = vi.mocked(ctx.log.warn);
    const meta = warn.mock.calls[0]?.[1];
    expect(meta).toMatchObject({
      consoleMessage:
        "embedded run agent end: runId=run-1 isError=true model=claude sonnet 4 provider=anthropic]8;;https://evil.test error=connection refused",
    });
    expect(meta?.consoleMessage).not.toContain("\n");
    expect(meta?.consoleMessage).not.toContain("\r");
    expect(meta?.consoleMessage).not.toContain("\t");
    expect(meta?.consoleMessage).not.toContain("\u001b");
  });

  it("redacts logged error text before emitting lifecycle events", () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "x-api-key: sk-abcdefghijklmnopqrstuvwxyz123456",
        content: [{ type: "text", text: "" }],
      },
      { onAgentEvent },
    );

    handleAgentEnd(ctx);

    const warn = vi.mocked(ctx.log.warn);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      event: "embedded_run_agent_end",
      error: "x-api-key: ***",
      rawErrorPreview: "x-api-key: ***",
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "error",
        error: "x-api-key: ***",
      },
    });
  });

  it("keeps non-error run-end logging on debug only", () => {
    const ctx = createContext(undefined);

    handleAgentEnd(ctx);

    expect(ctx.log.warn).not.toHaveBeenCalled();
    expect(ctx.log.debug).toHaveBeenCalledWith("embedded run agent end: runId=run-1 isError=false");
  });

  // Producer-side tests: verify that handleAgentEnd correctly forwards
  // structured rate-limit fields into the onAgentEvent callback so downstream
  // consumers (server-chat.ts) can surface them in the chat error payload.

  it("forwards limitTokensPerMinute and requestedTokens for OpenAI TPM rate-limit error", () => {
    // Real OpenAI error form: "Limit <N>, Requested <M>" in the message.
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "error",
        errorMessage:
          "Request too large for gpt-4o-mini on tokens per min (TPM): Limit 30000, Requested 52748. " +
          "The input or output tokens must be reduced in order to run the models.",
        content: [{ type: "text", text: "" }],
      },
      { onAgentEvent },
    );

    handleAgentEnd(ctx);

    // The friendly error text must still be present.
    expect(onAgentEvent).toHaveBeenCalledTimes(1);
    const callData = onAgentEvent.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(callData).toMatchObject({
      phase: "error",
      // error is present (exact text is handled by formatAssistantErrorText; just
      // assert it is a non-empty string, not the raw provider message).
      error: expect.any(String),
      limitTokensPerMinute: 30000,
      requestedTokens: 52748,
    });
    expect(callData.error).toBeTruthy();
  });

  it("forwards limitTokensPerMinute without requestedTokens for Anthropic rate-limit form", () => {
    // Anthropic's form only includes the limit, not the requested amount.
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "error",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        errorMessage:
          "This request would exceed your organization's rate limit of 30,000 input tokens per minute " +
          "(model: claude-3-5-sonnet-20241022). Your current rate limit is 30,000 input tokens per minute.",
        content: [{ type: "text", text: "" }],
      },
      { onAgentEvent },
    );

    handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledTimes(1);
    const callData = onAgentEvent.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(callData).toMatchObject({
      phase: "error",
      error: expect.any(String),
      limitTokensPerMinute: 30000,
    });
    // Anthropic does not provide the requested token count — must be absent.
    expect("requestedTokens" in callData).toBe(false);
    expect(callData.error).toBeTruthy();
  });
});
