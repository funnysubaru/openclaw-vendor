/**
 * ADR-0033 任务84(c) review2 P2-2：投递恢复停在员工库启动准入等待上时，恢复任务自己的
 * stop 必须立即打断等待。真实关闭顺序是关闭前置阶段先 await stopDeliveryRecovery()，之后
 * 才轮到 cancelAgentStartupAdmission，只靠准入取消的话关闭会被慢准入拖住。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueDelivery } from "../infra/outbound/delivery-queue-storage.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  cancelAgentStartupAdmission,
  scheduleAgentStartupAdmission,
} from "../state/agent-startup-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createLog,
  createTestCron,
  createTestCronReconciliation,
  createTestCronState,
  runtimeServiceMocks as hoisted,
  resetRuntimeServiceMocks,
} from "./server-runtime-services.test-harness.js";

const { activateGatewayScheduledServices } = await import("./server-runtime-services.js");

function activateScheduledServicesForTest() {
  return activateGatewayScheduledServices({
    minimalTestGateway: false,
    cfgAtStart: {} as never,
    deps: {} as never,
    sessionDeliveryRecoveryMaxEnqueuedAt: 123,
    cronReconciliation: createTestCronReconciliation(),
    logCron: { error: vi.fn() },
    cronState: createTestCronState(createTestCron()),
    log: createLog(),
  });
}

describe("server-runtime-services startup admission", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.stubEnv("OPENCLAW_SKIP_CHANNELS", "");
    vi.stubEnv("OPENCLAW_SKIP_PROVIDERS", "");
    resetGatewayWorkAdmission();
    resetRuntimeServiceMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetGatewayWorkAdmission();
  });

  it("stops outbound recovery promptly while it waits for agent startup admission", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-recovery-admission-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const admissionGate = createDeferredCore<void>();
    try {
      await enqueueDelivery({
        channel: "admission-test",
        to: "peer",
        payloads: [{ text: "pending" }],
        session: { key: "agent:main:main", agentId: "main" },
      });
      scheduleAgentStartupAdmission({
        agentIds: ["main"],
        openAgent: async () => await admissionGate.promise,
        migrateAgent: async () => {},
      });
      const actual = await vi.importActual<
        typeof import("../infra/outbound/delivery-queue-recovery.js")
      >("../infra/outbound/delivery-queue-recovery.js");
      const recoveryStarted = createDeferredCore<void>();
      hoisted.recoverPendingDeliveries.mockImplementationOnce(async (opts) => {
        recoveryStarted.resolve();
        return await actual.recoverPendingDeliveries(opts);
      });

      const services = activateScheduledServicesForTest();
      await recoveryStarted.promise;
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
      expect(hoisted.deliverOutboundPayloads).not.toHaveBeenCalled();

      const outcome = await Promise.race([
        services.stopDeliveryRecovery().then(() => "stopped" as const),
        new Promise<"blocked">((resolve) => {
          setTimeout(() => resolve("blocked"), 2_000);
        }),
      ]);
      expect(outcome).toBe("stopped");
      expect(hoisted.deliverOutboundPayloads).not.toHaveBeenCalled();
      services.heartbeatRunner.stop();
    } finally {
      admissionGate.resolve();
      await cancelAgentStartupAdmission();
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
