import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import { killProcessTree } from "../../kill-tree.js";
import { spawnWithFallback } from "../../spawn-utils.js";
import { resolveWindowsCommandShim } from "../../windows-command.js";
import { createWindowsStreamDecoder } from "../../windows-encoding.js";
import type { ManagedRunStdin, SpawnProcessAdapter } from "../types.js";
import { toStringEnv } from "./env.js";

function resolveCommand(command: string): string {
  return resolveWindowsCommandShim({
    command,
    cmdCommands: ["npm", "pnpm", "yarn", "npx"],
  });
}

export type ChildAdapter = SpawnProcessAdapter<NodeJS.Signals | null>;

function isServiceManagedRuntime(): boolean {
  return Boolean(process.env.OPENCLAW_SERVICE_MARKER?.trim());
}

export async function createChildAdapter(params: {
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  input?: string;
  stdinMode?: "inherit" | "pipe-open" | "pipe-closed";
}): Promise<ChildAdapter> {
  const resolvedArgv = [...params.argv];
  resolvedArgv[0] = resolveCommand(resolvedArgv[0] ?? "");

  const stdinMode = params.stdinMode ?? (params.input !== undefined ? "pipe-closed" : "inherit");

  // In service-managed mode keep children attached so systemd/launchd can
  // stop the full process tree reliably. Outside service mode preserve the
  // existing POSIX detached behavior.
  const useDetached = process.platform !== "win32" && !isServiceManagedRuntime();

  const options: SpawnOptions = {
    cwd: params.cwd,
    env: params.env ? toStringEnv(params.env) : undefined,
    stdio: ["pipe", "pipe", "pipe"],
    detached: useDetached,
    windowsHide: true,
    windowsVerbatimArguments: params.windowsVerbatimArguments,
  };
  if (stdinMode === "inherit") {
    options.stdio = ["inherit", "pipe", "pipe"];
  } else {
    options.stdio = ["pipe", "pipe", "pipe"];
  }

  const spawned = await spawnWithFallback({
    argv: resolvedArgv,
    options,
    fallbacks: useDetached
      ? [
          {
            label: "no-detach",
            options: { detached: false },
          },
        ]
      : [],
  });

  const child = spawned.child as ChildProcessWithoutNullStreams;
  if (child.stdin) {
    if (params.input !== undefined) {
      child.stdin.write(params.input);
      child.stdin.end();
    } else if (stdinMode === "pipe-closed") {
      child.stdin.end();
    }
  }

  const stdin: ManagedRunStdin | undefined = child.stdin
    ? {
        destroyed: false,
        write: (data: string, cb?: (err?: Error | null) => void) => {
          try {
            child.stdin.write(data, cb);
          } catch (err) {
            cb?.(err as Error);
          }
        },
        end: () => {
          try {
            child.stdin.end();
          } catch {
            // ignore close errors
          }
        },
        destroy: () => {
          try {
            child.stdin.destroy();
          } catch {
            // ignore destroy errors
          }
        },
      }
    : undefined;

  // Yuiclaw PR-B（R4/组件6）：Windows 上把子进程输出按探测到的控制台代码页
  // （中文机常见 GBK/cp936）正确解码，而不是硬当 UTF-8——PS 5.1 默认输出就是
  // 控制台代码页字节，不是 UTF-8，硬 toString() 在中文/日文/韩文 Windows 上会乱码。
  // stdout / stderr 各建一个独立的流式解码器实例（不能共用，见 createWindowsStreamDecoder
  // 注释）：每个实例内部持有跨 chunk 复用的 TextDecoder 状态，正确处理多字节字符
  // （GBK 2 字节等）恰好跨在两个 chunk 边界之间的情况，不会把半个字符解出乱码。
  // 非 win32：createWindowsStreamDecoder 内部直接走 chunk.toString("utf8")，
  // 与改动前完全等价，无副作用（R4.4）。
  const decodeStdoutChunk = createWindowsStreamDecoder();
  const decodeStderrChunk = createWindowsStreamDecoder();

  const onStdout = (listener: (chunk: string) => void) => {
    child.stdout.on("data", (chunk) => {
      listener(decodeStdoutChunk(chunk));
    });
  };

  const onStderr = (listener: (chunk: string) => void) => {
    child.stderr.on("data", (chunk) => {
      listener(decodeStderrChunk(chunk));
    });
  };

  const wait = async () =>
    await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve({ code, signal });
      });
    });

  const kill = (signal?: NodeJS.Signals) => {
    const pid = child.pid ?? undefined;
    if (signal === undefined || signal === "SIGKILL") {
      if (pid) {
        killProcessTree(pid);
      } else {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore kill errors
        }
      }
      return;
    }
    try {
      child.kill(signal);
    } catch {
      // ignore kill errors for non-kill signals
    }
  };

  const dispose = () => {
    child.removeAllListeners();
  };

  return {
    pid: child.pid ?? undefined,
    stdin,
    onStdout,
    onStderr,
    wait,
    kill,
    dispose,
  };
}
