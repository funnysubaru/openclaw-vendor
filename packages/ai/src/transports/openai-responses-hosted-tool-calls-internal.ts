import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AssistantMessage, HostedToolCall } from "../types.js";

/** Responses `include` value that asks the provider to return web-search source URLs. */
export const RESPONSES_WEB_SEARCH_SOURCES_INCLUDE = "web_search_call.action.sources";

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Records a provider-hosted `web_search_call` output item on the assistant message.
 * Hosted calls run inside the provider, so no local tool execution or hook sees them; the
 * runtime reports the recorded facts to `after_tool_call` observers at message end.
 * Repeated items with the same id (streamed done item + terminal output) are merged: a later item
 * only overrides the status and fields it actually carries, so sparse terminal copies keep the
 * sources and action details recorded earlier.
 */
export function recordResponsesHostedToolCall(output: AssistantMessage, item: unknown): void {
  if (!isRecord(item) || item.type !== "web_search_call") {
    return;
  }
  const id = readText(item.id);
  if (!id) {
    return;
  }
  const rawAction = isRecord(item.action) ? item.action : undefined;
  const action: NonNullable<HostedToolCall["action"]> = {};
  if (rawAction) {
    const type = readText(rawAction.type);
    const query = readText(rawAction.query);
    const queries = Array.isArray(rawAction.queries)
      ? rawAction.queries.filter((entry): entry is string => readText(entry) !== undefined)
      : [];
    const url = readText(rawAction.url);
    const pattern = readText(rawAction.pattern);
    if (type) {
      action.type = type;
    }
    if (query) {
      action.query = query;
    }
    if (queries.length > 0) {
      action.queries = queries;
    }
    if (url) {
      action.url = url;
    }
    if (pattern) {
      action.pattern = pattern;
    }
  }
  const sources = Array.isArray(rawAction?.sources)
    ? rawAction.sources.flatMap((source) => {
        const url = isRecord(source) ? readText(source.url) : undefined;
        return url ? [url] : [];
      })
    : [];
  const status = readText(item.status);
  const calls = (output.hostedToolCalls ??= []);
  const existingIndex = calls.findIndex((entry) => entry.id === id);
  const existing = existingIndex >= 0 ? calls[existingIndex] : undefined;
  const mergedAction = { ...existing?.action, ...action };
  const mergedSources = sources.length > 0 ? sources : existing?.sources;
  const call: HostedToolCall = {
    type: "web_search",
    id,
    status: status ?? existing?.status ?? "unknown",
    ...(Object.keys(mergedAction).length > 0 ? { action: mergedAction } : {}),
    ...(mergedSources && mergedSources.length > 0 ? { sources: mergedSources } : {}),
  };
  if (existingIndex >= 0) {
    calls[existingIndex] = call;
  } else {
    calls.push(call);
  }
}

/**
 * When the final request carries the hosted `web_search` tool, also ask for its source URLs so
 * observers can show what the search returned. Requests without the hosted tool are unchanged.
 */
export function withResponsesWebSearchSourcesInclude<T extends Record<string, unknown>>(
  body: T,
): T {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (!tools.some((tool) => isRecord(tool) && tool.type === "web_search")) {
    return body;
  }
  const include = Array.isArray(body.include) ? body.include : [];
  if (include.includes(RESPONSES_WEB_SEARCH_SOURCES_INCLUDE)) {
    return body;
  }
  return { ...body, include: [...include, RESPONSES_WEB_SEARCH_SOURCES_INCLUDE] };
}
