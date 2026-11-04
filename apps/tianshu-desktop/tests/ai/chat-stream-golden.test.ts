/**
 * runChatStream 事件序列 golden 基线（统一 LLM 栈 T3-1）
 *
 * 契约目的：Task 9 把引擎从 Vercel AI SDK streamText 换成 LangChain
 * createReactAgent + streamEvents 后，本文件断言必须零修改通过——
 * 这里锁的是换引擎的行为契约，不是引擎实现。
 *
 * 断言原则（引擎无关）：
 * - 只锁两类可观察输出：onChunk 推送的 ChatStreamChunk 事件序列、
 *   runChatStream 返回的最终 blocks（MessageBlock 终态）与 errorCode
 * - 不引用任何引擎内部细节（SDK 流 part 类型名、prompt 消息形状等）；
 *   期望值全部从现引擎实跑得出（golden = 锁定现状，不是发明理想）
 * - 唯一允许随引擎更换而变的是 model 替身本体（现 AI SDK
 *   MockLanguageModelV3，Task 9 换 BaseChatModel 替身）；modelCallCount
 *   统计替身被调用次数，text 切分粒度由替身脚本决定（替身保持同等
 *   切分即可），两者都不是引擎契约的一部分
 *
 * 锁定序列（详见各用例）：
 * - A 纯文本：reasoning-delta → text-delta…；blocks = thinking + text + usage
 * - B 工具往返：tool-update(ready,含 args) → running → done(含 output) →
 *   text-delta；blocks = tool_call(done) + text + usage；模型恰被调用 2 次
 * - B2 多轮 usage 累加（终审修复新增，A–C 原断言零改动）：两轮各带
 *   usage → blocks usage = 两者之和（usage 按 run_id 去重每轮恰计一次、
 *   跨轮累加，对齐旧 AI SDK totalUsage 全步累加语义）
 * - B3 usage 仅 end 聚合上报（终审遗留 T9c-b 回补）：流式 chunk 不带
 *   usage（usageOnEndOnly 替身形态）→ blocks usage 仍按 end 聚合结算
 * - C 中止：用户中止不是错误——无 error chunk/errorCode，已生成内容保留，
 *   挂起工具块统一落 error/"已中断"；预先中止则零 chunk 零 block
 */
import { describe, expect, it, vi } from "vitest";

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

vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    message: { findMany: async () => [] },
  },
}));

import { z } from "zod";
import { scriptedChatModel } from "./helpers/scripted-chat-model";
import { runChatStream } from "../../electron/domains/ai/chat/chat.service";
import type { AgentStreamOptions } from "../../electron/domains/ai/agent/tool-gate";
import { ApprovalCoordinator } from "../../electron/domains/ai/agent/approval";
import type { ToolDefinition } from "../../electron/domains/ai/agent/file-tools";
import type { ChatStreamChunk } from "../../src-react/domains/ai/api/chat.api";

const userHistory = [
  {
    role: "user" as const,
    blocks: JSON.stringify([{ type: "text", text: "hi" }]),
  },
];

// ---------- mock 模型：_streamResponseChunks 按调用序弹出脚本 ----------
// 换引擎替身（golden 断言零改动的一部分，见文件头注释）：LangChain 脚本化
// 假模型，ScriptStep 形状与旧 AI SDK 替身一致（text/reasoning/tool 步）

// ---------- 工具与 agent 上下文夹具 ----------

/** echo 工具：成功路径回显（kind=read 无审批，经 tool-gate 正常执行） */
const makeEchoTool = (
  execute: ToolDefinition<{ text: string }>["execute"] = async (_ctx, args) =>
    `echo: ${args.text}`,
): ToolDefinition<{ text: string }> => ({
  name: "echo",
  description: "测试回显工具",
  parameters: z.object({ text: z.string() }),
  kind: "read",
  execute: vi.fn(execute),
});

const makeAgent = (approvals: ApprovalCoordinator): AgentStreamOptions => ({
  sessionId: 1,
  workspacePath: "/tmp/ws",
  fullAccess: () => true,
  isToolAllowed: async () => false,
  requestApproval: (toolCallId, argSummary) =>
    approvals.request(toolCallId, argSummary),
});

