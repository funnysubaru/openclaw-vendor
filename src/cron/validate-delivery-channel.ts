/**
 * cron/validate-delivery-channel —— `cron.add` / `cron.update` 入口的 channel
 * 白名单校验。在 schema (Ajv) 校验之后、落库之前拦下"非 deliverable channel id
 * 灌入 delivery.channel 字段"的事故。
 *
 * **作用域**：本模块校验 `delivery.channel` 字面量是否落在白名单内。
 *   - **channel 字段一旦写入就跑白名单（PR #40 follow-up Medium 2 修复）** —— 与
 *     `delivery.mode` 无关。`mode === "none"` + 写入非法 channel 也会被拒，避免 legacy
 *     升格出 `{ mode: "none", channel: "bogus" }` 这类绕白名单的脏 DB 字段。
 *   - channel 缺失 / 非 string / 空白 —— 一律放行（不强制要求 channel 字段；missing 由
 *     vendor runtime 的 "Channel is required when multiple channels..." fallback 兜底）。
 *   - announce 之外的 mode 没有 channel 字段同样放行（none / webhook / undefined）。
 *   - 将来若新增 mode 字面量（如 "queue" / "mqtt"），channel 写入仍走同一白名单。
 *
 * 业务意图（详见 Yuiclaw 项目 plan §2 根因 + CLAUDE.md §8 Debugging Protocol）：
 * 2026-05-13 实战发现 AI 调 cron tool 时把 `openclaw-control-ui` (client id) 误记成
 * `webchat-control-ui` 写进 cron.delivery.channel 字段。schema 只检查"是否非空 string"，
 * vendor 落库后等到运行时 channel-selection 抛"Channel is required when multiple
 * channels are configured" 错误，cron 静默失败。
 *
 * **白名单 ≡ runtime 真正合法 (P1.1 修复，PR #39 follow-up review)**：
 * 白名单**等于** `listDeliverableMessageChannels()`，**不含**
 * `INTERNAL_MESSAGE_CHANNEL ("webchat")`。
 * 理由：webchat 在 vendor runtime delivery path 仍然被拒收（见
 * `src/infra/outbound/targets.ts:179` "Delivering to WebChat is not supported"），
 * 把 webchat 加进 add/update 白名单只会让
 * `{ delivery: { mode: "announce", channel: "webchat" } }` 通过 add/update 校验、
 * 但等到 cron 实际跑完才抛 delivery-target error —— 与"add/update 时立即拦下"的
 * 初衷相反。
 *
 * Yuiclaw (Y) 方案的"投到 panel session"**不**走 `delivery.channel = "webchat"`，
 * 走 `job.sessionKey` 复用：
 *   - `job.sessionKey = "agent:<...>:panel-<...>"` (canonical agent: 前缀)
 *   - `delivery.mode = "none"` 或不配 delivery
 *   - cron isolated turn 写到该 sessionKey 派生的 jsonl，host UI 切到对应 panel tab
 *     即可看到 agent reply
 */

import { listDeliverableMessageChannels } from "../utils/message-channel.js";
import type { CronJobCreate, CronJobPatch } from "./types.js";
import { buildLegacyDeliveryPatchForServiceUpdate } from "./legacy-delivery.js";

/**
 * 计算当前合法的 cron delivery.channel 白名单 = runtime 真正可投递的 channels。
 * 抽函数让 cron.add / cron.update / 单测共用同一定义。
 *
 * **不含** webchat —— webchat session 复用走 `job.sessionKey`，不是 delivery target
 * (详见文件头 P1.1 注释)。
 */
export function listValidCronDeliveryChannels(): string[] {
  return [...(listDeliverableMessageChannels() as readonly string[])];
}

export type CronDeliveryChannelValidation =
  | { ok: true }
  | { ok: false; message: string };

/**
 * 校验单个 cron.delivery 对象的 channel 字段。
 * 入参用 `unknown` 是因为这步在 schema 校验之后跑，schema 已保证基本结构，
 * 但 channel 字面量本身仍需要业务白名单校验。
 *
 * 返回 `{ ok: false, message }` 时调用方应回 INVALID_REQUEST 错误。
 */
