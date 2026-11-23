import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageManager = process.argv[2];
const version = "12.15.0";
const wrapperHash =
  "b3951d6d6ff4a9f13dc7cf56cd28d2b8eb37dbcc9c68e52e1e1191873ea9f82a017287ab50baadc5ccc494f036c67c0e47eb13608c2fa36f47711b61ea128e61";
const nativeHashes = {
  x64: "c9cf9095947ef7e9ebdbd2787d1ce13286a98314c10e776affea5eca8ab55d4b9f9d01677db5d4305b9d0c82b31e2e78e658a71aa98e9977e7d0da2e7cd81c3a",
  arm64:
    "a8c2fff1a097b2587cb5dff0e14f8724da94719dbe9ba11f4db592708cd9466c8fb1114dfb10782cfd54fe1ca6c5cd6248988ab46e7a1c9c767ef504ad61481b",
};
const nativeHash = nativeHashes[process.arch];
const archiveRoot = "/opt/crabbox/toolchain-archives";

if (
  process.platform === "linux" &&
  nativeHash &&
  packageManager === `pnpm@${version}+sha512.${wrapperHash}`
) {
  const staging = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), "pnpm-image-"));
  let corepackHome;
  try {
    const archives = [
      [`pnpm-${version}.tgz`, wrapperHash],
      [`exe.linux-${process.arch}-${version}.tgz`, nativeHash],
    ];
    let valid = true;
    for (const [name, hash] of archives) {
      const destination = join(staging, name);
      try {
        // Hash the private bytes we will extract, not a mutable image marker.
        await copyFile(join(archiveRoot, name), destination);
      } catch (error) {
        if (["ENOENT", "EACCES", "EISDIR"].includes(error.code)) {
          valid = false;
          break;
        }
        throw error;
      }
      if (
        createHash("sha512")
          .update(await readFile(destination))
          .digest("hex") !== hash
      ) {
        valid = false;
        break;
      }
    }
    if (valid) {
      corepackHome = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), "openclaw-corepack-"));
      const pnpmRoot = join(corepackHome, "v1", "pnpm", version);
      const roots = [
        pnpmRoot,
        join(pnpmRoot, "node_modules", "@pnpm", `exe.linux-${process.arch}`),
      ];
      for (const [index, [name]] of archives.entries()) {
        await mkdir(roots[index], { recursive: true });
        const result = spawnSync(
          "tar",
          ["-xzf", join(staging, name), "-C", roots[index], "--strip-components=1"],
          { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
        );
        if (result.error || result.status !== 0) {
          throw new Error(`Cannot extract authenticated pnpm image archive: ${result.stderr}`, {
            cause: result.error,
          });
        }
      }
      // Corepack 0.35's v1 cache format; image-provided .corepack files are never read.
      await writeFile(
        join(pnpmRoot, ".corepack"),
        JSON.stringify({
          locator: { name: "pnpm", reference: packageManager.slice("pnpm@".length) },
          bin: { pnpm: "./bin/pnpm.mjs", pnpx: "./bin/pnpx.mjs" },
          hash: `sha512.${wrapperHash}`,
        }),
      );
      process.stdout.write(`${corepackHome}\n`);
      corepackHome = undefined;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (corepackHome) {
      await rm(corepackHome, { recursive: true, force: true });
    }
  }
}
