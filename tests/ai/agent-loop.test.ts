import { describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  // Log/prisma-client 顶层读取 app.getPath("userData")/getAppPath/isPackaged
  // 计算日志与数据目录（data-root 冷迁移链路）
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
}));

const prismaStub = {
  messages: [] as Array<{
    id: number;
    sessionId: number;
    role: string;
    blocks: string;
    error: string | null;
  }>,
};

vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    message: { findMany: async () => prismaStub.messages },
  },
}));

import { z } from "zod";
import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { scriptedChatModel } from "./helpers/scripted-chat-model";
import { ipcMain } from "electron";
import ChatService, {
  runChatStream,
} from "../../electron/domains/ai/chat/chat.service";
import type { AgentStreamOptions } from "../../electron/domains/ai/agent/tool-gate";
import {
  blocksToModelMessages,
  type MessageBlock,
} from "../../electron/domains/ai/chat/blocks";
import { ApprovalCoordinator } from "../../electron/domains/ai/agent/approval";
import { generateUserToken } from "../../electron/commons/ipc-user";
import type { ToolDefinition } from "../../electron/domains/ai/agent/file-tools";
import type { ChatStreamChunk } from "../../src-react/domains/ai/api/chat.api";
import type { SessionRepository } from "../../electron/domains/ai/chat/session.repo";

const userHistory = [
  {
    role: "user" as const,
    blocks: JSON.stringify([{ type: "text", text: "hi" }]),
  },
];

// ---------- mock 模型：_streamResponseChunks 按调用序弹出脚本（换引擎替身） ----------

type ScriptStep =
  | { kind: "text"; delta: string }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
    };

/** v3 → LangChain：tool args 原样（对象经 zod schema 校验，字符串走 MCP 流） */
function agentModel(
  scripts: Array<{
    steps: ScriptStep[];
    usage?: { input: number; output: number };
  }>,
) {
  const { model } = scriptedChatModel(scripts);
  return { model, calls: model.callsLog };
}

// ---------- 工具与 agent 上下文夹具 ----------

const makeReadTool = (
  execute: ToolDefinition<{ path: string }>["execute"] = async () =>
    "     1| hello",
): ToolDefinition<{ path: string }> => ({
  name: "read_file",
  description: "测试读工具",
  parameters: z.object({ path: z.string() }),
  kind: "read",
  execute: vi.fn(execute),
});

const makeWriteTool = (
  execute: ToolDefinition<{
    path: string;
    content: string;
  }>["execute"] = async () => "已写入 a.txt（2 字节）",
  // name 可覆写：权限放宽（spec §4.4）后 write_file 免审，审批挂起用例
  // 改走仍在兜底审批面的 delete_file（delete=ask 裁定）
  name = "write_file",
): ToolDefinition<{ path: string; content: string }> => ({
  name,
  description: "测试写工具",
  parameters: z.object({ path: z.string(), content: z.string() }),
  kind: "write",
  execute: vi.fn(execute),
});

const makeAgent = (
  approvals: ApprovalCoordinator,
  fullAccess = false,
  allowedTools: string[] = [],
): AgentStreamOptions => ({
  sessionId: 1,
  workspacePath: "/tmp/ws",
  fullAccess: () => fullAccess,
  isToolAllowed: async (toolName: string) => allowedTools.includes(toolName),
  requestApproval: (toolCallId, argSummary) =>
    approvals.request(toolCallId, argSummary),
});

/** 提取第二次模型调用收到的 ToolMessage 文本（引擎自动回喂验证）。
 * LangChain 形状：ToolMessage {content, tool_call_id, name} */
function fedToolResult(calls: Array<{ messages: BaseMessage[] }>): {
  toolCallId: string;
  toolName: string;
  value: string;
} | null {
  for (const call of calls.slice(1)) {
    for (const message of call.messages) {
      if (message instanceof ToolMessage) {
        return {
          toolCallId: message.tool_call_id,
          toolName: message.name ?? "",
          value: typeof message.content === "string" ? message.content : "",
        };
      }
    }
  }
  return null;
}

