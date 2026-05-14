/**
 * cron/validate-delivery-channel —— `cron.add` / `cron.update` 入口的 channel
 * 白名单校验。在 schema (Ajv) 校验之后、落库之前拦下"非 deliverable channel id
 * 灌入 delivery.channel 字段"的事故。
 *
 * 业务意图（详见 Yuiclaw 项目 plan §2 根因 + CLAUDE.md §8 Debugging Protocol）：
 * 2026-05-13 实战发现 AI 调 cron tool 时把 `openclaw-control-ui` (client id) 误记成
 * `webchat-control-ui` 写进 cron.delivery.channel 字段。schema 只检查"是否非空 string"，
 * vendor 落库后等到运行时 channel-selection 抛"Channel is required when multiple
 * channels are configured" 错误，cron 静默失败。
 *
 * 白名单 = `listDeliverableMessageChannels()` ∪ `INTERNAL_MESSAGE_CHANNEL` (webchat):
 *   - line / telegram / slack / signal / discord / 其它 plugin channels 都来自前者
 *   - webchat 作为合法投递目标（详见 cron delivery-target.ts 的 webchat 分支：
 *     `delivery.to` 作为 sessionKey，让 cron 投到 panel 指定 webchat session）
 */

import {
  INTERNAL_MESSAGE_CHANNEL,
  listDeliverableMessageChannels,
} from "../utils/message-channel.js";
import type { CronJobCreate, CronJobPatch } from "./types.js";

/**
 * 计算当前合法的 cron delivery.channel 白名单（含动态 plugin channels + webchat）。
 * 抽函数让 cron.add / cron.update / 单测共用同一定义。
 */
export function listValidCronDeliveryChannels(): string[] {
  const deliverable = listDeliverableMessageChannels() as readonly string[];
  return [...deliverable, INTERNAL_MESSAGE_CHANNEL];
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
  // announce 之外的 mode 不需要 channel（none / webhook 已在别处校验）
  if (d.mode !== "announce") return { ok: true };
  // announce 模式但 channel 字段缺失/非 string 走旧逻辑兜底（vendor 自己会按 fallback
  // 解析 last channel 或抛 "Channel is required..."），这里只拦"非法字面量"的场景
  if (typeof d.channel !== "string" || !d.channel.trim()) return { ok: true };
  const channel = d.channel.trim();
  const allowed = listValidCronDeliveryChannels();
  if (!allowed.includes(channel)) {
    return {
      ok: false,
      message:
        `delivery.channel "${channel}" is not a valid delivery target. ` +
        `Allowed: ${allowed.join(", ")}. (Use "webchat" to deliver into the panel ` +
        `webchat conversation specified by delivery.to as sessionKey.)`,
    };
  }
  return { ok: true };
}

/**
 * 便捷包装：从 cron.add 的 jobCreate / cron.update 的 patch 里抽出 delivery 字段做校验。
 */
export function validateCronJobCreateDelivery(
  jobCreate: CronJobCreate,
): CronDeliveryChannelValidation {
  return validateCronDeliveryChannel((jobCreate as { delivery?: unknown }).delivery);
}

export function validateCronJobPatchDelivery(
  patch: CronJobPatch | Record<string, unknown>,
): CronDeliveryChannelValidation {
  return validateCronDeliveryChannel((patch as { delivery?: unknown }).delivery);
}
