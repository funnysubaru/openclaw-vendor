// ADR-0033 任务84(c) selfreview2 P2：一轮对话里写别的员工的 auth 库（继承来的 owner 凭据、
// OAuth 刷新时写 owner / 共享库）时，目标库若还在后台启动准入，异步写入入口先透明等它完成，
// 而不是进同步写事务撞上"准入中"兜底、让这一轮失败。
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  cancelAgentStartupAdmission,
  resetAgentStartupAdmissionForTest,
  scheduleAgentStartupAdmission,
} from "../../state/agent-startup-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveAgentDir } from "../agent-scope-config.js";
import { updateAuthProfileStoreWithLock } from "./store-runtime.js";

afterEach(() => {
  resetAgentStartupAdmissionForTest();
  closeOpenClawAgentDatabasesForTest();
});

describe("auth profile writes wait for the target database's startup admission", () => {
  it("写别的员工 auth 库：该库准入中先等待，准入完成后写入成功", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      const opsAgentDir = path.resolve(resolveAgentDir(cfg, "ops"));
      const gate = createDeferred<void>();
      scheduleAgentStartupAdmission({
        agentIds: ["ops"],
        openAgent: async () => await gate.promise,
        migrateAgent: async () => {},
      });
      try {
        let settled = false;
        const write = updateAuthProfileStoreWithLock({
          agentDir: opsAgentDir,
          updater: (store) => {
            store.profiles["openai:default"] = {
              type: "api_key",
              provider: "openai",
              key: "sk-test-admission",
            };
            return true;
          },
        }).then((value) => {
          settled = true;
          return value;
        });
        await new Promise((resolve) => {
          setTimeout(resolve, 200);
        });
        expect(settled).toBe(false);

        gate.resolve();
        const written = await write;
        expect(written?.profiles["openai:default"]).toBeDefined();
      } finally {
        gate.resolve();
        await cancelAgentStartupAdmission();
      }
    });
  });
});
