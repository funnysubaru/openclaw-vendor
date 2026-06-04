import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveOllamaBaseUrlForRun } from "../../ollama-stream.js";
import {
  buildAfterTurnRuntimeContext,
  composeSystemPromptWithHookContext,
  isOllamaCompatProvider,
  maybeResetOrchestratorYieldContextAfterUserAbort,
  stripSessionsYieldArtifacts,
  prependSystemPromptAddition,
  resolveAttemptFsWorkspaceOnly,
  resolveOllamaCompatNumCtxEnabled,
  resolvePromptBuildHookResult,
  resolvePromptModeForSession,
  shouldInjectOllamaCompatNumCtx,
  decodeHtmlEntitiesInObject,
  wrapOllamaCompatNumCtx,
  wrapStreamFnRepairMalformedToolCallArguments,
  wrapStreamFnTrimToolCallNames,
} from "./attempt.js";

function createOllamaProviderConfig(injectNumCtxForOpenAICompat: boolean): OpenClawConfig {
  return {
    models: {
      providers: {
        ollama: {
          baseUrl: "http://127.0.0.1:11434/v1",
          api: "openai-completions",
          injectNumCtxForOpenAICompat,
          models: [],
        },
      },
    },
  };
}

describe("resolvePromptBuildHookResult", () => {
  function createLegacyOnlyHookRunner() {
    return {
      hasHooks: vi.fn(
        (hookName: "before_prompt_build" | "before_agent_start") =>
          hookName === "before_agent_start",
      ),
      runBeforePromptBuild: vi.fn(async () => undefined),
      runBeforeAgentStart: vi.fn(async () => ({ prependContext: "from-hook" })),
    };
  }

  it("reuses precomputed legacy before_agent_start result without invoking hook again", async () => {
    const hookRunner = createLegacyOnlyHookRunner();
    const result = await resolvePromptBuildHookResult({
      prompt: "hello",
      messages: [],
      hookCtx: {},
      hookRunner,
      legacyBeforeAgentStartResult: { prependContext: "from-cache", systemPrompt: "legacy-system" },
    });

    expect(hookRunner.runBeforeAgentStart).not.toHaveBeenCalled();
    expect(result).toEqual({
      prependContext: "from-cache",
      systemPrompt: "legacy-system",
      prependSystemContext: undefined,
      appendSystemContext: undefined,
    });
  });

  it("calls legacy hook when precomputed result is absent", async () => {
    const hookRunner = createLegacyOnlyHookRunner();
    const messages = [{ role: "user", content: "ctx" }];
    const result = await resolvePromptBuildHookResult({
      prompt: "hello",
      messages,
      hookCtx: {},
      hookRunner,
    });

    expect(hookRunner.runBeforeAgentStart).toHaveBeenCalledTimes(1);
    expect(hookRunner.runBeforeAgentStart).toHaveBeenCalledWith({ prompt: "hello", messages }, {});
    expect(result.prependContext).toBe("from-hook");
  });

  it("merges prompt-build and legacy context fields in deterministic order", async () => {
    const hookRunner = {
      hasHooks: vi.fn(() => true),
      runBeforePromptBuild: vi.fn(async () => ({
        prependContext: "prompt context",
        prependSystemContext: "prompt prepend",
        appendSystemContext: "prompt append",
      })),
      runBeforeAgentStart: vi.fn(async () => ({
        prependContext: "legacy context",
        prependSystemContext: "legacy prepend",
        appendSystemContext: "legacy append",
      })),
    };

    const result = await resolvePromptBuildHookResult({
      prompt: "hello",
      messages: [],
      hookCtx: {},
      hookRunner,
    });

    expect(result.prependContext).toBe("prompt context\n\nlegacy context");
    expect(result.prependSystemContext).toBe("prompt prepend\n\nlegacy prepend");
    expect(result.appendSystemContext).toBe("prompt append\n\nlegacy append");
  });
});

describe("composeSystemPromptWithHookContext", () => {
  it("returns undefined when no hook system context is provided", () => {
    expect(composeSystemPromptWithHookContext({ baseSystemPrompt: "base" })).toBeUndefined();
  });

  it("builds prepend/base/append system prompt order", () => {
    expect(
      composeSystemPromptWithHookContext({
        baseSystemPrompt: "  base system  ",
        prependSystemContext: "  prepend  ",
        appendSystemContext: "  append  ",
      }),
    ).toBe("prepend\n\nbase system\n\nappend");
  });

  it("avoids blank separators when base system prompt is empty", () => {
    expect(
      composeSystemPromptWithHookContext({
        baseSystemPrompt: "   ",
        appendSystemContext: "  append only  ",
      }),
    ).toBe("append only");
  });
});

describe("resolvePromptModeForSession", () => {
  it("uses minimal mode for subagent sessions", () => {
    expect(resolvePromptModeForSession("agent:main:subagent:child")).toBe("minimal");
  });

  it("uses minimal mode for cron sessions", () => {
    expect(resolvePromptModeForSession("agent:main:cron:job-1")).toBe("minimal");
    expect(resolvePromptModeForSession("agent:main:cron:job-1:run:run-abc")).toBe("minimal");
  });

  it("uses full mode for regular and undefined sessions", () => {
    expect(resolvePromptModeForSession(undefined)).toBe("full");
    expect(resolvePromptModeForSession("agent:main")).toBe("full");
    expect(resolvePromptModeForSession("agent:main:thread:abc")).toBe("full");
  });
});

