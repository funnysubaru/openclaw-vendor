// 验证本地 provider baseUrl 识别逻辑，含 ADR-0033 任务72第二批新加的 host→boolean 缓存
// （isLoopbackOrRfc1918Ipv4HostCached）。缓存是按 host 字符串做的纯函数记忆化，这里重点
// 验证「不同 host 不会互相串味」——这正是本类缓存改动最容易引入隐蔽 bug 的地方：如果缓存
// key 算错（比如漏了端口/大小写规整，或者用了 baseUrl 全串而不是 host），一个本地地址判断
// 可能会污染另一个公网地址的判断结果。
import { describe, expect, it } from "vitest";
import { isLocalProviderBaseUrl } from "./model-provider-local.js";

describe("isLocalProviderBaseUrl", () => {
  it("recognizes localhost, loopback, and RFC1918 hosts regardless of call order", () => {
    // 故意把一个公网地址和多个本地地址交替调用，制造缓存命中/未命中交叉的场景：
    // 如果新加的 host 级缓存把结果存错了 key，这里会第一个暴露出来。
    expect(isLocalProviderBaseUrl("https://api.openai.com/v1")).toBe(false);
    expect(isLocalProviderBaseUrl("http://localhost:11434")).toBe(true);
    expect(isLocalProviderBaseUrl("https://api.openai.com/v1")).toBe(false);
    expect(isLocalProviderBaseUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isLocalProviderBaseUrl("http://192.168.1.50:8000")).toBe(true);
    expect(isLocalProviderBaseUrl("https://api.anthropic.com")).toBe(false);
    // 同一个 host 第二次调用必须复用缓存且结果一致（覆盖缓存命中路径本身）。
    expect(isLocalProviderBaseUrl("http://127.0.0.1:9999")).toBe(true);
    expect(isLocalProviderBaseUrl("https://api.openai.com/v2")).toBe(false);
  });

  it("recognizes .local suffix and additionalHostnames without consulting the ip cache", () => {
    expect(isLocalProviderBaseUrl("http://mybox.local:1234")).toBe(true);
    expect(isLocalProviderBaseUrl("https://gateway.internal", new Set(["gateway.internal"]))).toBe(
      true,
    );
    // 没带 additionalHostnames 时同一个 host 不应该被之前某次调用"带 alias"的结果污染——
    // additionalHostnames 的判断在代码里短路于 ip 缓存之前，不进入本次新加的缓存，
    // 这里验证两种调用方式互不影响。
    expect(isLocalProviderBaseUrl("https://gateway.internal")).toBe(false);
  });

  it("returns false for a malformed URL instead of throwing", () => {
    expect(isLocalProviderBaseUrl("not a url")).toBe(false);
  });

  it("strips IPv6 bracket notation before classifying the host", () => {
    expect(isLocalProviderBaseUrl("http://[::1]:11434")).toBe(true);
  });
});
