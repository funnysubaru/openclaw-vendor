/**
 * provider-billing-hooks.ts
 *
 * PLG 计费切面 —— 供 Yuiclaw extension 注入实现的 BillingHooks 接口，
 * 以及把 billing 逻辑 wrap 到 StreamFn 栈里的工厂函数。
 *
 * 设计原则（路 A）：
 *   - vendor 只承载「机制」（接口定义 + wrap 骨架 + registry），
 *     业务细节（HTTP 调 BFF、Supabase user mapping 等）全部留给
 *     Yuiclaw extension（extensions/yuiclaw-billing）实现后注入。
 *   - 未注入时（registry 为 null）wrapProviderWithBilling 原样返回
 *     baseFn，与现有行为完全一致，零开销。
 *   - usage 从流的 result() 方法里取（该方法返回最终 AssistantMessage，
 *     包含 .usage 字段），不从 baseFn 返回值直接取——因为 baseFn 一返回
 *     流还没结束，usage 在流末尾才完整。
 *   - costUsd 在 postCharge 调用前，用 estimateUsageCost(normalizeUsage(rawUsage), modelCost)
 *     即时算出（复用 vendor 现有单价公式），不依赖事后扫 JSONL 的 session-cost-usage.ts。
 *
 * 关于 eventId：
 *   每次 streamFn 被调用（即每次真实 LLM 调用，含多轮 tool-call 续接）
 *   都会生成一个稳定 eventId，贯穿 preCheck → postCharge/cancelReservation，
 *   供上层做幂等键使用（防止网络重试导致重复扣费）。
 */

import { randomUUID } from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { NormalizedUsage } from "../agents/usage.js";
import { normalizeUsage } from "../agents/usage.js";
import type { ModelCostConfig } from "../utils/usage-format.js";
import { estimateUsageCost } from "../utils/usage-format.js";

// =============================================================================
// BillingHooks 接口
// =============================================================================

/**
 * 每次 LLM 调用的上下文标识，贯穿 preCheck → postCharge/cancelReservation。
 * 只使用 vendor 级别的标识符，不含 Supabase URL / Yuiclaw 业务字段。
 * Yuiclaw extension 负责用 sessionKey → supabase_user_id 的映射。
 */
export type BillingCallContext = {
  /** 本次调用的稳定幂等键，由 wrapProviderWithBilling 为每次 streamFn 调用生成 */
  eventId: string;

  /** 当前模型 ID，如 "claude-3-5-sonnet-20241022" */
  modelName: string;

  /** provider ID，如 "anthropic" / "openai" / "gemini" */
  provider: string;

  /** session 的持久化 key（跨 sessionId），用于映射用户 */
  sessionKey?: string;

  /** 本次 session 的 ephemeral UUID（每次 /new 或 /reset 重建） */
  sessionId?: string;

  /** run ID，标识单次 agent 调用 */
  runId?: string;

  /** agent ID */
  agentId?: string;

  /**
   * 消息来源渠道（如 "panel-chat" / "line" / "telegram" / "cron"），
   * 对应 params.messageChannel，供 Yuiclaw 侧映射到 ChargeSource。
   */
  messageChannel?: string;

  /**
   * 估算的 input token 数（来自 context.messages 的 token 估算，或 0）。
   * 仅供 preCheck 阶段做配额预检，精确值以 postCharge 时的 usage 为准。
   * NOTE: vendor 层没有 tokenizer，此处传 0 由 extension 决定是否自行估算。
   */
  estimatedInputTokens: number;
};

/**
 * postCharge 和 cancelReservation 时追加的 usage / cost 字段。
 * 来自流末尾 result() 方法返回的 message.usage，经 normalizeUsage 规范化。
 */
export type BillingChargeContext = BillingCallContext & {
  /** 本次 LLM 调用规范化后的 usage，可能为 undefined（provider 不返回 usage 时） */
  usage: NormalizedUsage | undefined;

  /**
   * 按模型单价即时算出的成本（单位：美元）。
   * 算法：estimateUsageCost({ usage, cost: modelCostConfig })
   * 可能为 undefined（usage 或模型单价配置缺失时）。
   */
  costUsd: number | undefined;
};

