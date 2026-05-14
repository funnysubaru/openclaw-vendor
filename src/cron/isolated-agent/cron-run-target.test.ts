import { describe, expect, it } from "vitest";
import { resolveCronRunTarget } from "./cron-run-target.js";

describe("resolveCronRunTarget (Open Question, PR #39 follow-up)", () => {
  it("no sessionKey: 用 requestedAgentId + cron:<jobId> 派生 (默认行为)", () => {
    const target = resolveCronRunTarget({ id: "job-1" }, "main");
    expect(target.agentId).toBe("main");
    expect(target.sessionKey).toBe("cron:job-1");
    expect(target.divergence).toBeUndefined();
  });

  it("canonical sessionKey + job.agentId 一致: 取 sessionKey 嵌入 agentId,无 divergence", () => {
    const target = resolveCronRunTarget(
      { id: "j", agentId: "custom-x", sessionKey: "agent:custom-x:user:abc:panel-y" },
      "custom-x",
    );
    expect(target.agentId).toBe("custom-x");
    expect(target.sessionKey).toBe("agent:custom-x:user:abc:panel-y");
    expect(target.divergence).toBeUndefined();
  });

  it("canonical sessionKey + job.agentId 不一致: agentId 取 sessionKey 嵌入值,返回 divergence", () => {
    // 例:host 写 job 时把 agentId 设成 main 但 sessionKey 指向 custom-x
    // 真相之源 = sessionKey(决定 jsonl 落到哪)
    const target = resolveCronRunTarget(
      { id: "j", agentId: "main", sessionKey: "agent:custom-x:user:abc:panel-y" },
      "main",
    );
    expect(target.agentId).toBe("custom-x");
    expect(target.sessionKey).toBe("agent:custom-x:user:abc:panel-y");
    expect(target.divergence).toEqual({
      jobAgentId: "main",
      sessionKeyAgentId: "custom-x",
    });
  });

  it("canonical sessionKey + job.agentId 缺省: 不算 divergence,直接用 sessionKey 嵌入 agentId", () => {
    const target = resolveCronRunTarget(
      { id: "j", sessionKey: "agent:custom-x:user:abc:panel-y" },
      "main",
    );
    expect(target.agentId).toBe("custom-x");
    expect(target.divergence).toBeUndefined();
  });

  it("canonical sessionKey 大小写: 全文 lowercase 后再 parse,与 toAgentStoreSessionKey 对齐", () => {
    const target = resolveCronRunTarget(
      { id: "j", agentId: "Custom-X", sessionKey: "Agent:Custom-X:User:ABC:Panel-Y" },
      "Custom-X",
    );
    expect(target.agentId).toBe("custom-x");
    expect(target.sessionKey).toBe("agent:custom-x:user:abc:panel-y");
    // job.agentId "custom-x" === sessionKeyAgentId "custom-x" → no divergence
    expect(target.divergence).toBeUndefined();
  });

  it("legacy/非 canonical sessionKey (不以 agent: 开头): 回退 cron:<jobId> + requestedAgentId", () => {
    const target = resolveCronRunTarget(
      { id: "j", agentId: "custom-x", sessionKey: "discord:channel:ops" },
      "custom-x",
    );
    expect(target.agentId).toBe("custom-x");
    expect(target.sessionKey).toBe("cron:j");
    expect(target.divergence).toBeUndefined();
  });

  it("空 sessionKey: 用 requestedAgentId + cron:<jobId>", () => {
    const target = resolveCronRunTarget({ id: "j", sessionKey: "" }, "main");
    expect(target.agentId).toBe("main");
    expect(target.sessionKey).toBe("cron:j");
  });
});
