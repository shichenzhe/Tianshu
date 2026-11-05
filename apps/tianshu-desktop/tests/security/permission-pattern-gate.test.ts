/**
 * 参数级审批 pattern 的执行门行为（security P1-3 / skills-tools-mcp §6-6）：
 * runToolCall 记忆查表——ask 级来源（cmdAsk bash / 文件门 block）可被
 * 工作空间记忆抑制（pattern 行参数级匹配 / 无 pattern 行旧全等语义），
 * 硬线（危险分级/批量删除）永不被记忆抑制（对齐 WorkBuddy bypass
 * 「requires confirmation every time」）。isToolAllowed 双参形态与
 * 旧签名桩兼容性同钉。
 */
import { describe, expect, it, vi } from "vitest";

// tool-gate 传递依赖 Log → electron（prisma-client 顶层读 app.getPath）
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
}));

import { runToolCall } from "../../electron/domains/ai/agent/tool-gate";
import type { AgentStreamOptions } from "../../electron/domains/ai/agent/tool-gate";
import type { ToolDefinition } from "../../electron/domains/ai/agent/file-tools";

const bashDef: ToolDefinition = {
  name: "bash",
  description: "bash",
  parameters: {},
  kind: "write",
  execute: async () => "done",
};

const makeAgent = (
  overrides: Partial<AgentStreamOptions> = {},
): AgentStreamOptions => ({
  sessionId: 1,
  workspacePath: "/tmp/ws",
  fullAccess: () => false,
  isToolAllowed: async () => false,
  requestApproval: async () => true,
  ...overrides,
});

describe("runToolCall 记忆抑制面（参数级审批批）", () => {
  it("isToolAllowed 收到 input：pattern 匹配判定在装配实现侧（透传即达）", async () => {
    const isToolAllowed = vi.fn(async () => false);
    const decideCommand = () => "ask" as const;
    await runToolCall(
      bashDef,
      makeAgent({ isToolAllowed, decideCommand }),
      "t1",
      { command: "git push" },
      undefined,
    );
    expect(isToolAllowed).toHaveBeenCalledWith("bash", { command: "git push" });
  });

  it("bash cmdAsk 命中记忆免审（旧签名 `(toolName) => boolean` 桩兼容生效）", async () => {
    const requestApproval = vi.fn(async () => true);
    const agent = makeAgent({
      // 旧式单参实现——对新增可选参天然兼容（TS 结构化函数赋值）
      isToolAllowed: (async (toolName: string) => toolName === "bash") as never,
      decideCommand: () => "ask" as const,
      requestApproval,
    });
    const out = await runToolCall(bashDef, agent, "t1", { command: "x" }, undefined);
    expect(requestApproval).not.toHaveBeenCalled();
    expect(out).toBe("done");
  });

  it("bash cmdAsk 未命中记忆照旧挂审批（行为不回归）", async () => {
    const requestApproval = vi.fn(async () => true);
    const agent = makeAgent({
      isToolAllowed: async () => false,
      decideCommand: () => "ask" as const,
      requestApproval,
    });
    await runToolCall(bashDef, agent, "t1", { command: "x" }, undefined);
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it("危险分级硬线不被记忆抑制：HIGH 命令记忆命中仍审批（bypass 每次确认）", async () => {
    const requestApproval = vi.fn(async () => true);
    const agent = makeAgent({
      isToolAllowed: async () => true,
      requestApproval,
    });
    // rm -rf / 为危险表 HIGH/CRITICAL 命令（assessCommandRisk 表内项）
    await runToolCall(bashDef, agent, "t1", { command: "rm -rf /" }, undefined);
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it("无 ask 来源不触表：default 档普通命令零额外查询（热路径零开销）", async () => {
    const isToolAllowed = vi.fn(async () => true);
    const agent = makeAgent({ isToolAllowed });
    await runToolCall(bashDef, agent, "t1", { command: "ls" }, undefined);
    expect(isToolAllowed).not.toHaveBeenCalled();
  });

  it("read 类工具（kind read）的文件门 block 不查记忆——新抑制面限 write", async () => {
    const isToolAllowed = vi.fn(async () => true);
    const readDef: ToolDefinition = {
      name: "read",
      description: "read",
      parameters: {},
      kind: "read",
      execute: async () => "content",
    };
    const requestApproval = vi.fn(async () => true);
    const agent = makeAgent({
      isToolAllowed,
      requestApproval,
      decideFileAccess: () => "block" as const,
    });
    await runToolCall(readDef, agent, "t1", { path: "secret.key" }, undefined);
    expect(isToolAllowed).not.toHaveBeenCalled();
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });
});
