import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGatewayToolMock } = vi.hoisted(() => ({
  callGatewayToolMock: vi.fn(),
}));

vi.mock("../agent-scope.js", () => ({
  resolveSessionAgentId: () => "agent-123",
}));

import { createCronTool } from "./cron-tool.js";

describe("cron tool flat-params", () => {
  beforeEach(() => {
    callGatewayToolMock.mockClear();
    callGatewayToolMock.mockResolvedValue({ ok: true });
  });

  it("forces caller sessionKey during flat-params recovery, overriding AI-supplied top-level sessionKey (PR-A)", async () => {
    // PR-A force-override 应用到 flat-params recovery 路径:
    // 之前: 显式 top-level sessionKey 在 synthetic job 构造里被原样带入 → AI 幻觉
    //   sessionKey 仍能落库。
    // 现在: 同 nested job.sessionKey 一致, caller agentSessionKey 总是覆盖。
    const callerSessionKey = "agent:main:discord:channel:ops";
    const tool = createCronTool(
      { agentSessionKey: callerSessionKey },
      { callGatewayTool: callGatewayToolMock },
    );
    await tool.execute("call-flat-session-key", {
      action: "add",
      sessionKey: "agent:main:fabricated-telegram-via-flat",
      schedule: { kind: "at", at: new Date(123).toISOString() },
      message: "do stuff",
    });

    const [method, _gatewayOpts, params] = callGatewayToolMock.mock.calls[0] as [
      string,
      unknown,
      { sessionKey?: string },
    ];
    expect(method).toBe("cron.add");
    expect(params.sessionKey).toBe(callerSessionKey);
  });
});
