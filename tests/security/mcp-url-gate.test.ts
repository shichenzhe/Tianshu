/**
 * MCP 入口预判与 stdio env 单测（SP5 Task 4）：
 * http url deny 抛错（不触 SDK 构造）、放行与 stdio 缺省不判、
 * checkUrl 抛错 fail-open 放行（终审 S2：客户端照常创建 + winston error）、
 * mergeStdioEnv 门未装/门装+代理两态。
 * mcp-manager/network-gate 传递依赖 Log（→ electron），经 vi.mock 替换。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../electron/commons/Log", () => ({
  default: { error: vi.fn() },
}));

import Log from "../../electron/commons/Log";
import type { NetworkPolicyState } from "../../electron/domains/security/domain-policy";
import {
  assertMcpUrlAllowed,
  McpManager,
  mergeStdioEnv,
  type McpClientLike,
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

  it("checkUrl 抛错 → 客户端照常创建（fail-open 放行）+ winston error（终审 S2）", async () => {
    installNetworkGate({
      policyProvider: () => policy({}),
      audit: () => {},
    });
    const client: McpClientLike = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
    };
    const manager = new McpManager({
      // 生产 createClient 内嵌 assertMcpUrlAllowed：注入抛错的 checkUrl 须被吸收
      createClient: async (row) => {
        assertMcpUrlAllowed(row, () => {
          throw new Error("check boom");
        });
        return client;
      },
      prisma: { mcpServer: { findMany: async () => [] } },
    });
    await manager.connect({
      id: 1,
      name: "s",
      transport: "http",
      url: "https://ok.com/mcp",
    });
    expect(manager.getStatuses()[0]).toMatchObject({ state: "connected" });
    expect(vi.mocked(Log.error)).toHaveBeenCalledWith(
      expect.stringContaining("https://ok.com/mcp"),
    );
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
