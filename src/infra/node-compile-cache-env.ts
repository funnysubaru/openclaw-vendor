import * as module from "node:module";
import path from "node:path";
import {
  isUnderOpenClawCompileCacheNamespace,
  maintainOpenClawCompileCache,
  resolveSafeNodeCompileCacheDirectory,
} from "../../node-compile-cache.mjs";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// The launcher publishes this same fact before importing built runtime chunks.
// Node's cache cannot be reset during this instance's lifetime; neither can its owner fact.
const COMPILE_CACHE_BASE_KEY = Symbol.for("openclaw.nodeCompileCacheBase");

function compileCacheOwner() {
  return resolveGlobalSingleton<{ baseDirectory?: string }>(COMPILE_CACHE_BASE_KEY, () => ({}));
}

/**
 * Enable through OpenClaw, retaining only the input to a successful first enable.
 *
 * Yuiclaw's gateway launcher sets `NODE_COMPILE_CACHE` on the child environment
 * *before* spawning, so Node auto-enables the cache from that inherited env var
 * at process bootstrap - before this call ever runs. `enableCompileCache()`
 * then reports `ALREADY_ENABLED`, not `ENABLED`, for the exact same directory
 * this module would have resolved on its own. Treating only `ENABLED` as
 * success (the upstream behavior as of this writing - no later upstream commit
 * addresses this) means owner registration and retention maintenance never run
 * on this path, which is the launcher's actual, everyday path in Yuiclaw - not
 * an edge case. Accept `ALREADY_ENABLED` too, but only once the directory
 * that's actually active is confirmed to live inside the OpenClaw namespace we
 * just resolved; a cache some unrelated code enabled under a different
 * directory must not be adopted as ours.
 */
export function enableOwnedNodeCompileCache(directory: string): void {
  const baseDirectory = path.resolve(directory);
  const result = module.enableCompileCache(directory);
  const statuses = module.constants?.compileCacheStatus;
  const accepted =
    statuses !== undefined &&
    (result?.status === statuses.ENABLED || result?.status === statuses.ALREADY_ENABLED);
  if (
    accepted &&
    isUnderOpenClawCompileCacheNamespace(module.getCompileCacheDir?.(), baseDirectory)
  ) {
    compileCacheOwner().baseDirectory ??= baseDirectory;
    void maintainOpenClawCompileCache(baseDirectory);
  }
}

export function resolveNodeCompileCacheEnv(env = process.env): NodeJS.ProcessEnv {
  if (env.NODE_DISABLE_COMPILE_CACHE !== undefined) {
    return env;
  }
  // Getter and ALREADY_ENABLED directories are Node-owned leaves, not child cache bases.
  const directory = env.NODE_COMPILE_CACHE ?? compileCacheOwner().baseDirectory;
  if (directory && !resolveSafeNodeCompileCacheDirectory(directory)) {
    const disabled: NodeJS.ProcessEnv = { ...env, NODE_DISABLE_COMPILE_CACHE: "1" };
    delete disabled.NODE_COMPILE_CACHE;
    return disabled;
  }
  if (env.NODE_COMPILE_CACHE !== undefined) {
    return env;
  }
  return directory ? { ...env, NODE_COMPILE_CACHE: directory } : env;
}