/**
 * BillingHooks 接口——由 Yuiclaw extension 实现并注入。
 *
 * 三个生命周期回调对应 streamFn 的三个出口：
 *   preCheck  → 调用 baseFn 之前（可拒绝调用）
 *   postCharge → 流正常完成后（取到 usage，扣费）
 *   cancelReservation → baseFn 抛错 / 流 error / abort 时（释放预占）
 */
export type BillingHooks = {
  /**
   * 调用 LLM 之前的配额检查。
   *
   * 返回 { allowed: false } 时，wrapProviderWithBilling 不会调用 baseFn，
   * 而是抛出一个带 reason 的 Error（message 格式：`[billing] blocked: <reason>`）。
   *
   * 基础设施故障时 BFF 侧应 fail-open（返回 allowed: true），
   * vendor 只忠实 respect 这个 flag，不自行决策。
   */
  preCheck: (ctx: BillingCallContext) => Promise<{ allowed: boolean; reason?: string }>;

  /**
   * 流正常完成后的扣费回调。
   *
   * ctx 包含规范化后的 usage 和即时算出的 costUsd。
   * 实现侧应做幂等处理（以 eventId 为键）。
   * 此函数抛错不影响主流程（wrap 内部 catch + log）。
   */
  postCharge: (ctx: BillingChargeContext) => Promise<void>;

  /**
   * baseFn 抛错 / 流 error / abort 时的预占释放。
   *
   * 调用时机：LLM 未真正产生有效成本（如网络超时、用户 abort、provider error）。
   * 实现侧应释放 preCheck 写下的 reservation（以 eventId 为键定位）。
   * 此函数抛错不影响主流程（wrap 内部 catch + log）。
   */
  cancelReservation: (ctx: BillingCallContext) => Promise<void>;
};

// =============================================================================
// 全局 BillingHooks 注册点（路 A 核心：模块级 registry）
// =============================================================================

/**
 * 使用 Symbol.for 保证跨模块边界（如 gateway 子进程内 esm / cjs 混用时）
 * 只有一个注册槽位，与 hook-runner-global.ts 的 globalThis 策略对齐。
 */
const BILLING_HOOKS_KEY = Symbol.for("openclaw.billing.hooks");

type BillingHooksGlobal = {
  hooks: BillingHooks | null;
};

function getBillingHooksGlobal(): BillingHooksGlobal {
  const g = globalThis as typeof globalThis & {
    [BILLING_HOOKS_KEY]?: BillingHooksGlobal;
  };
  return (g[BILLING_HOOKS_KEY] ??= { hooks: null });
}

/**
 * 注册 BillingHooks 实现。
 * 由 Yuiclaw extension（extensions/yuiclaw-billing）在插件 activate 阶段调用。
 *
 * 重复注册会覆盖旧实现（允许热更新）。
 */
export function setBillingHooks(hooks: BillingHooks): void {
  getBillingHooksGlobal().hooks = hooks;
}

/**
 * 获取当前注册的 BillingHooks 实现。
 * 返回 null 表示尚未注册，调用方应退化为 no-op（不影响正常流程）。
 */
export function getBillingHooks(): BillingHooks | null {
  return getBillingHooksGlobal().hooks;
}

/**
 * 清除 BillingHooks（主要用于单测隔离）。
 */
export function clearBillingHooks(): void {
  getBillingHooksGlobal().hooks = null;
}

// =============================================================================
// wrapProviderWithBilling
// =============================================================================

/**
 * 向后兼容关键参数：用于 postCharge 时即时算 costUsd。
 * attempt.ts 调用时从 params.config + params.model 取得，由此传入。
 */
export type BillingWrapParams = {
  /** 从 attempt 作用域注入的标识信息，按需填充 */
  modelName: string;
  provider: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  agentId?: string;
  messageChannel?: string;
  /** 模型单价配置（来自 config.models.providers[provider].models[].cost） */
  modelCost?: ModelCostConfig;
};

