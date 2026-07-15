import { describe, expect, it } from "vitest";
import { createExecTool } from "./bash-tools.exec.js";
import { sanitizeBinaryOutput } from "./shell-utils.js";

// Yuiclaw PR-B（R3/组件5）端到端测试：验证 createExecTool({ messageProvider }) 会把
// 归一化后的渠道值真的注入到实际 spawn 出来的子进程 env（OPENCLAW_MESSAGE_CHANNEL），
// 而不是只测到 runExecProcess 内部某个中间变量——走真实 exec，跟既有的
// bash-tools.exec.path.test.ts（"sets OPENCLAW_SHELL for host=gateway commands"）同一套
// 端到端验证风格，跨平台各走各的 shell 命令（照 bash-tools.test.ts 的 isWin 三元式先例）。
const isWin = process.platform === "win32";
const printChannelCmd = isWin
  ? "Write-Output $env:OPENCLAW_MESSAGE_CHANNEL"
  : 'printf "%s" "${OPENCLAW_MESSAGE_CHANNEL:-}"';

const normalizeText = (value?: string) =>
  sanitizeBinaryOutput(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

async function runAndCaptureChannel(messageProvider?: string): Promise<string> {
  const tool = createExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    messageProvider,
  });
  const result = await tool.execute("call-message-channel", { command: printChannelCmd });
  return normalizeText(result.content.find((c) => c.type === "text")?.text);
}

describe("exec OPENCLAW_MESSAGE_CHANNEL 注入（R3/组件5）", () => {
  it("面板(webchat) run 的子进程 env 里能读到 OPENCLAW_MESSAGE_CHANNEL=webchat", async () => {
    const value = await runAndCaptureChannel("webchat");
    expect(value).toBe("webchat");
  });

  it("bot channel(line) run 的子进程 env 里能读到归一化后的 channel", async () => {
    const value = await runAndCaptureChannel("line");
    expect(value).toBe("line");
  });

  it("原始 channel 带大小写/空白也会先归一化再注入（复用 normalizeMessageChannel，不新造语义）", async () => {
    const value = await runAndCaptureChannel("  WebChat  ");
    expect(value).toBe("webchat");
  });

  it("拿不到 messageProvider 时不注入该变量（下游按默认拦处理，R3.5）", async () => {
    const value = await runAndCaptureChannel(undefined);
    // 变量未注入 → 命令读到空值 → stdout 为空 → exec 工具把空输出包成占位符文案
    // "(no output)"（bash-tools.exec.ts 既有行为，与本改动无关，不是 ""）。
    expect(value).toBe("(no output)");
  });

  // B1.2 核心断言：方案 B（穿透 params.env 按 run 隔离）而非方案 A（改全局 process.env）。
  // 两个 createExecTool 各自绑定不同 channel、并发各跑一次 exec，各自子进程读到的
  // OPENCLAW_MESSAGE_CHANNEL 必须只对应各自创建时绑定的值，不能被对方污染——
  // 这正是防止"面板 run 读到 bot run 的 channel 从而绕过安全闸"的关键证明。
  it("两个 run 并发使用不同 channel 时互不污染（方案 B 隔离性核心断言）", async () => {
    const [panelValue, botValue] = await Promise.all([
      runAndCaptureChannel("webchat"),
      runAndCaptureChannel("line"),
    ]);

    expect(panelValue).toBe("webchat");
    expect(botValue).toBe("line");
  });

  // 反过来再跑一轮、顺序调换，进一步排除"恰好没撞上竞态窗口"的偶然通过。
  it("并发隔离在多组不同 channel 组合下依然成立", async () => {
    const results = await Promise.all([
      runAndCaptureChannel("telegram"),
      runAndCaptureChannel("webchat"),
      runAndCaptureChannel("mobile-chat"),
    ]);

    expect(results).toEqual(["telegram", "webchat", "mobile-chat"]);
  });
});
