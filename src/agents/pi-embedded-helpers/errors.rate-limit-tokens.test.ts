import { describe, expect, it } from "vitest";
import { parseRateLimitTokens } from "./errors.js";

// ---------------------------------------------------------------------------
// Core cases (original coverage)
// ---------------------------------------------------------------------------

describe("parseRateLimitTokens", () => {
  it("extracts both limit and requested from OpenAI TPM form", () => {
    const raw =
      "Request too large for gpt-4o-mini on tokens per min (TPM): Limit 30000, Requested 52748. " +
      "The input or output tokens must be reduced in order to run the models.";
    expect(parseRateLimitTokens(raw)).toEqual({
      limitTokensPerMinute: 30000,
      requestedTokens: 52748,
    });
  });

  it("handles thousands separators in OpenAI form", () => {
    const raw = "Limit 30,000, Requested 52,748";
    expect(parseRateLimitTokens(raw)).toEqual({
      limitTokensPerMinute: 30000,
      requestedTokens: 52748,
    });
  });

  it("extracts only limitTokensPerMinute from Anthropic form (no requestedTokens)", () => {
    const raw =
      "This request would exceed your organization's rate limit of 30,000 input tokens per minute " +
      "(model: claude-3-5-sonnet-20241022). Your current rate limit is 30,000 input tokens per minute.";
    const result = parseRateLimitTokens(raw);
    expect(result).toEqual({ limitTokensPerMinute: 30000 });
    // requestedTokens must be absent — Anthropic does not provide it
    expect("requestedTokens" in result).toBe(false);
  });

  it("returns {} for non-rate-limit text", () => {
    expect(parseRateLimitTokens("connection refused")).toEqual({});
    expect(parseRateLimitTokens("Internal server error")).toEqual({});
    expect(parseRateLimitTokens("")).toEqual({});
  });

  it("returns {} when rate-limit text has no numbers", () => {
    // Matches rate-limit keyword but no numbers — should not produce partial output
    expect(parseRateLimitTokens("rate limit exceeded")).toEqual({});
  });

  it("handles OpenAI form without thousands separators and mixed whitespace", () => {
    const raw = "Limit 100000,  Requested 120000";
    expect(parseRateLimitTokens(raw)).toEqual({
      limitTokensPerMinute: 100000,
      requestedTokens: 120000,
    });
  });

  it("is case-insensitive for the OpenAI form", () => {
    const raw = "limit 30000, requested 52748";
    expect(parseRateLimitTokens(raw)).toEqual({
      limitTokensPerMinute: 30000,
      requestedTokens: 52748,
    });
  });

  it("is case-insensitive for the Anthropic form", () => {
    const raw = "Rate Limit Of 50,000 Input Tokens Per Minute (model: claude-opus-4)";
    expect(parseRateLimitTokens(raw)).toEqual({ limitTokensPerMinute: 50000 });
  });

  // ---------------------------------------------------------------------------
  // OpenAI wording variants — document current regex behavior
  // ---------------------------------------------------------------------------

  describe("OpenAI wording variants", () => {
    // Colon separator: some proxy/error-formatter layers emit "Limit: 30000,
    // Requested: 52748". The regex accepts an optional colon after each keyword.
    it("handles optional colon after Limit and Requested keywords", () => {
      expect(parseRateLimitTokens("Limit: 30000, Requested: 52748")).toEqual({
        limitTokensPerMinute: 30000,
        requestedTokens: 52748,
      });
    });

    it("handles optional colon after Limit only (Requested has no colon)", () => {
      expect(parseRateLimitTokens("Limit: 30000, Requested 52748")).toEqual({
        limitTokensPerMinute: 30000,
        requestedTokens: 52748,
      });
    });

    // Tab whitespace between keyword and number.
    it("handles tab whitespace after Limit/Requested", () => {
      expect(parseRateLimitTokens("Limit\t30000,\tRequested\t52748")).toEqual({
        limitTokensPerMinute: 30000,
        requestedTokens: 52748,
      });
    });

    // Both numbers with mixed thousands-separator usage.
    it("handles mixed thousands-separator styles (one with, one without)", () => {
      expect(parseRateLimitTokens("Limit 30,000, Requested 52748")).toEqual({
        limitTokensPerMinute: 30000,
        requestedTokens: 52748,
      });
    });

    // Numbers embedded inside a JSON-like error payload — the regex scans
    // the whole string so it still fires even with surrounding markup.
    it("extracts numbers embedded inside a JSON-like error payload", () => {
      const raw =
        '{"error": "TPM rate limit exceeded: Limit 30000, Requested 52748. ' +
        'Please slow down your requests."}';
      expect(parseRateLimitTokens(raw)).toEqual({
        limitTokensPerMinute: 30000,
        requestedTokens: 52748,
      });
    });

    // Uppercase variant of the full message (LIMIT/REQUESTED).
    it("handles fully uppercased keywords", () => {
      expect(parseRateLimitTokens("LIMIT 30000, REQUESTED 52748")).toEqual({
        limitTokensPerMinute: 30000,
        requestedTokens: 52748,
      });
    });

    // Only one of the two numbers present — should return {} because the OpenAI
    // branch requires both, and the Anthropic branch will not fire for this form.
    it("returns {} when only Limit is present without Requested (OpenAI form incomplete)", () => {
      expect(parseRateLimitTokens("Limit 30000")).toEqual({});
    });

    // "Limit" immediately followed by colon and no space before the number.
    it("handles Limit: with no space before the number", () => {
      // "Limit:30000" — colon immediately followed by digit.
      // The regex requires at least one \s+ after the (optional) colon, so
      // this variant does NOT match. Test documents current behavior.
      expect(parseRateLimitTokens("Limit:30000, Requested:52748")).toEqual({});
    });

    // Numbers separated by whitespace with no comma — not the OpenAI form.
    // Documents that a comma is required between the two numbers.
    it("returns {} when Limit and Requested are separated by whitespace only (no comma)", () => {
      expect(parseRateLimitTokens("Limit 30000 Requested 52748")).toEqual({});
    });

    // Very large numbers (GPT-4-level limits) to guard against parseInt overflow
    // — JavaScript Number can represent integers up to 2^53 safely.
    it("handles very large token counts without precision loss", () => {
      expect(parseRateLimitTokens("Limit 2000000, Requested 2100000")).toEqual({
        limitTokensPerMinute: 2_000_000,
        requestedTokens: 2_100_000,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Anthropic wording variants — document current regex behavior
  // ---------------------------------------------------------------------------

  describe("Anthropic wording variants", () => {
    // No thousands separator — the most common variant since Anthropic API
    // responses do not always format numbers with commas.
    it("handles limit number without a thousands separator", () => {
      const raw = "You have exceeded the rate limit of 30000 input tokens per minute.";
      expect(parseRateLimitTokens(raw)).toEqual({ limitTokensPerMinute: 30000 });
    });

    // Extra whitespace between "of" and the number.
    it("handles extra whitespace between 'of' and the limit number", () => {
      const raw = "rate limit of  30,000  input tokens per minute";
      expect(parseRateLimitTokens(raw)).toEqual({ limitTokensPerMinute: 30000 });
    });

    // Embedded inside a longer Anthropic 429 response body (realistic context).
    it("extracts limit from a realistic Anthropic 429 response body", () => {
      const raw =
        "Your request has been rate limited. " +
        "This request would exceed your organization's rate limit of 40,000 input tokens per minute " +
        "for model claude-sonnet-4-6. " +
        "Please reduce the frequency or size of your requests.";
      expect(parseRateLimitTokens(raw)).toEqual({ limitTokensPerMinute: 40000 });
    });

    // Anthropic sometimes returns the limit twice in the same message.
    // The regex uses the first match; test that behavior is stable.
    it("uses the first occurrence when limit appears twice in the message", () => {
      const raw =
        "rate limit of 30,000 input tokens per minute. " +
        "Your current rate limit of 30,000 input tokens per minute is active.";
      expect(parseRateLimitTokens(raw)).toEqual({ limitTokensPerMinute: 30000 });
    });

    // "output tokens" instead of "input tokens" — NOT a known Anthropic variant
    // for TPM limits; documents that the regex correctly ignores it.
    it("returns {} when the phrase uses 'output tokens' instead of 'input tokens'", () => {
      const raw = "rate limit of 30,000 output tokens per minute";
      expect(parseRateLimitTokens(raw)).toEqual({});
    });

    // Extra space inserted between "rate" and "limit" — documents that the
    // phrase is matched verbatim so "rate  limit" would not fire.
    it("returns {} when extra space breaks the 'rate limit' phrase", () => {
      const raw = "rate  limit of 30,000 input tokens per minute";
      expect(parseRateLimitTokens(raw)).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------
  // Accepted over-match behavior — documented, not a desired feature
  // ---------------------------------------------------------------------------

  describe("accepted theoretical over-match", () => {
    // The OpenAI regex matches any comma-paired "Limit N, Requested M" shape
    // regardless of surrounding context.  A contrived string like
    // "Credit Limit 30000, Requested 52748" (no TPM / rate-limit context) also
    // parses successfully.
    //
    // This is an accepted trade-off: tightening the pattern to require a "TPM"
    // or "tokens per minute" context marker would regress the colon-variant
    // tolerance tested above (e.g. bare "Limit: 30000, Requested: 52748").
    // In real error payloads the shape only appears in TPM 429 responses, so
    // the false-positive is harmless.  This test documents the behavior so
    // future readers know it is intentional, not a bug.
    it("parses a contrived non-TPM string that matches the Limit/Requested shape (accepted over-match)", () => {
      const raw = "Credit Limit 30000, Requested 52748";
      expect(parseRateLimitTokens(raw)).toEqual({
        limitTokensPerMinute: 30000,
        requestedTokens: 52748,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Negative / guard cases — text that mentions rates but has no parseable nums
  // ---------------------------------------------------------------------------

  describe("negative and guard cases", () => {
    it("returns {} for generic rate-limit text with no numbers", () => {
      expect(parseRateLimitTokens("You have been rate limited.")).toEqual({});
      expect(parseRateLimitTokens("429 Too Many Requests")).toEqual({});
      expect(parseRateLimitTokens("rate limit exceeded")).toEqual({});
    });

    it("returns {} for billing errors that mention limits but no token counts", () => {
      // Billing errors may mention "limit" but not in either provider's number format.
      expect(parseRateLimitTokens("You have reached your monthly spend limit.")).toEqual({});
    });

    it("returns {} for context-overflow errors that mention request sizes", () => {
      // Context overflow messages sometimes include token counts in a different format;
      // they must not be confused with rate-limit token counts.
      expect(
        parseRateLimitTokens(
          "Your request is 52000 tokens, which exceeds the context window of 32000 tokens.",
        ),
      ).toEqual({});
    });

    it("returns {} for unrelated text that contains numbers", () => {
      expect(parseRateLimitTokens("Response: 200 OK, body length: 1024 bytes")).toEqual({});
    });
  });
});
