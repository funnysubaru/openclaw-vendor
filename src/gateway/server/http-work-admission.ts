// Gateway HTTP boundary helpers coordinate request and upgrade work with host suspension.
import type { ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { waitForHttpRequestRejection } from "../../infra/http-request-lifecycle.js";
import { tryBeginGatewayRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { rejectWebSocketUpgrade } from "../../shared/websocket-upgrade-reject.js";
import { waitForAgentStartupAdmissionBeforeRequest } from "../../state/agent-startup-admission.js";

type GatewayBoundaryHandler = () => Promise<boolean> | boolean;

async function runWithGatewayBoundaryWorkAdmission(
  origin: string,
  reject: () => void,
  run: GatewayBoundaryHandler,
): Promise<boolean> {
  const admission = tryBeginGatewayRootWorkAdmission(origin);
  if (!admission) {
    reject();
    return true;
  }
  try {
    return await admission.run(async () => await run());
  } finally {
    admission.release();
  }
}

/** Runs one HTTP user-work route under the same root fence as Gateway RPCs. */
export async function runWithGatewayHttpWorkAdmission(
  res: ServerResponse,
  run: GatewayBoundaryHandler,
): Promise<boolean> {
  const reject = () => {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", "1");
    res.end(
      JSON.stringify({
        error: {
          message: "Gateway is temporarily unavailable while suspending or restarting",
          type: "service_unavailable",
          code: "gateway_unavailable",
        },
      }),
    );
  };
  // ADR-0033 任务84(c)：员工库后台启动准入未完成时，HTTP 用户路由先等它（路由后面多是
  // 同步读员工库）。HTTP 路径看不出目标员工，所以等全部在途准入；不读员工库的路由（头像、
  // 插件静态资源等）也会在启动后这几秒里一起等——跟改动前"准入完成才开始监听"的体验
  // 一致，换来的是不用逐个路由判断。等待放在 root work 准入之前，不阻塞重启 / 挂起排空；
  // 关闭时调度器 abort 会让等待立即结束并返回 503。
  const startupAdmission = waitForAgentStartupAdmissionBeforeRequest();
  if (startupAdmission) {
    try {
      await startupAdmission;
    } catch {
      reject();
      return true;
    }
  }
  return await runWithGatewayBoundaryWorkAdmission("http:request", reject, async () => {
    try {
      return await run();
    } finally {
      await waitForHttpRequestRejection(res.req);
    }
  });
}

export function rejectGatewayUpgradeServiceUnavailable(
  socket: Pick<Duplex, "end" | "destroy">,
  body: string,
): void {
  rejectWebSocketUpgrade(socket, {
    status: 503,
    body: { contentType: "text/plain; charset=utf-8", text: body },
  });
}

/** Holds upgrade admission until one plugin handler owns or declines the socket. */
export async function runWithGatewayUpgradeWorkAdmission(
  socket: Duplex,
  run: GatewayBoundaryHandler,
): Promise<boolean> {
  return await runWithGatewayBoundaryWorkAdmission(
    "http:upgrade",
    () => {
      rejectGatewayUpgradeServiceUnavailable(socket, "Gateway websocket admission closed");
    },
    run,
  );
}
