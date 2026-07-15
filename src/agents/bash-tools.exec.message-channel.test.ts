import { afterEach, describe, expect, it } from "vitest";
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

// review Minor#2：光看"打印出来的值是不是空"分不清"key 真的不存在"和"key 存在但值是空
// 字符串"——两条 shell 语法专门只判存在性，不看值本身，且两平台都**显式**打印
// isset/unset token（review Minor#1：不再让 POSIX 侧靠"空输出→(no output)占位符"
// 这种间接判定，两条分支断言语义完全对称）：
// POSIX 用 `[ "${OPENCLAW_MESSAGE_CHANNEL+x}" = x ]`——key 存在时 `${VAR+x}` 展开成
// 字面量 "x"，与 "x" 相等即 isset；key 真的 unset 时 `${VAR+x}` 展开成空，不等于
// "x"，判 unset，两种情况都显式 printf 对应 token，不依赖"没输出"这种弱信号。
// PowerShell 用 Test-Path env:VAR 做等价判断，本就是显式输出，不必改。
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

  // review Important#1（安全问题，首轮漏判）：`...opts.env` 展开若带着继承/伪造的
  // OPENCLAW_MESSAGE_CHANNEL，而本 run 又拿不到真实 channel，旧写法"只在拿得到时
  // 才赋值"会让这个残留值原样透传进子进程——下游 ppt preview 硬闸会把它当真实
  // channel 读，面板会话可能被误判成 bot channel 从而绕过安全闸。这里覆盖两个
  // 污染来源：①父进程 process.env 继承 ②tool 调用自己的 params.env 显式携带。
  describe("污染回归测（review Important#1：拿不到 channel 时必须清掉继承/伪造的残留值）", () => {
    const originalProcessEnvChannel = process.env.OPENCLAW_MESSAGE_CHANNEL;

    afterEach(() => {
      // 每个用例结束都还原 process.env，避免污染同文件其它用例或后续测试文件。
      if (originalProcessEnvChannel === undefined) {
        delete process.env.OPENCLAW_MESSAGE_CHANNEL;
      } else {
        process.env.OPENCLAW_MESSAGE_CHANNEL = originalProcessEnvChannel;
      }
    });

    it("父进程 process.env 里预置了残留 channel、本 run 无 messageProvider → 子进程 env 里该 key 必须不存在", async () => {
      process.env.OPENCLAW_MESSAGE_CHANNEL = "line";

      const presence = await runExecTool({
        messageProvider: undefined,
        command: printChannelPresenceCmd,
      });

      // review Minor#1：两平台都断言显式的 "unset" token（不再靠 POSIX 侧"没输出→
      // (no output) 占位符"这种间接信号），断言语义完全对称——判的是"key 不存在"，
      // 不是"值是空字符串"（后者分辨不出"真的清掉了"还是"凑巧被覆盖成空串"）。
      expect(presence).toBe("unset");
    });

    it("tool 调用自己的 params.env 显式携带伪造 channel、本 run 无 messageProvider → 仍必须不存在", async () => {
      const presence = await runExecTool({
        messageProvider: undefined,
        command: printChannelPresenceCmd,
        env: { OPENCLAW_MESSAGE_CHANNEL: "line" },
      });

      expect(presence).toBe("unset");
    });

    it("即便父进程 process.env 有残留值，本 run 真有 channel 时 runtime 计算值仍会覆盖它（不是巧合地被清空）", async () => {
      process.env.OPENCLAW_MESSAGE_CHANNEL = "line";

      const value = await runExecTool({ messageProvider: "webchat", command: printChannelCmd });

      expect(value).toBe("webchat");
    });
  });
});
