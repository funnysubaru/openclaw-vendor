// PR #132 selfreview3：OAuth 刷新栅栏只在真正要写某个 peer 员工库之前等它的准入。
// R1 / R2：不持有该凭据、根本不会被写的 peer，既不让刷新陪它等，也不因它准入失败而失败。
// R3：准入已失败、但确实持有该凭据的 peer 仍让刷新失败（fail-closed，避免它重启后拿旧
// refresh token 再刷一次触发重用检测），错误点名该员工并提示重启 gateway。
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  cancelAgentStartupAdmission,
  resetAgentStartupAdmissionForTest,
  scheduleAgentStartupAdmission,
  waitForAgentStartupAdmission,
} from "../../state/agent-startup-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveAgentDir } from "../agent-scope-config.js";
import { listCandidateAuthProfileStores } from "./candidate-stores.js";
import { createOAuthRefreshFence } from "./oauth-refresh-marker.js";
import { fenceOAuthRefreshPeers } from "./oauth-refresh-peers.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import { saveAuthProfileStore } from "./store-runtime.js";

afterEach(() => {
  resetAgentStartupAdmissionForTest();
  closeOpenClawAgentDatabasesForTest();
});

const profileId = "openai-codex:default";

async function setup(cfg: OpenClawConfig) {
  const original = {
    type: "oauth" as const,
    provider: "openai-codex",
    access: "expired-access",
    refresh: "refresh-token",
    expires: Date.now() - 60_000,
  };
  const mainDir = path.resolve(resolveAgentDir(cfg, "main"));
  const opsDir = path.resolve(resolveAgentDir(cfg, "ops"));
  // ops 的 auth 库存在，但只有一个无关的 api_key 凭据：它不是该 OAuth 凭据的 peer，永远不会被写。
  saveAuthProfileStore(
    {
      version: 1,
      profiles: { "anthropic:default": { type: "api_key", provider: "anthropic", key: "k" } },
    },
    opsDir,
  );
  saveAuthProfileStore({ version: 1, profiles: { [profileId]: original } }, mainDir);
  closeOpenClawAgentDatabasesForTest();
  return { original, mainDir, opsDir };
}

describe("PR #132 selfreview3：OAuth 栅栏对不需要写的 peer 也等准入", () => {
  it("R1 ops 准入失败（库本身完好，例如 handoff 失败）且 ops 不持有该凭据：main 的刷新栅栏应成功（0 claims）", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      const { original, mainDir } = await setup(cfg);
      const candidates = await listCandidateAuthProfileStores({ cfg });
      console.log("[R1] candidates:", candidates.map((c) => c.agentId).join(","));
      scheduleAgentStartupAdmission({
        agentIds: ["ops"],
        narrowRequestsToAgent: true,
        openAgent: async () => {},
        migrateAgent: async () => {
          throw new Error("ops handoff failed (simulated)");
        },
      });
      await waitForAgentStartupAdmission("ops")?.catch(() => {});
      try {
        const outcome = await fenceOAuthRefreshPeers({
          cfg,
          ownerDatabasePath: resolveAuthProfileDatabasePath(mainDir),
          profileId,
          generation: original,
          fence: createOAuthRefreshFence({ profileId, credential: original }),
          rollbackOnFailure: false,
        }).then(
          (claims) => `claims:${claims.length}`,
          (error: unknown) =>
            `rejected: ${String(error)} / cause: ${String((error as { cause?: unknown }).cause)}`,
        );
        console.log("[R1] outcome:", outcome);
        expect(outcome).toBe("claims:0");
      } finally {
        await cancelAgentStartupAdmission();
      }
    });
  });

  it("R2 ops 准入中且 ops 不持有该凭据：main 的刷新栅栏不应陪 ops 等", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      const { original, mainDir } = await setup(cfg);
      const gate = createDeferred<void>();
      scheduleAgentStartupAdmission({
        agentIds: ["ops"],
        narrowRequestsToAgent: true,
        openAgent: async () => await gate.promise,
        migrateAgent: async () => {},
      });
      try {
        let settled = "pending";
        const fence = fenceOAuthRefreshPeers({
          cfg,
          ownerDatabasePath: resolveAuthProfileDatabasePath(mainDir),
          profileId,
          generation: original,
          fence: createOAuthRefreshFence({ profileId, credential: original }),
          rollbackOnFailure: false,
        }).then(
          (claims) => {
            settled = `claims:${claims.length}`;
          },
          (error: unknown) => {
            settled = `rejected: ${String(error)}`;
          },
        );
        await new Promise((resolve) => {
          setTimeout(resolve, 300);
        });
        const atWindow = settled;
        console.log("[R2] after 300ms with ops pending:", atWindow);
        gate.resolve();
        await fence;
        console.log("[R2] after ops admitted:", settled);
        expect(atWindow).toBe("claims:0");
      } finally {
        gate.resolve();
        await cancelAgentStartupAdmission();
      }
    });
  });

  it("R3 ops 准入失败且持有同代际凭据：刷新 fail-closed，错误点名 ops 并提示重启", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      const original = {
        type: "oauth" as const,
        provider: "openai-codex",
        access: "expired-access",
        refresh: "refresh-token",
        expires: Date.now() - 60_000,
      };
      const mainDir = path.resolve(resolveAgentDir(cfg, "main"));
      const opsDir = path.resolve(resolveAgentDir(cfg, "ops"));
      // 先写 ops 再写 main：ops 留下一份同代际的历史副本（会被认领、需要写）。
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: original } }, opsDir);
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: original } }, mainDir);
      closeOpenClawAgentDatabasesForTest();
      scheduleAgentStartupAdmission({
        agentIds: ["ops"],
        narrowRequestsToAgent: true,
        openAgent: async () => {},
        migrateAgent: async () => {
          throw new Error("ops handoff failed (simulated)");
        },
      });
      await waitForAgentStartupAdmission("ops")?.catch(() => {});
      try {
        const error = await fenceOAuthRefreshPeers({
          cfg,
          ownerDatabasePath: resolveAuthProfileDatabasePath(mainDir),
          profileId,
          generation: original,
          fence: createOAuthRefreshFence({ profileId, credential: original }),
          rollbackOnFailure: false,
        }).then(
          () => undefined,
          (rejection: unknown) => rejection,
        );
        expect(error).toBeDefined();
        const message = String((error as { cause?: unknown }).cause ?? error);
        expect(message).toContain('agent "ops"');
        expect(message).toContain("Restart the gateway");
      } finally {
        await cancelAgentStartupAdmission();
      }
    });
  });
});
