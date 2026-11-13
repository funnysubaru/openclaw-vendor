/**
 * web_fetch failure log summary for the tool adapter (Yuiwork collab patch #4, collab-m1-beta task 247).
 * Kept out of agent-tool-definition-adapter.ts so the collab-only code replays as one file.
 */
import { isPlainObject } from "../utils.js";
import { sanitizeForConsole } from "./console-sanitize.js";
import { sanitizeWebFetchUrl } from "./tools/web-fetch-url.js";

// Yuiwork collab patch #4 (collab-m1-beta task 247): web_fetch failure logs keep only the
// host and the HTTP status (or the error class). The URL path/query can carry what the user
// searched for, and the thrown message embeds the error page body (`Web fetch failed (404):
// <body>`), so neither may reach operator logs. The model-visible error result is unchanged.
export const WEB_FETCH_TOOL_NAME = "web_fetch";
// HTTP failures whose status code comes from our own code, not from the remote page: the direct
// fetch (`Web fetch failed (NNN): …`, src/agents/tools/web-fetch.ts) and the Firecrawl fallback
// that web_fetch awaits before giving up (`Firecrawl API error (NNN): …` /
// `Firecrawl fetch failed (NNN): …`, extensions/firecrawl/src/firecrawl-client.ts). Only the
// status is kept; everything after it (the wrapped error body) is dropped.
const WEB_FETCH_HTTP_FAILURE_PATTERNS: ReadonlyArray<{ re: RegExp; labels?: string }> = [
  { re: /^Web fetch failed \((\d{3})\)/ },
  // The Firecrawl API itself answered non-2xx (postFirecrawlJson).
  { re: /^Firecrawl API error \((\d{3})\)/, labels: "provider=firecrawl kind=api-error" },
  // The Firecrawl API answered 2xx but the scrape failed: normally the target site's HTTP status
  // (parseFirecrawlScrapePayload, `target returned an unsuccessful HTTP status`), or a
  // `success: false` payload carrying Firecrawl's own response status.
  { re: /^Firecrawl fetch failed \((\d{3})\)/, labels: "provider=firecrawl kind=fetch-failed" },
];
const WEB_FETCH_ERROR_NAME_MAX_CHARS = 64;
// web_fetch is a network-sourced tool (`resultContentSource: "network"`), so in the real runtime
// the before_tool_call wrapper re-throws its failures as
// `new Error(wrapExternalContent(message, { source: "api" }))` (protectNetworkToolExecutionError,
// src/agents/tool-result-error.ts): a fixed security notice, then one envelope
// `<<<EXTERNAL_UNTRUSTED_CONTENT id="…">>>\nSource: API\n---\n<original message>…`. The status
// patterns above are anchored to the original message, so that single outer envelope is skipped
// first. Only the first real start marker counts; wrapExternalContent folds marker lookalikes in
// the wrapped text, so the page body cannot forge an earlier one.
const PROTECTED_NETWORK_ERROR_OPEN_RE =
  /^(?:[\s\S]*?\n)?<<<EXTERNAL_UNTRUSTED_CONTENT id="[0-9a-f]+">>>\r?\n(?:Source: [^\n]*\r?\n)?---\r?\n/u;

function unwrapProtectedNetworkErrorMessage(message: string): string {
  const open = PROTECTED_NETWORK_ERROR_OPEN_RE.exec(message);
  return open ? message.slice(open[0].length) : message;
}

function readWebFetchUrlParam(value: unknown): unknown {
  let parsed = value;
  if (typeof parsed === "string") {
    // Tool params normally arrive as objects; a raw JSON string is tolerated the same way the
    // exec sanitizer does, but anything unparseable is treated as "no URL" rather than logged.
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  return isPlainObject(parsed) ? parsed.url : undefined;
}

function describeWebFetchHostForLog(...candidates: unknown[]): string {
  // Effective params win (a before_tool_call hook may have rewritten the URL); raw params are
  // the fallback. Only URL#hostname is ever emitted, never the original string.
  for (const candidate of candidates) {
    const url = readWebFetchUrlParam(candidate);
    if (typeof url !== "string") {
      continue;
    }
    // Same repair the tool applies before fetching (e.g. `https:// docs.example.com`), so the
    // logged host is the one actually requested.
    const repaired = sanitizeWebFetchUrl(url);
    if (!repaired) {
      continue;
    }
    try {
      return new URL(repaired).hostname || "invalid-url";
    } catch {
      return "invalid-url";
    }
  }
  return "unknown";
}

export function describeWebFetchFailureForLog(params: {
  err: unknown;
  message: string;
  rawParams: unknown;
  effectiveParams: unknown;
}): string {
  const host = describeWebFetchHostForLog(params.effectiveParams, params.rawParams);
  const message = unwrapProtectedNetworkErrorMessage(params.message);
  for (const pattern of WEB_FETCH_HTTP_FAILURE_PATTERNS) {
    const status = pattern.re.exec(message)?.[1];
    if (status) {
      return pattern.labels
        ? `host=${host} status=${status} ${pattern.labels}`
        : `host=${host} status=${status}`;
    }
  }
  // Non-HTTP failures (network errors, SSRF blocks, invalid URLs, provider fallbacks) can
  // also echo the URL in their message, so only the error class name is logged.
  const errorName =
    params.err instanceof Error
      ? sanitizeForConsole(params.err.name, WEB_FETCH_ERROR_NAME_MAX_CHARS)
      : undefined;
  return `host=${host} error=${errorName ?? typeof params.err}`;
}
