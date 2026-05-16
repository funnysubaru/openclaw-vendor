import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

vi.mock("../../config/sessions.js", () => ({
  loadSessionStore: vi.fn(),
  resolveStorePath: vi.fn().mockReturnValue("/tmp/test-store.json"),
  evaluateSessionFreshness: vi.fn().mockReturnValue({ fresh: true }),
  resolveSessionResetPolicy: vi.fn().mockReturnValue({ mode: "idle", idleMinutes: 60 }),
}));

vi.mock("../../agents/bootstrap-cache.js", () => ({
  clearBootstrapSnapshot: vi.fn(),
  clearBootstrapSnapshotOnSessionRollover: vi.fn(({ sessionKey, previousSessionId }) => {
    if (sessionKey && previousSessionId) {
      clearBootstrapSnapshot(sessionKey);
    }
  }),
}));

import { clearBootstrapSnapshot } from "../../agents/bootstrap-cache.js";
import { loadSessionStore, evaluateSessionFreshness } from "../../config/sessions.js";
import { resolveCronSession } from "./session.js";

const NOW_MS = 1_737_600_000_000;

type SessionStore = ReturnType<typeof loadSessionStore>;
type SessionStoreEntry = SessionStore[string];
type MockSessionStoreEntry = Partial<SessionStoreEntry>;

function resolveWithStoredEntry(params?: {
  sessionKey?: string;
  entry?: MockSessionStoreEntry;
  forceNew?: boolean;
  fresh?: boolean;
}) {
  const sessionKey = params?.sessionKey ?? "webhook:stable-key";
  const store: SessionStore = params?.entry
    ? ({ [sessionKey]: params.entry as SessionStoreEntry } as SessionStore)
    : {};
  vi.mocked(loadSessionStore).mockReturnValue(store);
  vi.mocked(evaluateSessionFreshness).mockReturnValue({ fresh: params?.fresh ?? true });

  return resolveCronSession({
    cfg: {} as OpenClawConfig,
    sessionKey,
    agentId: "main",
    nowMs: NOW_MS,
    forceNew: params?.forceNew,
  });
}