/**
 * 将 BillingHooks 包裹到 streamFn 外层，实现计费切面。
 *
 * 行为：
 *   hooks 为 null/undefined → 原样返回 baseFn（向后兼容，零开销）
 *   hooks 不为 null →
 *     1. preCheck：调 baseFn 之前检查配额，blocked → 抛错
 *     2. 调 baseFn 拿流
 *     3. wrap 流的 result()：正常完成 → postCharge；抛错 → cancelReservation
 *     4. wrap 流的 [Symbol.asyncIterator]：迭代中 error → cancelReservation
 *     5. baseFn 本身抛错 → cancelReservation
 *
 * streamFn 每次被 pi-agent-core 调用对应一次真实 LLM 请求（含多轮 tool-call
 * 续接）——这是「按每次真实调用扣费」的正确粒度。
 */
export function wrapProviderWithBilling(
  baseFn: StreamFn,
  hooks: BillingHooks | null | undefined,
  params: BillingWrapParams,
): StreamFn {
  // 没有注入 billing hooks → 原样透传，向后兼容
  if (!hooks) {
    return baseFn;
  }

  return (model, context, options) => {
    // 为本次调用生成稳定幂等键，贯穿 preCheck → postCharge/cancel
    const eventId = randomUUID();

    const callCtx: BillingCallContext = {
      eventId,
      modelName: params.modelName,
      provider: params.provider,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      runId: params.runId,
      agentId: params.agentId,
      messageChannel: params.messageChannel,
      // vendor 层没有 tokenizer，estimatedInputTokens 传 0；
      // Yuiclaw extension 可在 BFF 侧自行估算（如从 preCheck ctx 里的 sessionKey 查历史）
      estimatedInputTokens: 0,
    };

    // -------------------------------------------------------------------------
    // 异步包装：preCheck → baseFn → wrap 流
    // -------------------------------------------------------------------------
    const doCall = async (): Promise<ReturnType<StreamFn>> => {
      // 1) preCheck
      let checkResult: { allowed: boolean; reason?: string };
      try {
        checkResult = await hooks.preCheck(callCtx);
      } catch (preCheckErr) {
        // preCheck 本身抛错（如 BFF 不可达）：fail-open，继续调用
        // 记录警告但不阻断，避免 billing 基础设施故障影响正常使用
        console.warn(
          `[billing] preCheck threw, failing open. eventId=${eventId} err=${String(preCheckErr)}`,
        );
        checkResult = { allowed: true };
      }

      if (!checkResult.allowed) {
        // 配额不足——抛错阻断本次 LLM 调用
        // 不需要 cancelReservation，因为 preCheck 返回 blocked 时 BFF 不应已写入 reservation
        throw new Error(`[billing] blocked: ${checkResult.reason ?? "quota exceeded"}`);
      }

      // 2) 调 baseFn
      let stream: ReturnType<StreamFn>;
      try {
        stream = baseFn(model, context, options);
      } catch (baseFnErr) {
        // baseFn 同步抛错（极罕见，但防御一下）
        hooks.cancelReservation(callCtx).catch((err) => {
          console.warn(`[billing] cancelReservation failed. eventId=${eventId} err=${String(err)}`);
        });
        throw baseFnErr;
      }

      // 3) 包住流——支持两种形态：
      //    a) 直接是 stream 对象（同步返回）
      //    b) Promise<stream>（异步返回，如 openai-responses WebSocket 的情况）
      if (stream && typeof stream === "object" && "then" in stream) {
        // 异步流：baseFn 返回 Promise，resolve 后再 wrap
        return Promise.resolve(stream).then(
          (resolvedStream) => wrapBillingStream(resolvedStream, callCtx, hooks, params),
          (err) => {
            // baseFn Promise reject
            hooks.cancelReservation(callCtx).catch((cancelErr) => {
              console.warn(
                `[billing] cancelReservation failed. eventId=${eventId} err=${String(cancelErr)}`,
              );
            });
            throw err;
          },
        ) as ReturnType<StreamFn>;
      }

      // 同步流
      return wrapBillingStream(stream, callCtx, hooks, params) as ReturnType<StreamFn>;
    };

    // StreamFn 签名允许同步或异步返回；这里统一走 Promise，
    // 与现有 wrap 中 `if ("then" in maybeStream)` 的处理逻辑对齐。
    return doCall() as ReturnType<StreamFn>;
  };
}

