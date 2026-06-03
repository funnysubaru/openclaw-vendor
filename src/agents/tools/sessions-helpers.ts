export type {
  AgentToAgentPolicy,
  SessionAccessAction,
  SessionAccessResult,
  SessionToolsVisibility,
} from "./sessions-access.js";
export {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxSessionToolsVisibility,
  resolveSandboxedSessionToolContext,
  resolveSessionToolsVisibility,
} from "./sessions-access.js";
export type { SessionReferenceResolution } from "./sessions-resolution.js";
export {
  isRequesterSpawnedSessionVisible,
  isResolvedSessionVisibleToRequester,
  listSpawnedSessionKeys,
  looksLikeSessionId,
  looksLikeSessionKey,
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  resolveSessionReference,
  resolveVisibleSessionReference,
  shouldResolveSessionIdInput,
  shouldVerifyRequesterSpawnedSessionVisibility,
} from "./sessions-resolution.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-resolution.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { sanitizeUserFacingText } from "../pi-embedded-helpers.js";
import {
  stripDowngradedToolCallText,
  stripMinimaxToolCallXml,
  stripModelSpecialTokens,
  stripThinkingTagsFromText,
} from "../pi-embedded-utils.js";

export type SessionKind = "main" | "group" | "cron" | "hook" | "node" | "other";

export type SessionListDeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
};

export type SessionListRow = {
  key: string;
  kind: SessionKind;
  channel: string;
  label?: string;
  displayName?: string;
  deliveryContext?: SessionListDeliveryContext;
  updatedAt?: number | null;
  sessionId?: string;
  model?: string;
  contextTokens?: number | null;
  totalTokens?: number | null;
  thinkingLevel?: string;
  verboseLevel?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  sendPolicy?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  transcriptPath?: string;
  messages?: unknown[];
};

function normalizeKey(value?: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function classifySessionKind(params: {
  key: string;
  gatewayKind?: string | null;
  alias: string;
  mainKey: string;
}): SessionKind {
  const key = params.key;
  if (key === params.alias || key === params.mainKey) {
    return "main";
  }
  if (key.startsWith("cron:")) {
    return "cron";
  }
  if (key.startsWith("hook:")) {
    return "hook";
  }
  if (key.startsWith("node-") || key.startsWith("node:")) {
    return "node";
  }
  if (params.gatewayKind === "group") {
    return "group";
  }
  if (key.includes(":group:") || key.includes(":channel:")) {
    return "group";
  }
  return "other";
}

export function deriveChannel(params: {
  key: string;
  kind: SessionKind;
  channel?: string | null;
  lastChannel?: string | null;
}): string {
  if (params.kind === "cron" || params.kind === "hook" || params.kind === "node") {
    return "internal";
  }
  const channel = normalizeKey(params.channel ?? undefined);
  if (channel) {
    return channel;
  }
  const lastChannel = normalizeKey(params.lastChannel ?? undefined);
  if (lastChannel) {
    return lastChannel;
  }
  const parts = params.key.split(":").filter(Boolean);
  if (parts.length >= 3 && (parts[1] === "group" || parts[1] === "channel")) {
    return parts[0];
  }
  return "unknown";
}

export function stripToolMessages(messages: unknown[]): unknown[] {
  return messages.filter((msg) => {
    if (!msg || typeof msg !== "object") {
      return true;
    }
    const role = (msg as { role?: unknown }).role;
    return role !== "toolResult" && role !== "tool";
  });
}

/**
 * Sanitize text content to strip tool call markers and thinking tags.
 * This ensures user-facing text doesn't leak internal tool representations.
 */
export function sanitizeTextContent(text: string): string {
  if (!text) {
    return text;
  }
  return stripThinkingTagsFromText(
    stripDowngradedToolCallText(stripModelSpecialTokens(stripMinimaxToolCallXml(text))),
  );
}

export function extractAssistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  if ((message as { role?: unknown }).role !== "assistant") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const joined =
    extractTextFromChatContent(content, {
      sanitizeText: sanitizeTextContent,
      joinWith: "",
      normalizeText: (text) => text.trim(),
    }) ?? "";
  const stopReason = (message as { stopReason?: unknown }).stopReason;
  // Gate on stopReason only — a non-error response with a stale/background errorMessage
  // should not have its content rewritten with error templates (#13935).
  const errorContext = stopReason === "error";

  return joined ? sanitizeUserFacingText(joined, { errorContext }) : undefined;
}

/**
 * 会话级 abort 闸专用的 controller session key 归一化。
 *
 * 业务意图：这是整个 abort-cascade 特性的「头号正确性保证」——
 * 打标（标记 controller 已 abort）、announce 查闸（子 agent 唤醒时判断）、
 * spawn 查闸（spawn 新子 agent 时判断）、清除（abort 完成后清 flag）
 * 四处必须使用同一个 canonical key，否则会出现「打了标但查不到、清了别的 key」的幽灵 bug。
 *
 * 实现与 abort.ts 历史上的 normalizeRequesterSessionKey 完全一致——
 * 抽到这里做单一来源，abort.ts 改为委托调用，不再持有独立副本。
 *
 * 关键边界：
 * - key 为空/纯空白 → undefined（后续调用方可安全做 early-return）
 * - resolveInternalSessionKey 会把 alias/mainKey 归一成统一形式，
 *   保证 "main" / "global" / 主 key 等多种写法都映射到同一个 canonical key
 */
export function normalizeControllerSessionKey(
  cfg: OpenClawConfig,
  key: string | undefined,
): string | undefined {
  const cleaned = key?.trim();
  if (!cleaned) {
    return undefined;
  }
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  return resolveInternalSessionKey({ key: cleaned, alias, mainKey });
}
