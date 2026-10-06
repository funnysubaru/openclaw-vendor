// Yuiclaw fork：Windows 优雅关闭控制通道（替换 openclaw-vendor #98 的 stdin 通道）。
//
// 为什么不用 stdin：Windows 上父进程（Yuiclaw launcher）收发不了 POSIX 信号，#98 当初让
// 父进程往 gateway 的 stdin 写一行暗号来触发优雅关闭。但 stdin 是管道时，gateway 自己派生的
// 子进程会继承它——vendor 的 exec-runner 在没有 input 时 stdin 默认 "inherit"。Git for
// Windows 继承一根「正被 gateway 读着的」管道后不退出，一直挂到 GIT_TIMEOUT_MS(120s) 才被杀，
// 导致每个新会话首条消息在 capture_session_diff_baseline 白等 2 分钟（2026-10-06 Windows
// 真机物证：gateway 内同一条 git rev-parse，stdin=ignore 90ms / inherit 150s 不退）。
//
// 现在的做法：父进程把 gateway 的 stdin 设为 ignore（子进程继承到的是 NUL，不会卡），另开一根
// 额外管道（stdio 第 4 项，即 fd 3）专门传暗号，并通过 OPENCLAW_CONTROL_FD 告诉 gateway 是哪个
// fd。gateway 派生子进程时 stdio 只列 0-2，这根管道不会作为子进程的标准流传下去。
//
// 唯一要「刻意传下去」的地方是 openclaw.mjs 的自我重启外壳（respawn-child-runner.ts）：外壳
// 用 stdio:"inherit" 拉起真正跑 gateway 的里层进程，"inherit" 只传 0-2，不转传的话里层的 fd 3
// 是个不相干的句柄（2026-10-06 Windows 真机实测里层报 "Unsupported fd type: FILE"）。
import fs from "node:fs";
import net from "node:net";
import type { StdioOptions } from "node:child_process";

export const GATEWAY_CONTROL_FD_ENV = "OPENCLAW_CONTROL_FD";

/**
 * 解析 OPENCLAW_CONTROL_FD。只接受 ≥3 的十进制整数：0-2 是标准流，拿它们当控制通道等于
 * 回到 stdin 方案的老问题；其它非法值（空串、负数、小数、"abc"）一律视为未开启，返回 undefined。
 */
export function parseGatewayControlFd(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    return undefined;
  }
  const fd = Number(raw.trim());
  return Number.isSafeInteger(fd) && fd >= 3 ? fd : undefined;
}

/**
 * 把父进程传下来的控制管道包成只读 socket。Windows / Unix 上 Node 都支持用 fd 打开继承来的
 * 管道（Node 自己的 IPC 通道 NODE_CHANNEL_FD 也是这么接的）。fd 无效时这里会同步抛错，由调用方
 * 降级为「不装控制通道」——父进程那边等不到优雅退出会落到 taskkill 强杀兜底，不会卡住退出。
 */
export function openGatewayControlChannel(fd: number): net.Socket {
  return new net.Socket({ fd, readable: true, writable: false });
}

function isFdOpen(fd: number): boolean {
  try {
    fs.fstatSync(fd);
    return true;
  } catch {
    return false;
  }
}

/**
 * 自我重启外壳拉起里层进程时用的 stdio + env：
 *   - env 里带了合法的控制 fd、且外壳自己手上这个 fd 确实是开着的 → 0-2 照旧 inherit，并把
 *     控制 fd 原样转传到里层同一个 fd 号（中间空位填 ignore），里层 run-loop 才收得到暗号；
 *   - 否则（没开控制通道 / 值非法 / 外壳手上没有这个 fd）→ 保持原来的 "inherit"，并从里层 env
 *     删掉 OPENCLAW_CONTROL_FD，免得里层去打开一个不相干的 fd。拿不到控制通道只意味着优雅退出
 *     不可用，父进程会落到强杀兜底；绝不能因为转传失败让 gateway 起不来。
 * 不带控制 fd 时返回值与改造前完全一致（stdio:"inherit"、env 原样），对上游运行方式零影响。
 */
export function resolveRespawnStdioWithControlFd(
  env: NodeJS.ProcessEnv,
  fdIsOpen: (fd: number) => boolean = isFdOpen,
): { stdio: StdioOptions; env: NodeJS.ProcessEnv } {
  const raw = env[GATEWAY_CONTROL_FD_ENV];
  if (raw === undefined) {
    return { stdio: "inherit", env };
  }
  const fd = parseGatewayControlFd(raw);
  if (fd === undefined || !fdIsOpen(fd)) {
    const { [GATEWAY_CONTROL_FD_ENV]: _dropped, ...rest } = env;
    return { stdio: "inherit", env: rest };
  }
  const stdio: Array<"inherit" | "ignore" | number> = ["inherit", "inherit", "inherit"];
  while (stdio.length < fd) {
    stdio.push("ignore");
  }
  stdio.push(fd);
  return { stdio, env };
}