describe("resolveAttemptFsWorkspaceOnly", () => {
  it("uses global tools.fs.workspaceOnly when agent has no override", () => {
    const cfg: OpenClawConfig = {
      tools: {
        fs: { workspaceOnly: true },
      },
    };

    expect(
      resolveAttemptFsWorkspaceOnly({
        config: cfg,
        sessionAgentId: "main",
      }),
    ).toBe(true);
  });

  it("prefers agent-specific tools.fs.workspaceOnly override", () => {
    const cfg: OpenClawConfig = {
      tools: {
        fs: { workspaceOnly: true },
      },
      agents: {
        list: [
          {
            id: "main",
            tools: {
              fs: { workspaceOnly: false },
            },
          },
        ],
      },
    };

    expect(
      resolveAttemptFsWorkspaceOnly({
        config: cfg,
        sessionAgentId: "main",
      }),
    ).toBe(false);
  });
});
describe("wrapStreamFnTrimToolCallNames", () => {
  function createFakeStream(params: { events: unknown[]; resultMessage: unknown }): {
    result: () => Promise<unknown>;
    [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
  } {
    return {
      async result() {
        return params.resultMessage;
      },
      [Symbol.asyncIterator]() {
        return (async function* () {
          for (const event of params.events) {
            yield event;
          }
        })();
      },
    };
  }

  async function invokeWrappedStream(
    baseFn: (...args: never[]) => unknown,
    allowedToolNames?: Set<string>,
  ) {
    const wrappedFn = wrapStreamFnTrimToolCallNames(baseFn as never, allowedToolNames);
    return await wrappedFn({} as never, {} as never, {} as never);
  }

  function createEventStream(params: {
    event: unknown;
    finalToolCall: { type: string; name: string };
  }) {
    const finalMessage = { role: "assistant", content: [params.finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({ events: [params.event], resultMessage: finalMessage }),
    );
    return { baseFn, finalMessage };
  }

  it("trims whitespace from live streamed tool call names and final result message", async () => {
    const partialToolCall = { type: "toolCall", name: " read " };
    const messageToolCall = { type: "toolCall", name: " exec " };
    const finalToolCall = { type: "toolCall", name: " write " };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
      message: { role: "assistant", content: [messageToolCall] },
    };
    const { baseFn, finalMessage } = createEventStream({ event, finalToolCall });

    const stream = await invokeWrappedStream(baseFn);

    const seenEvents: unknown[] = [];
    for await (const item of stream) {
      seenEvents.push(item);
    }
    const result = await stream.result();

    expect(seenEvents).toHaveLength(1);
    expect(partialToolCall.name).toBe("read");
    expect(messageToolCall.name).toBe("exec");
    expect(finalToolCall.name).toBe("write");
    expect(result).toBe(finalMessage);
    expect(baseFn).toHaveBeenCalledTimes(1);
  });

  it("supports async stream functions that return a promise", async () => {
    const finalToolCall = { type: "toolCall", name: " browser " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(async () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    const result = await stream.result();

    expect(finalToolCall.name).toBe("browser");
    expect(result).toBe(finalMessage);
    expect(baseFn).toHaveBeenCalledTimes(1);
  });
  it("normalizes common tool aliases when the canonical name is allowed", async () => {
    const finalToolCall = { type: "toolCall", name: " BASH " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["exec"]));
    const result = await stream.result();

    expect(finalToolCall.name).toBe("exec");
    expect(result).toBe(finalMessage);
  });

  it("maps provider-prefixed tool names to allowed canonical tools", async () => {
    const partialToolCall = { type: "toolCall", name: " functions.read " };
    const messageToolCall = { type: "toolCall", name: " functions.write " };
    const finalToolCall = { type: "toolCall", name: " tools/exec " };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
      message: { role: "assistant", content: [messageToolCall] },
    };
    const { baseFn } = createEventStream({ event, finalToolCall });

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write", "exec"]));

    for await (const _item of stream) {
      // drain
    }
    await stream.result();

    expect(partialToolCall.name).toBe("read");
    expect(messageToolCall.name).toBe("write");
    expect(finalToolCall.name).toBe("exec");
  });

  it("normalizes toolUse and functionCall names before dispatch", async () => {
    const partialToolCall = { type: "toolUse", name: " functions.read " };
    const messageToolCall = { type: "functionCall", name: " functions.exec " };
    const finalToolCall = { type: "toolUse", name: " tools/write " };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
      message: { role: "assistant", content: [messageToolCall] },
    };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [event],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write", "exec"]));

    for await (const _item of stream) {
      // drain
    }
    const result = await stream.result();

    expect(partialToolCall.name).toBe("read");
    expect(messageToolCall.name).toBe("exec");
    expect(finalToolCall.name).toBe("write");
    expect(result).toBe(finalMessage);
  });

  it("preserves multi-segment tool suffixes when dropping provider prefixes", async () => {
    const finalToolCall = { type: "toolCall", name: " functions.graph.search " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["graph.search", "search"]));
    const result = await stream.result();

    expect(finalToolCall.name).toBe("graph.search");
    expect(result).toBe(finalMessage);
  });

  it("infers tool names from malformed toolCallId variants when allowlist is present", async () => {
    const partialToolCall = { type: "toolCall", id: "functions.read:0", name: "" };
    const finalToolCallA = { type: "toolCall", id: "functionsread3", name: "" };
    const finalToolCallB: { type: string; id: string; name?: string } = {
      type: "toolCall",
      id: "functionswrite4",
    };
    const finalToolCallC = { type: "functionCall", id: "functions.exec2", name: "" };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
    };
    const finalMessage = {
      role: "assistant",
      content: [finalToolCallA, finalToolCallB, finalToolCallC],
    };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [event],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write", "exec"]));
    for await (const _item of stream) {
      // drain
    }
    const result = await stream.result();

    expect(partialToolCall.name).toBe("read");
    expect(finalToolCallA.name).toBe("read");
    expect(finalToolCallB.name).toBe("write");
    expect(finalToolCallC.name).toBe("exec");
    expect(result).toBe(finalMessage);
  });

  it("does not infer names from malformed toolCallId when allowlist is absent", async () => {
    const finalToolCall: { type: string; id: string; name?: string } = {
      type: "toolCall",
      id: "functionsread3",
    };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    await stream.result();

    expect(finalToolCall.name).toBeUndefined();
  });

  it("infers malformed non-blank tool names before dispatch", async () => {
    const partialToolCall = { type: "toolCall", id: "functionsread3", name: "functionsread3" };
    const finalToolCall = { type: "toolCall", id: "functionsread3", name: "functionsread3" };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
    };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [event],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    for await (const _item of stream) {
      // drain
    }
    await stream.result();

    expect(partialToolCall.name).toBe("read");
    expect(finalToolCall.name).toBe("read");
  });

  it("recovers malformed non-blank names when id is missing", async () => {
    const finalToolCall = { type: "toolCall", name: "functionsread3" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
  });

  it("recovers canonical tool names from canonical ids when name is empty", async () => {
    const finalToolCall = { type: "toolCall", id: "read", name: "" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
  });

  it("recovers tool names from ids when name is whitespace-only", async () => {
    const finalToolCall = { type: "toolCall", id: "functionswrite4", name: "   " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("write");
  });

  it("keeps blank names blank and assigns fallback ids when both name and id are blank", async () => {
    const finalToolCall = { type: "toolCall", id: "", name: "" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("");
    expect(finalToolCall.id).toBe("call_auto_1");
  });

  it("assigns fallback ids when both name and id are missing", async () => {
    const finalToolCall: { type: string; name?: string; id?: string } = { type: "toolCall" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBeUndefined();
    expect(finalToolCall.id).toBe("call_auto_1");
  });

  it("prefers explicit canonical names over conflicting canonical ids", async () => {
    const finalToolCall = { type: "toolCall", id: "write", name: "read" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
    expect(finalToolCall.id).toBe("write");
  });

  it("prefers explicit trimmed canonical names over conflicting malformed ids", async () => {
    const finalToolCall = { type: "toolCall", id: "functionswrite4", name: " read " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
  });

  it("does not rewrite composite names that mention multiple tools", async () => {
    const finalToolCall = { type: "toolCall", id: "functionsread3", name: "read write" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read write");
  });

  it("fails closed for malformed non-blank names that are ambiguous", async () => {
    const finalToolCall = { type: "toolCall", id: "functions.exec2", name: "functions.exec2" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["exec", "exec2"]));
    await stream.result();

    expect(finalToolCall.name).toBe("functions.exec2");
  });

  it("matches malformed ids case-insensitively across common separators", async () => {
    const finalToolCall = { type: "toolCall", id: "Functions.Read_7", name: "" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
  });
  it("does not override explicit non-blank tool names with inferred ids", async () => {
    const finalToolCall = { type: "toolCall", id: "functionswrite4", name: "someOtherTool" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("someOtherTool");
  });

  it("fails closed when malformed ids could map to multiple allowlisted tools", async () => {
    const finalToolCall = { type: "toolCall", id: "functions.exec2", name: "" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["exec", "exec2"]));
    await stream.result();

    expect(finalToolCall.name).toBe("");
  });
  it("does not collapse whitespace-only tool names to empty strings", async () => {
    const partialToolCall = { type: "toolCall", name: "   " };
    const finalToolCall = { type: "toolCall", name: "\t  " };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
    };
    const { baseFn } = createEventStream({ event, finalToolCall });

    const stream = await invokeWrappedStream(baseFn);

    for await (const _item of stream) {
      // drain
    }
    await stream.result();

    expect(partialToolCall.name).toBe("   ");
    expect(finalToolCall.name).toBe("\t  ");
    expect(baseFn).toHaveBeenCalledTimes(1);
  });

  it("assigns fallback ids to missing/blank tool call ids in streamed and final messages", async () => {
    const partialToolCall = { type: "toolCall", name: " read ", id: "   " };
    const finalToolCallA = { type: "toolCall", name: " exec ", id: "" };
    const finalToolCallB: { type: string; name: string; id?: string } = {
      type: "toolCall",
      name: " write ",
    };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
    };
    const finalMessage = { role: "assistant", content: [finalToolCallA, finalToolCallB] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [event],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // drain
    }
    const result = await stream.result();

    expect(partialToolCall.name).toBe("read");
    expect(partialToolCall.id).toBe("call_auto_1");
    expect(finalToolCallA.name).toBe("exec");
    expect(finalToolCallA.id).toBe("call_auto_1");
    expect(finalToolCallB.name).toBe("write");
    expect(finalToolCallB.id).toBe("call_auto_2");
    expect(result).toBe(finalMessage);
  });

  it("trims surrounding whitespace on tool call ids", async () => {
    const finalToolCall = { type: "toolCall", name: " read ", id: "  call_42  " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    await stream.result();

    expect(finalToolCall.name).toBe("read");
    expect(finalToolCall.id).toBe("call_42");
  });
});

describe("wrapStreamFnRepairMalformedToolCallArguments", () => {
  function createFakeStream(params: { events: unknown[]; resultMessage: unknown }): {
    result: () => Promise<unknown>;
    [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
  } {
    return {
      async result() {
        return params.resultMessage;
      },
      [Symbol.asyncIterator]() {
        return (async function* () {
          for (const event of params.events) {
            yield event;
          }
        })();
      },
    };
  }

  async function invokeWrappedStream(baseFn: (...args: never[]) => unknown) {
    const wrappedFn = wrapStreamFnRepairMalformedToolCallArguments(baseFn as never);
    return await wrappedFn({} as never, {} as never, {} as never);
  }

  it("repairs anthropic-compatible tool arguments when trailing junk follows valid JSON", async () => {
    const partialToolCall = { type: "toolCall", name: "read", arguments: {} };
    const streamedToolCall = { type: "toolCall", name: "read", arguments: {} };
    const endMessageToolCall = { type: "toolCall", name: "read", arguments: {} };
    const finalToolCall = { type: "toolCall", name: "read", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const endMessage = { role: "assistant", content: [endMessageToolCall] };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"path":"/tmp/report.txt"}',
            partial: partialMessage,
          },
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: "xx",
            partial: partialMessage,
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedToolCall,
            partial: partialMessage,
            message: endMessage,
          },
        ],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // drain
    }
    const result = await stream.result();

    expect(partialToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(streamedToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(endMessageToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(finalToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(result).toBe(finalMessage);
  });

  it("keeps incomplete partial JSON unchanged until a complete object exists", async () => {
    const partialToolCall = { type: "toolCall", name: "read", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"path":"/tmp',
            partial: partialMessage,
          },
        ],
        resultMessage: { role: "assistant", content: [partialToolCall] },
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // drain
    }

    expect(partialToolCall.arguments).toEqual({});
  });

  it("does not repair tool arguments when trailing junk exceeds the Kimi-specific allowance", async () => {
    const partialToolCall = { type: "toolCall", name: "read", arguments: {} };
    const streamedToolCall = { type: "toolCall", name: "read", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"path":"/tmp/report.txt"}oops',
            partial: partialMessage,
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedToolCall,
            partial: partialMessage,
          },
        ],
        resultMessage: { role: "assistant", content: [partialToolCall] },
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // drain
    }

    expect(partialToolCall.arguments).toEqual({});
    expect(streamedToolCall.arguments).toEqual({});
  });

  it("clears a cached repair when later deltas make the trailing suffix invalid", async () => {
    const partialToolCall = { type: "toolCall", name: "read", arguments: {} };
    const streamedToolCall = { type: "toolCall", name: "read", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"path":"/tmp/report.txt"}',
            partial: partialMessage,
          },
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: "x",
            partial: partialMessage,
          },
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: "yzq",
            partial: partialMessage,
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedToolCall,
            partial: partialMessage,
          },
        ],
        resultMessage: { role: "assistant", content: [partialToolCall] },
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // drain
    }

    expect(partialToolCall.arguments).toEqual({});
    expect(streamedToolCall.arguments).toEqual({});
  });
});

