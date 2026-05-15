export function hasLegacyDeliveryHints(payload: Record<string, unknown>) {
  if (typeof payload.deliver === "boolean") {
    return true;
  }
  if (typeof payload.bestEffortDeliver === "boolean") {
    return true;
  }
  if (typeof payload.channel === "string" && payload.channel.trim()) {
    return true;
  }
  if (typeof payload.provider === "string" && payload.provider.trim()) {
    return true;
  }
  if (typeof payload.to === "string" && payload.to.trim()) {
    return true;
  }
  return false;
}

export function buildDeliveryFromLegacyPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const deliver = payload.deliver;
  const mode = deliver === false ? "none" : "announce";
  const channelRaw =
    typeof payload.channel === "string" && payload.channel.trim()
      ? payload.channel.trim().toLowerCase()
      : typeof payload.provider === "string"
        ? payload.provider.trim().toLowerCase()
        : "";
  const toRaw = typeof payload.to === "string" ? payload.to.trim() : "";
  const next: Record<string, unknown> = { mode };
  if (channelRaw) {
    next.channel = channelRaw;
  }
  if (toRaw) {
    next.to = toRaw;
  }
  if (typeof payload.bestEffortDeliver === "boolean") {
    next.bestEffort = payload.bestEffortDeliver;
  }
  return next;
}

/**
 * Service-layer 用的 legacy → delivery patch 升格（用于 cron.update 的 patch.payload
 * 路径）。与 `buildDeliveryPatchFromLegacyPayload` 的差别：
 *   - **hasLegacyHints** 仅看 deliver / bestEffortDeliver / to，**不含 channel**：
 *     即只有 `payload.channel` 时不触发（service-layer 不会把孤立的 channel 作为
 *     升格信号）；与 `hasLegacyDeliveryHints` 的"channel 也算"宽口径**不同**。
 *   - **不读 `payload.provider`**：service-layer 只识别 `payload.channel`。
 *
 * **统一入口（PR #40 follow-up review Medium 1 修复）**：
 * 之前 `validateCronJobPatchDelivery` 走 `buildDeliveryPatchFromLegacyPayload`，
 * service-layer `updateJob` 走另一份 `buildLegacyDeliveryPatch`（曾私有在
 * jobs.ts:701）。两者触发条件不同，长期可能漂移再次造出"校验拦住 / 服务层另一条
 * 路写进去"的洞。本函数提到这里成为**共享单一源**：
 *   - service-layer `updateJob` import 这个函数（替代私有版本）
 *   - cron.update 路径的 `validateCronJobPatchDelivery` 也 import 这个函数
 *     （确保两边判断一致）
 *
 * **cron.add 与 cron.update 的对称性（PR #41 follow-up review #1）**：
 * cron.add 路径**不**走本函数 —— 走的是上游 `normalizeCronJobCreate (applyDefaults: true)`
 * → `normalizeLegacyDeliveryInput` → `buildDeliveryPatchFromLegacyPayload`（宽口径，
 * channel 单独存在就触发升格，并读 `payload.provider`）。两条路径**有意不对称**：
 *   - **cron.add** 是新 job 入口，要尽可能宽容地把历史 / 第三方客户端写的 legacy 形态
 *     升格成现代 `delivery` 结构；升格后再走相同的白名单校验。
 *   - **cron.update** 是 patch 入口，只在"真的会让 service-layer 改 job.delivery 落库"
 *     的情况下做校验（避免对孤立 `payload.channel` 之类无效 patch 误拦）。
 *   - 主事故路径 (`channel + to` / `webchat-control-ui` 类杜撰 channel) 两条路径都被
 *     拦下：cron.add 在 normalize 后由 `validateCronJobCreateDelivery` 校验；
 *     cron.update 在 patch 预览后由 `validateCronJobPatchDelivery` 校验。
 *
 * 若未来要把 add/update 统一到完全相同的升格函数，需要先评估 cron.add 收紧
 * `hasLegacyDeliveryHints`（去掉 channel-alone 和 provider）对现网 host 的兼容性。
 * 当前**有意保持不对称**，本注释作为决策落档。
 */
