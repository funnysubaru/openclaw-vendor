// PR #132 第三轮独立审查（selfreview3）的一轮探针（按需搬入其中 3 条）。
// 每员工默认库布局（收窄证明成立）下卡住 ops 的准入，让 main 走真实收窄分发跑一轮真实的
// chat.send（本地 mock 模型，127.0.0.1:0 临时端口，不起 gateway），在准入闸门上插桩，记录
// 这一轮里（排除准入工作自身的异步作用域）经过闸门的目标员工。
// - 纯文本一轮：只碰 main，任何 ops 闸门都不应出现。
// - session_status 读 / 写 ops 会话：跨员工访问必须先异步等 ops 准入（dbwait / async 记录
//   都是预期行为），不能撞上同步兜底被拒（thrown 里不应有 ops）。第一次看到 ops 闸门 500ms
//   后才放行 ops，让等待能结束、这一轮能跑完。
import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeOpenAiResponsesSse } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { scheduleBackgroundSessionStartupMigration } from "../config/sessions/startup-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import * as admission from "../state/agent-startup-admission.js";
import {
  cancelAgentStartupAdmission,
  resetAgentStartupAdmissionForTest,
  waitForAgentStartupAdmission,
} from "../state/agent-startup-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { RespondFn } from "./server-methods/types.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

afterEach(() => {
  resetAgentStartupAdmissionForTest();
});

