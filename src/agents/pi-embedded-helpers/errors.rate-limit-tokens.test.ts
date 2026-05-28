import { describe, expect, it } from "vitest";
import { parseRateLimitTokens } from "./errors.js";

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
});
