import { describe, expect, it } from "vitest";
import {
  createOpenAIChoiceStopReasonTracker,
  mapOpenAIChoiceStopReason,
  mapOpenAIStopReason,
} from "./openai-stop-reason.js";

describe("mapOpenAIStopReason", () => {
  it.each([
    ["stop", { stopReason: "stop" }],
    ["end", { stopReason: "stop" }],
    ["length", { stopReason: "length" }],
    ["function_call", { stopReason: "toolUse" }],
    ["tool_calls", { stopReason: "toolUse" }],
    [null, { stopReason: "stop" }],
  ] as const)("maps %s", (reason, expected) => {
    expect(mapOpenAIStopReason(reason)).toEqual(expected);
  });

  it("keeps singular tool_call opt-in", () => {
    expect(mapOpenAIStopReason("tool_call")).toEqual({
      stopReason: "error",
      errorMessage: "Provider finish_reason: tool_call",
    });
    expect(mapOpenAIStopReason("tool_call", { allowSingularToolCall: true })).toEqual({
      stopReason: "toolUse",
    });
  });

  it("surfaces provider errors and unknown reasons", () => {
    expect(mapOpenAIStopReason("content_filter")).toEqual({
      stopReason: "error",
      errorMessage: "Provider finish_reason: content_filter",
    });
    expect(mapOpenAIStopReason("unexpected")).toEqual({
      stopReason: "error",
      errorMessage: "Provider finish_reason: unexpected",
    });
  });
});

describe("mapOpenAIChoiceStopReason", () => {
  it("appends a well-formed native_finish_reason to error results only", () => {
    expect(
      mapOpenAIChoiceStopReason({
        finish_reason: "error",
        native_finish_reason: "MALFORMED_FUNCTION_CALL",
      }).errorMessage,
    ).toBe("Provider finish_reason: error (native_finish_reason: MALFORMED_FUNCTION_CALL)");
    expect(
      mapOpenAIChoiceStopReason({ finish_reason: "stop", native_finish_reason: "STOP" }),
    ).toEqual(mapOpenAIStopReason("stop"));
  });

  it("drops native_finish_reason values that are not plain enum-like tokens", () => {
    for (const native of ["bad\nline", "x".repeat(65), "", 42]) {
      expect(
        mapOpenAIChoiceStopReason({ finish_reason: "error", native_finish_reason: native })
          .errorMessage,
      ).toBe("Provider finish_reason: error");
    }
  });
});

describe("createOpenAIChoiceStopReasonTracker", () => {
  it("retains native_finish_reason when a trailing chunk repeats the same finish_reason", () => {
    const track = createOpenAIChoiceStopReasonTracker(true);
    const output: {
      stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
      errorMessage?: string;
    } = {
      stopReason: "stop",
    };
    expect(
      track({ finish_reason: "error", native_finish_reason: "MALFORMED_FUNCTION_CALL" }, output),
    ).toBe("error");
    expect(track({ finish_reason: "error" }, output)).toBe("error");
    expect(output.errorMessage).toBe(
      "Provider finish_reason: error (native_finish_reason: MALFORMED_FUNCTION_CALL)",
    );
  });

  it("clears stale native_finish_reason and deletes errorMessage when a later chunk changes finish_reason", () => {
    const track = createOpenAIChoiceStopReasonTracker(true);
    const output: {
      stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
      errorMessage?: string;
    } = {
      stopReason: "stop",
    };
    track({ finish_reason: "error", native_finish_reason: "MALFORMED_FUNCTION_CALL" }, output);
    track({ finish_reason: "content_filter" }, output);
    expect(output.errorMessage).toBe("Provider finish_reason: content_filter");
    track({ finish_reason: "stop" }, output);
    expect(output.stopReason).toBe("stop");
    expect(Object.hasOwn(output, "errorMessage")).toBe(false);
  });
});