describe("runChatStream agent loop", () => {
  it("多步循环：tool_call 块先于文本按发生顺序落库，结果自动回喂下一步", async () => {
    const approvals = new ApprovalCoordinator();
    const readTool = makeReadTool();
    const { model, calls } = agentModel([
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
      {
        steps: [{ kind: "text", delta: "文件内容是 hello" }],
        usage: { input: 3, output: 5 },
      },
    ]);
    const chunks: ChatStreamChunk[] = [];

    const result = await runChatStream({
      model,
      history: userHistory,
      params: {},
      toolDefinitions: [readTool],
      agent: makeAgent(approvals, true),
      onChunk: (chunk) => chunks.push(chunk),
    });

    // SDK 内建多步：两次模型调用，第一步的工具结果自动回喂第二步
    expect(calls.length).toBe(2);
    expect(fedToolResult(calls)).toEqual({
      toolCallId: "t1",
      toolName: "read_file",
      value: "     1| hello",
    });

    // blocks 有序序列：tool_call 终态在前，后续文本另起新块，usage 收尾
    expect(result.blocks).toEqual([
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "read_file",
        args: { path: "a.txt" },
        state: "done",
        output: "     1| hello",
      },
      { type: "text", text: "文件内容是 hello" },
      { type: "usage", input: 3, output: 5 },
    ]);
    expect(result.errorCode).toBeUndefined();

    // 工具状态 chunk 顺序：ready → running → done
    const states = chunks
      .filter((chunk) => chunk.type === "tool-update")
      .map((chunk) => (chunk as { state: string }).state);
    expect(states).toEqual(["ready", "running", "done"]);
  });

  it("审批拒绝：挂起后 respond false → denied 终态块 + 拒绝文案回喂 + 循环继续", async () => {
    const approvals = new ApprovalCoordinator();
    const writeTool = makeWriteTool(undefined, "delete_file");
    const { model, calls } = agentModel([
      {
        steps: [
          {
            kind: "tool",
            toolCallId: "t1",
            toolName: "delete_file",
            input: { path: "a.txt", content: "hi" },
          },
        ],
      },
      {
        steps: [{ kind: "text", delta: "好的，我换个思路" }],
        usage: { input: 3, output: 5 },
      },
    ]);
    const chunks: ChatStreamChunk[] = [];

    const pending = runChatStream({
      model,
      history: userHistory,
      params: {},
      toolDefinitions: [writeTool],
      agent: makeAgent(approvals, false),
      onChunk: (chunk) => chunks.push(chunk),
    });

    // delete_file 未授权（兜底审批面剩余项，delete=ask 裁定）：execute 挂起等待审批
    await vi.waitFor(() => expect(approvals.pendingCount).toBe(1));
    const approvalChunk = chunks.find(
      (chunk) => chunk.type === "approval-request",
    );
    expect(approvalChunk).toMatchObject({
      toolCallId: "t1",
      toolName: "delete_file",
      argSummary: "delete_file → a.txt",
    });

    await approvals.respond("t1", false);
    const result = await pending;

    // 拒绝：工具本体未执行，拒绝文案作为 tool-result 回喂，循环继续至终文本
    expect(writeTool.execute).not.toHaveBeenCalled();
    expect(fedToolResult(calls)).toMatchObject({
      toolCallId: "t1",
      value: "用户拒绝了此操作",
    });
    expect(result.blocks).toEqual([
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "delete_file",
        args: { path: "a.txt", content: "hi" },
        state: "denied",
        output: "用户拒绝了此操作",
      },
      { type: "text", text: "好的，我换个思路" },
      { type: "usage", input: 3, output: 5 },
    ]);
    expect(result.errorCode).toBeUndefined();
  });

  it("stepCountIs 保险丝：模型持续 tool-call 时按 maxSteps 截断终止", async () => {
    const approvals = new ApprovalCoordinator();
    // 每步恰一个工具调用，永不停手；脚本长度远超上限
    const scripts: StepScript[] = Array.from({ length: 10 }, (_, index) => ({
      steps: [
        {
          kind: "tool" as const,
          toolCallId: `t${index}`,
          toolName: "read_file",
          input: { path: `f${index}.txt` },
        },
      ],
    }));
    const { model, calls } = agentModel(scripts);

    const result = await runChatStream({
      model,
      history: userHistory,
      params: {},
      toolDefinitions: [makeReadTool()],
      agent: makeAgent(approvals, true),
      maxSteps: 3,
    });

    expect(calls.length).toBe(3);
    const toolBlocks = result.blocks.filter(
      (block) => block.type === "tool_call",
    );
    expect(toolBlocks.length).toBe(3);
    expect(
      toolBlocks.every(
        (block) => block.type === "tool_call" && block.state === "done",
      ),
    ).toBe(true);
    expect(result.errorCode).toBeUndefined();
  });

  it("中断时未到达终态的工具块记 error('已中断')，且不视为错误", async () => {
    const approvals = new ApprovalCoordinator();
    // execute 永不 resolve：模拟执行中被用户中止
    const hangingTool = makeReadTool(() => new Promise<string>(() => {}));
    const { model } = agentModel([
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
    ]);
    const abort = new AbortController();

    const result = await runChatStream({
      model,
      history: userHistory,
      params: {},
      toolDefinitions: [hangingTool],
      agent: makeAgent(approvals, true),
      abortSignal: abort.signal,
      onChunk: (chunk) => {
        if (
          chunk.type === "tool-update" &&
          (chunk as { state: string }).state === "running"
        ) {
          abort.abort();
        }
      },
    });

    expect(result.errorCode).toBeUndefined();
    // 中断的工具块落 error 终态（usage 块的有无不属于本用例关注点）
    const toolBlocks = result.blocks.filter(
      (block) => block.type === "tool_call",
    );
    expect(toolBlocks).toEqual([
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "read_file",
        args: { path: "a.txt" },
        state: "error",
        output: "已中断",
      },
    ]);
  });
});

