/**
 * MCP 入口预判与 stdio env 单测（SP5 Task 4）：
 * http url deny 抛错（不触 SDK 构造）、放行与 stdio 缺省不判、
 * mergeStdioEnv 门未装/门装+代理两态。
 */
import { describe, expect, it } from "vitest";
import type { NetworkPolicyState } from "../../electron/domains/security/domain-policy";
import {
  assertMcpUrlAllowed,
  mergeStdioEnv,
} from "../../electron/domains/ai/agent/mcp-manager";
import {
  installNetworkGate,
  uninstallNetworkGateForTest,
} from "../../electron/domains/security/network-gate";

/** 判定输入用全量策略（judgeDomain 直读各名单字段，部分态会抛错走 fail-open） */
const policy = (over: Partial<NetworkPolicyState>): NetworkPolicyState => ({
  exemptDomains: [],
  domainAllow: [],
  domainDeny: [],
  blockAllNetwork: false,
  maliciousDomainProtection: false,
  ...over,
});

describe("MCP 入口预判与 stdio env（SP5）", () => {
  it("http url deny 命中 → 抛错（未触 SDK 构造）", () => {
    installNetworkGate({
      policyProvider: () => policy({ domainDeny: ["evil.com"] }),
      audit: () => {},
    });
    expect(() =>
      assertMcpUrlAllowed({
        id: 1,
        name: "s",
        transport: "http",
        url: "https://evil.com/mcp",
      }),
    ).toThrow(/网络安全策略已拒绝 evil.com/);
    uninstallNetworkGateForTest();
  });

  it("放行不抛；stdio url 缺省不判", () => {
    installNetworkGate({
      policyProvider: () => policy({}),
      audit: () => {},
    });
    expect(() =>
      assertMcpUrlAllowed({
        id: 1,
        name: "s",
        transport: "http",
        url: "https://ok.com/mcp",
      }),
    ).not.toThrow();
    expect(() =>
      assertMcpUrlAllowed({
        id: 1,
        name: "s",
        transport: "stdio",
        command: "npx",
      }),
    ).not.toThrow();
    uninstallNetworkGateForTest();
  });

  it("mergeStdioEnv：门未装返回原 env；门装+代理时合并注入", () => {
    expect(
      mergeStdioEnv({
        id: 1,
        name: "s",
        transport: "stdio",
        command: "npx",
        env: { A: "1" },
      }),
    ).toEqual({ A: "1" });
    const gate = installNetworkGate({
      policyProvider: () => policy({}),
      audit: () => {},
    });
    gate.setProxyUrl("http://127.0.0.1:3128");
    expect(
      mergeStdioEnv({
        id: 1,
        name: "s",
        transport: "stdio",
        command: "npx",
        env: { A: "1" },
      }),
    ).toEqual({
      A: "1",
      HTTPS_PROXY: "http://127.0.0.1:3128",
      HTTP_PROXY: "http://127.0.0.1:3128",
      ALL_PROXY: "http://127.0.0.1:3128",
      NO_PROXY: "localhost,127.0.0.1,::1",
    });
    uninstallNetworkGateForTest();
  });
});