// =============================================================================
// 内部辅助：包住单个流对象
// =============================================================================

/**
 * 包住一个已解析的流对象，在 result() 完成后触发 postCharge，
 * 在 result() 抛错或迭代中 error 时触发 cancelReservation。
 *
 * 流对象来自 @mariozechner/pi-ai streamSimple，具有：
 *   - result(): Promise<AgentMessage>  ——流结束后返回完整 message（含 .usage）
 *   - [Symbol.asyncIterator]()        ——逐事件消费流
 *
 * 复用现有 wrap（如 wrapStreamTrimToolCallNames）同款的 result() 覆写模式。
 */
function wrapBillingStream(
  stream: Awaited<ReturnType<StreamFn>>,
  callCtx: BillingCallContext,
  hooks: BillingHooks,
  params: BillingWrapParams,
): Awaited<ReturnType<StreamFn>> {
  // --- result() 包裹 ---
  // result() 返回流完整结束后的最终 AssistantMessage，包含 .usage 字段。
  // 这是取 usage 最可靠的时机（流已完整消费完）。
  const originalResult = (stream as { result?: () => Promise<unknown> }).result?.bind(stream);

  if (originalResult) {
    (stream as { result: () => Promise<unknown> }).result = async () => {
      try {
        const message = await originalResult();
        // 从最终 message 里取 usage
        const rawUsage = (message as { usage?: unknown } | null | undefined)?.usage;
        const normalizedUsage = normalizeUsage(rawUsage as Parameters<typeof normalizeUsage>[0]);
        const costUsd = estimateUsageCost({
          usage: normalizedUsage,
          cost: params.modelCost,
        });

        // postCharge：fire-and-forget，不阻塞主流程
        // 抛错只记录警告，不影响 agent loop 继续
        hooks
          .postCharge({
            ...callCtx,
            usage: normalizedUsage,
            costUsd,
          })
          .catch((err) => {
            console.warn(
              `[billing] postCharge failed. eventId=${callCtx.eventId} err=${String(err)}`,
            );
          });

        return message;
      } catch (err) {
        // result() 抛错（流本身出错 / abort）→ cancelReservation
        hooks.cancelReservation(callCtx).catch((cancelErr) => {
          console.warn(
            `[billing] cancelReservation failed. eventId=${callCtx.eventId} err=${String(cancelErr)}`,
          );
        });
        throw err;
      }
    };
  }

  // --- [Symbol.asyncIterator] 包裹 ---
  // 在迭代中途出错时也触发 cancelReservation。
  // 注意：result() 是权威来源；asyncIterator 的包裹只是防御层，
  // 避免调用方只迭代不调 result() 时漏掉 cancel。
  // 已经通过 result() 触发过 postCharge/cancel 的情况下，这里的 cancel 是幂等的
  // （Yuiclaw extension 侧用 eventId 做幂等处理）。
  const originalAsyncIterator = (
    stream as { [Symbol.asyncIterator]: () => AsyncIterator<unknown> }
  )[Symbol.asyncIterator]?.bind(stream);

  if (originalAsyncIterator) {
    (stream as { [Symbol.asyncIterator]: () => AsyncIterator<unknown> })[Symbol.asyncIterator] =
      function () {
        const iterator = originalAsyncIterator();
        return {
          async next() {
            try {
              return await iterator.next();
            } catch (err) {
              // 迭代中途抛错（流 error / abort）
              hooks.cancelReservation(callCtx).catch((cancelErr) => {
                console.warn(
                  `[billing] cancelReservation (iter) failed. eventId=${callCtx.eventId} err=${String(cancelErr)}`,
                );
              });
              throw err;
            }
          },
          async return(value?: unknown) {
            return iterator.return?.(value) ?? { done: true as const, value: undefined };
          },
          async throw(error?: unknown) {
            return iterator.throw?.(error) ?? { done: true as const, value: undefined };
          },
        };
      };
  }

  return stream;
}