export function validateCronDeliveryChannel(
  delivery: unknown,
): CronDeliveryChannelValidation {
  if (!delivery || typeof delivery !== "object") return { ok: true };
  const d = delivery as { mode?: unknown; channel?: unknown };

  // **Channel 字段一旦写入就跑白名单（PR #40 follow-up review Medium 2 修复）**：
  // 之前只在 mode === "announce" 时校验 channel，导致 legacy `deliver: false + channel: "bogus"`
  // 升格为 `{ mode: "none", channel: "bogus" }` 时绕过 channel 白名单 → DB 留脏 channel 字段。
  // 运行时 announce 路径可能忽略 mode=none 的 channel，但下游若有人读 `delivery.channel`
  // 做 UI 路由会踩坑。现在策略：
  //   - 没写 channel（或非 string / 空白）→ ok: true（不强制要求 channel 字段）
  //   - 写了 channel 字面量 → 一律跑白名单，与 mode 无关
  if (typeof d.channel !== "string" || !d.channel.trim()) return { ok: true };
  const channel = d.channel.trim();
  const allowed = listValidCronDeliveryChannels();
  if (!allowed.includes(channel)) {
    return {
      ok: false,
      message:
        `delivery.channel "${channel}" is not a valid delivery target. ` +
        `Allowed: ${allowed.join(", ")}. ` +
        `(To make cron land in a panel webchat session, set job.sessionKey ` +
        `to that session's canonical "agent:<...>:panel-<...>" key and leave ` +
        `delivery as none/unset; do not use "webchat" as delivery.channel.)`,
    };
  }
  return { ok: true };
}

/**
 * 便捷包装：从 cron.add 的 jobCreate 抽出 delivery 字段做校验。
 *
 * cron.add 路径 (gateway handler) 调 `normalizeCronJobCreate` 时 `applyDefaults: true`，
 * 触发 `normalizeLegacyDeliveryInput` 把 legacy `payload.channel` 升格成 `delivery.channel`
 * 后再校验 → cron.add 本身覆盖 legacy 路径。
 */
export function validateCronJobCreateDelivery(
  jobCreate: CronJobCreate,
): CronDeliveryChannelValidation {
  return validateCronDeliveryChannel((jobCreate as { delivery?: unknown }).delivery);
}

/**
 * 便捷包装：从 cron.update 的 patch 抽出 delivery 字段做校验。
 *
 * **P1.2 修复（PR #39 follow-up review）**：cron.update 路径 (gateway handler) 调
 * `normalizeCronJobPatch` 时 `applyDefaults: false`，**不**触发 `normalizeLegacyDeliveryInput`
 * 的 legacy → delivery 升格 (见 normalize.ts:410 `if (options.applyDefaults)` 块)。
 * 因此 `{ patch: { payload: { kind: "agentTurn", channel: "webchat-control-ui", to: "..." } } }`
 * 会 patch.delivery === undefined → validateCronDeliveryChannel 直接 ok: true。
 * 但 service-layer `updateJob` (jobs.ts:606) 仍然走 `buildLegacyDeliveryPatch(patch.payload)`
 * 把 legacy channel 合并进 `job.delivery`，导致脏 channel 落库（复现 Bug A）。
 *
 * 修法：在 patch.delivery 缺省时，**手工跑一次** legacy 升格的预览，对升格出的
 * delivery patch 也做白名单校验。这里不修改入参 patch（保留服务层语义），仅用于校验。
 */
export function validateCronJobPatchDelivery(
  patch: CronJobPatch | Record<string, unknown>,
): CronDeliveryChannelValidation {
  const directDelivery = (patch as { delivery?: unknown }).delivery;
  if (directDelivery !== undefined) {
    return validateCronDeliveryChannel(directDelivery);
  }
  // patch.delivery 缺省时，**用 service-layer 实际使用的同一升格函数**
  // (`buildLegacyDeliveryPatchForServiceUpdate`) 做预览，对升格出的 delivery
  // 也跑白名单。这样确保 gateway 校验和 service 落库走同一逻辑（PR #40
  // follow-up review Medium 1）。
  const payload = (patch as { payload?: unknown }).payload;
  if (
    payload &&
    typeof payload === "object" &&
    (payload as { kind?: unknown }).kind === "agentTurn"
  ) {
    const legacy = buildLegacyDeliveryPatchForServiceUpdate(payload as Record<string, unknown>);
    if (legacy) {
      // 直接 validate 升格结果，让 Medium 2 修复后的"channel 字段一旦写入就跑白名单"
      // 逻辑同时覆盖 mode=none 的脏 channel 场景
      return validateCronDeliveryChannel(legacy);
    }
  }
  return { ok: true };
}
