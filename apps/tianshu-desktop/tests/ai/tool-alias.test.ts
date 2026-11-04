/** 工具名精简批次（2026-10-29 用户裁定）别名层三件：
 * ① canonicalToolName 纯映射——20 老名→15 新名单源在 @tianshu/core/tool-alias，
 *    三端（electron/src-react/server）与测试共用同一契约；
 * ② filterDisabledTools 禁用名单归一——toolPermission DB 存老名（用户禁用
 *    read_file），改名后禁用语义必须延续（禁用=对模型不存在，SP6）；
 * ③ runChatStream 别名分发——模型模仿历史块发出老名 tool_call（编辑重发
 *    场景），经 ToolNode 子类归一后由新名工具执行（绑定面只出新名 schema） */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
}));

vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    message: { findMany: async () => [] },
  },
}));

import { z } from "zod";
import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
import {
  canonicalToolName,
  TOOL_NAME_ALIASES,
} from "../../packages/tianshu-core/src/tool-alias";
import {
  filterDisabledTools,
  registerTools,
  registry,
} from "../../electron/domains/ai/agent/tool-registry";
import { runChatStream } from "../../electron/domains/ai/chat/chat.service";
import { scriptedChatModel } from "./helpers/scripted-chat-model";
import type { ToolDefinition } from "../../electron/domains/ai/agent/file-tools";
import type { AgentStreamOptions } from "../../electron/domains/ai/agent/tool-gate";
import type { ChatStreamChunk } from "../../src-react/domains/ai/api/chat.api";

const userHistory = [
  {
    role: "user" as const,
    blocks: JSON.stringify([{ type: "text", text: "hi" }]),
  },
];

const makeAgent = (): AgentStreamOptions => ({
  sessionId: 1,
  workspacePath: "/tmp/ws",
  fullAccess: () => true,
  isToolAllowed: async () => true,
  requestApproval: () => new Promise<boolean>(() => {}),
});

describe("canonicalToolName（别名单源契约）", () => {
  it("20 老名全部映射到 15 新名，无遗漏无多余", () => {
    expect(Object.keys(TOOL_NAME_ALIASES).sort()).toEqual(
      [
        "read_file",
        "write_file",
        "list_dir",
        "search_files",
        "delete_file",
        "run_command",
        "web_fetch",
        "open_browser",
        "plan_create_item",
        "plan_update_status",
        "plan_append_summary",
        "plan_list_items",
        "plan_get_item",
        "create_automation_task",
        "recommend_experts",
        "dispatch_member",
        "create_workflow",
        "update_workflow",
        "list_workflows",
        "get_workflow",
      ].sort(),
    );
  });

  it("核心 8 名映射正确", () => {
    expect(canonicalToolName("read_file")).toBe("read");
    expect(canonicalToolName("write_file")).toBe("write");
    expect(canonicalToolName("list_dir")).toBe("ls");
    expect(canonicalToolName("search_files")).toBe("grep");
    expect(canonicalToolName("delete_file")).toBe("rm");
    expect(canonicalToolName("run_command")).toBe("bash");
    expect(canonicalToolName("web_fetch")).toBe("fetch");
    expect(canonicalToolName("open_browser")).toBe("browse");
  });

  it("plan 五件坍缩到 todo_write/todo_read，workflow 四件坍缩到 write/read", () => {
    expect(canonicalToolName("plan_create_item")).toBe("todo_write");
    expect(canonicalToolName("plan_update_status")).toBe("todo_write");
    expect(canonicalToolName("plan_append_summary")).toBe("todo_write");
    expect(canonicalToolName("plan_list_items")).toBe("todo_read");
    expect(canonicalToolName("plan_get_item")).toBe("todo_read");
    expect(canonicalToolName("create_workflow")).toBe("workflow_write");
    expect(canonicalToolName("update_workflow")).toBe("workflow_write");
    expect(canonicalToolName("list_workflows")).toBe("workflow_read");
    expect(canonicalToolName("get_workflow")).toBe("workflow_read");
  });

  it("新名/未知名/mcp 前缀原样透传", () => {
    expect(canonicalToolName("read")).toBe("read");
    expect(canonicalToolName("browser_click")).toBe("browser_click");
    expect(canonicalToolName("run_workflow")).toBe("run_workflow");
    expect(canonicalToolName("mcp__github_create_issue")).toBe(
      "mcp__github_create_issue",
    );
  });
});