export function buildLegacyDeliveryPatchForServiceUpdate(
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const deliver = payload.deliver;
  const toRaw = typeof payload.to === "string" ? payload.to.trim() : "";
  const hasLegacyHints =
    typeof deliver === "boolean" ||
    typeof payload.bestEffortDeliver === "boolean" ||
    Boolean(toRaw);
  if (!hasLegacyHints) {
    return null;
  }

  const patch: Record<string, unknown> = {};
  let hasPatch = false;

  if (deliver === false) {
    patch.mode = "none";
    hasPatch = true;
  } else if (deliver === true || toRaw) {
    patch.mode = "announce";
    hasPatch = true;
  }

  if (typeof payload.channel === "string") {
    const channel = payload.channel.trim().toLowerCase();
    patch.channel = channel ? channel : undefined;
    hasPatch = true;
  }
  if (typeof payload.to === "string") {
    patch.to = payload.to.trim();
    hasPatch = true;
  }
  if (typeof payload.bestEffortDeliver === "boolean") {
    patch.bestEffort = payload.bestEffortDeliver;
    hasPatch = true;
  }

  return hasPatch ? patch : null;
}

export function buildDeliveryPatchFromLegacyPayload(payload: Record<string, unknown>) {
  const deliver = payload.deliver;
  const channelRaw =
    typeof payload.channel === "string" && payload.channel.trim()
      ? payload.channel.trim().toLowerCase()
      : typeof payload.provider === "string" && payload.provider.trim()
        ? payload.provider.trim().toLowerCase()
        : "";
  const toRaw = typeof payload.to === "string" ? payload.to.trim() : "";
  const next: Record<string, unknown> = {};
  let hasPatch = false;

  if (deliver === false) {
    next.mode = "none";
    hasPatch = true;
  } else if (
    deliver === true ||
    channelRaw ||
    toRaw ||
    typeof payload.bestEffortDeliver === "boolean"
  ) {
    next.mode = "announce";
    hasPatch = true;
  }
  if (channelRaw) {
    next.channel = channelRaw;
    hasPatch = true;
  }
  if (toRaw) {
    next.to = toRaw;
    hasPatch = true;
  }
  if (typeof payload.bestEffortDeliver === "boolean") {
    next.bestEffort = payload.bestEffortDeliver;
    hasPatch = true;
  }

  return hasPatch ? next : null;
}

export function mergeLegacyDeliveryInto(
  delivery: Record<string, unknown>,
  payload: Record<string, unknown>,
) {
  const patch = buildDeliveryPatchFromLegacyPayload(payload);
  if (!patch) {
    return { delivery, mutated: false };
  }

  const next = { ...delivery };
  let mutated = false;

  if ("mode" in patch && patch.mode !== next.mode) {
    next.mode = patch.mode;
    mutated = true;
  }
  if ("channel" in patch && patch.channel !== next.channel) {
    next.channel = patch.channel;
    mutated = true;
  }
  if ("to" in patch && patch.to !== next.to) {
    next.to = patch.to;
    mutated = true;
  }
  if ("bestEffort" in patch && patch.bestEffort !== next.bestEffort) {
    next.bestEffort = patch.bestEffort;
    mutated = true;
  }

  return { delivery: next, mutated };
}

export function normalizeLegacyDeliveryInput(params: {
  delivery?: Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
}) {
  if (!params.payload || !hasLegacyDeliveryHints(params.payload)) {
    return {
      delivery: params.delivery ?? undefined,
      mutated: false,
    };
  }

  const nextDelivery = params.delivery
    ? mergeLegacyDeliveryInto(params.delivery, params.payload)
    : {
        delivery: buildDeliveryFromLegacyPayload(params.payload),
        mutated: true,
      };
  stripLegacyDeliveryFields(params.payload);
  return {
    delivery: nextDelivery.delivery,
    mutated: true,
  };
}

export function stripLegacyDeliveryFields(payload: Record<string, unknown>) {
  if ("deliver" in payload) {
    delete payload.deliver;
  }
  if ("channel" in payload) {
    delete payload.channel;
  }
  if ("provider" in payload) {
    delete payload.provider;
  }
  if ("to" in payload) {
    delete payload.to;
  }
  if ("bestEffortDeliver" in payload) {
    delete payload.bestEffortDeliver;
  }
}
