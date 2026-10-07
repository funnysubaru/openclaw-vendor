export function consumeLauncherRootOptionToken(args: string[], index: number): number;
export function isForegroundGmailRunInvocation(argv: string[]): boolean;
export function isNativeHookRelayInvocation(argv: string[]): boolean;
export function resolveRecoveryPath(
  value: string | null | undefined,
  homeDir?: string | null,
  options?: { allowMissing?: boolean; allowCwd?: boolean; trustedRoot?: string },
): string | null;
export function isUsableNode(
  nodePath: string,
  options?: { allowCwd?: boolean; trustedRoot?: string; env?: NodeJS.ProcessEnv },
): boolean;
export function runRespawnedChild(command: string, args: string[], env: NodeJS.ProcessEnv): true;
export const GATEWAY_CONTROL_FD_ENV: "OPENCLAW_CONTROL_FD";
export function parseGatewayControlFd(raw: string | undefined): number | undefined;
export function resolveLauncherRespawnStdio(
  env: NodeJS.ProcessEnv,
  fdIsOpen?: (fd: number) => boolean,
): { stdio: import("node:child_process").StdioOptions; env: NodeJS.ProcessEnv };
export function recoverNodeRuntime(options?: {
  homeDir?: string;
  allowInstall?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean>;
