/**
 * MCP 折叠会话级自适应——chat 装配面接线（skills-tools-mcp §6-3）：
 * collectToolDefinitions 的 MCP 前缀面替换为 manager 自适应面（按会话
 * contextWindow 动态调线）；未安装 manager 时回落 registry 静态线
 * （测试/局部装配零扰动）。与 mcp-manager.test.ts 的 adaptiveDefinitions
 * 直测互补，此处钉「装配层真的换了面 + 窗口真的透传」。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

import {
  McpManager,
  installMcpAdaptiveSource,
  type McpClientLike,
  type McpServerConfig,
} from "../../electron/domains/ai/agent/mcp-manager";
import {
  registry,
  registerTools,
  unregisterTools,
} from "../../electron/domains/ai/agent/tool-registry";
import ChatService from "../../electron/domains/ai/chat/chat.service";
import type { ToolDefinition } from "../../electron/domains/ai/agent/file-tools";

const server: McpServerConfig = {
  id: 1,
  name: "srv",
  transport: "stdio",
  command: "npx",
  args: ["-y", "fake-mcp"],
};

const client: McpClientLike = {
  listTools: async () => ({
    tools: [
      {
        name: "tool_a",
        description: "A".repeat(3000),
        inputSchema: { type: "object" },
      },
    ],
  }),
  callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
  close: async () => {},
};

const fakeMcpTool = (name: string): ToolDefinition => ({
  name,
  description: `伪 ${name}`,
  parameters: {},
  kind: "read",
  execute: async () => "ok",
});

afterEach(() => {
  installMcpAdaptiveSource(null);
  unregisterTools("mcp__");
});

/** 经 internals 直调 collectToolDefinitions（签名后两位固定：非项目/无门控） */
const collect = (svc: ChatService, modelContextWindow?: number | null) =>
  (
    svc as unknown as {
      collectToolDefinitions: (
        agent: unknown,
        skills: unknown[],
        isProjectSession: boolean,
        team: unknown,
        gate: unknown,
        expertRecommend: boolean,
        modelContextWindow?: number | null,
      ) => ToolDefinition[];
    }
  ).collectToolDefinitions(
    { workspacePath: "/tmp/ws", isToolAllowed: async () => false },
    [],
    false,
    null,
    { scenario: null, assistantBound: false, workflowCreatorEnabled: false },
    false,
    modelContextWindow,
  );

describe("collectToolDefinitions MCP 自适应面接线", () => {
  it("已安装 manager：registry 静态折叠面被替换为按窗口的自适应面", async () => {
    const manager = new McpManager({
      createClient: async () => client,
      prisma: { mcpServer: { findMany: async () => [] } },
    });
    await manager.connect(server);
    // 单工具 ≈1.5K token：静态线 4000 内直注（registry 面为直接工具）
    expect(registry.getDefinitions().some((d) => d.name === "mcp__srv__tool_a")).toBe(
      true,
    );
    // 干扰项：registry 内另挂一个静态注册的伪 mcp 工具——必须被自适应面替换掉
    registerTools([fakeMcpTool("mcp__stale__ghost")]);

    installMcpAdaptiveSource(manager);
    const svc = new ChatService(
      { assertSessionOwned: async () => {}, getSession: async () => null } as never,
      undefined,
      null as never,
    );

    // 32K 窗（预算 1000 < 1.5K）：折叠为聚合两跳
    const small = collect(svc, 32 * 1024).map((d) => d.name);
    expect(small).toContain("mcp__srv__list_tools");
    expect(small).toContain("mcp__srv__call_tool");
    expect(small).not.toContain("mcp__srv__tool_a");
    // 静态注册的伪 mcp 面不再出现（registry mcp__ 前缀整体让位）
    expect(small).not.toContain("mcp__stale__ghost");

    // 标准窗（128K，预算 4000 > 1.5K）：直注
    const standard = collect(svc, 131072).map((d) => d.name);
    expect(standard).toContain("mcp__srv__tool_a");
    expect(standard).not.toContain("mcp__srv__call_tool");
  });

  it("未安装 manager：registry 静态面原样透出（测试/局部装配零扰动）", () => {
    registerTools([fakeMcpTool("mcp__plain__tool")]);
    const svc = new ChatService(
      { assertSessionOwned: async () => {}, getSession: async () => null } as never,
      undefined,
      null as never,
    );
    const names = collect(svc).map((d) => d.name);
    expect(names).toContain("mcp__plain__tool");
  });
});
