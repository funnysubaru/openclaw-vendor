/**
 * cronHandlers 短路测试（Low 3，PR #39 follow-up review）
 *
 * 单测 validate-delivery-channel.ts 已覆盖纯函数正确性；本文件锁住的是 cronHandlers
 * 调用顺序：当 validateCronJobCreateDelivery / validateCronJobPatchDelivery 返回
 * `{ ok: false }` 时，cron.add / cron.update 必须 INVALID_REQUEST 短路，**不**调用
 * context.cron.add / context.cron.update（防止后续有人调整顺序、把校验放到落库后）。
 *
 * **依赖（Low 3，PR #39 follow-up-3 review）**：本文件的"非法 channel → 短路"用例
 * 依赖 `validateCronAddParams` / `validateCronUpdateParams` 先对 params shape 放行。
 * 若日后 schema 收紧（如对 delivery 结构更严的 Ajv 规则），同一 fixture 可能在
 * shape 校验阶段就被拒，错误形态会从「delivery.channel 非法」变成「invalid cron.add
 * params」。届时需要：① 调 fixture 以满足新 shape；或 ② 拆成两条用例，分别
 * 验证 shape-invalid 与 channel-invalid 的短路。这里把假设显式写下来，便于以后
 * 维护者理解失败信号。
 */
import { describe, expect, it, vi } from "vitest";
import { cronHandlers } from "./cron.js";
import { ErrorCodes } from "../protocol/index.js";
import type { GatewayRequestContext } from "./types.js";

function buildContextStub() {
  const cronAdd = vi.fn();
  const cronUpdate = vi.fn();
  const logGatewayInfo = vi.fn();
  const context = {
    cron: {
      add: cronAdd,
      update: cronUpdate,
    },
    logGateway: {
      info: logGatewayInfo,
    },
  } as unknown as GatewayRequestContext;
  return { context, cronAdd, cronUpdate };
}

function buildValidCronAddParams() {
  return {
    name: "test-job",
    enabled: true,
    schedule: { kind: "at" as const, at: new Date(Date.now() + 60_000).toISOString() },
    sessionTarget: "main" as const,
    wakeMode: "next-heartbeat" as const,
    payload: { kind: "systemEvent" as const, text: "hello" },
  };
}

describe("cronHandlers delivery validation short-circuit", () => {
  it("cron.add: invalid delivery.channel → INVALID_REQUEST + does NOT call context.cron.add", async () => {
    const { context, cronAdd } = buildContextStub();
    const respond = vi.fn();

    const params = {
      ...buildValidCronAddParams(),
      delivery: {
        mode: "announce" as const,
        channel: "webchat-control-ui", // 杜撰的 channel id —— 应被白名单拦下
        to: "main",
      },
    };

    await cronHandlers["cron.add"]({
      req: {} as never,
      params: params as unknown as Record<string, unknown>,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context,
    });

    expect(cronAdd).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledOnce();
    const [ok, data, err] = respond.mock.calls[0];
    expect(ok).toBe(false);
    expect(data).toBeUndefined();
    expect(err).toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
      message: expect.stringContaining("webchat-control-ui"),
    });
  });

  it("cron.update: invalid patch.delivery.channel → INVALID_REQUEST + does NOT call context.cron.update", async () => {
    const { context, cronUpdate } = buildContextStub();
    const respond = vi.fn();

    const params = {
      id: "job-xyz",
      patch: {
        delivery: {
          mode: "announce" as const,
          channel: "not-a-real-channel",
          to: "anywhere",
        },
      },
    };

    await cronHandlers["cron.update"]({
      req: {} as never,
      params: params as unknown as Record<string, unknown>,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context,
    });

    expect(cronUpdate).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledOnce();
    const [ok, , err] = respond.mock.calls[0];
    expect(ok).toBe(false);
    expect(err).toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
      message: expect.stringContaining("not-a-real-channel"),
    });
  });

  it("cron.update: patch without delivery field → DOES call context.cron.update (happy path)", async () => {
    // Info 4 (PR #39 follow-up-3 review)：防回归——patch 不带 delivery 字段时不应被
    // delivery 白名单误拦。模拟"只改 schedule"或"只改 name" 这种最常见的 cron.update
    // 用法。
    const { context, cronUpdate } = buildContextStub();
    const respond = vi.fn();
    cronUpdate.mockResolvedValue({ id: "job-xyz", name: "renamed" });

    const params = {
      id: "job-xyz",
      patch: {
        name: "renamed-cron-job",
        // 故意不写 delivery 字段
      },
    };

    await cronHandlers["cron.update"]({
      req: {} as never,
      params: params as unknown as Record<string, unknown>,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context,
    });

    expect(cronUpdate).toHaveBeenCalledOnce();
    expect(cronUpdate).toHaveBeenCalledWith(
      "job-xyz",
      expect.objectContaining({ name: "renamed-cron-job" }),
    );
    expect(respond).toHaveBeenCalledOnce();
    const [ok] = respond.mock.calls[0];
    expect(ok).toBe(true);
  });

  it("cron.add: valid announce channel (webchat) passes validation → DOES call context.cron.add", async () => {
    // 对照用例：白名单内 channel 不被误拦，保护 happy path
    const { context, cronAdd } = buildContextStub();
    const respond = vi.fn();
    cronAdd.mockResolvedValue({ id: "new-job-id", name: "ok" });

    const params = {
      ...buildValidCronAddParams(),
      delivery: {
        mode: "announce" as const,
        channel: "webchat",
        to: "agent:main:user:abc:panel-xyz",
      },
    };

    await cronHandlers["cron.add"]({
      req: {} as never,
      params: params as unknown as Record<string, unknown>,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context,
    });

    expect(cronAdd).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledOnce();
    const [ok] = respond.mock.calls[0];
    expect(ok).toBe(true);
  });
});
