/**
 * web_fetch URL parameter repair, shared by the tool and the tool adapter's failure log.
 *
 * Yuiwork collab patch #4 (collab-m1-beta task 247) moved this helper out of web-fetch.ts
 * unchanged, so the adapter can log the host of the URL the tool actually requested without
 * importing the whole fetch runtime.
 */

/**
 * Sanitize a web_fetch URL parameter that may contain LLM-injected whitespace.
 *
 * Fixes the reported case where a model emits a space between the scheme and
 * authority (e.g. `https:// docs.openclaw.ai`), which causes `new URL()` to
 * throw. Path and query whitespace is intentionally preserved — the WHATWG URL
 * parser percent-encodes those characters correctly per RFC 3986.
 */
export function sanitizeWebFetchUrl(raw: string): string {
  let end = raw.length;
  while (end > 0 && raw.charCodeAt(end - 1) <= 0x20) {
    end -= 1;
  }
  const trimmed = raw.slice(0, end).replace(/^\s+/, "");
  const repaired = trimmed.replace(/^(https?:\/\/)\s+/i, "$1");
  return repaired.replace(/^(https?:\/\/[^/?#\s]+)\s+$/i, "$1");
}
