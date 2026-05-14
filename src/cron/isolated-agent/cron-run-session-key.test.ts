import { describe, expect, it } from "vitest";
import { resolveCronRunSessionKey } from "./cron-run-session-key.js";

describe("resolveCronRunSessionKey", () => {
  it("returns cron:<jobId> when job.sessionKey is missing (default isolated behavior)", () => {
    expect(resolveCronRunSessionKey({ id: "job-1" })).toBe("cron:job-1");
  });

  it("returns cron:<jobId> when job.sessionKey is empty string", () => {
    expect(resolveCronRunSessionKey({ id: "job-2", sessionKey: "" })).toBe("cron:job-2");
  });

  it("returns cron:<jobId> when job.sessionKey is whitespace-only", () => {
    expect(resolveCronRunSessionKey({ id: "job-3", sessionKey: "   " })).toBe("cron:job-3");
  });

  it("returns cron:<jobId> when sessionKey doesn't start with 'agent:' (legacy format)", () => {
    // 旧格式 sessionKey (无 agent: 前缀) 不复用，避免误把非合法 session 当成 panel session
    expect(
      resolveCronRunSessionKey({ id: "job-4", sessionKey: "discord:channel:ops" }),
    ).toBe("cron:job-4");
    expect(
      resolveCronRunSessionKey({ id: "job-5", sessionKey: "legacy-key-no-prefix" }),
    ).toBe("cron:job-5");
  });

  it("reuses the panel session key (agent:<agentId>:user:<uid>:panel-*)", () => {
    // Yuiclaw panel 选了"目的地 session"后，jobs.json.sessionKey 是这个格式
    const panelKey = "agent:custom-cbd0fe4a:user:06148fa3-9aa3-4b28-b1b1-3513ada1dc9e:panel-d1e7fc49";
    expect(resolveCronRunSessionKey({ id: "job-6", sessionKey: panelKey })).toBe(panelKey);
  });

  it("reuses a LINE-bound session key (agent:<agentId>:user:<uid>:line:group:<gid>)", () => {
    // vendor cron-tool 创建 cron 时从 chat 上下文继承的 LINE session key 也应复用——
    // cron 跑完结果发到 LINE 用户对话，符合 cron-tool 设计意图
    const lineKey = "agent:custom-x:user:abc:line:group:ca310c392625f3d968f56ff04a4163ec4";
    expect(resolveCronRunSessionKey({ id: "job-7", sessionKey: lineKey })).toBe(lineKey);
  });

  it("reuses the agent main session key (agent:main:user:<uid>:main)", () => {
    const mainKey = "agent:main:user:06148fa3:main";
    expect(resolveCronRunSessionKey({ id: "job-8", sessionKey: mainKey })).toBe(mainKey);
  });

  it("is case-insensitive on the 'agent:' prefix detection", () => {
    // 防御性：大小写混合的 sessionKey 仍按 agent: 前缀复用
    expect(
      resolveCronRunSessionKey({ id: "job-9", sessionKey: "Agent:custom:user:x:y" }),
    ).toBe("Agent:custom:user:x:y");
  });

  it("trims surrounding whitespace before evaluation", () => {
    // 用户/AI 写入时可能带空格——trim 后仍要识别为合法
    const padded = "  agent:custom:user:x:panel-abc  ";
    expect(resolveCronRunSessionKey({ id: "job-10", sessionKey: padded })).toBe(
      "agent:custom:user:x:panel-abc",
    );
  });

  it("does NOT reuse sessionKey that merely contains 'agent:' but doesn't start with it", () => {
    // 防御性：sessionKey 不是 agent: 开头就不复用，避免奇怪 substring 命中
    expect(
      resolveCronRunSessionKey({ id: "job-11", sessionKey: "prefix-agent:malformed" }),
    ).toBe("cron:job-11");
  });
});
