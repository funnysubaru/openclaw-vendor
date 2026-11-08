// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeConfigSnapshot from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { getPreparedModelCatalogOwnerSnapshot } from "./prepared-model-catalog.js";
import { publishPreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";

let state: OpenClawTestState;

describe("prepared model runtime publication fingerprints", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "prepared-model-runtime" });
    await resetPreparedModelRuntimeHarness(state);
  });

  // Yuiwork collab backport of upstream #171371 (COLLAB-PATCHES.md #3). Upstream spies on
  // stableConfigStringify in runtime-config-snapshot-match.ts; this base keeps it private to
  // runtime-snapshot.ts, so the fork test counts whole-config hashes instead.
  it("reuses publication fingerprints across fleet catalog reads without caching mutable projections", async () => {
    const hash = vi.spyOn(runtimeConfigSnapshot, "hashRuntimeConfigValue");
    try {
      for (const size of [8, 16]) {
        const config: OpenClawConfig = {
          agents: {
            entries: Object.fromEntries(
              Array.from({ length: size }, (_, index) => [`agent-${index}`, { name: "original" }]),
            ),
          },
        } as OpenClawConfig;
        runtimeConfigSnapshot.setRuntimeConfigSnapshot(config);
        const input = {
          agentDir: state.agentDir(`read-only-fleet-${size}`),
          config,
          agentId: "agent-0",
          readOnly: true,
        };
        const snapshot = await publishPreparedModelRuntimeSnapshot(input, {
          catalogMode: "static",
        });
        hash.mockClear();
        // Published canonical config: catalog reads reuse the publication fingerprint.
        for (let request = 0; request < 16; request++) {
          expect(getPreparedModelCatalogOwnerSnapshot(input)).toBe(snapshot);
        }
        expect(hash.mock.calls.filter(([value]) => value === config)).toHaveLength(0);

        // Caller-owned projections are still hashed, so an edited clone stops matching.
        const projected = structuredClone(config);
        expect(getPreparedModelCatalogOwnerSnapshot({ ...input, config: projected })).toBe(
          snapshot,
        );
        projected.agents!.entries!["agent-0"]!.name = "projected";
        expect(
          getPreparedModelCatalogOwnerSnapshot({ ...input, config: projected }),
        ).toBeUndefined();

        // Republishing refreshes the fingerprint: the old owner no longer matches.
        config.agents!.entries!["agent-0"]!.name = "republished";
        runtimeConfigSnapshot.setRuntimeConfigSnapshot(config);
        expect(getPreparedModelCatalogOwnerSnapshot(input)).toBeUndefined();
        const replacement = await publishPreparedModelRuntimeSnapshot(input, {
          catalogMode: "static",
        });
        expect(replacement).not.toBe(snapshot);
        expect(getPreparedModelCatalogOwnerSnapshot(input)).toBe(replacement);
      }
    } finally {
      runtimeConfigSnapshot.clearRuntimeConfigSnapshot();
      hash.mockRestore();
    }
  });
});

afterEach(async ({ task }) => {
  vi.restoreAllMocks();
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});
