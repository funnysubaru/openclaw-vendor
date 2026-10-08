// ADR-0033 任务84(c) 方案 B 回归：员工库后台启动准入未完成时，请求在入口透明等待，
// 而不是撞上同步开库入口的可重试错误；等待能被关闭 / 热重启打断，失败的员工立即返回
// 同一原因。走真实分发层 handleGatewayRequest + 真实 handler + 真实临时 SQLite。
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import {
  cancelAgentStartupAdmission,
  resetAgentStartupAdmissionForTest,
  scheduleAgentStartupAdmission,
} from "../state/agent-startup-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { RespondFn } from "./server-methods/types.js";
import { GatewayRequestEntryLifetime } from "./server-request-entry.js";
import { runWithGatewayHttpWorkAdmission } from "./server/http-work-admission.js";

afterEach(() => {
  resetAgentStartupAdmissionForTest();
});

const cfg = { agents: { entries: { main: {} } } } satisfies OpenClawConfig;
const scope = { agentId: "main", sessionKey: "agent:main:main", sessionId: "main-1" };

/** 准入里的 open 阶段卡在 gate 上，但会响应调度器 abort（模拟真实工作在关闭时收尾）。 */
function scheduleGatedAdmission(agentIds: string[]) {
  const gate = createDeferred<void>();
  scheduleAgentStartupAdmission({
    agentIds,
    openAgent: async (_agentId, signal) => await racePromiseWithAbortSignal(gate.promise, signal),
    migrateAgent: async () => {},
  });
  return gate;
}

function dispatch(
  method: string,
  params: Record<string, unknown>,
  context = createDirectChatContext({ getRuntimeConfig: () => cfg }),
) {
  const respond = vi.fn<RespondFn>();
  const request = handleGatewayRequest({
    req: { type: "req", id: `startup-admission-${method}`, method, params },
    respond,
    client: { connect: { scopes: ["operator.admin"] } } as never,
    isWebchatConnect: () => false,
    context,
  });
  return { request, respond };
}

async function tick(ms = 20) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("gateway request entry waits for agent startup admission", () => {
  it.each([
    ["sessions.list", {}],
    ["chat.history", { sessionKey: scope.sessionKey }],
    ["sessions.usage", { key: scope.sessionKey }],
  ] as const)("%s 在准入进行中发出 → 等待后正常返回", async (method, params) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig(cfg);
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const gate = scheduleGatedAdmission(["main"]);
      try {
        const { request, respond } = dispatch(method, params);
        // 给足时间让"不等待"的实现跑完整个 handler（这些 handler 冷启动要几百毫秒），
        // 确认请求是真被挡住，而不是只是还没跑到 respond。
        await Promise.race([request, tick(3_000)]);
        expect(respond).not.toHaveBeenCalled();

        gate.resolve();
        await request;
        expect(respond).toHaveBeenCalledOnce();
        expect(respond.mock.calls[0]?.[0]).toBe(true);
      } finally {
        gate.resolve();
        await cancelAgentStartupAdmission();
      }
    });
  });

  it("等待中触发 cancel（关闭 / 热重启）→ 请求立即以可重试 UNAVAILABLE 结束，cancel 不卡", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig(cfg);
      scheduleGatedAdmission(["main"]);
      const { request, respond } = dispatch("sessions.list", {});
      await tick();
      expect(respond).not.toHaveBeenCalled();

      await cancelAgentStartupAdmission();
      await request;
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
      );
    });
  });

  it("关闭前奏关掉请求入口租约 → 等待中的请求立即结束，入口排空不必等准入", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig(cfg);
      const gate = scheduleGatedAdmission(["main"]);
      const requestEntryLifetime = new GatewayRequestEntryLifetime();
      try {
        const { request, respond } = dispatch(
          "sessions.list",
          {},
          createDirectChatContext({ getRuntimeConfig: () => cfg, requestEntryLifetime }),
        );
        await tick();
        expect(respond).not.toHaveBeenCalled();

        requestEntryLifetime.beginClose();
        await request;
        await requestEntryLifetime.waitForPendingEntries();
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
        );
      } finally {
        gate.resolve();
        await cancelAgentStartupAdmission();
      }
    });
  });

  it("目标员工准入已失败 → 立即返回同一失败原因，不陪其它员工等", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig(cfg);
      scheduleAgentStartupAdmission({
        agentIds: ["main"],
        openAgent: async () => {
          throw new Error("main integrity failed");
        },
        migrateAgent: async () => {},
      });
      const otherGate = scheduleGatedAdmission(["ops"]);
      try {
        await tick();
        const { request, respond } = dispatch("chat.history", { sessionKey: scope.sessionKey });
        await request;
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "UNAVAILABLE",
            retryable: false,
            message: expect.stringContaining("main integrity failed"),
          }),
        );
      } finally {
        otherGate.resolve();
        await cancelAgentStartupAdmission();
      }
    });
  });

  it("HTTP 用户路由在准入进行中先等待，cancel 时返回 503", async () => {
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn(),
      req: { socket: {} },
    } as unknown as ServerResponse;
    const gate = scheduleGatedAdmission(["main"]);
    const run = vi.fn(async () => true);
    const waited = runWithGatewayHttpWorkAdmission(res, run);
    await tick();
    expect(run).not.toHaveBeenCalled();
    gate.resolve();
    await waited;
    expect(run).toHaveBeenCalledOnce();

    scheduleGatedAdmission(["ops"]);
    const cancelled = runWithGatewayHttpWorkAdmission(res, run);
    await tick();
    await cancelAgentStartupAdmission();
    await expect(cancelled).resolves.toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(503);
  });

  it("免等白名单：心跳方法 last-heartbeat 在准入中立即返回，白名单外的方法仍等待", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig(cfg);
      const gate = scheduleGatedAdmission(["main"]);
      try {
        const heartbeat = dispatch("last-heartbeat", {});
        const presence = dispatch("system-presence", {});
        await Promise.race([heartbeat.request, tick(2_000)]);
        expect(heartbeat.respond).toHaveBeenCalledOnce();
        expect(heartbeat.respond.mock.calls[0]?.[0]).toBe(true);
        // 白名单外（即便同样只读内存）也照常等待：防止白名单被写成全放行。
        await Promise.race([presence.request, tick(500)]);
        expect(presence.respond).not.toHaveBeenCalled();

        gate.resolve();
        await presence.request;
        expect(presence.respond.mock.calls[0]?.[0]).toBe(true);
      } finally {
        gate.resolve();
        await cancelAgentStartupAdmission();
      }
    });
  });
});
