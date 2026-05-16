import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGatewayMock } = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../agent-scope.js", () => ({
  resolveSessionAgentId: () => "agent-123",
}));

import { createCronTool } from "./cron-tool.js";

describe("cron tool", () => {
  function readGatewayCall(index = 0): { method?: string; params?: Record<string, unknown> } {
    return (
      (callGatewayMock.mock.calls[index]?.[0] as
        | { method?: string; params?: Record<string, unknown> }
        | undefined) ?? { method: undefined, params: undefined }
    );
  }

  function readCronPayloadText(index = 0): string {
    const params = readGatewayCall(index).params as { payload?: { text?: string } } | undefined;
    return params?.payload?.text ?? "";
  }

  function expectSingleGatewayCallMethod(method: string) {
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    const call = readGatewayCall(0);
    expect(call.method).toBe(method);
    return call.params;
  }

  function buildReminderAgentTurnJob(overrides: Record<string, unknown> = {}): {
    name: string;
    schedule: { at: string };
    payload: { kind: "agentTurn"; message: string };
    delivery?: { mode: string; to?: string };
  } {
    return {
      name: "reminder",
      schedule: { at: new Date(123).toISOString() },
      payload: { kind: "agentTurn", message: "hello" },
      ...overrides,
    };
  }

  async function executeAddAndReadDelivery(params: {
    callId: string;
    agentSessionKey: string;
    delivery?: { mode?: string; channel?: string; to?: string } | null;
  }) {
    const tool = createCronTool({ agentSessionKey: params.agentSessionKey });
    await tool.execute(params.callId, {
      action: "add",
      job: {
        ...buildReminderAgentTurnJob(),
        ...(params.delivery !== undefined ? { delivery: params.delivery } : {}),
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: { delivery?: { mode?: string; channel?: string; to?: string } };
    };
    return call?.params?.delivery;
  }

  async function executeAddAndReadSessionKey(params: {
    callId: string;
    agentSessionKey: string;
    jobSessionKey?: string;
  }): Promise<string | undefined> {
    const tool = createCronTool({ agentSessionKey: params.agentSessionKey });
    await tool.execute(params.callId, {
      action: "add",
      job: {
        name: "wake-up",
        schedule: { at: new Date(123).toISOString() },
        ...(params.jobSessionKey ? { sessionKey: params.jobSessionKey } : {}),
        payload: { kind: "systemEvent", text: "hello" },
      },
    });
    const call = readGatewayCall();
    const payload = call.params as { sessionKey?: string } | undefined;
    return payload?.sessionKey;
  }

  async function executeAddWithContextMessages(callId: string, contextMessages: number) {
    const tool = createCronTool({ agentSessionKey: "main" });
    await tool.execute(callId, {
      action: "add",
      contextMessages,
      job: {
        name: "reminder",
        schedule: { at: new Date(123).toISOString() },
        payload: { kind: "systemEvent", text: "Reminder: the thing." },
      },
    });
  }

  beforeEach(() => {
    callGatewayMock.mockClear();
    callGatewayMock.mockResolvedValue({ ok: true });
  });

  it("marks cron as owner-only", async () => {
    const tool = createCronTool();
    expect(tool.ownerOnly).toBe(true);
  });

  it.each([
    [
      "update",
      { action: "update", jobId: "job-1", patch: { foo: "bar" } },
      { id: "job-1", patch: { foo: "bar" } },
    ],
    [
      "update",
      { action: "update", id: "job-2", patch: { foo: "bar" } },
      { id: "job-2", patch: { foo: "bar" } },
    ],
    ["remove", { action: "remove", jobId: "job-1" }, { id: "job-1" }],
    ["remove", { action: "remove", id: "job-2" }, { id: "job-2" }],
    ["run", { action: "run", jobId: "job-1" }, { id: "job-1", mode: "force" }],
    ["run", { action: "run", id: "job-2" }, { id: "job-2", mode: "force" }],
    ["runs", { action: "runs", jobId: "job-1" }, { id: "job-1" }],
    ["runs", { action: "runs", id: "job-2" }, { id: "job-2" }],
  ])("%s sends id to gateway", async (action, args, expectedParams) => {
    const tool = createCronTool();
    await tool.execute("call1", args);

    const params = expectSingleGatewayCallMethod(`cron.${action}`);
    expect(params).toEqual(expectedParams);
  });

  it("prefers jobId over id when both are provided", async () => {
    const tool = createCronTool();
    await tool.execute("call1", {
      action: "run",
      jobId: "job-primary",
      id: "job-legacy",
    });

    expect(readGatewayCall().params).toEqual({ id: "job-primary", mode: "force" });
  });

  it("supports due-only run mode", async () => {
    const tool = createCronTool();
    await tool.execute("call-due", {
      action: "run",
      jobId: "job-due",
      runMode: "due",
    });

    expect(readGatewayCall().params).toEqual({ id: "job-due", mode: "due" });
  });

  it("normalizes cron.add job payloads", async () => {
    const tool = createCronTool();
    await tool.execute("call2", {
      action: "add",
      job: {
        data: {
          name: "wake-up",
          schedule: { atMs: 123 },
          payload: { kind: "systemEvent", text: "hello" },
        },
      },
    });

    const params = expectSingleGatewayCallMethod("cron.add");
    expect(params).toEqual({
      name: "wake-up",
      enabled: true,
      deleteAfterRun: true,
      schedule: { kind: "at", at: new Date(123).toISOString() },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hello" },
    });
  });

  it("does not default agentId when job.agentId is null", async () => {
    const tool = createCronTool({ agentSessionKey: "main" });
    await tool.execute("call-null", {
      action: "add",
      job: {
        name: "wake-up",
        schedule: { at: new Date(123).toISOString() },
        agentId: null,
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: { agentId?: unknown };
    };
    expect(call?.params?.agentId).toBeNull();
  });

  it("stamps cron.add with caller sessionKey when missing", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const callerSessionKey = "agent:main:discord:channel:ops";
    const sessionKey = await executeAddAndReadSessionKey({
      callId: "call-session-key",
      agentSessionKey: callerSessionKey,
    });
    expect(sessionKey).toBe(callerSessionKey);
  });

  it("forces caller sessionKey on cron.add, overriding AI-supplied job.sessionKey", async () => {
    // 业务意图（PR-A，回应用户实战 2026-05-16）:
    // 之前: AI 显式写 job.sessionKey 时 cron-tool 保留它 → AI 幻觉值
    //   (e.g. "webchat-control-ui" / 编造的 panel-xxxxxxxx) 落库 → cron 运行时报错 /
    //   投到不存在的 session。
    // 现在: opts.agentSessionKey (caller 当前 session) 永远是真相之源,
    //   AI 提供的任何 job.sessionKey 都被覆盖。这剥夺了 "agent 跨 session 设 cron"
    //   能力,但实战中没有合法用例,反而幻觉是反复发生的问题。
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const callerSessionKey = "agent:main:user:abc:panel-real123";
    const sessionKey = await executeAddAndReadSessionKey({
      callId: "call-force-override",
      agentSessionKey: callerSessionKey,
      jobSessionKey: "agent:main:fabricated-by-ai-hallucination",
    });
    expect(sessionKey).toBe(callerSessionKey);
  });

  it("forces caller sessionKey on cron.update patch, overriding AI-supplied patch.sessionKey", async () => {
    // 业务意图（PR-A force-override 应用到 cron.update path）:
    // cron.add 已强制覆盖, cron.update 也必须 — 否则 AI 可以通过 update 把幻觉
    // sessionKey 灌进既存 job, 绕过 add path 的保护。
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const callerSessionKey = "agent:main:user:abc:panel-real999";
    const tool = createCronTool({ agentSessionKey: callerSessionKey });
    await tool.execute("call-update-force", {
      action: "update",
      jobId: "job-xyz",
      patch: {
        sessionKey: "agent:main:fabricated-on-update",
        agentId: "fabricated-agent-id",
        name: "renamed",
      },
    });
    const call = readGatewayCall();
    const patch = (call.params as { patch?: { sessionKey?: string; agentId?: string; name?: string } })?.patch;
    expect(patch?.sessionKey).toBe(callerSessionKey);
    // agentId 同样被 caller sessionKey 派生覆盖 (test mock resolveSessionAgentId → "agent-123")
    expect(patch?.agentId).toBe("agent-123");
    // 其他字段不受影响
    expect(patch?.name).toBe("renamed");
  });

  it("preserves explicit patch.agentId=null on cron.update (intentional unbind)", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool({ agentSessionKey: "agent:main:user:abc:panel-real" });
    await tool.execute("call-update-null", {
      action: "update",
      jobId: "job-xyz",
      patch: {
        agentId: null,
        sessionKey: null,
      },
    });
    const call = readGatewayCall();
    const patch = (call.params as { patch?: { agentId?: unknown; sessionKey?: unknown } })?.patch;
    expect(patch?.agentId).toBeNull();
    expect(patch?.sessionKey).toBeNull();
  });

  it("does not stamp sessionKey when caller has no agentSessionKey (CLI / external client)", async () => {
    // 边界: 没有 caller session 的场景 (e.g. CLI 直接调 cron.add) — 不覆盖,沿用 AI/调用方
    // 提供的 job.sessionKey (或 vendor schema 校验后 fallback)。
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool({ agentSessionKey: undefined });
    await tool.execute("call-no-caller", {
      action: "add",
      job: {
        name: "wake-up",
        schedule: { at: new Date(123).toISOString() },
        sessionKey: "agent:main:caller-provided-key",
        payload: { kind: "systemEvent", text: "hello" },
      },
    });
    const call = readGatewayCall();
    const payload = call.params as { sessionKey?: string } | undefined;
    expect(payload?.sessionKey).toBe("agent:main:caller-provided-key");
  });

  it("adds recent context for systemEvent reminders when contextMessages > 0", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        messages: [
          { role: "user", content: [{ type: "text", text: "Discussed Q2 budget" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "We agreed to review on Tuesday." }],
          },
          { role: "user", content: [{ type: "text", text: "Remind me about the thing at 2pm" }] },
        ],
      })
      .mockResolvedValueOnce({ ok: true });

    await executeAddWithContextMessages("call3", 3);

    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    const historyCall = readGatewayCall(0);
    expect(historyCall.method).toBe("chat.history");

    const cronCall = readGatewayCall(1);
    expect(cronCall.method).toBe("cron.add");
    const text = readCronPayloadText(1);
    expect(text).toContain("Recent context:");
    expect(text).toContain("User: Discussed Q2 budget");
    expect(text).toContain("Assistant: We agreed to review on Tuesday.");
    expect(text).toContain("User: Remind me about the thing at 2pm");
  });

  it("caps contextMessages at 10", async () => {
    const messages = Array.from({ length: 12 }, (_, idx) => ({
      role: "user",
      content: [{ type: "text", text: `Message ${idx + 1}` }],
    }));
    callGatewayMock.mockResolvedValueOnce({ messages }).mockResolvedValueOnce({ ok: true });

    await executeAddWithContextMessages("call5", 20);

    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    const historyCall = readGatewayCall(0);
    expect(historyCall.method).toBe("chat.history");
    const historyParams = historyCall.params as { limit?: number } | undefined;
    expect(historyParams?.limit).toBe(10);

    const text = readCronPayloadText(1);
    expect(text).not.toMatch(/Message 1\\b/);
    expect(text).not.toMatch(/Message 2\\b/);
    expect(text).toContain("Message 3");
    expect(text).toContain("Message 12");
  });

  it("does not add context when contextMessages is 0 (default)", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool({ agentSessionKey: "main" });
    await tool.execute("call4", {
      action: "add",
      job: {
        name: "reminder",
        schedule: { at: new Date(123).toISOString() },
        payload: { text: "Reminder: the thing." },
      },
    });

    // Should only call cron.add, not chat.history
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    const cronCall = readGatewayCall(0);
    expect(cronCall.method).toBe("cron.add");
    const text = readCronPayloadText(0);
    expect(text).not.toContain("Recent context:");
  });

  it("preserves explicit agentId null on add", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool({ agentSessionKey: "main" });
    await tool.execute("call6", {
      action: "add",
      job: {
        name: "reminder",
        schedule: { at: new Date(123).toISOString() },
        agentId: null,
        payload: { kind: "systemEvent", text: "Reminder: the thing." },
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      method?: string;
      params?: { agentId?: string | null };
    };
    expect(call.method).toBe("cron.add");
    expect(call.params?.agentId).toBeNull();
  });

  it("infers delivery from threaded session keys", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-thread",
        agentSessionKey: "agent:main:slack:channel:general:thread:1699999999.0001",
      }),
    ).toEqual({
      mode: "announce",
      channel: "slack",
      to: "general",
    });
  });

  it("preserves telegram forum topics when inferring delivery", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-telegram-topic",
        agentSessionKey: "agent:main:telegram:group:-1001234567890:topic:99",
      }),
    ).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "-1001234567890:topic:99",
    });
  });

  it("infers delivery when delivery is null", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-null-delivery",
        agentSessionKey: "agent:main:dm:alice",
        delivery: null,
      }),
    ).toEqual({
      mode: "announce",
      to: "alice",
    });
  });

  // ── Flat-params recovery (issue #11310) ──────────────────────────────

  it("recovers flat params when job is missing", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool();
    await tool.execute("call-flat", {
      action: "add",
      name: "flat-job",
      schedule: { kind: "at", at: new Date(123).toISOString() },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "do stuff" },
    });

    const params = expectSingleGatewayCallMethod("cron.add") as
      | { name?: string; sessionTarget?: string; payload?: { kind?: string } }
      | undefined;
    expect(params?.name).toBe("flat-job");
    expect(params?.sessionTarget).toBe("isolated");
    expect(params?.payload?.kind).toBe("agentTurn");
  });

  it("recovers flat params when job is empty object", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool();
    await tool.execute("call-empty-job", {
      action: "add",
      job: {},
      name: "empty-job",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "wake up" },
    });

    const params = expectSingleGatewayCallMethod("cron.add") as
      | { name?: string; sessionTarget?: string; payload?: { text?: string } }
      | undefined;
    expect(params?.name).toBe("empty-job");
    expect(params?.sessionTarget).toBe("main");
    expect(params?.payload?.text).toBe("wake up");
  });

  it("recovers flat message shorthand as agentTurn payload", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool();
    await tool.execute("call-msg-shorthand", {
      action: "add",
      schedule: { kind: "at", at: new Date(456).toISOString() },
      message: "do stuff",
    });

    const params = expectSingleGatewayCallMethod("cron.add") as
      | { payload?: { kind?: string; message?: string }; sessionTarget?: string }
      | undefined;
    // normalizeCronJobCreate infers agentTurn from message and isolated from agentTurn
    expect(params?.payload?.kind).toBe("agentTurn");
    expect(params?.payload?.message).toBe("do stuff");
    expect(params?.sessionTarget).toBe("isolated");
  });

  it("does not recover flat params when no meaningful job field is present", async () => {
    const tool = createCronTool();
    await expect(
      tool.execute("call-no-signal", {
        action: "add",
        name: "orphan-name",
        enabled: true,
      }),
    ).rejects.toThrow("job required");
  });

  it("prefers existing non-empty job over flat params", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool();
    await tool.execute("call-nested-wins", {
      action: "add",
      job: {
        name: "nested-job",
        schedule: { kind: "at", at: new Date(123).toISOString() },
        payload: { kind: "systemEvent", text: "from nested" },
      },
      name: "flat-name-should-be-ignored",
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: { name?: string; payload?: { text?: string } };
    };
    expect(call?.params?.name).toBe("nested-job");
    expect(call?.params?.payload?.text).toBe("from nested");
  });

  it("does not infer delivery when mode is none", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    const delivery = await executeAddAndReadDelivery({
      callId: "call-none",
      agentSessionKey: "agent:main:discord:dm:buddy",
      delivery: { mode: "none" },
    });
    expect(delivery).toEqual({ mode: "none" });
  });

  it("does not infer announce delivery when mode is webhook", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    const delivery = await executeAddAndReadDelivery({
      callId: "call-webhook-explicit",
      agentSessionKey: "agent:main:discord:dm:buddy",
      delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
    });
    expect(delivery).toEqual({
      mode: "webhook",
      to: "https://example.invalid/cron-finished",
    });
  });

  it("fails fast when webhook mode is missing delivery.to", async () => {
    const tool = createCronTool({ agentSessionKey: "agent:main:discord:dm:buddy" });

    await expect(
      tool.execute("call-webhook-missing", {
        action: "add",
        job: {
          ...buildReminderAgentTurnJob(),
          delivery: { mode: "webhook" },
        },
      }),
    ).rejects.toThrow('delivery.mode="webhook" requires delivery.to to be a valid http(s) URL');
    expect(callGatewayMock).toHaveBeenCalledTimes(0);
  });

  it("fails fast when webhook mode uses a non-http URL", async () => {
    const tool = createCronTool({ agentSessionKey: "agent:main:discord:dm:buddy" });

    await expect(
      tool.execute("call-webhook-invalid", {
        action: "add",
        job: {
          ...buildReminderAgentTurnJob(),
          delivery: { mode: "webhook", to: "ftp://example.invalid/cron-finished" },
        },
      }),
    ).rejects.toThrow('delivery.mode="webhook" requires delivery.to to be a valid http(s) URL');
    expect(callGatewayMock).toHaveBeenCalledTimes(0);
  });

  it("recovers flat patch params for update action", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool();
    await tool.execute("call-update-flat", {
      action: "update",
      jobId: "job-1",
      name: "new-name",
      enabled: false,
    });

    const params = expectSingleGatewayCallMethod("cron.update") as
      | { id?: string; patch?: { name?: string; enabled?: boolean } }
      | undefined;
    expect(params?.id).toBe("job-1");
    expect(params?.patch?.name).toBe("new-name");
    expect(params?.patch?.enabled).toBe(false);
  });

  it("recovers additional flat patch params for update action", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool();
    await tool.execute("call-update-flat-extra", {
      action: "update",
      id: "job-2",
      sessionTarget: "main",
      failureAlert: { after: 3, cooldownMs: 60_000 },
    });

    const params = expectSingleGatewayCallMethod("cron.update") as
      | {
          id?: string;
          patch?: {
            sessionTarget?: string;
            failureAlert?: { after?: number; cooldownMs?: number };
          };
        }
      | undefined;
    expect(params?.id).toBe("job-2");
    expect(params?.patch?.sessionTarget).toBe("main");
    expect(params?.patch?.failureAlert).toEqual({ after: 3, cooldownMs: 60_000 });
  });
});
