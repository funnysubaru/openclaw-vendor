/**
 * Reports provider-hosted tool calls (for example OpenAI Responses `web_search_call`) to
 * `after_tool_call` observers. These calls run inside the provider, so neither local tool
 * execution nor `before_tool_call` sees them; the facts arrive on the assistant message
 * (`hostedToolCalls`) and are reported once per call id when that message ends.
 *
 * Hosted calls are observational only: no `before_tool_call` (nothing can be blocked any more),
 * no tool result enters the transcript, and nothing is replayed to the provider.
 */
import type { HostedToolCall } from "../llm/types.js";
import type {
  PluginHookAfterToolCallEvent,
  PluginHookToolRequesterContext,
} from "../plugins/types.js";
import { loadHookRunnerGlobal } from "./embedded-agent-subscribe.handlers.tools.results.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import type { AgentMessage } from "./runtime/index.js";

/**
 * Upper bound for waiting on observers. The final reply of the same provider response is
 * delivered right after message end, so observers that record the call against the still-open
 * run get a short head start; a slow observer never holds the reply longer than this.
 */
const HOSTED_TOOL_HOOK_WAIT_MS = 5_000;

/**
 * Requester identity for provider-hosted tool hooks, built from the same run facts as the local
 * tool hook context (createOpenClawCodingTools), so observers can apply one identity rule.
 */
export function buildHostedToolHookRequester(params: {
  messageChannel?: string;
  messageProvider?: string;
  agentAccountId?: string;
  senderId?: string | null;
  senderIsOwner?: boolean;
  memberRoleIds?: readonly string[];
}): { requester?: PluginHookToolRequesterContext } {
  const channel = params.messageChannel ?? params.messageProvider;
  const requester = {
    ...(channel ? { channel } : {}),
    ...(params.agentAccountId ? { accountId: params.agentAccountId } : {}),
    ...(params.senderId ? { senderId: params.senderId } : {}),
    ...(params.senderIsOwner !== undefined ? { senderIsOwner: params.senderIsOwner } : {}),
    ...(params.memberRoleIds?.length ? { roleIds: [...params.memberRoleIds] } : {}),
  } satisfies PluginHookToolRequesterContext;
  return Object.keys(requester).length > 0 ? { requester } : {};
}

const reportedHostedToolCallIds = new WeakMap<object, Set<string>>();

function hostedToolCallParams(call: HostedToolCall): Record<string, unknown> {
  const action = call.action ?? {};
  return {
    ...(action.query ? { query: action.query } : {}),
    ...(action.queries ? { queries: action.queries } : {}),
    ...(action.url ? { url: action.url } : {}),
    ...(action.pattern ? { pattern: action.pattern } : {}),
  };
}

function hostedToolCallResultText(call: HostedToolCall): string {
  const lines = [`status: ${call.status}`];
  if (call.sources?.length) {
    lines.push("sources:", ...call.sources);
  }
  return lines.join("\n");
}

/**
 * Fires `after_tool_call` for hosted calls on this assistant message that were not reported yet.
 * Returns undefined (synchronously) when there is nothing to report, so ordinary messages keep
 * the synchronous message_end path; otherwise resolves once observers finish or the wait bound
 * passes. Never rejects.
 */
export function runHostedToolCallAfterHooks(
  ctx: EmbeddedAgentSubscribeContext,
  message: AgentMessage,
): Promise<void> | undefined {
  const calls =
    message.role === "assistant" && Array.isArray(message.hostedToolCalls)
      ? message.hostedToolCalls
      : [];
  if (calls.length === 0) {
    return undefined;
  }
  let reported = reportedHostedToolCallIds.get(ctx.state);
  if (!reported) {
    reported = new Set();
    reportedHostedToolCallIds.set(ctx.state, reported);
  }
  const pending = calls.filter((call) => !reported.has(call.id));
  if (pending.length === 0) {
    return undefined;
  }
  for (const call of pending) {
    reported.add(call.id);
  }
  const run = async () => {
    const hookRunner = ctx.hookRunner ?? (await loadHookRunnerGlobal()).getGlobalHookRunner();
    if (!hookRunner?.hasHooks("after_tool_call")) {
      return;
    }
    await Promise.all(
      pending.map(async (call) => {
        const hookEvent: PluginHookAfterToolCallEvent = {
          toolName: call.type,
          params: hostedToolCallParams(call),
          runId: ctx.params.runId,
          toolCallId: call.id,
          result: {
            content: [{ type: "text", text: hostedToolCallResultText(call) }],
            details: { status: call.status, ...(call.sources ? { sources: call.sources } : {}) },
          },
          error: call.status === "completed" ? undefined : `${call.type} ${call.status}`,
        };
        try {
          await hookRunner.runAfterToolCall(hookEvent, {
            toolName: call.type,
            toolKind: "provider_hosted",
            agentId: ctx.params.agentId,
            sessionKey: ctx.params.sessionKey,
            sessionId: ctx.params.sessionId,
            runId: ctx.params.runId,
            toolCallId: call.id,
            ...(ctx.params.requester ? { requester: ctx.params.requester } : {}),
          });
        } catch (err: unknown) {
          ctx.log.warn(`after_tool_call hook failed: tool=${call.type} error=${String(err)}`);
        }
      }),
    );
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, HOSTED_TOOL_HOOK_WAIT_MS);
    timer.unref?.();
  });
  return Promise.race([
    run().catch((err: unknown) => {
      ctx.log.warn(`hosted tool after_tool_call failed: error=${String(err)}`);
    }),
    bound,
  ]).finally(() => clearTimeout(timer));
}
