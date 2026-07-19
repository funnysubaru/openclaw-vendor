import { afterEach, describe, expect, it } from "vitest";
import { createExecTool } from "./bash-tools.exec.js";
import { sanitizeBinaryOutput } from "./shell-utils.js";

// Yuiclaw 端到端测试：验证 createExecTool({ sessionKey }) 会把该 run 的 sessionKey 真的
// 注入实际 spawn 出来的子进程 env（OPENCLAW_SESSION_KEY），而不是只测到 runExecProcess
// 内部某个中间变量——跟既有的 bash-tools.exec.message-channel.test.ts（同一处
// shellRuntimeEnv、同一套 delete-then-set 范式）走同一套端到端验证风格。
//
// 业务背景：Yuiclaw 的 ppt-master 确认页"事件驱动唤醒"需要子进程（本地 daemon）
// 读到 OPENCLAW_SESSION_KEY 才能确定性地回调"叫醒哪个会话"；读不到就整组唤醒参数
// 不下发，退回纯轮询。详见 bash-tools.exec-runtime.ts 里对应改动处的中文注释。
const isWin = process.platform === "win32";
const printSessionKeyCmd = isWin
  ? "Write-Output $env:OPENCLAW_SESSION_KEY"
  : 'printf "%s" "${OPENCLAW_SESSION_KEY:-}"';

// 只判"key 是否存在"，不看值本身——空字符串与"key 不存在"在消费侧语义不同
// （消费侧用 `${VAR+x}` 之类的存在性判断，空串会被误判成"有值"），必须分开断言。
const printSessionKeyPresenceCmd = isWin
  ? 'if (Test-Path env:OPENCLAW_SESSION_KEY) { Write-Output "isset" } else { Write-Output "unset" }'
  : 'if [ "${OPENCLAW_SESSION_KEY+x}" = x ]; then printf isset; else printf unset; fi';

const normalizeText = (value?: string) =>
  sanitizeBinaryOutput(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

async function runExecTool(params: {
  sessionKey?: string;
  command: string;
  env?: Record<string, string>;
}): Promise<string> {
  const tool = createExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    sessionKey: params.sessionKey,
  });
  const result = await tool.execute("call-session-key", {
    command: params.command,
    env: params.env,
  });
  return normalizeText(result.content.find((c) => c.type === "text")?.text);
}

describe("exec OPENCLAW_SESSION_KEY 注入", () => {
  it("有 sessionKey 时子进程 env 里能读到该值", async () => {
    const value = await runExecTool({
      sessionKey: "agent:ppt-master:main",
      command: printSessionKeyCmd,
    });
    expect(value).toBe("agent:ppt-master:main");
  });

  it("sessionKey 带首尾空白会先 trim 再注入", async () => {
    const value = await runExecTool({
      sessionKey: "  agent:ppt-master:main  ",
      command: printSessionKeyCmd,
    });
    expect(value).toBe("agent:ppt-master:main");
  });

  it("拿不到 sessionKey 时该 key 在子进程 env 里彻底不存在（不是空串）", async () => {
    const presence = await runExecTool({
      sessionKey: undefined,
      command: printSessionKeyPresenceCmd,
    });
    expect(presence).toBe("unset");
  });

  it("sessionKey 为纯空白时按无效处理，该 key 不存在", async () => {
    const presence = await runExecTool({
      sessionKey: "   ",
      command: printSessionKeyPresenceCmd,
    });
    expect(presence).toBe("unset");
  });

  // delete-then-set 边界回归测：`...opts.env` 展开若带着父进程继承残留、或 tool
  // 调用自己 params.env 显式伪造的同名 key，而本 run 又拿不到真实 sessionKey——
  // 必须无条件清掉，不能让残留/伪造值原样透传进子进程（否则 daemon 可能把系统消息
  // 误唤醒进错误会话）。覆盖两个污染来源：①父进程 process.env 继承 ②tool 调用
  // 自己的 params.env 显式携带。
  describe("污染回归测（拿不到 sessionKey 时必须清掉继承/伪造的残留值）", () => {
    const originalProcessEnvSessionKey = process.env.OPENCLAW_SESSION_KEY;

    afterEach(() => {
      // 每个用例结束都还原 process.env，避免污染同文件其它用例或后续测试文件。
      if (originalProcessEnvSessionKey === undefined) {
        delete process.env.OPENCLAW_SESSION_KEY;
      } else {
        process.env.OPENCLAW_SESSION_KEY = originalProcessEnvSessionKey;
      }
    });

    it("父进程 process.env 里预置了残留 sessionKey、本 run 无 sessionKey → 子进程 env 里该 key 必须不存在", async () => {
      process.env.OPENCLAW_SESSION_KEY = "agent:stale:leftover";

      const presence = await runExecTool({
        sessionKey: undefined,
        command: printSessionKeyPresenceCmd,
      });

      expect(presence).toBe("unset");
    });

    it("tool 调用自己的 params.env 显式携带伪造 sessionKey、本 run 无 sessionKey → 仍必须不存在", async () => {
      const presence = await runExecTool({
        sessionKey: undefined,
        command: printSessionKeyPresenceCmd,
        env: { OPENCLAW_SESSION_KEY: "agent:forged:by-tool-call" },
      });

      expect(presence).toBe("unset");
    });

    it("即便父进程 process.env 有残留值，本 run 真有 sessionKey 时 runtime 计算值仍会覆盖它（不是巧合地被清空）", async () => {
      process.env.OPENCLAW_SESSION_KEY = "agent:stale:leftover";

      const value = await runExecTool({
        sessionKey: "agent:ppt-master:main",
        command: printSessionKeyCmd,
      });

      expect(value).toBe("agent:ppt-master:main");
    });
  });
});
