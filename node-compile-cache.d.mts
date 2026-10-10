export function resolveOpenClawCompileCacheDirectory(params: {
  installRoot: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined;
export function resolveSafeNodeCompileCacheDirectory(directory: string): string | undefined;
export function isUnderOpenClawCompileCacheNamespace(
  activeDirectory: string | undefined,
  namespaceDirectory: string,
): boolean;
export function maintainOpenClawCompileCache(directory: string): Promise<void>;