describe("resolveCronSession", () => {
  beforeEach(() => {
    vi.mocked(clearBootstrapSnapshot).mockReset();
  });

  it("preserves modelOverride and providerOverride from existing session entry", () => {
    const result = resolveWithStoredEntry({
      sessionKey: "agent:main:cron:test-job",
      entry: {
        sessionId: "old-session-id",
        updatedAt: 1000,
        modelOverride: "deepseek-v3-4bit-mlx",
        providerOverride: "inferencer",
        thinkingLevel: "high",
        model: "k2p5",
      },
    });

    expect(result.sessionEntry.modelOverride).toBe("deepseek-v3-4bit-mlx");
    expect(result.sessionEntry.providerOverride).toBe("inferencer");
    expect(result.sessionEntry.thinkingLevel).toBe("high");
    // The model field (last-used model) should also be preserved
    expect(result.sessionEntry.model).toBe("k2p5");
  });

  it("handles missing modelOverride gracefully", () => {
    const result = resolveWithStoredEntry({
      sessionKey: "agent:main:cron:test-job",
      entry: {
        sessionId: "old-session-id",
        updatedAt: 1000,
        model: "claude-opus-4-5",
      },
    });

    expect(result.sessionEntry.modelOverride).toBeUndefined();
    expect(result.sessionEntry.providerOverride).toBeUndefined();
  });

  it("handles no existing session entry", () => {
    const result = resolveWithStoredEntry({
      sessionKey: "agent:main:cron:new-job",
    });

    expect(result.sessionEntry.modelOverride).toBeUndefined();
    expect(result.sessionEntry.providerOverride).toBeUndefined();
    expect(result.sessionEntry.model).toBeUndefined();
    expect(result.isNewSession).toBe(true);
  });

  // New tests for session reuse behavior (#18027)
  describe("session reuse for webhooks/cron", () => {
    it("reuses existing sessionId when session is fresh", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id-123",
          updatedAt: NOW_MS - 1000,
          systemSent: true,
        },
        fresh: true,
      });

      expect(result.sessionEntry.sessionId).toBe("existing-session-id-123");
      expect(result.isNewSession).toBe(false);
      expect(result.systemSent).toBe(true);
      expect(clearBootstrapSnapshot).not.toHaveBeenCalled();
    });

    it("creates new sessionId when session is stale", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "old-session-id",
          updatedAt: NOW_MS - 86_400_000, // 1 day ago
          systemSent: true,
          modelOverride: "gpt-4.1-mini",
          providerOverride: "openai",
          sendPolicy: "allow",
        },
        fresh: false,
      });

      expect(result.sessionEntry.sessionId).not.toBe("old-session-id");
      expect(result.isNewSession).toBe(true);
      expect(result.systemSent).toBe(false);
      expect(result.sessionEntry.modelOverride).toBe("gpt-4.1-mini");
      expect(result.sessionEntry.providerOverride).toBe("openai");
      expect(result.sessionEntry.sendPolicy).toBe("allow");
      expect(clearBootstrapSnapshot).toHaveBeenCalledWith("webhook:stable-key");
    });

    it("creates new sessionId when forceNew is true", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id-456",
          updatedAt: NOW_MS - 1000,
          systemSent: true,
          modelOverride: "sonnet-4",
          providerOverride: "anthropic",
        },
        fresh: true,
        forceNew: true,
      });

      expect(result.sessionEntry.sessionId).not.toBe("existing-session-id-456");
      expect(result.isNewSession).toBe(true);
      expect(result.systemSent).toBe(false);
      expect(result.sessionEntry.modelOverride).toBe("sonnet-4");
      expect(result.sessionEntry.providerOverride).toBe("anthropic");
      expect(clearBootstrapSnapshot).toHaveBeenCalledWith("webhook:stable-key");
    });

    it("clears delivery routing metadata and deliveryContext when forceNew is true", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id-789",
          updatedAt: NOW_MS - 1000,
          systemSent: true,
          lastChannel: "slack" as never,
          lastTo: "channel:C0XXXXXXXXX",
          lastAccountId: "acct-123",
          lastThreadId: "1737500000.123456",
          deliveryContext: {
            channel: "slack",
            to: "channel:C0XXXXXXXXX",
            threadId: "1737500000.123456",
          },
          modelOverride: "gpt-5.2",
        },
        fresh: true,
        forceNew: true,
      });

      expect(result.isNewSession).toBe(true);
      // Delivery routing state must be cleared to prevent thread leaking.
      // deliveryContext must also be cleared because normalizeSessionEntryDelivery
      // repopulates lastThreadId from deliveryContext.threadId on store writes.
      expect(result.sessionEntry.lastChannel).toBeUndefined();
      expect(result.sessionEntry.lastTo).toBeUndefined();
      expect(result.sessionEntry.lastAccountId).toBeUndefined();
      expect(result.sessionEntry.lastThreadId).toBeUndefined();
      expect(result.sessionEntry.deliveryContext).toBeUndefined();
      // Per-session overrides must be preserved
      expect(result.sessionEntry.modelOverride).toBe("gpt-5.2");
    });

    it("clears delivery routing metadata when session is stale", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "old-session-id",
          updatedAt: NOW_MS - 86_400_000,
          lastChannel: "slack" as never,
          lastTo: "channel:C0XXXXXXXXX",
          lastThreadId: "1737500000.999999",
          deliveryContext: {
            channel: "slack",
            to: "channel:C0XXXXXXXXX",
            threadId: "1737500000.999999",
          },
        },
        fresh: false,
      });

      expect(result.isNewSession).toBe(true);
      expect(result.sessionEntry.lastChannel).toBeUndefined();
      expect(result.sessionEntry.lastTo).toBeUndefined();
      expect(result.sessionEntry.lastAccountId).toBeUndefined();
      expect(result.sessionEntry.lastThreadId).toBeUndefined();
      expect(result.sessionEntry.deliveryContext).toBeUndefined();
    });

    it("preserves delivery routing metadata when reusing fresh session", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id-101",
          updatedAt: NOW_MS - 1000,
          systemSent: true,
          lastChannel: "slack" as never,
          lastTo: "channel:C0XXXXXXXXX",
          lastThreadId: "1737500000.123456",
          deliveryContext: {
            channel: "slack",
            to: "channel:C0XXXXXXXXX",
            threadId: "1737500000.123456",
          },
        },
        fresh: true,
      });

      expect(result.isNewSession).toBe(false);
      expect(result.sessionEntry.lastChannel).toBe("slack");
      expect(result.sessionEntry.lastTo).toBe("channel:C0XXXXXXXXX");
      expect(result.sessionEntry.lastThreadId).toBe("1737500000.123456");
      expect(result.sessionEntry.deliveryContext).toEqual({
        channel: "slack",
        to: "channel:C0XXXXXXXXX",
        threadId: "1737500000.123456",
      });
    });

    it("creates new sessionId when entry exists but has no sessionId", () => {
      const result = resolveWithStoredEntry({
        entry: {
          updatedAt: NOW_MS - 1000,
          modelOverride: "some-model",
        },
      });

      expect(result.sessionEntry.sessionId).toBeDefined();
      expect(result.isNewSession).toBe(true);
      // Should still preserve other fields from entry
      expect(result.sessionEntry.modelOverride).toBe("some-model");
    });
  });

  // PR-B (2026-05-16 实战修复): panel-* sessionKey 是 host UI 用户对话的 stable
  // 标识,cron 写入必须 append 到当前 jsonl 而非 roll 新 sessionId。否则 cron 的
  // reply 落到孤儿 jsonl,panel UI 看不到 → 违背 (Y) 方案承诺。
  //
  // 匹配模式: `^agent:[a-z0-9_-]+:user:[a-f0-9-]+:panel-` (canonical panel UI 派生
  // 形态)。其它 cron:<jobId> / line / direct 等保持原有 freshness + forceNew 语义。
  describe("panel-* sessionKey reuse override (PR-B)", () => {
    const PANEL_KEY = "agent:custom-cbd0fe4a:user:06148fa3-9aa3-4b28-b1b1-3513ada1dc9e:panel-d1e7fc49";

    it("reuses existing sessionId for panel-* key even when forceNew=true", () => {
      // Cron with sessionTarget=isolated 调用 resolveCronSession 时 forceNew=true。
      // 之前: 无条件 randomUUID → 滚走 user 的 panel sessionId。
      // 现在: panel-* key 强制 reuse,cron 写到 user 的 panel jsonl。
      const result = resolveWithStoredEntry({
        sessionKey: PANEL_KEY,
        entry: {
          sessionId: "user-panel-stable-id",
          updatedAt: NOW_MS - 1000,
          systemSent: true,
        },
        forceNew: true,
        fresh: true,
      });

      expect(result.sessionEntry.sessionId).toBe("user-panel-stable-id");
      expect(result.isNewSession).toBe(false);
      expect(clearBootstrapSnapshot).not.toHaveBeenCalled();
    });

    it("reuses existing sessionId for panel-* key even when freshness=stale", () => {
      // 之前: 1 天没动的 panel session 会被判 stale → roll。
      // 现在: panel-* key 不走 freshness eviction,永远 reuse。
      const result = resolveWithStoredEntry({
        sessionKey: PANEL_KEY,
        entry: {
          sessionId: "user-panel-old-but-valid",
          updatedAt: NOW_MS - 7 * 86_400_000, // 7 days ago
          systemSent: true,
        },
        fresh: false,
      });

      expect(result.sessionEntry.sessionId).toBe("user-panel-old-but-valid");
      expect(result.isNewSession).toBe(false);
      expect(clearBootstrapSnapshot).not.toHaveBeenCalled();
    });

    it("creates new sessionId for panel-* key when no entry exists (first cron run)", () => {
      // 边界: 首次 cron run, panel-* sessionKey 没在 sessions.json — 此时确实需要
      // 创建 sessionId。后续 panel UI / cron 都复用之。
      const result = resolveWithStoredEntry({
        sessionKey: PANEL_KEY,
        forceNew: true,
      });

      expect(result.sessionEntry.sessionId).toBeDefined();
      expect(result.isNewSession).toBe(true);
    });

    it("still rolls sessionId for non-panel cron sessionKey when forceNew=true (no regression)", () => {
      // 对照: cron:<jobId> 派生 key 保持原行为, isolated cron 每次起新 session。
      const result = resolveWithStoredEntry({
        sessionKey: "agent:main:cron:job-abc",
        entry: {
          sessionId: "old-cron-session",
          updatedAt: NOW_MS - 1000,
          systemSent: true,
        },
        forceNew: true,
        fresh: true,
      });

      expect(result.sessionEntry.sessionId).not.toBe("old-cron-session");
      expect(result.isNewSession).toBe(true);
    });

    it("still rolls sessionId for non-panel cron sessionKey on freshness=stale (no regression)", () => {
      // 对照: 非 panel key 的 stale-eviction 保持原行为。
      const result = resolveWithStoredEntry({
        sessionKey: "agent:main:cron:job-abc",
        entry: {
          sessionId: "old-stale",
          updatedAt: NOW_MS - 86_400_000,
          systemSent: true,
        },
        fresh: false,
      });

      expect(result.sessionEntry.sessionId).not.toBe("old-stale");
      expect(result.isNewSession).toBe(true);
    });
  });
});
