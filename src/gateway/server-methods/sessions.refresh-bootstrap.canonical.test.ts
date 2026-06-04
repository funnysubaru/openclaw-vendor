// sessions.refreshBootstrap —— canonical key 解析回归测试（review 第2轮 P2-3）
//
// bug：handler 直接用 RPC 传入的 raw key 调 clearBootstrapSnapshot,但 bootstrap 缓存是按
// canonical key 存的。调用方传 alias（如 "main"）时返回 ok:true,实际 canonical 缓存没被清掉。
// 修复：先经 resolveGatewaySessionStoreTarget 解析 canonical 再清(对齐 sessions.patch/reset)。
//
// 这里 mock 掉缓存层 + 解析层,只验证 handler「用 canonical 而非 raw key 清缓存」的契约。
// 现有 sessions.refresh-bootstrap.test.ts 用真实 bootstrap-cache 测缓存行为,所以这条单独成文件
// （避免与那边的真实缓存 mock 冲突）。

import { beforeEach, describe, expect, it, vi } from "vitest";

const { clearBootstrapSnapshot, resolveGatewaySessionStoreTarget } = vi.hoisted(() => ({
  clearBootstrapSnapshot: vi.fn(),
  resolveGatewaySessionStoreTarget: vi.fn(),
}));

vi.mock("../../agents/bootstrap-cache.js", () => ({
  clearBootstrapSnapshot,
  clearAllBootstrapSnapshots: vi.fn(),
}));

// session-utils 还导出很多别的（chat.ts 等都依赖）→ 部分 mock,只覆盖解析函数。
vi.mock("../session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-utils.js")>();
  return { ...actual, resolveGatewaySessionStoreTarget };
});

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return { ...actual, loadConfig: () => ({ session: { mainKey: "main" } }) };
});

import { sessionsHandlers } from "./sessions.js";

describe("sessions.refreshBootstrap canonicalizes key before clearing (review P2-3)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clears the resolved canonical key, not the raw alias", async () => {
    // 调用方传 alias "main" → 解析出 canonical "agent:main:main"
    resolveGatewaySessionStoreTarget.mockReturnValue({
      canonicalKey: "agent:main:main",
      storePath: "/tmp/sessions.json",
      storeKeys: [],
    });

    const respond = vi.fn();
    await sessionsHandlers["sessions.refreshBootstrap"]({
      params: { key: "main" },
      respond: respond as never,
      context: {} as never,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
    });

    // 核心：用 canonical 清,绝不用 raw alias 清（否则缓存清不到）
    expect(clearBootstrapSnapshot).toHaveBeenCalledWith("agent:main:main");
    expect(clearBootstrapSnapshot).not.toHaveBeenCalledWith("main");
    // 返回的 key 也应是 canonical（与 patch/reset 一致）
    expect(respond).toHaveBeenCalledWith(true, { ok: true, key: "agent:main:main" }, undefined);
  });
});
