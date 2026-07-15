import { killProcessTree } from "../../kill-tree.js";
import type { ManagedRunStdin, SpawnProcessAdapter } from "../types.js";
import { toStringEnv } from "./env.js";

const FORCE_KILL_WAIT_FALLBACK_MS = 4000;

type PtyExitEvent = { exitCode: number; signal?: number };
type PtyDisposable = { dispose: () => void };
type PtySpawnHandle = {
  pid: number;
  write: (data: string | Buffer) => void;
  onData: (listener: (value: string) => void) => PtyDisposable | void;
  onExit: (listener: (event: PtyExitEvent) => void) => PtyDisposable | void;
  kill: (signal?: string) => void;
};
type PtySpawn = (
  file: string,
  args: string[] | string,
  options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
  },
) => PtySpawnHandle;

type PtyModule = {
  spawn?: PtySpawn;
  default?: {
    spawn?: PtySpawn;
  };
};

export type PtyAdapter = SpawnProcessAdapter;

export async function createPtyAdapter(params: {
  shell: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  name?: string;
}): Promise<PtyAdapter> {
  const module = (await import("@lydell/node-pty")) as unknown as PtyModule;
  const spawn = module.spawn ?? module.default?.spawn;
  if (!spawn) {
    throw new Error("PTY support is unavailable (node-pty spawn not found).");
  }
  const pty = spawn(params.shell, params.args, {
    cwd: params.cwd,
    env: params.env ? toStringEnv(params.env) : undefined,
    name: params.name ?? process.env.TERM ?? "xterm-256color",
    cols: params.cols ?? 120,
    rows: params.rows ?? 30,
  });

  let dataListener: PtyDisposable | null = null;
  let exitListener: PtyDisposable | null = null;
  let waitResult: { code: number | null; signal: NodeJS.Signals | number | null } | null = null;
  let resolveWait:
    | ((value: { code: number | null; signal: NodeJS.Signals | number | null }) => void)
    | null = null;
  let waitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | number | null }> | null =
    null;
  let forceKillWaitFallbackTimer: NodeJS.Timeout | null = null;

  const clearForceKillWaitFallback = () => {
    if (!forceKillWaitFallbackTimer) {
      return;
    }
    clearTimeout(forceKillWaitFallbackTimer);
    forceKillWaitFallbackTimer = null;
  };

  const settleWait = (value: { code: number | null; signal: NodeJS.Signals | number | null }) => {
    if (waitResult) {
      return;
    }
    clearForceKillWaitFallback();
    waitResult = value;
    if (resolveWait) {
      const resolve = resolveWait;
      resolveWait = null;
      resolve(value);
    }
  };

  const scheduleForceKillWaitFallback = (signal: NodeJS.Signals) => {
    clearForceKillWaitFallback();
    // Some PTY hosts fail to emit onExit after kill; use a delayed fallback
    // so callers can still unblock without marking termination immediately.
    forceKillWaitFallbackTimer = setTimeout(() => {
      settleWait({ code: null, signal });
    }, FORCE_KILL_WAIT_FALLBACK_MS);
    forceKillWaitFallbackTimer.unref();
  };

  exitListener =
    pty.onExit((event) => {
      const signal = event.signal && event.signal !== 0 ? event.signal : null;
      settleWait({ code: event.exitCode ?? null, signal });
    }) ?? null;

  const stdin: ManagedRunStdin = {
    destroyed: false,
    write: (data, cb) => {
      try {
        pty.write(data);
        cb?.(null);
      } catch (err) {
        cb?.(err as Error);
      }
    },
    end: () => {
      try {
        const eof = process.platform === "win32" ? "\x1a" : "\x04";
        pty.write(eof);
      } catch {
        // ignore EOF errors
      }
    },
  };

  // Yuiclaw PR-B（R4/组件6）调查结论：这里刻意**不**套用 child.ts 那套
  // createWindowsStreamDecoder（按控制台代码页重新解码）。
  //
  // 原因：@lydell/node-pty 在 Windows 上（windowsPtyAgent.js）无条件对底层
  // conout socket 做了 `setEncoding('utf8')`，且该行为**不受**其自身 `encoding`
  // spawn 选项控制（windowsTerminal.js 对 Windows 平台直接忽略这个选项，只打
  // 一句 warn）。也就是说：到这个 onData 回调时，`chunk` 已经是 node-pty 内部
  // 用 UTF-8 StringDecoder 强制解码好的 JS string，不是原始字节——PS 5.1 若实际
  // 输出的是 GBK 字节，此时非法字节序列已经被替换成 U+FFFD、信息已不可逆丢失。
  // 在这一层再对它做一次"当 GBK 解码"，等于对一个已经损坏的 UTF-8 字符串做
  // 二次错误解码，只会产出更严重的双重乱码，而不是修复。
  //
  // 好消息：agent 默认的 exec/bash 调用（ppt-master run_engine 等）走的是
  // child.ts（plain child_process.spawn，未设 pty:true），只有 agent 显式传
  // `pty: true`（TTY 场景，如需要交互式终端的子 agent/coding agent）才会走到
  // 这个 pty adapter。所以 child.ts 的修复已覆盖 R4 报告的实际乱码场景；
  // 这条 PTY 路径的 Windows 编码问题（若未来真的需要修）属于不同性质的
  // bug——正确方向是让 PowerShell 子进程自身输出 UTF-8（如 spawn 前注入
  // `[Console]::OutputEncoding=UTF8`，即设计文档风险§1 的"方案 B"），而不是
  // 在这一层做事后重新解码。详见 openclaw-vendor PR 描述里的调查记录。
  const onStdout = (listener: (chunk: string) => void) => {
    dataListener =
      pty.onData((chunk) => {
        listener(chunk.toString());
      }) ?? null;
  };

  const onStderr = (_listener: (chunk: string) => void) => {
    // PTY gives a unified output stream.
  };

  const wait = async () => {
    if (waitResult) {
      return waitResult;
    }
    if (!waitPromise) {
      waitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | number | null }>(
        (resolve) => {
          resolveWait = resolve;
          if (waitResult) {
            const settled = waitResult;
            resolveWait = null;
            resolve(settled);
          }
        },
      );
    }
    return waitPromise;
  };

  const kill = (signal: NodeJS.Signals = "SIGKILL") => {
    try {
      if (signal === "SIGKILL" && typeof pty.pid === "number" && pty.pid > 0) {
        killProcessTree(pty.pid);
      } else if (process.platform === "win32") {
        pty.kill();
      } else {
        pty.kill(signal);
      }
    } catch {
      // ignore kill errors
    }

    if (signal === "SIGKILL") {
      scheduleForceKillWaitFallback(signal);
    }
  };

  const dispose = () => {
    try {
      dataListener?.dispose();
    } catch {
      // ignore disposal errors
    }
    try {
      exitListener?.dispose();
    } catch {
      // ignore disposal errors
    }
    clearForceKillWaitFallback();
    dataListener = null;
    exitListener = null;
    settleWait({ code: null, signal: null });
  };

  return {
    pid: pty.pid || undefined,
    stdin,
    onStdout,
    onStderr,
    wait,
    kill,
    dispose,
  };
}