describe("blocksToModelMessages（历史回喂）", () => {
  it("纯 text/thinking/usage 块 → 字符串 content（P0 行为不变）", async () => {
    const blocks: MessageBlock[] = [
      { type: "thinking", text: "想一想" },
      { type: "text", text: "你好" },
      { type: "usage", input: 1, output: 2 },
    ];
    const messages = await blocksToModelMessages(blocks, "assistant");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.getType?.()).toBe("ai");
    expect(messages[0]?.content).toBe("你好");
  });

  it("tool_call 块 → AIMessage.tool_calls（前导文本并入）+ ToolMessage（回喂 output）", async () => {
    const blocks: MessageBlock[] = [
      { type: "text", text: "我先看看" },
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "read_file",
        args: { path: "a.txt" },
        state: "done",
        output: "内容",
      },
      { type: "text", text: "结论" },
    ];
    const messages = await blocksToModelMessages(blocks);
    expect(messages).toHaveLength(3);
    expect(messages[0]?.getType?.()).toBe("ai");
    expect(messages[0]?.content).toBe("我先看看");
    expect(
      (messages[0] as unknown as { tool_calls?: unknown[] }).tool_calls,
    ).toEqual([
      {
        id: "t1",
        name: "read_file",
        args: { path: "a.txt" },
        type: "tool_call",
      },
    ]);
    expect(messages[1] instanceof ToolMessage).toBe(true);
    expect(messages[1]).toMatchObject({
      tool_call_id: "t1",
      name: "read_file",
      content: "内容",
    });
    expect(messages[2]?.getType?.()).toBe("ai");
    expect(messages[2]?.content).toBe("结论");
  });

  it("denied 块以原文案回喂；output 缺失回喂空串", async () => {
    const blocks: MessageBlock[] = [
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "write_file",
        args: { path: "a.txt", content: "x" },
        state: "denied",
        output: "用户拒绝了此操作",
      },
      {
        type: "tool_call",
        toolCallId: "t2",
        toolName: "read_file",
        args: { path: "b.txt" },
        state: "error",
      },
    ];
    const messages = await blocksToModelMessages(blocks);
    expect(messages).toHaveLength(4);
    expect(messages[1]).toMatchObject({
      tool_call_id: "t1",
      name: "write_file",
      content: "用户拒绝了此操作",
    });
    expect(messages[3]).toMatchObject({
      tool_call_id: "t2",
      name: "read_file",
      content: "",
    });
  });
});

describe("agent:approve 审批接线", () => {
  it("handler 注册并接通 ApprovalCoordinator.respond", async () => {
    const handle = ipcMain.handle as unknown as MockInstance;
    const svc = new ChatService({} as unknown as SessionRepository);
    const approvals = (svc as unknown as { approvals: ApprovalCoordinator })
      .approvals;

    const approveHandler = handle.mock.calls.find(
      ([channel]) => channel === "agent:approve",
    )?.[1] as (
      event: unknown,
      toolCallId: string,
      approved: boolean,
      token: string,
    ) => Promise<boolean>;
    expect(approveHandler).toBeTypeOf("function");

    // handleUser 形态：末参 token（无效 token 整体拒绝）
    const token = generateUserToken({ id: 1, username: "t" });
    const pending = approvals.request("t9", "write_file → a.txt");
    expect(await approveHandler({}, "t9", true, token)).toBe(true);
    await expect(pending).resolves.toBe(true);
    expect(await approveHandler({}, "ghost", true, token)).toBe(false);
    await expect(
      approveHandler({}, "t9", true, "not-a-token"),
    ).rejects.toThrow();
  });
});
