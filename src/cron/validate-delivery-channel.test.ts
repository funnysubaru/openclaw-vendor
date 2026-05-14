import { describe, expect, it } from "vitest";
import {
  listValidCronDeliveryChannels,
  validateCronDeliveryChannel,
} from "./validate-delivery-channel.js";

describe("listValidCronDeliveryChannels", () => {
  it("includes webchat as a valid cron delivery target", () => {
    // webchat 是 internal channel，但 cron 复用 sessionKey 跑时允许出现在
    // delivery.channel 字段作为"运行容器"标记（详见 server-cron runIsolatedAgentJob）
    expect(listValidCronDeliveryChannels()).toContain("webchat");
  });

  it("includes the standard deliverable channels (line / telegram / slack / ...)", () => {
    const allowed = listValidCronDeliveryChannels();
    expect(allowed).toContain("line");
    expect(allowed).toContain("telegram");
    expect(allowed).toContain("slack");
  });
});

describe("validateCronDeliveryChannel", () => {
  it("accepts missing delivery (none mode)", () => {
    expect(validateCronDeliveryChannel(undefined)).toEqual({ ok: true });
    expect(validateCronDeliveryChannel(null)).toEqual({ ok: true });
    expect(validateCronDeliveryChannel({})).toEqual({ ok: true });
  });

  it("accepts delivery.mode = none / webhook with any channel value (white-listed elsewhere)", () => {
    expect(
      validateCronDeliveryChannel({ mode: "none", channel: "anything" }),
    ).toEqual({ ok: true });
    expect(
      validateCronDeliveryChannel({ mode: "webhook", to: "https://example.com" }),
    ).toEqual({ ok: true });
  });

  it("accepts announce + valid deliverable channel (line)", () => {
    const result = validateCronDeliveryChannel({ mode: "announce", channel: "line" });
    expect(result.ok).toBe(true);
  });

  it("accepts announce + webchat (cron 复用 sessionKey 场景)", () => {
    const result = validateCronDeliveryChannel({ mode: "announce", channel: "webchat" });
    expect(result.ok).toBe(true);
  });

  it("rejects the AI-fabricated 'webchat-control-ui' literal (本事故核心，2026-05-13)", () => {
    const result = validateCronDeliveryChannel({
      mode: "announce",
      channel: "webchat-control-ui",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("webchat-control-ui");
      expect(result.message).toContain("Allowed:");
    }
  });

  it("rejects any unknown channel id (defense in depth)", () => {
    expect(
      validateCronDeliveryChannel({ mode: "announce", channel: "some-fake-channel" }).ok,
    ).toBe(false);
  });

  it("accepts announce mode with missing channel (falls through to vendor's last-channel resolution)", () => {
    // schema 已保证 channel 字段非空 string；此函数只拦"非法字面量"
    // missing channel 走 vendor 的 fallback (channel-selection.ts)，不在本函数范围
    expect(
      validateCronDeliveryChannel({ mode: "announce" }),
    ).toEqual({ ok: true });
  });

  it("treats whitespace-only channel as missing (allow vendor fallback)", () => {
    expect(
      validateCronDeliveryChannel({ mode: "announce", channel: "   " }),
    ).toEqual({ ok: true });
  });
});