describe("runChatStream golden 事件序列基线（换引擎行为契约）", () => {
  it("A 纯文本：reasoning → text 增量按序推送，终态 = thinking + text + usage", async () => {
    const { model } = scriptedChatModel([
      {
        steps: [
          { kind: "reasoning", delta: "想一想" },
          { kind: "text", delta: "你好" },
          { kind: "text", delta: "！" },
        ],
        usage: { input: 2, output: 7 },
      },
    ]);
    const chunks: ChatStreamChunk[] = [];

    const result = await runChatStream({
      model,
      history: userHistory,
      params: {},
      onChunk: (chunk) => chunks.push(chunk),
    });

    // chunk 序列：reasoning 与 text 增量按发生顺序，text 两次增量不合并
    expect(chunks).toEqual([
      { type: "reasoning-delta", text: "想一想" },
      { type: "text-delta", text: "你好" },
      { type: "text-delta", text: "！" },
    ]);
    // blocks 终态：thinking/text 各一块（增量拼接），usage 收尾
    expect(result.blocks).toEqual([
      { type: "thinking", text: "想一想" },
      { type: "text", text: "你好！" },
      { type: "usage", input: 2, output: 7 },
    ]);
    expect(result.errorCode).toBeUndefined();
    expect(result.errorMessage).toBeUndefined();
  });

  it("B 工具往返：ready(含 args) → running → done(含 output) → 后续文本，结果回喂驱动第二次模型调用", async () => {
    const approvals = new ApprovalCoordinator();
    const echoTool = makeEchoTool();
    const { model, modelCallCount } = scriptedChatModel([
      {
        steps: [
          {
            kind: "tool",
            toolCallId: "t1",
            toolName: "echo",
            input: { text: "ping" },
          },
        ],
      },
      {
        steps: [{ kind: "text", delta: "pong" }],
        usage: { input: 5, output: 9 },
      },
    ]);
    const chunks: ChatStreamChunk[] = [];

    const result = await runChatStream({
      model,
      history: userHistory,
      params: {},
      toolDefinitions: [echoTool],
      agent: makeAgent(approvals),
      onChunk: (chunk) => chunks.push(chunk),
    });

    // chunk 序列：工具三态后文本续流；usage 不出 chunk（只进 blocks）
    expect(chunks).toEqual([
      {
        type: "tool-update",
        toolCallId: "t1",
        toolName: "echo",
        args: { text: "ping" },
        state: "ready",
      },
      {
        type: "tool-update",
        toolCallId: "t1",
        toolName: "echo",
        state: "running",
      },
      {
        type: "tool-update",
        toolCallId: "t1",
        toolName: "echo",
        state: "done",
        output: "echo: ping",
      },
      { type: "text-delta", text: "pong" },
    ]);
    // 工具确实经注入定义执行（模型给的 args 原样到达 execute）
    expect(echoTool.execute).toHaveBeenCalledTimes(1);
    expect(echoTool.execute).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 1 }),
      { text: "ping" },
    );
    // 工具结果回喂 → 引擎发起第二次模型调用产出终答
    expect(modelCallCount()).toBe(2);
    // blocks 终态：tool_call 块在前（保序），文本另起新块，usage 收尾
    expect(result.blocks).toEqual([
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "echo",
        args: { text: "ping" },
        state: "done",
        output: "echo: ping",
      },
      { type: "text", text: "pong" },
      { type: "usage", input: 5, output: 9 },
    ]);
    expect(result.errorCode).toBeUndefined();
  });

  it("B2 多轮 usage 累加：两轮各带 usage → blocks usage = 两者之和（对齐 totalUsage 全步累加）", async () => {
    const approvals = new ApprovalCoordinator();
    const echoTool = makeEchoTool();
    const { model, modelCallCount } = scriptedChatModel([
      {
        steps: [
          {
            kind: "tool",
            toolCallId: "t1",
            toolName: "echo",
            input: { text: "ping" },
          },
        ],
        usage: { input: 10, output: 3 },
      },
      {
        steps: [{ kind: "text", delta: "pong" }],
        usage: { input: 5, output: 9 },
      },
    ]);

    const result = await runChatStream({
      model,
      history: userHistory,
      params: {},
      toolDefinitions: [echoTool],
      agent: makeAgent(approvals),
      onChunk: () => {},
    });

    expect(modelCallCount()).toBe(2);
    // 中间轮（工具轮）usage 不再被末轮覆盖：两轮相加 = 15/12
    expect(result.blocks).toEqual([
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "echo",
        args: { text: "ping" },
        state: "done",
        output: "echo: ping",
      },
      { type: "text", text: "pong" },
      { type: "usage", input: 15, output: 12 },
    ]);
    expect(result.errorCode).toBeUndefined();
  });

  it("B3 usage 仅 end 聚合上报（usageOnEndOnly 形态）：流式 chunk 不带 usage，blocks usage 仍按 on_chat_model_end 聚合正确结算", async () => {
    const { model } = scriptedChatModel([
      {
        steps: [{ kind: "text", delta: "终答" }],
        usage: { input: 5, output: 9 },
        usageOnEndOnly: true,
      },
    ]);
    const chunks: ChatStreamChunk[] = [];

    const result = await runChatStream({
      model,
      history: userHistory,
      params: {},
      onChunk: (chunk) => chunks.push(chunk),
    });

    // 部分 provider 形态：流式事件侧无 usage，仅 end 聚合消息上报——
    // emitter 聚合回退分支（settleRun 兜底入账）在此真实链路上生效
    expect(chunks).toEqual([{ type: "text-delta", text: "终答" }]);
    expect(result.blocks).toEqual([
      { type: "text", text: "终答" },
      { type: "usage", input: 5, output: 9 },
    ]);
    expect(result.errorCode).toBeUndefined();
  });

  it('C 流中中止：已生成文本保留、挂起工具块落 error/"已中断"、无错误码且不再调用模型', async () => {
    const approvals = new ApprovalCoordinator();
    // execute 永不 resolve：模拟执行中被用户中止
    const hangingTool = makeEchoTool(() => new Promise<string>(() => {}));
    const { model, modelCallCount } = scriptedChatModel([
      {
        steps: [
          { kind: "text", delta: "已生成的部分" },
          {
            kind: "tool",
            toolCallId: "t1",
            toolName: "echo",
            input: { text: "ping" },
          },
        ],
      },
    ]);
    const abort = new AbortController();
    const chunks: ChatStreamChunk[] = [];

    const result = await runChatStream({
      model,
      history: userHistory,
      params: {},
      toolDefinitions: [hangingTool],
      agent: makeAgent(approvals),
      abortSignal: abort.signal,
      onChunk: (chunk) => {
        chunks.push(chunk);
        // running 态到达即用户点停：挂起中的 execute 被中止竞速了结
        if (
          chunk.type === "tool-update" &&
          (chunk as { state: string }).state === "running"
        ) {
          abort.abort();
        }
      },
    });

    // chunk 序列止于 running：中止后无终态 chunk、无 error chunk
    expect(chunks).toEqual([
      { type: "text-delta", text: "已生成的部分" },
      {
        type: "tool-update",
        toolCallId: "t1",
        toolName: "echo",
        args: { text: "ping" },
        state: "ready",
      },
      {
        type: "tool-update",
        toolCallId: "t1",
        toolName: "echo",
        state: "running",
      },
    ]);
    // blocks 终态：用户主动中止不是错误——无 errorCode，已生成文本保留，
    // 挂起工具块统一了结为 error/"已中断"
    expect(result.blocks).toEqual([
      { type: "text", text: "已生成的部分" },
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "echo",
        args: { text: "ping" },
        state: "error",
        output: "已中断",
      },
    ]);
    expect(result.errorCode).toBeUndefined();
    expect(result.errorMessage).toBeUndefined();
    // 中止即停：引擎不再发起下一次模型调用
    expect(modelCallCount()).toBe(1);
  });

  it("C 预先中止：abortSignal 进场即 aborted → 零 chunk 零 block 且无错误码", async () => {
    const approvals = new ApprovalCoordinator();
    const { model } = scriptedChatModel([
      {
        steps: [
          { kind: "text", delta: "不该出现" },
          {
            kind: "tool",
            toolCallId: "t1",
            toolName: "echo",
            input: { text: "ping" },
          },
        ],
      },
    ]);
    const chunks: ChatStreamChunk[] = [];

    const result = await runChatStream({
      model,
      history: userHistory,
      params: {},
      toolDefinitions: [makeEchoTool()],
      agent: makeAgent(approvals),
      abortSignal: AbortSignal.abort(),
      onChunk: (chunk) => chunks.push(chunk),
    });

    // 用户主动中止不是错误：不产出任何事件与内容，也不记错误码
    expect(chunks).toEqual([]);
    expect(result.blocks).toEqual([]);
    expect(result.errorCode).toBeUndefined();
    expect(result.errorMessage).toBeUndefined();
  });
});
