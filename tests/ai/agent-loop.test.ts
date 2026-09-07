import { describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  // Log 模块顶层读取 app.getPath("userData") 计算日志目录
  app: { getPath: vi.fn(() => "/tmp/tianshu-test-user-data") },
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

import { MockLanguageModelV3 } from "ai/test";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { ipcMain } from "electron";
import ChatService, {
  runChatStream,
  type AgentStreamOptions,
} from "../../electron/domains/ai/chat/chat.service";
import {
  blocksToModelMessages,
  type MessageBlock,
} from "../../electron/domains/ai/chat/blocks";
import { ApprovalCoordinator } from "../../electron/domains/ai/agent/approval";
import type { ToolDefinition } from "../../electron/domains/ai/agent/file-tools";
import type { ChatStreamChunk } from "../../src-react/domains/ai/api/chat.api";
import type { SessionRepository } from "../../electron/domains/ai/chat/session.repo";

const userHistory = [
  {
    role: "user" as const,
    blocks: JSON.stringify([{ type: "text", text: "hi" }]),
  },
];

// ---------- mock 模型：doStream 按调用序弹出脚本（SDK 多步 = 每 step 一次 doStream） ----------

type ScriptStep =
  | { kind: "text"; delta: string }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
    };

interface StepScript {
  steps: ScriptStep[];
  usage?: { input: number; output: number };
}

interface CapturedCall {
  prompt: Array<{ role: string; content: unknown }>;
}

/** v3 协议：tool-call 的 input 为 JSON 字符串，SDK 解析并按 zod schema 校验 */
function agentModel(scripts: StepScript[]) {
  const calls: CapturedCall[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (callOptions) => {
      const index = calls.length;
      const script = scripts[index] ?? { steps: [] as ScriptStep[] };
      const usage = script.usage ?? { input: 0, output: 0 };
      calls.push({
        prompt: callOptions.prompt.map((message) => ({
          role: message.role as string,
          content: message.content as unknown,
        })),
      });
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            const hasTool = script.steps.some((step) => step.kind === "tool");
            let textOpen = false;
            for (const step of script.steps) {
              if (step.kind === "text") {
                if (!textOpen) {
                  controller.enqueue({ type: "text-start", id: `t${index}` });
                  textOpen = true;
                }
                controller.enqueue({
                  type: "text-delta",
                  id: `t${index}`,
                  delta: step.delta,
                });
              } else {
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: step.toolCallId,
                  toolName: step.toolName,
                  input: JSON.stringify(step.input),
                });
              }
            }
            if (textOpen) {
              controller.enqueue({ type: "text-end", id: `t${index}` });
            }
            controller.enqueue({
              type: "finish",
              // v7 协议：finishReason 为 {unified, raw} 对象（字符串形式 unified 缺失
              // 会导致 SDK 拒绝执行工具，见 LanguageModelV3FinishReason）
              finishReason: hasTool
                ? { unified: "tool-calls", raw: "tool-calls" }
                : { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: {
                  total: usage.input,
                  noCache: undefined,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: {
                  total: usage.output,
                  text: usage.output,
                  reasoning: undefined,
                },
              },
            });
            controller.close();
          },
        }),
      };
    },
  });
  return { model, calls };
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
): ToolDefinition<{ path: string; content: string }> => ({
  name: "write_file",
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

/** 提取 doStream 收到的下一步 prompt 中的 tool-result 文本（SDK 自动回喂验证）。
 * v3 prompt 协议：tool-result 部分为 {type, toolCallId, toolName, output: {type:'text', value}} */
function fedToolResult(calls: CapturedCall[]): {
  toolCallId: string;
  toolName: string;
  value: string;
} | null {
  for (const call of calls.slice(1)) {
    for (const message of call.prompt) {
      if (message.role !== "tool") {
        continue;
      }
      const parts = message.content as Array<{
        type: string;
        toolCallId: string;
        toolName: string;
        output?: { type: string; value?: string };
      }>;
      const part = parts?.find((item) => item.type === "tool-result");
      if (part) {
        return {
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          value: part.output?.value ?? "",
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
    const writeTool = makeWriteTool();
    const { model, calls } = agentModel([
      {
        steps: [
          {
            kind: "tool",
            toolCallId: "t1",
            toolName: "write_file",
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

    // write 未授权：execute 挂起等待审批
    await vi.waitFor(() => expect(approvals.pendingCount).toBe(1));
    const approvalChunk = chunks.find(
      (chunk) => chunk.type === "approval-request",
    );
    expect(approvalChunk).toMatchObject({
      toolCallId: "t1",
      toolName: "write_file",
      argSummary: "write_file → a.txt",
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
        toolName: "write_file",
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
  it("纯 text/thinking/usage 块 → 字符串 content（P0 行为不变）", () => {
    const blocks: MessageBlock[] = [
      { type: "thinking", text: "想一想" },
      { type: "text", text: "你好" },
      { type: "usage", input: 1, output: 2 },
    ];
    expect(blocksToModelMessages(blocks, "assistant")).toEqual([
      { role: "assistant", content: "你好" },
    ] as ModelMessage[]);
  });

  it("tool_call 块 → assistant tool-call 部分 + role:tool 消息（input/output 字段名对齐）", () => {
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
    expect(blocksToModelMessages(blocks)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "我先看看" },
          {
            type: "tool-call",
            toolCallId: "t1",
            toolName: "read_file",
            input: { path: "a.txt" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "t1",
            toolName: "read_file",
            output: { type: "text", value: "内容" },
          },
        ],
      },
      { role: "assistant", content: "结论" },
    ] as ModelMessage[]);
  });

  it("denied 块以原文案回喂；output 缺失回喂空串", () => {
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
    const messages = blocksToModelMessages(blocks);
    expect(messages).toHaveLength(4);
    expect(messages[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "t1",
          toolName: "write_file",
          output: { type: "text", value: "用户拒绝了此操作" },
        },
      ],
    });
    expect(messages[3]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "t2",
          toolName: "read_file",
          output: { type: "text", value: "" },
        },
      ],
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
    ) => boolean;
    expect(approveHandler).toBeTypeOf("function");

    const pending = approvals.request("t9", "write_file → a.txt");
    expect(approveHandler({}, "t9", true)).toBe(true);
    await expect(pending).resolves.toBe(true);
    expect(approveHandler({}, "ghost", true)).toBe(false);
  });
});