describe("isOllamaCompatProvider", () => {
  it("detects native ollama provider id", () => {
    expect(
      isOllamaCompatProvider({
        provider: "ollama",
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
      }),
    ).toBe(true);
  });

  it("detects localhost Ollama OpenAI-compatible endpoint", () => {
    expect(
      isOllamaCompatProvider({
        provider: "custom",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:11434/v1",
      }),
    ).toBe(true);
  });

  it("does not misclassify non-local OpenAI-compatible providers", () => {
    expect(
      isOllamaCompatProvider({
        provider: "custom",
        api: "openai-completions",
        baseUrl: "https://api.openrouter.ai/v1",
      }),
    ).toBe(false);
  });

  it("detects remote Ollama-compatible endpoint when provider id hints ollama", () => {
    expect(
      isOllamaCompatProvider({
        provider: "my-ollama",
        api: "openai-completions",
        baseUrl: "http://ollama-host:11434/v1",
      }),
    ).toBe(true);
  });

  it("detects IPv6 loopback Ollama OpenAI-compatible endpoint", () => {
    expect(
      isOllamaCompatProvider({
        provider: "custom",
        api: "openai-completions",
        baseUrl: "http://[::1]:11434/v1",
      }),
    ).toBe(true);
  });

  it("does not classify arbitrary remote hosts on 11434 without ollama provider hint", () => {
    expect(
      isOllamaCompatProvider({
        provider: "custom",
        api: "openai-completions",
        baseUrl: "http://example.com:11434/v1",
      }),
    ).toBe(false);
  });
});

