/**
 * cronHandlers 短路测试（Low 3，PR #39 follow-up review）
 *
 * 单测 validate-delivery-channel.ts 已覆盖纯函数正确性；本文件锁住的是 cronHandlers
 * 调用顺序：当 validateCronJobCreateDelivery / validateCronJobPatchDelivery 返回
 * `{ ok: false }` 时，cron.add / cron.update 必须 INVALID_REQUEST 短路，**不**调用
 * context.cron.add / context.cron.update（防止后续有人调整顺序、把校验放到落库后）。
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
