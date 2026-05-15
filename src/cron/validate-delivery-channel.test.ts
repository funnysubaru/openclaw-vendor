import { describe, expect, it } from "vitest";
import {
  listValidCronDeliveryChannels,
  validateCronDeliveryChannel,
  validateCronJobPatchDelivery,
} from "./validate-delivery-channel.js";

describe("listValidCronDeliveryChannels", () => {
  it("EXCLUDES webchat (P1.1 fix) — webchat 不是合法 delivery target", () => {
    // 之前版本把 webchat 加进白名单，但 vendor runtime
    // (src/infra/outbound/targets.ts:179) 仍然拒绝 webchat 投递 → cron 校验通过但运行时
    // 报 "Delivering to WebChat is not supported"。session 复用走 job.sessionKey，
    // 不是 delivery.channel。详见 validate-delivery-channel.ts 文件头 P1.1 注释。
    expect(listValidCronDeliveryChannels()).not.toContain("webchat");
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

  it("accepts delivery without a channel field regardless of mode (none / webhook / undefined)", () => {
    expect(validateCronDeliveryChannel({ mode: "none" })).toEqual({ ok: true });
    expect(
      validateCronDeliveryChannel({ mode: "webhook", to: "https://example.com" }),
    ).toEqual({ ok: true });
  });

  it("rejects channel field with non-whitelisted value even when mode is not announce (Medium 2 修复)", () => {
    // 之前版本只在 mode === "announce" 时校验 channel,导致 legacy 升格出的
    // { mode: "none", channel: "bogus" } 绕过白名单 → DB 留脏 channel 字段。
    // 现在策略:写了 channel 就跑白名单,与 mode 无关。
    expect(
      validateCronDeliveryChannel({ mode: "none", channel: "webchat-control-ui" }).ok,
    ).toBe(false);
    expect(
      validateCronDeliveryChannel({ mode: "none", channel: "webchat" }).ok,
    ).toBe(false);
  });

  it("accepts mode=none + valid channel (channel 字段允许提示用途,只要在白名单内)", () => {
    expect(
      validateCronDeliveryChannel({ mode: "none", channel: "line" }),
    ).toEqual({ ok: true });
  });

  it("accepts announce + valid deliverable channel (line)", () => {
    const result = validateCronDeliveryChannel({ mode: "announce", channel: "line" });
    expect(result.ok).toBe(true);
  });

  it("REJECTS announce + webchat (P1.1 fix) — webchat runtime path 不支持", () => {
    const result = validateCronDeliveryChannel({ mode: "announce", channel: "webchat" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("webchat");
      // 错误文案应引导用 job.sessionKey 而不是 delivery.channel="webchat"
      expect(result.message).toContain("sessionKey");
    }
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

/**
 * P1.2 修复（PR #39 follow-up review）：cron.update 路径下 patch.delivery 缺省时，
 * service-layer (jobs.ts:606) 会从 patch.payload.channel/to/deliver 升格成 delivery patch
 * 落库；之前版本 validateCronJobPatchDelivery 只看 patch.delivery，legacy 路径直接绕过
 * 白名单。修复后 validateCronJobPatchDelivery 在 patch.delivery 缺省时模拟升格、对升格出
 * 来的 delivery 也做校验。
 */
describe("validateCronJobPatchDelivery — legacy payload.channel coverage (P1.2)", () => {
  it("rejects legacy payload.channel 'webchat-control-ui' (本事故 update 入口复现)", () => {
    const patch = {
      payload: {
        kind: "agentTurn",
        message: "x",
        channel: "webchat-control-ui",
        to: "main",
      },
    };
    const result = validateCronJobPatchDelivery(patch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("webchat-control-ui");
    }
  });

  it("rejects legacy payload.channel 'webchat' + to (触发 service-layer 升格的最小完整形式)", () => {
    // 单独 payload.channel 没有 to/deliver 时,service-layer hasLegacyHints=false,不会
    // 实际升格落库 -> validate 也跟着 ok (统一源行为一致)。带上 to 才真正触发 service
    // 升格 -> 此时校验必须拦下。
    const patch = {
      payload: { kind: "agentTurn", message: "x", channel: "webchat", to: "main" },
    };
    const result = validateCronJobPatchDelivery(patch);
    expect(result.ok).toBe(false);
  });

  it("does NOT reject legacy payload.channel alone (no to/deliver → service-layer 不升格)", () => {
    // 共享单一源:service-layer buildLegacyDeliveryPatchForServiceUpdate 的 hasLegacyHints
    // 不含 channel,所以孤立的 payload.channel 不会被升格成 delivery 落库 -> 校验也跟着放行。
    // 不是漏洞:这种 patch 不会改变 job.delivery。
    const patch = {
      payload: { kind: "agentTurn", message: "x", channel: "webchat-control-ui" },
    };
    expect(validateCronJobPatchDelivery(patch).ok).toBe(true);
  });

  it("rejects legacy deliver=false + 脏 channel + to (mode=none 路径,Medium 2 交叉)", () => {
    // service-layer 升格为 { mode: "none", channel: "bogus", to: "..." } 后,Medium 2
    // 修复让 validateCronDeliveryChannel 一旦看到 channel 就跑白名单 -> 拦下脏数据。
    const patch = {
      payload: {
        kind: "agentTurn",
        message: "x",
        deliver: false,
        channel: "webchat-control-ui",
        to: "main",
      },
    };
    const result = validateCronJobPatchDelivery(patch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("webchat-control-ui");
    }
  });

  it("accepts legacy payload.channel 'line' (合法 deliverable channel)", () => {
    const patch = {
      payload: {
        kind: "agentTurn",
        message: "x",
        channel: "line",
        to: "U1234567890",
      },
    };
    expect(validateCronJobPatchDelivery(patch).ok).toBe(true);
  });

  it("ignores legacy fields when payload.kind !== 'agentTurn' (systemEvent 不走 legacy delivery)", () => {
    const patch = {
      payload: { kind: "systemEvent", text: "ping", channel: "webchat-control-ui" },
    };
    expect(validateCronJobPatchDelivery(patch).ok).toBe(true);
  });

  it("prefers patch.delivery over legacy payload fields when both present", () => {
    // 显式 patch.delivery 存在时，只看 patch.delivery，不再尝试 legacy 升格
    const patch = {
      delivery: { mode: "announce" as const, channel: "line", to: "U..." },
      payload: { kind: "agentTurn", message: "x", channel: "bogus" }, // legacy 字段在场，但被忽略
    };
    expect(validateCronJobPatchDelivery(patch).ok).toBe(true);
  });

  it("treats patch with neither delivery nor legacy hints as ok (only-rename / only-schedule patch)", () => {
    expect(validateCronJobPatchDelivery({ name: "renamed" }).ok).toBe(true);
    expect(
      validateCronJobPatchDelivery({ payload: { kind: "agentTurn", message: "x" } }).ok,
    ).toBe(true);
  });
});