function textEvents(text: string, id: string): Record<string, unknown>[] {
  const message = {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    { type: "response.output_text.done", item_id: id, output_index: 0, content_index: 0, text },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: `resp-${id}`,
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
}

function toolCallEvents(name: string, args: Record<string, unknown>, id: string) {
  const item = {
    type: "function_call",
    id: `fc_${id}`,
    call_id: `call_${id}`,
    name,
    arguments: JSON.stringify(args),
    status: "completed",
  };
  return [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress" },
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp-${id}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
}

type ToolStep = { name: string; args: Record<string, unknown> };

const PROBES: Array<{
  label: string;
  tools: ToolStep[];
  toolsProfile?: string;
  crossAgent: boolean;
}> = [
  { label: "纯文本一轮", tools: [], crossAgent: false },
  {
    label: "session_status 指向 ops 会话（读）",
    tools: [{ name: "session_status", args: { sessionKey: "agent:ops:chat1" } }],
    toolsProfile: "full",
    crossAgent: true,
  },
  {
    label: "session_status 改 ops 会话模型（写）",
    tools: [
      {
        name: "session_status",
        args: { sessionKey: "agent:ops:chat1", model: "mock-openai/probe" },
      },
    ],
    toolsProfile: "full",
    crossAgent: true,
  },
];

describe("PR #132 selfreview3 薄弱点 1：main 的真实 chat.send 一轮在 ops 准入中触碰哪些员工库", () => {
  it.each(PROBES)(
    "$label",
    async (probe) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const requestBodies: string[] = [];
        const toolQueue = [...probe.tools];
        let step = 0;
        const server = createServer((request, response: ServerResponse) => {
          void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            requestBodies.push(Buffer.concat(chunks).toString("utf8"));
            step += 1;
            const next = toolQueue.shift();
            writeOpenAiResponsesSse(
              response,
              next
                ? toolCallEvents(next.name, next.args, `s${step}`)
                : textEvents("done", `m${step}`),
            );
          })().catch((error: unknown) => response.writeHead(500).end(String(error)));
        });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("mock provider did not bind");
        }
        const provider = buildMockOpenAiResponsesProvider(
          `http://127.0.0.1:${address.port}/v1`,
          "probe",
        );
        const cfg = {
          agents: {
            ownership: "explicit",
            entries: { main: {}, ops: {} },
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              heartbeat: { every: "0m" },
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: {
                  agentRuntime: { id: "openclaw" },
                  params: { transport: "sse", openaiWsWarmup: false },
                },
              },
            },
          },
          models: {
            mode: "replace",
            providers: {
              [provider.providerId]: { ...provider.config, request: { allowPrivateNetwork: true } },
            },
          },
          tools: {
            profile: probe.toolsProfile ?? "minimal",
            agentToAgent: { enabled: true, allow: ["*"] },
            sessions: { visibility: "all" },
          },
        } as unknown as OpenClawConfig;
        await state.writeConfig(cfg);
        for (const agentId of ["main", "ops"]) {
          await upsertSessionEntryCore(
            { agentId, sessionKey: `agent:${agentId}:chat1`, sessionId: `${agentId}-1` },
            { sessionId: `${agentId}-1`, updatedAt: 1 },
          );
        }
        const opsPath = openOpenClawAgentDatabase({ agentId: "ops" }).path;
        closeOpenClawAgentDatabasesForTest();
        const releaseOps = createDeferred<void>();
        const actualCheck = integrityWorker.assertSqliteIntegrityInWorker;
        vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
          async (pathname, busyTimeoutMs, signal) => {
            if (pathname === opsPath) {
              await releaseOps.promise;
            }
            return await actualCheck(pathname, busyTimeoutMs, signal);
          },
        );
        await scheduleBackgroundSessionStartupMigration({
          cfg: { ...cfg, session: { mainKey: "work" } },
          log: { info: vi.fn(), warn: vi.fn() },
        });
        const gated: string[] = [];
        const thrown: string[] = [];
        // 准入工作自己的异步作用域里（getAgentStartupAdmissionWorkSignal 有值）不记。
        const outsideAdmission = () => admission.getAgentStartupAdmissionWorkSignal() === undefined;
        const realWait = admission.waitForAgentStartupAdmission;
        const realAssert = admission.assertAgentStartupAdmissionSettled;
        const realDbWait = admission.waitForAgentDatabaseStartupAdmission;
        let recording = false;
        // 跨员工探针：第一次在闸门上看到 ops 后 500ms 才放行 ops——同步兜底若会拒，此时已拒
        // （记进 thrown）；异步等待则在放行后继续，这一轮能跑完。
        let releaseScheduled = false;
        const noteOpsGate = (agentId: string) => {
          if (agentId === "ops" && !releaseScheduled) {
            releaseScheduled = true;
            setTimeout(() => releaseOps.resolve(), 500).unref?.();
          }
        };
        vi.spyOn(admission, "waitForAgentStartupAdmission").mockImplementation((agentId) => {
          if (recording && outsideAdmission()) {
            gated.push(`async:${agentId}`);
            noteOpsGate(agentId);
          }
          return realWait(agentId);
        });
        vi.spyOn(admission, "waitForAgentDatabaseStartupAdmission").mockImplementation(
          (agentId) => {
            if (recording && outsideAdmission()) {
              gated.push(`dbwait:${agentId}`);
              noteOpsGate(agentId);
            }
            return realDbWait(agentId);
          },
        );
        vi.spyOn(admission, "assertAgentStartupAdmissionSettled").mockImplementation((agentId) => {
          if (recording && outsideAdmission()) {
            gated.push(`sync:${agentId}`);
            noteOpsGate(agentId);
          }
          try {
            realAssert(agentId);
          } catch (error) {
            if (recording && outsideAdmission()) {
              thrown.push(
                `${agentId}: ${String(error)}\n${new Error().stack?.split("\n").slice(2, 18).join("\n")}`,
              );
            }
            throw error;
          }
        });
        const respond = vi.fn<RespondFn>();
        const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
        try {
          await realWait("main");
          expect(realWait("ops")).toBeDefined();
          recording = true;
          await handleGatewayRequest({
            req: {
              type: "req",
              id: "p5",
              method: "chat.send",
              params: {
                sessionKey: "agent:main:chat1",
                message: "hi",
                idempotencyKey: `p5-run-${probe.label.length}-${Date.now()}`,
              },
            },
            respond,
            client: { connect: { scopes: ["operator.admin"] } } as never,
            isWebchatConnect: () => false,
            context,
          });
          // 等这一轮真正结束（broadcast 出 chat final / error），最多 100 秒。
          const deadline = Date.now() + 100_000;
          const startedAt = Date.now();
          const isTerminal = () =>
            (context.broadcast as ReturnType<typeof vi.fn>).mock.calls.some(
              ([event, payload]) =>
                event === "chat" &&
                ["final", "error", "aborted"].includes(
                  String((payload as { state?: string })?.state),
                ),
            );
          let lastDump = Date.now();
          let doneAt: number | undefined;
          const finished = () => {
            if (isTerminal()) {
              return true;
            }
            if (requestBodies.length > probe.tools.length) {
              doneAt ??= Date.now();
              return Date.now() - doneAt > 5_000;
            }
            return false;
          };
          while (!finished() && Date.now() < deadline) {
            await new Promise((resolve) => {
              setTimeout(resolve, 50);
            });
            if (Date.now() - lastDump > 5_000) {
              lastDump = Date.now();
              console.log(
                `[P5 ${probe.label}] t=${Date.now() - startedAt} reqs=${requestBodies.length} gates=${JSON.stringify(gated.slice(-6))}`,
              );
            }
          }
          console.log(`[P5 ${probe.label}] waited ms:`, Date.now() - startedAt);
          recording = false;
          const terminal = (context.broadcast as ReturnType<typeof vi.fn>).mock.calls
            .filter(([event]) => event === "chat")
            .map(([, payload]) => payload)
            .at(-1);
          console.log(
            `[P5 ${probe.label}] respond:`,
            JSON.stringify(respond.mock.calls).slice(0, 400),
          );
          console.log(`[P5 ${probe.label}] provider requests:`, requestBodies.length);
          console.log(
            `[P5 ${probe.label}] tools offered:`,
            JSON.stringify(
              (JSON.parse(requestBodies[0] ?? "{}").tools ?? []).map(
                (t: { name?: string }) => t.name,
              ),
            ),
          );
          for (const [index, body] of requestBodies.entries()) {
            const parsed = JSON.parse(body) as {
              input?: Array<{ type?: string; output?: unknown }>;
            };
            const outputs = (parsed.input ?? []).filter(
              (item) => item.type === "function_call_output",
            );
            if (outputs.length > 0) {
              console.log(
                `[P5 ${probe.label}] req#${index} tool outputs:`,
                JSON.stringify(outputs).slice(0, 700),
              );
            }
          }
          console.log(
            `[P5 ${probe.label}] terminal:`,
            String(JSON.stringify(terminal)).slice(0, 500),
          );
          console.log(
            `[P5 ${probe.label}] gates:`,
            JSON.stringify([...new Set(gated)]),
            "count",
            gated.length,
          );
          console.log(`[P5 ${probe.label}] thrown:`, thrown.join("\n---\n"));
          console.log(
            `[P5 ${probe.label}] logGateway.error/warn:`,
            JSON.stringify([
              ...(context.logGateway.error as ReturnType<typeof vi.fn>).mock.calls,
              ...(context.logGateway.warn as ReturnType<typeof vi.fn>).mock.calls,
            ]).slice(0, 800),
          );
          expect(requestBodies.length).toBeGreaterThan(0);
          if (probe.crossAgent) {
            // 跨员工访问只允许"先等 ops 准入"，不允许撞上同步兜底被拒。
            expect(thrown.filter((entry) => entry.startsWith("ops:"))).toEqual([]);
            expect(requestBodies.length).toBeGreaterThan(probe.tools.length);
          } else {
            expect(gated.filter((entry) => entry.endsWith(":ops"))).toEqual([]);
          }
        } finally {
          recording = false;
          releaseOps.resolve();
          await waitForAgentStartupAdmission("ops")?.catch(() => {});
          console.log("[P5] cleanup: releasing");
          vi.restoreAllMocks();
          await cancelAgentStartupAdmission();
          console.log("[P5] cleanup: admission cancelled");
          server.closeAllConnections();
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
        }
      });
    },
    180_000,
  );
});
