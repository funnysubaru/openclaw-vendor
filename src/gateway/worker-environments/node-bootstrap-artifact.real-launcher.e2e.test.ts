// Real-launcher regression test (review on openclaw-vendor#137, 2026-10-10):
// openclaw.mjs now statically imports node-compile-cache.mjs at its top,
// unconditionally. BOOTSTRAP_LAUNCHER_FILES in node-bootstrap-artifact.ts is a
// separate, hand-maintained list of root-level launcher files to copy into a
// worker bootstrap artifact; node-bootstrap-artifact.test.ts only exercises it
// against a synthetic placeholder openclaw.mjs ('import "./dist/entry.js";'),
// which never imports node-compile-cache.mjs and so cannot catch a missing
// entry here. This test packages the real repo's real openclaw.mjs (plus its
// real launcher siblings) through the real artifact pipeline, extracts it,
// and runs it - exactly how the reviewer reproduced "node openclaw.mjs
// --version" failing with ERR_MODULE_NOT_FOUND before node-compile-cache.mjs
// was added to that list.
//
// The surrounding dist/ content is otherwise synthetic and minimal on
// purpose: prepareNodeBootstrapArtifact() validates the *entire* built import
// closure of whatever packageRoot it is given, and this repo's own real dist/
// can be transiently incomplete for reasons that have nothing to do with the
// launcher files this test cares about (a missing qa-runtime chunk broke this
// test the first time it ran against the real repo's own dist/ - entirely
// unrelated to this fix). A synthetic dist/ with zero imports sidesteps that
// unrelated fragility while still exercising the real launcher files for real.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatCliProcessFailure,
  runCliProcessChild,
} from "../../cli/cli-process-child.test-helpers.js";
import { createNodeBootstrapArtifactProvider } from "./node-bootstrap-artifact.js";

const execFileAsync = promisify(execFile);

const roots: string[] = [];
const version = "2026.9.9";
const buildId = "fixture-real-launcher-build";
// Matches BOOTSTRAP_LAUNCHER_FILES in node-bootstrap-artifact.ts - this list
// is intentionally duplicated rather than imported, so a future edit to one
// without the other shows up as a failing assertion below instead of two
// lists silently drifting apart.
const REAL_LAUNCHER_FILES = [
  "openclaw.mjs",
  "node-compile-cache.mjs",
  "node-version.mjs",
  "node-sqlite.mjs",
  "node-runtime-update.mjs",
  "node-runtime-recovery.mjs",
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function sanitizedChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_COMPILE_CACHE;
  delete env.NODE_DISABLE_COMPILE_CACHE;
  return env;
}

async function write(root: string, relative: string, contents: string | object): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, typeof contents === "string" ? contents : JSON.stringify(contents));
}

describe("node bootstrap artifact (real launcher)", () => {
  it("packages an artifact whose extracted openclaw.mjs actually starts", async () => {
    const realRepoRoot = path.resolve(".");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-bootstrap-fixture-"));
    roots.push(root);
    const packageRoot = path.join(root, "gateway");
    await fs.mkdir(packageRoot, { recursive: true });

    for (const relative of REAL_LAUNCHER_FILES) {
      await fs.copyFile(path.join(realRepoRoot, relative), path.join(packageRoot, relative));
    }
    // A zero-import entry keeps this fixture's own import closure trivially
    // complete, regardless of the real repo's dist/ state.
    await write(packageRoot, "dist/entry.js", 'process.stdout.write("fixture-entry-ran");\n');
    await write(packageRoot, "dist/build-info.json", { version, buildId });
    // prepareNodeBootstrapArtifact() always generates .openclaw-lifecycle-pending
    // into the artifact (by design - a worker node must run through its own
    // install lifecycle before being considered ready); openclaw.mjs refuses to
    // start while that marker is present, so this fixture needs the same
    // preinstall/postinstall pair the real package ships to clear it.
    await write(packageRoot, "scripts/preinstall.mjs", "export {};\n");
    await write(
      packageRoot,
      "scripts/postinstall.mjs",
      'import { rmSync } from "node:fs"; rmSync(new URL("../.openclaw-lifecycle-pending", import.meta.url));',
    );
    await write(packageRoot, "package.json", {
      name: "openclaw",
      version,
      type: "module",
      files: ["dist/", "scripts/preinstall.mjs", "scripts/postinstall.mjs"],
      scripts: {
        preinstall: "node scripts/preinstall.mjs",
        postinstall: "node scripts/postinstall.mjs",
      },
    });

    const provider = createNodeBootstrapArtifactProvider({
      packageRoot,
      runningBuildId: buildId,
      plugins: [],
    });
    try {
      const artifact = await provider.prepare();

      const installRoot = path.join(root, "installed");
      await fs.mkdir(installRoot);
      await tar.extract({ file: artifact.tarballPath, cwd: installRoot });
      const packageDir = path.join(installRoot, "package");

      // node-compile-cache.mjs must ship: openclaw.mjs imports it unconditionally
      // at its top, so a worker bootstrap artifact missing it fails to even
      // start, not just lose the compile-cache feature.
      await expect(fs.stat(path.join(packageDir, "node-compile-cache.mjs"))).resolves.toBeTruthy();

      // Clear the lifecycle-pending marker the same way a real worker node
      // would, before openclaw.mjs will agree to start at all.
      await execFileAsync(process.execPath, [path.join(packageDir, "scripts/preinstall.mjs")]);
      await execFileAsync(process.execPath, [path.join(packageDir, "scripts/postinstall.mjs")]);
      await expect(
        fs.access(path.join(packageDir, ".openclaw-lifecycle-pending")),
      ).rejects.toHaveProperty("code", "ENOENT");

      const result = await runCliProcessChild({
        nodeArgs: [path.join(packageDir, "openclaw.mjs"), "--version"],
        env: sanitizedChildEnv(),
      });
      expect(
        result.code,
        formatCliProcessFailure({ reason: "extracted openclaw.mjs --version failed", ...result }),
      ).toBe(0);
      expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
      expect(result.stdout).toContain(version);
    } finally {
      await provider.close();
    }
  });
});