describe("filterDisabledTools（禁用名单老名归一）", () => {
  it("DB 存老名 read_file 照样禁掉新名 read 工具", () => {
    const defs = [{ name: "read" }, { name: "browser_click" }];
    expect(filterDisabledTools(defs, ["read_file"])).toEqual([
      { name: "browser_click" },
    ]);
  });

  it("新名直禁与新名透传互不影响（双向兼容）", () => {
    const defs = [{ name: "read" }, { name: "write" }];
    expect(filterDisabledTools(defs, ["read"])).toEqual([{ name: "write" }]);
    expect(filterDisabledTools(defs, [])).toHaveLength(2);
  });
});

describe("registry.find（老名查找归一）", () => {
  it("find(\"read_file\") 归一命中内置新名 read 工具", () => {
    // registry 初始集已含改名后的内置 read（file-tools），老名经归一
    // 命中同名工具（toBe 具体实例在初始集先行注册时不成立，按名断言）
    expect(registry.find("read_file")?.name).toBe("read");
    expect(registry.find("read")?.name).toBe("read");
    expect(registry.find("bash")?.name).toBe("bash");
    expect(registry.find("run_command")?.name).toBe("bash");
  });
});

describe("runChatStream 别名分发（模型发老名 → 新名工具执行）", () => {
  const makeReadTool = (
    execute: ToolDefinition<{ path: string }>["execute"] = async () =>
      "     1| hello",
  ): ToolDefinition<{ path: string }> => ({
    name: "read",
    description: "测试读工具",
    parameters: z.object({ path: z.string() }),
    kind: "read",
    execute: vi.fn(execute),
  });

  /** 第二次模型调用收到的首条 ToolMessage（引擎回喂） */
  const fedToolResult = (calls: Array<{ messages: BaseMessage[] }>) => {
    for (const call of calls.slice(1)) {
      for (const message of call.messages) {
        if (message instanceof ToolMessage) {
          return {
            toolCallId: message.tool_call_id,
            toolName: message.name ?? "",
            value:
              typeof message.content === "string" ? message.content : "",
          };
        }
      }
    }
    return null;
  };

  it("老名 read_file 的 tool_call 由新名 read 工具执行并回喂结果", async () => {
    const readTool = makeReadTool();
    const { model } = scriptedChatModel([
      {
        steps: [
          {
            kind: "tool",
            toolCallId: "t1",
            toolName: "read_file",
            input: { path: "a.txt" },
          },
        ],
      },
      { steps: [{ kind: "text", delta: "done" }] },
    ]);
    const calls = (
      model as unknown as { callsLog: Array<{ messages: BaseMessage[] }> }
    ).callsLog;
    const chunks: ChatStreamChunk[] = [];

    const result = await runChatStream({
      model,
      history: userHistory,
      params: {},
      toolDefinitions: [readTool],
      agent: makeAgent(),
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(readTool.execute).toHaveBeenCalledTimes(1);
    // 回喂的 ToolMessage 以新名（工具本体视角）出现
    expect(fedToolResult(calls)).toMatchObject({
      toolCallId: "t1",
      toolName: "read",
      value: "     1| hello",
    });
    const toolBlocks = result.blocks.filter(
      (block) => block.type === "tool_call",
    );
    expect(toolBlocks).toHaveLength(1);
    expect(toolBlocks[0]).toMatchObject({ state: "done" });
  });

  it("新名 read 直呼路径不受别名层影响（回归守护）", async () => {
    const readTool = makeReadTool();
    const { model } = scriptedChatModel([
      {
        steps: [
          {
            kind: "tool",
            toolCallId: "t1",
            toolName: "read",
            input: { path: "a.txt" },
          },
        ],
      },
      { steps: [{ kind: "text", delta: "done" }] },
    ]);

    const result = await runChatStream({
      model,
      history: userHistory,
      params: {},
      toolDefinitions: [readTool],
      agent: makeAgent(),
    });

    expect(readTool.execute).toHaveBeenCalledTimes(1);
    expect(
      result.blocks.filter((block) => block.type === "tool_call"),
    ).toHaveLength(1);
  });
});
