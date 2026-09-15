// sessions.refreshBootstrap —— 单测（回搬自 openclaw-vendor #26/#67，2026-09-15 移植到
// v2026.9.4 基线）。
//
// 覆盖：
//   1. schema 校验：拒绝空 key / 拒绝非法附加字段。
//   2. 幂等性 + 语义：清掉 canonical key 对应的 bootstrap 缓存并返回 ok:true。
//   3. canonical key 解析（#67 回归）：调用方传 alias（如 "main"）时，必须清掉解析后的
//      canonical key，而不是原始 alias —— 否则真实缓存（按 canonical key 存储）不会被清。
//
// 这里 mock 掉 clearBootstrapSnapshot（真实缓存行为已由
// src/agents/bootstrap-cache.test.ts 覆盖）与 resolveGatewaySessionTargetFromKey（canonical
// 解析已由 session-utils 相关测试覆盖），只验证 handler 自身的编排契约：用 canonical key 调
// clearBootstrapSnapshot、respond 携带 canonical key。

import { beforeEach, describe, expect, it, vi } from "vitest";

const { clearBootstrapSnapshot, resolveGatewaySessionTargetFromKey } = vi.hoisted(() => ({
  clearBootstrapSnapshot: vi.fn(),
  resolveGatewaySessionTargetFromKey: vi.fn(),
}));

vi.mock("../../agents/bootstrap-cache.js", () => ({
  clearBootstrapSnapshot,
}));

// sessions-shared.js 还导出很多别的（sessions.patch/reset 等都依赖）→ 部分 mock，只覆盖
// canonical key 解析函数，其余走真实实现。
vi.mock("./sessions-shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sessions-shared.js")>();
  return { ...actual, resolveGatewaySessionTargetFromKey };
});

import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

function fakeContext(cfg: OpenClawConfig): GatewayRequestContext {
  return {
    getRuntimeConfig: () => cfg,
  } as unknown as GatewayRequestContext;
}

describe("sessions.refreshBootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveGatewaySessionTargetFromKey.mockReturnValue({
      cfg: {} as OpenClawConfig,
      target: { canonicalKey: "agent:main:main", storePath: "/tmp/sessions.json", storeKeys: [] },
      storePath: "/tmp/sessions.json",
    });
  });

  it("rejects an empty key", async () => {
    const respond = vi.fn() as unknown as RespondFn;
    await sessionMutationHandlers["sessions.refreshBootstrap"]!({
      params: { key: "" },
      respond,
      context: fakeContext({} as OpenClawConfig),
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.anything());
    expect(clearBootstrapSnapshot).not.toHaveBeenCalled();
  });

  it("rejects unexpected extra fields (closed schema)", async () => {
    const respond = vi.fn() as unknown as RespondFn;
    await sessionMutationHandlers["sessions.refreshBootstrap"]!({
      params: { key: "main", extra: "nope" },
      respond,
      context: fakeContext({} as OpenClawConfig),
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.anything());
    expect(clearBootstrapSnapshot).not.toHaveBeenCalled();
  });

  it("clears the resolved canonical key, not the raw alias, and responds ok:true", async () => {
    const respond = vi.fn() as unknown as RespondFn;
    // 调用方传 alias "main"；mock 解析出 canonical "agent:main:main"（回归 #67）。
    await sessionMutationHandlers["sessions.refreshBootstrap"]!({
      params: { key: "main" },
      respond,
      context: fakeContext({} as OpenClawConfig),
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(clearBootstrapSnapshot).toHaveBeenCalledWith("agent:main:main");
    expect(clearBootstrapSnapshot).not.toHaveBeenCalledWith("main");
    expect(respond).toHaveBeenCalledWith(true, { ok: true, key: "agent:main:main" }, undefined);
  });

  it("is idempotent when the target key has no cached bootstrap snapshot yet", async () => {
    // clearBootstrapSnapshot 对不存在的 key 本就是安全的 no-op（Map.delete 对不存在的 key
    // 直接返回 false，不抛错）；这里只需确认 handler 不会因为"没缓存"而拒绝请求。
    const respond = vi.fn() as unknown as RespondFn;
    await sessionMutationHandlers["sessions.refreshBootstrap"]!({
      params: { key: "main" },
      respond,
      context: fakeContext({} as OpenClawConfig),
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }), undefined);
  });
});