describe("resolveOllamaBaseUrlForRun", () => {
  it("prefers provider baseUrl over model baseUrl", () => {
    expect(
      resolveOllamaBaseUrlForRun({
        modelBaseUrl: "http://model-host:11434",
        providerBaseUrl: "http://provider-host:11434",
      }),
    ).toBe("http://provider-host:11434");
  });

  it("falls back to model baseUrl when provider baseUrl is missing", () => {
    expect(
      resolveOllamaBaseUrlForRun({
        modelBaseUrl: "http://model-host:11434",
      }),
    ).toBe("http://model-host:11434");
  });

  it("falls back to native default when neither baseUrl is configured", () => {
    expect(resolveOllamaBaseUrlForRun({})).toBe("http://127.0.0.1:11434");
  });
});

describe("wrapOllamaCompatNumCtx", () => {
  it("injects num_ctx and preserves downstream onPayload hooks", () => {
    let payloadSeen: Record<string, unknown> | undefined;
    const baseFn = vi.fn((_model, _context, options) => {
      const payload: Record<string, unknown> = { options: { temperature: 0.1 } };
      options?.onPayload?.(payload, _model);
      payloadSeen = payload;
      return {} as never;
    });
    const downstream = vi.fn();

    const wrapped = wrapOllamaCompatNumCtx(baseFn as never, 202752);
    void wrapped({} as never, {} as never, { onPayload: downstream } as never);

    expect(baseFn).toHaveBeenCalledTimes(1);
    expect((payloadSeen?.options as Record<string, unknown> | undefined)?.num_ctx).toBe(202752);
    expect(downstream).toHaveBeenCalledTimes(1);
  });
});

