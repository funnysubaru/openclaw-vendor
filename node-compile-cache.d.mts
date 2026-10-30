export function resolveOpenClawCompileCacheDirectory(params: {
  installRoot: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined;
export function resolveSafeNodeCompileCacheDirectory(directory: string): string | undefined;
export function isCurrentOpenClawCompileCache(
  currentDirectory: string | undefined,
  directory: string,
  env?: NodeJS.ProcessEnv,
): boolean;
export function isUnderOpenClawCompileCacheNamespace(
  activeDirectory: string | undefined,
  namespaceDirectory: string,
): boolean;
export function maintainOpenClawCompileCache(directory: string): Promise<void>;
