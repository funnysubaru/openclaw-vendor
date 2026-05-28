import { emitAgentEvent } from "../infra/agent-events.js";
import { createInlineCodeState } from "../markdown/code-spans.js";
import {
  buildApiErrorObservationFields,
  buildTextObservationFields,
  sanitizeForConsole,
} from "./pi-embedded-error-observation.js";
import {
  classifyFailoverReason,
  formatAssistantErrorText,
  parseRateLimitTokens,
} from "./pi-embedded-helpers.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { isAssistantMessage } from "./pi-embedded-utils.js";

export {
  handleAutoCompactionEnd,
  handleAutoCompactionStart,
} from "./pi-embedded-subscribe.handlers.compaction.js";

export function handleAgentStart(ctx: EmbeddedPiSubscribeContext) {
  ctx.log.debug(`embedded run agent start: runId=${ctx.params.runId}`);
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "lifecycle",
    data: {
      phase: "start",
      startedAt: Date.now(),
    },
  });
  void ctx.params.onAgentEvent?.({
    stream: "lifecycle",
    data: { phase: "start" },
  });
}

export function handleAgentEnd(ctx: EmbeddedPiSubscribeContext) {
  const lastAssistant = ctx.state.lastAssistant;
  const isError = isAssistantMessage(lastAssistant) && lastAssistant.stopReason === "error";

  if (isError && lastAssistant) {
    const friendlyError = formatAssistantErrorText(lastAssistant, {
      cfg: ctx.params.config,
      sessionKey: ctx.params.sessionKey,
      provider: lastAssistant.provider,
      model: lastAssistant.model,
    });
    const rawError = lastAssistant.errorMessage?.trim();
    const failoverReason = classifyFailoverReason(rawError ?? "");
    const errorText = (friendlyError || lastAssistant.errorMessage || "LLM request failed.").trim();
    const observedError = buildApiErrorObservationFields(rawError);
    const safeErrorText =
      buildTextObservationFields(errorText).textPreview ?? "LLM request failed.";
    const safeRunId = sanitizeForConsole(ctx.params.runId) ?? "-";
    const safeModel = sanitizeForConsole(lastAssistant.model) ?? "unknown";
    const safeProvider = sanitizeForConsole(lastAssistant.provider) ?? "unknown";
    // Parse verbatim token numbers from the raw provider error message.
    // These are non-sensitive display numbers (plan limit / prompt size) and
    // are intentionally kept separate from the redacted observedError fields.
    const rateLimitTokens = parseRateLimitTokens(rawError ?? "");
    ctx.log.warn("embedded run agent end", {
      event: "embedded_run_agent_end",
      tags: ["error_handling", "lifecycle", "agent_end", "assistant_error"],
      runId: ctx.params.runId,
      isError: true,
      error: safeErrorText,
      failoverReason,
      model: lastAssistant.model,
      provider: lastAssistant.provider,
      ...observedError,
      consoleMessage: `embedded run agent end: runId=${safeRunId} isError=true model=${safeModel} provider=${safeProvider} error=${safeErrorText}`,
    });
    // Structured error fields forwarded into both the agent event bus and the
    // onAgentEvent callback so downstream consumers (server-chat.ts) can
    // thread them into the chat payload for the panel to render.
    // Only defined fields are included — spread of {} is a no-op when no
    // rate-limit numbers were found.
    // errorEventData is extracted as a shared const so both the emitAgentEvent
    // and onAgentEvent paths stay in lockstep; endedAt is added only to the
    // emitAgentEvent path (it's an infra timestamp, not needed on the callback).
    const errorEventData = {
      phase: "error" as const,
      error: safeErrorText,
      ...(failoverReason !== null && { failoverReason }),
      ...(observedError.httpCode !== undefined && { httpCode: observedError.httpCode }),
      ...(observedError.providerErrorType !== undefined && {
        providerErrorType: observedError.providerErrorType,
      }),
      ...rateLimitTokens,
    };
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "lifecycle",
      data: { ...errorEventData, endedAt: Date.now() },
    });
    void ctx.params.onAgentEvent?.({
      stream: "lifecycle",
      data: errorEventData,
    });
  } else {
    ctx.log.debug(`embedded run agent end: runId=${ctx.params.runId} isError=${isError}`);
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "lifecycle",
      data: {
        phase: "end",
        endedAt: Date.now(),
      },
    });
    void ctx.params.onAgentEvent?.({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  }

  ctx.flushBlockReplyBuffer();
  // Flush the reply pipeline so the response reaches the channel before
  // compaction wait blocks the run.  This mirrors the pattern used by
  // handleToolExecutionStart and ensures delivery is not held hostage to
  // long-running compaction (#35074).
  void ctx.params.onBlockReplyFlush?.();

  ctx.state.blockState.thinking = false;
  ctx.state.blockState.final = false;
  ctx.state.blockState.inlineCode = createInlineCodeState();

  if (ctx.state.pendingCompactionRetry > 0) {
    ctx.resolveCompactionRetry();
  } else {
    ctx.maybeResolveCompactionWait();
  }
}