describe("resolveOllamaCompatNumCtxEnabled", () => {
  it("defaults to true when config is missing", () => {
    expect(resolveOllamaCompatNumCtxEnabled({ providerId: "ollama" })).toBe(true);
  });

  it("defaults to true when provider config is missing", () => {
    expect(
      resolveOllamaCompatNumCtxEnabled({
        config: { models: { providers: {} } },
        providerId: "ollama",
      }),
    ).toBe(true);
  });

  it("returns false when provider flag is explicitly disabled", () => {
    expect(
      resolveOllamaCompatNumCtxEnabled({
        config: createOllamaProviderConfig(false),
        providerId: "ollama",
      }),
    ).toBe(false);
  });
});

describe("shouldInjectOllamaCompatNumCtx", () => {
  it("requires openai-completions adapter", () => {
    expect(
      shouldInjectOllamaCompatNumCtx({
        model: {
          provider: "ollama",
          api: "openai-responses",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      }),
    ).toBe(false);
  });

  it("respects provider flag disablement", () => {
    expect(
      shouldInjectOllamaCompatNumCtx({
        model: {
          provider: "ollama",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
        config: createOllamaProviderConfig(false),
        providerId: "ollama",
      }),
    ).toBe(false);
  });
});

describe("decodeHtmlEntitiesInObject", () => {
  it("decodes HTML entities in string values", () => {
    const result = decodeHtmlEntitiesInObject(
      "source .env &amp;&amp; psql &quot;$DB&quot; -c &lt;query&gt;",
    );
    expect(result).toBe('source .env && psql "$DB" -c <query>');
  });

  it("recursively decodes nested objects", () => {
    const input = {
      command: "cd ~/dev &amp;&amp; npm run build",
      args: ["--flag=&quot;value&quot;", "&lt;input&gt;"],
      nested: { deep: "a &amp; b" },
    };
    const result = decodeHtmlEntitiesInObject(input) as Record<string, unknown>;
    expect(result.command).toBe("cd ~/dev && npm run build");
    expect((result.args as string[])[0]).toBe('--flag="value"');
    expect((result.args as string[])[1]).toBe("<input>");
    expect((result.nested as Record<string, string>).deep).toBe("a & b");
  });

  it("passes through non-string primitives unchanged", () => {
    expect(decodeHtmlEntitiesInObject(42)).toBe(42);
    expect(decodeHtmlEntitiesInObject(null)).toBe(null);
    expect(decodeHtmlEntitiesInObject(true)).toBe(true);
    expect(decodeHtmlEntitiesInObject(undefined)).toBe(undefined);
  });

  it("returns strings without entities unchanged", () => {
    const input = "plain string with no entities";
    expect(decodeHtmlEntitiesInObject(input)).toBe(input);
  });

  it("decodes numeric character references", () => {
    expect(decodeHtmlEntitiesInObject("&#39;hello&#39;")).toBe("'hello'");
    expect(decodeHtmlEntitiesInObject("&#x27;world&#x27;")).toBe("'world'");
  });
});
describe("prependSystemPromptAddition", () => {
  it("prepends context-engine addition to the system prompt", () => {
    const result = prependSystemPromptAddition({
      systemPrompt: "base system",
      systemPromptAddition: "extra behavior",
    });

    expect(result).toBe("extra behavior\n\nbase system");
  });

  it("returns the original system prompt when no addition is provided", () => {
    const result = prependSystemPromptAddition({
      systemPrompt: "base system",
    });

    expect(result).toBe("base system");
  });
});

describe("buildAfterTurnRuntimeContext", () => {
  it("uses primary model when compaction.model is not set", () => {
    const legacy = buildAfterTurnRuntimeContext({
      attempt: {
        sessionKey: "agent:main:session:abc",
        messageChannel: "slack",
        messageProvider: "slack",
        agentAccountId: "acct-1",
        authProfileId: "openai:p1",
        config: {} as OpenClawConfig,
        skillsSnapshot: undefined,
        senderIsOwner: true,
        provider: "openai-codex",
        modelId: "gpt-5.3-codex",
        thinkLevel: "off",
        reasoningLevel: "on",
        extraSystemPrompt: "extra",
        ownerNumbers: ["+15555550123"],
      },
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
    });

    expect(legacy).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.3-codex",
    });
  });

  it("passes primary model through even when compaction.model is set (override resolved in compactDirect)", () => {
    const legacy = buildAfterTurnRuntimeContext({
      attempt: {
        sessionKey: "agent:main:session:abc",
        messageChannel: "slack",
        messageProvider: "slack",
        agentAccountId: "acct-1",
        authProfileId: "openai:p1",
        config: {
          agents: {
            defaults: {
              compaction: {
                model: "openrouter/anthropic/claude-sonnet-4-5",
              },
            },
          },
        } as OpenClawConfig,
        skillsSnapshot: undefined,
        senderIsOwner: true,
        provider: "openai-codex",
        modelId: "gpt-5.3-codex",
        thinkLevel: "off",
        reasoningLevel: "on",
        extraSystemPrompt: "extra",
        ownerNumbers: ["+15555550123"],
      },
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
    });

    // buildAfterTurnLegacyCompactionParams no longer resolves the override;
    // compactEmbeddedPiSessionDirect does it centrally for both auto + manual paths.
    expect(legacy).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.3-codex",
    });
  });
  it("includes resolved auth profile fields for context-engine afterTurn compaction", () => {
    const legacy = buildAfterTurnRuntimeContext({
      attempt: {
        sessionKey: "agent:main:session:abc",
        messageChannel: "slack",
        messageProvider: "slack",
        agentAccountId: "acct-1",
        authProfileId: "openai:p1",
        config: { plugins: { slots: { contextEngine: "lossless-claw" } } } as OpenClawConfig,
        skillsSnapshot: undefined,
        senderIsOwner: true,
        provider: "openai-codex",
        modelId: "gpt-5.3-codex",
        thinkLevel: "off",
        reasoningLevel: "on",
        extraSystemPrompt: "extra",
        ownerNumbers: ["+15555550123"],
      },
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
    });

    expect(legacy).toMatchObject({
      authProfileId: "openai:p1",
      provider: "openai-codex",
      model: "gpt-5.3-codex",
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
    });
  });
});

