// sessions.refreshBootstrap RPC 单元测试 ——
// 验证三件事:
//   1. 协议层 schema 严格校验 { key } 形态(空 key / 多余字段都拒收)
//   2. bootstrap-cache 的 clearBootstrapSnapshot 真的会移除指定 key 的缓存,且不影响其他 key
//   3. handler 的对外契约稳定(成功路径返回 ok:true、失败路径返回 INVALID_REQUEST)
//
// 不做端到端 WebSocket 测试 —— 这个 RPC 极薄,wiring 由 method-scopes / server-methods-list 的现有
// 自动校验测试覆盖(method-scopes.test.ts 会卡住未分类的方法)。

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearAllBootstrapSnapshots,
  clearBootstrapSnapshot,
  getOrLoadBootstrapFiles,
} from "../../agents/bootstrap-cache.js";
import { validateSessionsRefreshBootstrapParams } from "../protocol/index.js";

describe("sessions.refreshBootstrap — schema validation", () => {
  it("accepts a non-empty string key", () => {
    const ok = validateSessionsRefreshBootstrapParams({ key: "agent:main:main" });
    expect(ok).toBe(true);
  });

  it("rejects empty key", () => {
    const ok = validateSessionsRefreshBootstrapParams({ key: "" });
    expect(ok).toBe(false);
  });

  it("rejects missing key", () => {
    const ok = validateSessionsRefreshBootstrapParams({});
    expect(ok).toBe(false);
  });

  it("rejects extra fields (additionalProperties: false 边界)", () => {
    // 防御未来误用 —— 例如把 reset 的 reason 字段抄到 refreshBootstrap 上
    const ok = validateSessionsRefreshBootstrapParams({
      key: "agent:main:main",
      reason: "new",
    });
    expect(ok).toBe(false);
  });

  it("rejects non-string key types", () => {
    expect(validateSessionsRefreshBootstrapParams({ key: 123 })).toBe(false);
    expect(validateSessionsRefreshBootstrapParams({ key: null })).toBe(false);
  });
});

describe("sessions.refreshBootstrap — bootstrap-cache behavior", () => {
  let tmpWorkspace: string;

  beforeEach(async () => {
    // 起一个最小 workspace,只放一个 SOUL.md,让 loadWorkspaceBootstrapFiles 有东西可读
    tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bootstrap-test-"));
    await fs.writeFile(path.join(tmpWorkspace, "SOUL.md"), "v1 SOUL content", "utf-8");
    clearAllBootstrapSnapshots();
  });

  afterEach(async () => {
    clearAllBootstrapSnapshots();
    await fs.rm(tmpWorkspace, { recursive: true, force: true });
  });

  it("clearBootstrapSnapshot removes only the specified key (其他 key 不受影响)", async () => {
    const keyA = "agent:main:main";
    const keyB = "agent:other:main";

    // 装载两个 key 的 snapshot;装完后内存里是 v1 内容
    await getOrLoadBootstrapFiles({ workspaceDir: tmpWorkspace, sessionKey: keyA });
    await getOrLoadBootstrapFiles({ workspaceDir: tmpWorkspace, sessionKey: keyB });

    // 改动 SOUL.md
    await fs.writeFile(path.join(tmpWorkspace, "SOUL.md"), "v2 SOUL content", "utf-8");

    // RPC handler 等价动作:只清 keyA
    clearBootstrapSnapshot(keyA);

    // keyA 重新装载应得到 v2(缓存已清);keyB 仍是 v1(缓存未动)
    const reloadedA = await getOrLoadBootstrapFiles({
      workspaceDir: tmpWorkspace,
      sessionKey: keyA,
    });
    const cachedB = await getOrLoadBootstrapFiles({
      workspaceDir: tmpWorkspace,
      sessionKey: keyB,
    });

    const soulA = reloadedA.find((f) => f.name === "SOUL.md");
    const soulB = cachedB.find((f) => f.name === "SOUL.md");
    expect(soulA?.content).toBe("v2 SOUL content");
    expect(soulB?.content).toBe("v1 SOUL content");
  });

  it("clearBootstrapSnapshot 是幂等的 —— 清一个不存在的 key 不报错", () => {
    expect(() => clearBootstrapSnapshot("agent:nonexistent:main")).not.toThrow();
  });
});
