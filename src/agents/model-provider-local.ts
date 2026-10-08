/** Shared local model-provider URL classification. */
import { isLoopbackIpAddress, isRfc1918Ipv4Address } from "@openclaw/net-policy/ip";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

// ADR-0033 任务72第二批（已查上游：isLoopbackIpAddress / isRfc1918Ipv4Address 的实现在
// @openclaw/net-policy/ip 这个独立发布的依赖包里，不在本仓库源码范围内，这个 PR 改不到它，
// 也没找到上游对这两个判断本身加缓存的提交）。CPU profile 实测这一步单独占 2.7 秒 self
// time，由 hasSyntheticLocalProviderAuthConfig 在整份模型目录的 unprofiledEvaluation 里对
// 同一个 provider baseUrl 反复调用触发。这两个判断合起来是纯函数——只吃 host 这一个字符串
// 入参，不读 env/fs/任何可变状态，所以按 host 字符串做缓存没有任何失效边界需要考虑（不像
// realpath 那种会因为文件系统变化而失效的缓存）：同一个 host 永远得到同一个布尔结果。
const loopbackOrRfc1918HostCache = new Map<string, boolean>();
function isLoopbackOrRfc1918Ipv4HostCached(host: string): boolean {
  const cached = loopbackOrRfc1918HostCache.get(host);
  if (cached !== undefined) {
    return cached;
  }
  const result = isLoopbackIpAddress(host) || isRfc1918Ipv4Address(host);
  loopbackOrRfc1918HostCache.set(host, result);
  return result;
}

export function isLocalProviderBaseUrl(
  baseUrl: string,
  additionalHostnames?: ReadonlySet<string>,
): boolean {
  try {
    let host = normalizeLowercaseStringOrEmpty(new URL(baseUrl).hostname);
    if (host.startsWith("[") && host.endsWith("]")) {
      host = host.slice(1, -1);
    }
    return (
      host === "localhost" ||
      host === "0.0.0.0" ||
      host.endsWith(".local") ||
      additionalHostnames?.has(host) === true ||
      isLoopbackOrRfc1918Ipv4HostCached(host)
    );
  } catch {
    return false;
  }
}