describe("maybeResetOrchestratorYieldContextAfterUserAbort", () => {
  // 构造一个最小可断言的 live session 桩 + 可注入的 strip/inject 桩。
  // strip 用 mock 记录是否被调；inject 用 mock 捕获注入的修正消息内容。
  function makeFixture() {
    const stripArtifacts = vi.fn();
    const injectCalls: Array<{
      customType: string;
      content: string;
      display: boolean;
      triggerTurn?: boolean;
    }> = [];
    const sendCustomMessage = vi.fn(
      async (
        message: { customType: string; content: string; display: boolean },
        options?: { triggerTurn?: boolean },
      ) => {
        injectCalls.push({ ...message, triggerTurn: options?.triggerTurn });
      },
    );
    // activeSession 桩：messages/agent/sessionManager 让真实 strip 也能跑（这里默认用注入桩，
    // 但保留这些字段以贴近真实形态）。
    const activeSession = {
      messages: [] as never[],
      agent: { replaceMessages: vi.fn() },
      sessionManager: undefined,
      sendCustomMessage,
    };
    return { stripArtifacts, injectCalls, activeSession };
  }

  const yieldLeaf = {
    type: "custom_message" as const,
    customType: "openclaw.sessions_yield",
  };

  it("三条触发判据齐全 → 命中：剥挂起态 + 注入修正 custom_message（保留上下文，不删历史）", async () => {
    const { stripArtifacts, injectCalls, activeSession } = makeFixture();

    const decision = await maybeResetOrchestratorYieldContextAfterUserAbort({
      leafEntry: yieldLeaf,
      abortedLastRunBeforeReset: true,
      inputProvenanceKind: "external_user",
      activeSession,
      stripArtifacts,
    });

    // 命中：执行了剥挂起态。
    expect(decision.applied).toBe(true);
    expect(decision.reason).toBe("applied");
    expect(stripArtifacts).toHaveBeenCalledTimes(1);
    expect(stripArtifacts).toHaveBeenCalledWith(activeSession);

    // 命中：注入了一条隐藏的修正说明（display:false、triggerTurn:false、专用 customType）。
    expect(injectCalls).toHaveLength(1);
    expect(injectCalls[0].customType).toBe("openclaw.session_aborted_reset");
    expect(injectCalls[0].display).toBe(false);
    expect(injectCalls[0].triggerTurn).toBe(false);
    // 文案要明确传达“子 agent 已终止、别等结果、要重新执行”三层意思。
    expect(injectCalls[0].content).toMatch(/sub-agents/i);
    expect(injectCalls[0].content).toMatch(/terminated|will NOT return/i);
    expect(injectCalls[0].content).toMatch(/re-plan|re-spawn|continue/i);
  });

  it("缺 abort 标记（正常 yield 等 announce）→ 不命中：不剥、不注入，正常 resume", async () => {
    const { stripArtifacts, injectCalls, activeSession } = makeFixture();

    const decision = await maybeResetOrchestratorYieldContextAfterUserAbort({
      leafEntry: yieldLeaf,
      abortedLastRunBeforeReset: false, // 没有用户主动 abort
      inputProvenanceKind: "external_user",
      activeSession,
      stripArtifacts,
    });

    expect(decision.applied).toBe(false);
    expect(decision.reason).toBe("not-aborted");
    expect(stripArtifacts).not.toHaveBeenCalled();
    expect(injectCalls).toHaveLength(0);
  });

  it("输入是子 agent announce（inter_session）而非用户 → 不命中：正常 announce resume 不受影响", async () => {
    const { stripArtifacts, injectCalls, activeSession } = makeFixture();

    const decision = await maybeResetOrchestratorYieldContextAfterUserAbort({
      leafEntry: yieldLeaf,
      abortedLastRunBeforeReset: true,
      inputProvenanceKind: "inter_session", // 子 agent announce
      activeSession,
      stripArtifacts,
    });

    expect(decision.applied).toBe(false);
    expect(decision.reason).toBe("inter-session-resume");
    expect(stripArtifacts).not.toHaveBeenCalled();
    expect(injectCalls).toHaveLength(0);
  });

  it("面板 chat.send：provenance=undefined（普通用户无 provenance）→ 命中（判据 #3 放宽为 != inter_session）", async () => {
    // 这是两轮 live 复验失败的核心场景之一：面板用户 resume 时 systemInputProvenance 仅 ACP 桥可设，
    // 普通用户 ctx.InputProvenance 为 undefined。早先「必须 == external_user」会把这种 resume 误排除。
    const { stripArtifacts, injectCalls, activeSession } = makeFixture();

    const decision = await maybeResetOrchestratorYieldContextAfterUserAbort({
      leafEntry: yieldLeaf,
      abortedLastRunBeforeReset: true,
      inputProvenanceKind: undefined, // 面板 chat.send 普通用户：无 provenance
      activeSession,
      stripArtifacts,
    });

    expect(decision.applied).toBe(true);
    expect(decision.reason).toBe("applied");
    expect(stripArtifacts).toHaveBeenCalledTimes(1);
    expect(injectCalls).toHaveLength(1);
  });

  it("输入是 internal_system（系统/cron 注入）→ 不命中：与 shouldClearAbortGuardForInbound 对齐（I2）", async () => {
    // I2：清闸 shouldClearAbortGuardForInbound(get-reply-inline-actions.ts:50) 对 internal_system
    // 不解除（非用户主动行为）；闸判据 #3 必须对齐——internal_system 不该触发 strip+inject。
    const { stripArtifacts, injectCalls, activeSession } = makeFixture();

    const decision = await maybeResetOrchestratorYieldContextAfterUserAbort({
      leafEntry: yieldLeaf,
      abortedLastRunBeforeReset: true,
      inputProvenanceKind: "internal_system",
      activeSession,
      stripArtifacts,
    });

    expect(decision.applied).toBe(false);
    expect(decision.reason).toBe("internal-system-resume");
    expect(stripArtifacts).not.toHaveBeenCalled();
    expect(injectCalls).toHaveLength(0);
  });

  it("leaf 是 sessions_yield_interrupt（jsonl 实测的真实 leaf 形态）→ 命中", async () => {
    // 历史 live 诊断 实测：yield 落盘后 interrupt 后于 context 落盘成为真正的 leaf。
    // 判据 #1 必须同时认 interrupt，否则面板场景永不命中。
    const { stripArtifacts, injectCalls, activeSession } = makeFixture();

    const decision = await maybeResetOrchestratorYieldContextAfterUserAbort({
      leafEntry: {
        type: "custom_message" as const,
        customType: "openclaw.sessions_yield_interrupt",
      },
      abortedLastRunBeforeReset: true,
      inputProvenanceKind: "external_user",
      activeSession,
      stripArtifacts,
    });

    expect(decision.applied).toBe(true);
    expect(decision.reason).toBe("applied");
    expect(stripArtifacts).toHaveBeenCalledTimes(1);
    expect(injectCalls).toHaveLength(1);
  });

  it("命中时真实 strip：interrupt + yield 上下文两条都剥到尽，leaf 退回 yield 之前的真实历史", async () => {
    // 不打 strip 桩，跑真实 stripSessionsYieldArtifacts，固化「context 也必须剥」这条根因修复。
    // 落盘顺序复刻 onYield：...真实历史末端(assistant), yield 上下文(custom_message),
    // interrupt(custom_message，真正的 leaf)。strip 后应只剩到“真实历史末端”。
    const liveMessages = [
      { role: "user", content: "做个调研" },
      { role: "assistant", content: [{ type: "text", text: "我先 spawn 子 agent" }] },
      {
        role: "custom",
        customType: "openclaw.sessions_yield",
        content: "Turn yielded.",
      },
      {
        role: "custom",
        customType: "openclaw.sessions_yield_interrupt",
        content: "[sessions_yield interrupt]",
      },
    ];
    const fileEntries = [
      { type: "session", id: "s0", parentId: null },
      { type: "message", id: "m1", parentId: "s0", message: { role: "user" } },
      { type: "message", id: "m2", parentId: "m1", message: { role: "assistant" } },
      {
        type: "custom_message",
        id: "c-yield",
        parentId: "m2",
        customType: "openclaw.sessions_yield",
      },
      {
        type: "custom_message",
        id: "c-interrupt",
        parentId: "c-yield",
        customType: "openclaw.sessions_yield_interrupt",
      },
    ];
    const byId = new Map(fileEntries.map((e) => [e.id, { id: e.id }]));
    const replaceMessages = vi.fn();
    const rewriteFile = vi.fn();
    const sendCustomMessage = vi.fn(async () => {});
    const activeSession = {
      messages: liveMessages as never[],
      agent: { replaceMessages },
      sessionManager: { fileEntries, byId, leafId: "c-interrupt", _rewriteFile: rewriteFile },
      sendCustomMessage,
    };

    const decision = await maybeResetOrchestratorYieldContextAfterUserAbort({
      leafEntry: {
        type: "custom_message" as const,
        customType: "openclaw.sessions_yield_interrupt",
      },
      abortedLastRunBeforeReset: true,
      inputProvenanceKind: "external_user",
      activeSession,
      // 不传 stripArtifacts → 跑真实 strip。
    });

    expect(decision.applied).toBe(true);

    // live transcript：两条 yield custom_message 都被剥，只剩到 assistant。
    expect(replaceMessages).toHaveBeenCalledTimes(1);
    const strippedLive = replaceMessages.mock.calls[0][0] as Array<{ customType?: string }>;
    expect(strippedLive).toHaveLength(2);
    expect(strippedLive.some((m) => m.customType?.startsWith("openclaw.sessions_yield"))).toBe(
      false,
    );

    // fileEntries：interrupt + yield 上下文都 pop 掉，leaf 退回 m2，文件被重写。
    expect(fileEntries.map((e) => e.id)).toEqual(["s0", "m1", "m2"]);
    expect(activeSession.sessionManager.leafId).toBe("m2");
    expect(byId.has("c-yield")).toBe(false);
    expect(byId.has("c-interrupt")).toBe(false);
    expect(rewriteFile).toHaveBeenCalledTimes(1);

    // 仍注入了修正说明。
    expect(sendCustomMessage).toHaveBeenCalledTimes(1);
  });

  it("stripSessionsYieldArtifacts 默认（不传 opts）保留 sessions_yield 上下文 —— 正常 yield 不变量（第 4 轮回归测试）", () => {
    // 正常 yield 流程（attempt.ts:2651 调 stripSessionsYieldArtifacts(activeSession)，不传 opts）：
    // 只剥 interrupt 拦截标记，**必须保留 sessions_yield 上下文**，否则会话脱离“等结果”挂起态 →
    // 面板丢 Stop 按钮 / waiting 气泡（这正是第 4 轮修的回归）。
    const liveMessages = [
      { role: "user", content: "做个调研" },
      { role: "assistant", content: [{ type: "text", text: "我先 spawn" }] },
      { role: "custom", customType: "openclaw.sessions_yield", content: "Turn yielded." },
      { role: "custom", customType: "openclaw.sessions_yield_interrupt", content: "[interrupt]" },
    ];
    const fileEntries = [
      { type: "session", id: "s0", parentId: null },
      { type: "message", id: "m1", parentId: "s0", message: { role: "user" } },
      { type: "message", id: "m2", parentId: "m1", message: { role: "assistant" } },
      { type: "custom_message", id: "c-yield", parentId: "m2", customType: "openclaw.sessions_yield" },
      {
        type: "custom_message",
        id: "c-interrupt",
        parentId: "c-yield",
        customType: "openclaw.sessions_yield_interrupt",
      },
    ];
    const byId = new Map(fileEntries.map((e) => [e.id, { id: e.id }]));
    const replaceMessages = vi.fn();
    const rewriteFile = vi.fn();
    const activeSession = {
      messages: liveMessages as never[],
      agent: { replaceMessages },
      sessionManager: { fileEntries, byId, leafId: "c-interrupt", _rewriteFile: rewriteFile },
    };

    stripSessionsYieldArtifacts(activeSession); // 默认 opts —— 正常 yield 路径

    // live transcript：剥了 interrupt，但保留 sessions_yield 上下文。
    const live = replaceMessages.mock.calls[0][0] as Array<{ customType?: string }>;
    expect(live.some((m) => m.customType === "openclaw.sessions_yield_interrupt")).toBe(false);
    expect(live.some((m) => m.customType === "openclaw.sessions_yield")).toBe(true);
    // fileEntries：只 pop interrupt，leaf 退回 c-yield（仍挂起态），yield 上下文保留。
    expect(fileEntries.map((e) => e.id)).toEqual(["s0", "m1", "m2", "c-yield"]);
    expect(activeSession.sessionManager.leafId).toBe("c-yield");
    expect(byId.has("c-yield")).toBe(true);
    expect(byId.has("c-interrupt")).toBe(false);
  });

  it("stripSessionsYieldArtifacts({ includeYieldContext: true }) 连 yield 上下文一起剥（abort 闸用）", () => {
    const liveMessages = [
      { role: "assistant", content: [{ type: "text", text: "我先 spawn" }] },
      { role: "custom", customType: "openclaw.sessions_yield", content: "Turn yielded." },
      { role: "custom", customType: "openclaw.sessions_yield_interrupt", content: "[interrupt]" },
    ];
    const fileEntries = [
      { type: "session", id: "s0", parentId: null },
      { type: "message", id: "m2", parentId: "s0", message: { role: "assistant" } },
      { type: "custom_message", id: "c-yield", parentId: "m2", customType: "openclaw.sessions_yield" },
      {
        type: "custom_message",
        id: "c-interrupt",
        parentId: "c-yield",
        customType: "openclaw.sessions_yield_interrupt",
      },
    ];
    const byId = new Map(fileEntries.map((e) => [e.id, { id: e.id }]));
    const replaceMessages = vi.fn();
    const rewriteFile = vi.fn();
    const activeSession = {
      messages: liveMessages as never[],
      agent: { replaceMessages },
      sessionManager: { fileEntries, byId, leafId: "c-interrupt", _rewriteFile: rewriteFile },
    };

    stripSessionsYieldArtifacts(activeSession, { includeYieldContext: true });

    const live = replaceMessages.mock.calls[0][0] as Array<{ customType?: string }>;
    expect(live.some((m) => m.customType?.startsWith("openclaw.sessions_yield"))).toBe(false);
    expect(fileEntries.map((e) => e.id)).toEqual(["s0", "m2"]);
    expect(activeSession.sessionManager.leafId).toBe("m2");
  });

  it("leaf 不是 sessions_yield 挂起态 → 不命中", async () => {
    const { stripArtifacts, injectCalls, activeSession } = makeFixture();

    const decision = await maybeResetOrchestratorYieldContextAfterUserAbort({
      leafEntry: { type: "message" }, // 普通消息 leaf，非 yield
      abortedLastRunBeforeReset: true,
      inputProvenanceKind: "external_user",
      activeSession,
      stripArtifacts,
    });

    expect(decision.applied).toBe(false);
    expect(decision.reason).toBe("not-yield-leaf");
    expect(stripArtifacts).not.toHaveBeenCalled();
    expect(injectCalls).toHaveLength(0);
  });

  it("leaf 为 undefined（无会话历史）→ 不命中", async () => {
    const { stripArtifacts, injectCalls, activeSession } = makeFixture();

    const decision = await maybeResetOrchestratorYieldContextAfterUserAbort({
      leafEntry: undefined,
      abortedLastRunBeforeReset: true,
      inputProvenanceKind: "external_user",
      activeSession,
      stripArtifacts,
    });

    expect(decision.applied).toBe(false);
    expect(decision.reason).toBe("not-yield-leaf");
    expect(stripArtifacts).not.toHaveBeenCalled();
    expect(injectCalls).toHaveLength(0);
  });
});
