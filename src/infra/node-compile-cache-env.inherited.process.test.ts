// Real-subprocess regression test (review on openclaw-vendor#137, 2026-10-10):
// enableOwnedNodeCompileCache() must register ownership and run retention
// maintenance even when Node already auto-enabled the compile cache from an
// inherited NODE_COMPILE_CACHE before this module's own enableCompileCache()
// call ran - that call then reports ALREADY_ENABLED, not ENABLED. This is
// Yuiclaw's gateway launcher's actual, everyday path (it sets
// NODE_COMPILE_CACHE on the child env before spawning), not an edge case.
// src/entry.compile-cache.test.ts mocks node:module and so cannot exercise
// this: the bug is in how Node itself reports status, which only a real
// child process observes.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  formatCliProcessFailure,
  runCliProcessChild,
} from "../cli/cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type DriverResult = {
  ownerBaseDirectory: string | null;
  inheritedEnv: NodeJS.ProcessEnv;
};

function inheritedEnvWithoutCompileCacheVars(directory: string): NodeJS.ProcessEnv {
  const env = { ...process.env, NODE_COMPILE_CACHE: directory };
  delete env.NODE_DISABLE_COMPILE_CACHE;
  return env;
}

async function writeOwnershipProbeDriver(
  root: string,
  options: { waitForRemovalOf?: string } = {},
): Promise<string> {
  const moduleUrl = pathToFileURL(path.resolve("src/infra/node-compile-cache-env.ts")).href;
  const entry = path.join(root, "driver.mjs");
  await fs.writeFile(
    entry,
    `import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { enableOwnedNodeCompileCache, resolveNodeCompileCacheEnv } from ${JSON.stringify(
      moduleUrl,
    )};
const directory = process.argv[2];
enableOwnedNodeCompileCache(directory);
const owner = globalThis[Symbol.for("openclaw.nodeCompileCacheBase")];
${
  options.waitForRemovalOf
    ? // maintainOpenClawCompileCache() unref()s its worker on purpose (it must
      // never keep a short-lived CLI command alive). Awaiting the internal
      // promise directly races the main thread exiting before the unref'd
      // worker is scheduled at all, so observe the real side effect instead:
      // poll, with a referenced sleep, for the stale sibling to actually be
      // gone (bounded, so a real regression fails fast rather than hanging).
      `const staleDirectory = ${JSON.stringify(options.waitForRemovalOf)};
const deadline = Date.now() + 5000;
while (Date.now() < deadline) {
  try {
    await readFile(staleDirectory + "/stale.bin");
  } catch {
    break;
  }
  await sleep(20);
}
`
    : ""
}
process.stdout.write(
  JSON.stringify({
    ownerBaseDirectory: owner?.baseDirectory ?? null,
    inheritedEnv: resolveNodeCompileCacheEnv({}),
  }),
);
`,
    "utf8",
  );
  return entry;
}

describe("node compile cache env (real subprocess, inherited NODE_COMPILE_CACHE)", () => {
  it("adopts an already-enabled cache inside its own namespace and retires a stale sibling", async () => {
    const root = tempDirs.make("openclaw-compile-cache-env-inherited-");
    const cacheBase = path.join(root, "cache");
    const directory = path.join(cacheBase, "openclaw", "2026.9.9", "deadbeefcafebabe");
    const staleDirectory = path.join(cacheBase, "openclaw", "2026.9.9", "0000000000000000");
    await fs.mkdir(staleDirectory, { recursive: true });
    await fs.writeFile(path.join(staleDirectory, "stale.bin"), "stale");

    const entry = await writeOwnershipProbeDriver(root, { waitForRemovalOf: staleDirectory });
    const result = await runCliProcessChild({
      nodeArgs: ["--import", path.resolve("scripts/tsx.mjs"), entry, directory],
      env: inheritedEnvWithoutCompileCacheVars(directory),
    });
    expect(
      result.code,
      formatCliProcessFailure({ reason: "driver process failed", ...result }),
    ).toBe(0);
    const parsed = JSON.parse(result.stdout) as DriverResult;
    // The bug this regresses: before the fix, this stayed null because
    // enableCompileCache() reported ALREADY_ENABLED (Node auto-enabled from
    // the inherited env var before the driver's own call ran), and only
    // ENABLED was accepted.
    expect(parsed.ownerBaseDirectory).toBe(directory);
    expect(parsed.inheritedEnv.NODE_COMPILE_CACHE).toBe(directory);
    // Maintenance only runs once ownership is registered - this is the
    // user-visible symptom the reviewer reproduced: "owner=null,旧目录和过期
    // 文件都还在".
    await expect(fs.stat(staleDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not adopt a cache that is active under an unrelated directory", async () => {
    const root = tempDirs.make("openclaw-compile-cache-env-unrelated-");
    const unrelatedBase = path.join(root, "unrelated-cache");
    const directory = path.join(root, "cache", "openclaw", "2026.9.9", "deadbeefcafebabe");

    const entry = await writeOwnershipProbeDriver(root);
    const result = await runCliProcessChild({
      nodeArgs: ["--import", path.resolve("scripts/tsx.mjs"), entry, directory],
      env: inheritedEnvWithoutCompileCacheVars(unrelatedBase),
    });
    expect(
      result.code,
      formatCliProcessFailure({ reason: "driver process failed", ...result }),
    ).toBe(0);
    const parsed = JSON.parse(result.stdout) as DriverResult;
    // Node auto-enabled under `unrelatedBase`, not under our resolved
    // `directory` - accepting ALREADY_ENABLED must not let this register
    // ownership (and later retention maintenance) over a namespace that was
    // never actually active.
    expect(parsed.ownerBaseDirectory).toBeNull();
    expect(parsed.inheritedEnv.NODE_COMPILE_CACHE).toBeUndefined();
  });
});
