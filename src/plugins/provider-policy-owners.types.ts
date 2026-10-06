import type { PluginManifestRecord } from "./manifest-registry.types.js";

/**
 * 回搬自上游 provider 策略查询性能修复系列（#144290/#145921/#146123/#149528/#155241/#155250，
 * ADR-0033 任务 72/84）。对一份插件注册表（registry.plugins）预先建好的 provider 归属索引：
 * - bundled：每个归一化 providerId 对应"按插件 id 字典序最先"的那个随包插件（与旧实现的
 *   toSorted 稳定排序语义保持一致，只是提前算好、不再每次调用重算）。
 * - trusted：每个归一化 providerId 对应按插件 id 字典序排好的、受信任的外部已安装插件列表。
 */
export type ProviderPolicyOwnerIndex = {
  bundled: Map<string, PluginManifestRecord>;
  trusted: Map<string, PluginManifestRecord[]>;
};
