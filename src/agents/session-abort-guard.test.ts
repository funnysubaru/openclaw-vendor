import { describe, it, expect, beforeEach } from "vitest";
import {
  markSessionAborted,
  isSessionAborted,
  noteDroppedAnnounce,
  clearSessionAbort,
  __testing,
} from "./session-abort-guard.js";

const cfg = {} as never; // 最小 cfg(normalizeControllerSessionKey 对该透传 key 原样返回)
const KEY = "agent:orch-1:user:u:panel";

describe("session-abort-guard", () => {
  beforeEach(() => __testing.reset());

  it("mark then is = true; clear then is = false", () => {
    expect(isSessionAborted(cfg, KEY)).toBe(false);
    markSessionAborted(cfg, KEY);
    expect(isSessionAborted(cfg, KEY)).toBe(true);
    clearSessionAbort(cfg, KEY);
    expect(isSessionAborted(cfg, KEY)).toBe(false);
  });

  it("noteDroppedAnnounce accumulates only when aborted", () => {
    expect(noteDroppedAnnounce(cfg, KEY)).toBe(0);
    markSessionAborted(cfg, KEY);
    expect(noteDroppedAnnounce(cfg, KEY)).toBe(1);
    expect(noteDroppedAnnounce(cfg, KEY)).toBe(2);
  });

  it("mark preserves existing droppedCount", () => {
    markSessionAborted(cfg, KEY);
    noteDroppedAnnounce(cfg, KEY);
    markSessionAborted(cfg, KEY);
    expect(noteDroppedAnnounce(cfg, KEY)).toBe(2);
  });

  it("empty/blank key is a no-op", () => {
    markSessionAborted(cfg, "  ");
    expect(isSessionAborted(cfg, "  ")).toBe(false);
  });
});
