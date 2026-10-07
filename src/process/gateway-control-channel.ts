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
// 兼容旧版 Yuiclaw：vendor 可以独立热更新，旧启动器只设 OPENCLAW_STDIN_CONTROL=1 并往 stdin
// 写暗号。没给 OPENCLAW_CONTROL_FD 时 run-loop 仍按旧协议读 stdin（同一个监听函数，见下方）。
//
// 唯一要「刻意传下去」的地方是自我重启外壳：外壳用 stdio:"inherit" 拉起真正跑 gateway 的里层
// 进程，"inherit" 只传 0-2，不转传的话里层的 fd 3 是个不相干的句柄（2026-10-06 Windows 真机
// 实测里层报 "Unsupported fd type: FILE"）。解析 fd / 拼转传 stdio 的唯一实现在根目录
// node-runtime-recovery.mjs（openclaw.mjs 启动器层不能依赖 dist，只能放那里），这里转出给 src 用。
import net from "node:net";
import { createInterface } from "node:readline";

export {
  GATEWAY_CONTROL_FD_ENV,
  parseGatewayControlFd,
  resolveLauncherRespawnStdio as resolveRespawnStdioWithControlFd,
} from "../../node-runtime-recovery.mjs";

/**
 * 把父进程传下来的控制管道包成只读 socket。Windows / Unix 上 Node 都支持用 fd 打开继承来的
 * 管道（Node 自己的 IPC 通道 NODE_CHANNEL_FD 也是这么接的）。fd 无效时这里会同步抛错，由调用方
 * 降级为「不装控制通道」——父进程那边等不到优雅退出会落到 taskkill 强杀兜底，不会卡住退出。
 */
export function openGatewayControlChannel(fd: number): net.Socket {
  return new net.Socket({ fd, readable: true, writable: false });
}

type ControlInput = NodeJS.ReadableStream & {
  unref?: () => void;
  destroy?: () => void;
};

/**
 * 在一条输入流上按行等关闭暗号，控制管道与旧 stdin 通道共用。
 *
 * 错误要在两层都接住：createInterface 会给 input 挂自己的 error 监听，再把同一个错误在
 * readline Interface 上重新 emit 一次。只给 input 挂监听时，Interface 上的 error 没人接会变成
 * uncaught exception 拖垮 gateway（2026-10-07 owner review 用 Windows Node 24 + PassThrough
 * 复现）。控制通道坏了只意味着「优雅退出不可用」，父进程会落到强杀兜底，所以这里只记一次
 * 警告并拆掉监听，gateway 照常运行。
 *
 * unref 只是「不挡退出」，不是「停读」：readline 照常收行、暗号照常生效，只是这个句柄不再单独
 * ref 住事件循环（gateway 靠 server 保活）。可选链：某些执行环境（如 vitest 的 threads 池）暴露
 * 的 process.stdin 没有 unref，跳过的后果只是进程可能晚一点退。
 *
 * ownsInput：控制管道是我们自己打开的，关闭时一并 destroy；process.stdin 不归我们管，只关 reader。
 */
export function listenForGatewayControlShutdown(params: {
  input: ControlInput;
  ownsInput: boolean;
  sentinel: string;
  onShutdown: () => void;
  onError: (error: unknown) => void;
}): { close: () => void } {
  const { input, ownsInput, sentinel, onShutdown, onError } = params;
  // terminal:false 明确按非交互管道处理（父进程写一行就走，不需要 TTY 行编辑/回显）。
  const reader = createInterface({ input, terminal: false });
  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    reader.close();
    if (ownsInput) {
      input.destroy?.();
    }
  };
  // input 与 reader 会先后报同一个错误；closed 之后不再重复记日志。input 上的监听在 close 后
  // 仍保留，用来吞掉拆除过程中可能再冒出的迟到错误。
  const handleError = (error: unknown) => {
    if (closed) {
      return;
    }
    onError(error);
    close();
  };
  input.on("error", handleError);
  reader.on("error", handleError);
  reader.on("line", (line) => {
    if (line.trim() === sentinel) {
      onShutdown();
    }
  });
  input.unref?.();
  return { close };
}
