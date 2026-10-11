import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  recordRemoteNodeBins,
  recordRemoteNodeInfo,
  removeRemoteNodeInfo,
} from "../runtime/remote.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import {
  expandExplicitSkillReferences,
  listSkillCommandsForWorkspace,
  prepareSkillCommandsForAgents,
} from "./chat-commands.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));
afterEach(() => {
  vi.restoreAllMocks();
});

describe("skill command discovery through workspace loading", () => {
  it.each(["workspace", "workshop"] as const)(
    "reports allowlist-hidden %s skills without loading another agent's skills",
    async (source) => {
      const root = tempDirs.make("openclaw-skill-command-discovery-");
      const workspaceDir = path.join(root, "workspace");
      const config = {
        plugins: { enabled: false },
        agents: {
          entries: {
            alpha: {
              agentDir: path.join(root, "alpha"),
              workspace: workspaceDir,
              skills: ["allowed"],
            },
            beta: { agentDir: path.join(root, "beta"), workspace: workspaceDir },
          },
        },
        skills: { allowBundled: [], entries: { disabled: { enabled: false } } },
      } satisfies OpenClawConfig;
      const skillRoot =
        source === "workshop"
          ? resolveWorkshopSkillsDir(config, "alpha")
          : path.join(workspaceDir, "skills");
      await writeSkill({
        dir: path.join(workspaceDir, "skills", "allowed"),
        name: "allowed",
        description: "Allowed procedure",
      });
      for (const name of ["hidden", "disabled"]) {
        await writeSkill({
          dir: path.join(skillRoot, name),
          name,
          description: `${name} procedure`,
        });
      }
      await writeSkill({
        dir: path.join(resolveWorkshopSkillsDir(config, "beta"), "beta-only"),
        name: "beta-only",
        description: "Beta's private procedure",
      });
      const bundledSkillsDir = path.join(root, "bundled");
      await fs.mkdir(bundledSkillsDir);
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: root, OPENCLAW_BUNDLED_SKILLS_DIR: bundledSkillsDir },
        async () => {
          const params = { workspaceDir, cfg: config, agentId: "alpha" };
          const skillCommands = listSkillCommandsForWorkspace(params);
          const allSkillCommands = listSkillCommandsForWorkspace({
            ...params,
            includeAllowlistHidden: true,
          });
          expect(skillCommands.map((command) => command.skillName)).toEqual(["allowed"]);
          expect(await prepareSkillCommandsForAgents({ cfg: config, agentIds: ["alpha"] })).toEqual(
            skillCommands,
          );
          expect(allSkillCommands.map((command) => command.skillName)).toEqual([
            "allowed",
            "hidden",
          ]);
          for (const text of [
            "Use $hidden for this task.",
            "/hidden run it",
            "/skill hidden run it",
          ]) {
            expect(
              expandExplicitSkillReferences({ text, skillCommands, allSkillCommands }),
            ).toEqual({
              body: text,
              error:
                'Skill "hidden" is not available for this agent. Update the skill allowlist or choose an allowed skill.',
              skills: [],
            });
          }
          expect(
            listSkillCommandsForWorkspace({ ...params, skillFilter: ["hidden"] }).map(
              (command) => command.skillName,
            ),
          ).toEqual(["hidden"]);
        },
      );
    },
  );

  it("rebuilds remote eligibility when a remote node disconnects during async preparation", async () => {
    const root = tempDirs.make("openclaw-skill-command-remote-");
    const workspaceDir = path.join(root, "workspace");
    const config = {
      plugins: { enabled: false },
      agents: {
        entries: { alpha: { agentDir: path.join(root, "alpha"), workspace: workspaceDir } },
      },
      skills: { allowBundled: [] },
    } satisfies OpenClawConfig;
    const bin = `remote-only-tool-${randomUUID()}`;
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "remote-only"),
      name: "remote-only",
      description: "Needs a bin only the remote node has",
      metadata: JSON.stringify({ openclaw: { requires: { bins: [bin] } } }),
    });
    const bundledSkillsDir = path.join(root, "bundled");
    await fs.mkdir(bundledSkillsDir);
    const nodeId = `node-${randomUUID()}`;
    recordRemoteNodeInfo({
      nodeId,
      displayName: "Remote Mac",
      platform: "darwin",
      commands: ["system.run"],
    });
    recordRemoteNodeBins(nodeId, [bin], "fixture-generation");
    // Hold the first local probe for the remote-only bin so the node can leave mid-preparation.
    const entered = createDeferred();
    const release = createDeferred();
    const actualAccess = fs.access;
    let held = false;
    vi.spyOn(fs, "access").mockImplementation(async (...args) => {
      if (!held && path.basename(String(args[0])).startsWith(bin)) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return actualAccess(...args);
    });
    try {
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: root, OPENCLAW_BUNDLED_SKILLS_DIR: bundledSkillsDir },
        async () => {
          const params = { workspaceDir, cfg: config, agentId: "alpha" };
          expect(listSkillCommandsForWorkspace(params).map((c) => c.skillName)).toEqual([
            "remote-only",
          ]);
          const pending = prepareSkillCommandsForAgents({ cfg: config, agentIds: ["alpha"] });
          try {
            await entered.promise;
            // Real disconnect path: drops the node and bumps the skills snapshot version.
            removeRemoteNodeInfo(nodeId);
          } finally {
            release.resolve();
          }
          expect((await pending).map((c) => c.skillName)).toEqual([]);
          expect(listSkillCommandsForWorkspace(params)).toEqual([]);
        },
      );
    } finally {
      removeRemoteNodeInfo(nodeId);
    }
  });
});
