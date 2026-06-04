import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
// normalizeControllerSessionKey 尚未实现——本测试先行（TDD 红阶段）
import { normalizeControllerSessionKey } from "./sessions-helpers.js";

describe("normalizeControllerSessionKey", () => {
  // 最小 cfg：resolveMainSessionAlias 在 cfg 无 session 字段时回退 mainKey="main" / alias="main"
  const cfg = {} as OpenClawConfig;

  it("空字符串应返回 undefined", () => {
    expect(normalizeControllerSessionKey(cfg, "")).toBeUndefined();
  });

  it("纯空白字符串应返回 undefined", () => {
    expect(normalizeControllerSessionKey(cfg, "   ")).toBeUndefined();
  });

  it("undefined 应返回 undefined", () => {
    expect(normalizeControllerSessionKey(cfg, undefined)).toBeUndefined();
  });

  it("相同 key 两次调用应返回相同 canonical key（幂等性）", () => {
    const a = normalizeControllerSessionKey(cfg, "agent:orch-1:user:u:panel");
    const b = normalizeControllerSessionKey(cfg, "agent:orch-1:user:u:panel");
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  it("有意义的 key 应返回非空字符串", () => {
    const result = normalizeControllerSessionKey(cfg, "agent:orch-1:user:u:panel");
    expect(typeof result).toBe("string");
    expect(result!.length).toBeGreaterThan(0);
  });

  it("使用显式 mainKey 配置时应同样幂等", () => {
    const cfgWithMain = {
      session: { mainKey: "Primary", scope: "global" },
    } as OpenClawConfig;
    const a = normalizeControllerSessionKey(cfgWithMain, "agent:orch-2:user:u:panel");
    const b = normalizeControllerSessionKey(cfgWithMain, "agent:orch-2:user:u:panel");
    expect(a).toBe(b);
  });
});
