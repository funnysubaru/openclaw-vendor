import { describe, expect, it, vi } from "vitest";
import { createSessionsYieldTool } from "./sessions-yield-tool.js";

describe("sessions_yield tool", () => {
  it("returns error when no sessionId is provided", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({ onYield });
    const result = await tool.execute("call-1", {});
    expect(result.details).toMatchObject({
      status: "error",
      error: "No session context",
    });
    expect(onYield).not.toHaveBeenCalled();
  });

  it("invokes onYield callback with default message", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({ sessionId: "test-session", onYield });
    const result = await tool.execute("call-1", {});
    expect(result.details).toMatchObject({ status: "yielded", message: "Turn yielded." });
    expect(onYield).toHaveBeenCalledOnce();
    expect(onYield).toHaveBeenCalledWith("Turn yielded.");
  });

  it("passes the custom message through the yield callback", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({ sessionId: "test-session", onYield });
    const result = await tool.execute("call-1", { message: "Waiting for fact-checker" });
    expect(result.details).toMatchObject({
      status: "yielded",
      message: "Waiting for fact-checker",
    });
    expect(onYield).toHaveBeenCalledOnce();
    expect(onYield).toHaveBeenCalledWith("Waiting for fact-checker");
  });

  it("returns error without onYield callback", async () => {
    const tool = createSessionsYieldTool({ sessionId: "test-session" });
    const result = await tool.execute("call-1", {});
    expect(result.details).toMatchObject({
      status: "error",
      error: "Yield not supported in this context",
    });
  });

  // 死锁守卫：本轮 spawn 全败 + 无活跃子代理时，guardDeadlockYield 返回拒绝文案 →
  // yield 必须被拒、且绝不调用 onYield（不触发 abort/park），把原因回传模型让它重试。
  it("拒绝挂起：guard 返回文案时返回 error 且不调用 onYield", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({
      sessionId: "test-session",
      onYield,
      guardDeadlockYield: () => "sessions_yield refused: would deadlock",
    });
    const result = await tool.execute("call-1", {});
    expect(result.details).toMatchObject({
      status: "error",
      error: "sessions_yield refused: would deadlock",
    });
    expect(onYield).not.toHaveBeenCalled();
  });

  // guard 返回 null（放行）时保持原行为：正常挂起。
  it("放行：guard 返回 null 时照常 yield", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({
      sessionId: "test-session",
      onYield,
      guardDeadlockYield: () => null,
    });
    const result = await tool.execute("call-1", {});
    expect(result.details).toMatchObject({ status: "yielded", message: "Turn yielded." });
    expect(onYield).toHaveBeenCalledOnce();
  });
});
