import { describe, expect, it } from "vitest";
import { createExecTool } from "./bash-tools.exec-run.js";
import { sanitizeBinaryOutput } from "./shell-utils.js";

// Yuiclaw fork（回搬自 openclaw-vendor #101，族 M-③）端到端测试：验证
// createExecTool({ messageProvider }) 会把归一化后的渠道值真的注入到实际 spawn
// 出来的子进程 env（OPENCLAW_MESSAGE_CHANNEL），而不是只测到 runExecProcess
// 内部某个中间变量——走真实 exec，跟既有的 bash-tools.exec.path.test.ts
// （"sets OPENCLAW_SHELL for host=gateway commands"）同一套端到端验证风格，
// 跨平台各走各的 shell 命令。
const isWin = process.platform === "win32";
const printChannelCmd = isWin
  ? "Write-Output $env:OPENCLAW_MESSAGE_CHANNEL"
  : 'printf "%s" "${OPENCLAW_MESSAGE_CHANNEL:-}"';

// 光看"打印出来的值是不是空"分不清"key 真的不存在"和"key 存在但值是空字符串"——
// 两条 shell 语法专门只判存在性，不看值本身，两平台都显式打印 isset/unset token。
// POSIX 用 `[ "${OPENCLAW_MESSAGE_CHANNEL+x}" = x ]`——key 存在时 `${VAR+x}` 展开成
// 字面量 "x"，与 "x" 相等即 isset；key 真的 unset 时展开成空，判 unset。
// PowerShell 用 Test-Path env:VAR 做等价判断。
const printChannelPresenceCmd = isWin
  ? 'if (Test-Path env:OPENCLAW_MESSAGE_CHANNEL) { Write-Output "isset" } else { Write-Output "unset" }'
  : 'if [ "${OPENCLAW_MESSAGE_CHANNEL+x}" = x ]; then printf isset; else printf unset; fi';

const normalizeText = (value?: string) =>
  sanitizeBinaryOutput(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

async function runExecTool(params: {
  messageProvider?: string;
  command: string;
  env?: Record<string, string>;
}): Promise<string> {
  const tool = createExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    messageProvider: params.messageProvider,
  });
  const result = await tool.execute("call-message-channel", {
    command: params.command,
    env: params.env,
  });
  return normalizeText(result.content.find((c) => c.type === "text")?.text);
}

async function runAndCaptureChannel(messageProvider?: string): Promise<string> {
  return runExecTool({ messageProvider, command: printChannelCmd });
}

describe("exec OPENCLAW_MESSAGE_CHANNEL 注入（族 M-③）", () => {
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

  it("拿不到 messageProvider 时不注入该变量（下游按默认拦处理）", async () => {
    const value = await runExecTool({
      messageProvider: undefined,
      command: printChannelPresenceCmd,
    });
    expect(value).toBe("unset");
  });

  // 核心断言：方案 B（穿透 params.env 按 run 隔离）而非方案 A（改全局 process.env）。
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

  // 污染回归测：父进程 process.env 继承残留的 OPENCLAW_MESSAGE_CHANNEL 必须被本次
  // run 的 delete-then-set 清掉，不能原样透传进子进程（下游安全闸绕过风险）。
  it("本次 run 拿不到 channel 时清掉继承自 process.env 的残留值", async () => {
    const previous = process.env.OPENCLAW_MESSAGE_CHANNEL;
    process.env.OPENCLAW_MESSAGE_CHANNEL = "line";
    try {
      const value = await runExecTool({
        messageProvider: undefined,
        command: printChannelPresenceCmd,
      });
      expect(value).toBe("unset");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_MESSAGE_CHANNEL;
      } else {
        process.env.OPENCLAW_MESSAGE_CHANNEL = previous;
      }
    }
  });

  // 污染回归测：tool 调用方在 params.env 里显式携带同名 key（伪造）也必须被清掉，
  // 本次 run 真有 channel 时用运行时算出的值覆盖，而不是采信调用方带来的值。
  it("本次 run 真有 channel 时覆盖 tool params.env 里携带的同名残留值", async () => {
    const value = await runExecTool({
      messageProvider: "webchat",
      command: printChannelCmd,
      env: { OPENCLAW_MESSAGE_CHANNEL: "line" },
    });
    expect(value).toBe("webchat");
  });
});
