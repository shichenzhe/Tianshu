// 移植自 mirror tests/ai/agent-loop.test.ts（runChatStream agent 循环 4 用例
// + 本仓新增 run_command 门控用例）。mirror 侧 electron mock/prisma stub 在
// 本仓不存在（纯注入无副作用依赖），direct import 即可。
import { z } from 'zod';
import { ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { scriptedChatModel } from '../helpers/scripted-chat-model';
import { runChatStream } from 'src/core/chat-runner.service';
import type { ChatStreamChunk } from '@tianshu/protocol';
import type { AgentStreamOptions } from 'src/core/tools/tool-gate';
import type { ToolDefinition } from 'src/core/tools/tool-definition';
import { ApprovalCoordinator } from 'src/core/tools/approval';

const userHistory = [
  {
    role: 'user' as const,
    blocks: JSON.stringify([{ type: 'text', text: 'hi' }]),
  },
];

/** v3 → LangChain：tool args 原样（对象经 zod schema 校验） */
function agentModel(
  scripts: Array<{
    steps: Array<
      | { kind: 'text'; delta: string }
      | {
          kind: 'tool';
          toolCallId: string;
          toolName: string;
          input: Record<string, unknown>;
        }
    >;
    usage?: { input: number; output: number };
  }>,
) {
  const { model } = scriptedChatModel(scripts);
  return { model, calls: model.callsLog };
}

// ---------- 工具与 agent 上下文夹具 ----------

const makeReadTool = (
  execute: ToolDefinition<{ path: string }>['execute'] = () =>
    Promise.resolve('     1| hello'),
): ToolDefinition<{ path: string }> => ({
  name: 'read_file',
  description: '测试读工具',
  parameters: z.object({ path: z.string() }),
  kind: 'read',
  execute: jest.fn(execute),
});

const makeWriteTool = (
  execute: ToolDefinition<{
    path: string;
    content: string;
  }>['execute'] = () => Promise.resolve('已写入 a.txt（2 字节）'),
  // name 可覆写：权限放宽（spec §4.4）后 write_file 免审，审批挂起用例
  // 改走仍在兜底审批面的 delete_file（delete=ask 裁定）
  name = 'write_file',
): ToolDefinition<{ path: string; content: string }> => ({
  name,
  description: '测试写工具',
  parameters: z.object({ path: z.string(), content: z.string() }),
  kind: 'write',
  execute: jest.fn(execute),
});

const makeAgent = (
  approvals: ApprovalCoordinator,
  fullAccess = false,
  allowedTools: string[] = [],
): AgentStreamOptions => ({
  sessionId: 1,
  workspacePath: '/tmp/ws',
  fullAccess: () => fullAccess,
  isToolAllowed: (toolName: string) =>
    Promise.resolve(allowedTools.includes(toolName)),
  requestApproval: (toolCallId, argSummary) =>
    approvals.request(toolCallId, argSummary),
});

/** 提取第二次模型调用收到的 ToolMessage 文本（引擎自动回喂验证） */
function fedToolResult(
  calls: Array<{ messages: BaseMessage[] }>,
): { toolCallId: string; toolName: string; value: string } | null {
  for (const call of calls.slice(1)) {
    for (const message of call.messages) {
      if (message instanceof ToolMessage) {
        return {
          toolCallId: message.tool_call_id,
          toolName: message.name ?? '',
          value: typeof message.content === 'string' ? message.content : '',
        };
      }
    }
  }
  return null;
}

describe('runChatStream agent loop', () => {
  it('多步循环：tool_call 块先于文本按发生顺序落库，结果自动回喂下一步', async () => {
    const approvals = new ApprovalCoordinator();
    const readTool = makeReadTool();
    const { model, calls } = agentModel([
      {
        steps: [
          {
            kind: 'tool',
            toolCallId: 't1',
            toolName: 'read_file',
            input: { path: 'a.txt' },
          },
        ],
      },
      {
        steps: [{ kind: 'text', delta: '文件内容是 hello' }],
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
      toolCallId: 't1',
      toolName: 'read_file',
      value: '     1| hello',
    });

    // blocks 有序序列：tool_call 终态在前，后续文本另起新块，usage 收尾
    expect(result.blocks).toEqual([
      {
        type: 'tool_call',
        toolCallId: 't1',
        toolName: 'read_file',
        args: { path: 'a.txt' },
        state: 'done',
        output: '     1| hello',
      },
      { type: 'text', text: '文件内容是 hello' },
      { type: 'usage', input: 3, output: 5 },
    ]);
    expect(result.errorCode).toBeUndefined();

    // 工具状态 chunk 顺序：ready → running → done
    const states = chunks
      .filter((chunk) => chunk.type === 'tool-update')
      .map((chunk) => (chunk as { state: string }).state);
    expect(states).toEqual(['ready', 'running', 'done']);
  });

  it('文本增量按序推送：text-delta 逐段、usage 不作 chunk（块收尾）', async () => {
    const approvals = new ApprovalCoordinator();
    const { model } = agentModel([
      {
        steps: [
          { kind: 'text', delta: '你好' },
          { kind: 'text', delta: '，世界' },
        ],
        usage: { input: 2, output: 4 },
      },
    ]);
    const chunks: ChatStreamChunk[] = [];

    const result = await runChatStream({
      model,
      history: userHistory,
      params: {},
      agent: makeAgent(approvals, true),
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(chunks).toEqual([
      { type: 'text-delta', text: '你好' },
      { type: 'text-delta', text: '，世界' },
    ]);
    expect(result.blocks).toEqual([
      { type: 'text', text: '你好，世界' },
      { type: 'usage', input: 2, output: 4 },
    ]);
  });

  it('审批拒绝：挂起后 respond false → denied 终态块 + 拒绝文案回喂 + 循环继续', async () => {
    const approvals = new ApprovalCoordinator();
    const writeExecute = jest.fn(() =>
      Promise.resolve('已写入 a.txt（2 字节）'),
    );
    const writeTool = makeWriteTool(writeExecute, 'delete_file');
    const { model, calls } = agentModel([
      {
        steps: [
          {
            kind: 'tool',
            toolCallId: 't1',
            toolName: 'delete_file',
            input: { path: 'a.txt', content: 'hi' },
          },
        ],
      },
      {
        steps: [{ kind: 'text', delta: '好的，我换个思路' }],
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

    // delete_file 未授权（兜底审批面剩余项）：execute 挂起等待审批
    await waitFor(() => expect(approvals.pendingCount).toBe(1));
    const approvalChunk = chunks.find(
      (chunk) => chunk.type === 'approval-request',
    );
    expect(approvalChunk).toMatchObject({
      toolCallId: 't1',
      toolName: 'delete_file',
      argSummary: 'delete_file → a.txt',
    });

    approvals.respond('t1', false);
    const result = await pending;

    // 拒绝：工具本体未执行，拒绝文案作为 tool-result 回喂，循环继续至终文本
    expect(writeExecute).not.toHaveBeenCalled();
    expect(fedToolResult(calls)).toMatchObject({
      toolCallId: 't1',
      value: '用户拒绝了此操作',
    });
    expect(result.blocks).toEqual([
      {
        type: 'tool_call',
        toolCallId: 't1',
        toolName: 'delete_file',
        args: { path: 'a.txt', content: 'hi' },
        state: 'denied',
        output: '用户拒绝了此操作',
      },
      { type: 'text', text: '好的，我换个思路' },
      { type: 'usage', input: 3, output: 5 },
    ]);
    expect(result.errorCode).toBeUndefined();
  });

  it('保险丝：模型持续 tool-call 时按 maxSteps 截断终止（无错）', async () => {
    const approvals = new ApprovalCoordinator();
    // 每步恰一个工具调用，永不停手；脚本长度远超上限
    const scripts = Array.from({ length: 10 }, (_, index) => ({
      steps: [
        {
          kind: 'tool' as const,
          toolCallId: `t${index}`,
          toolName: 'read_file',
          input: { path: `f${index}.txt` },
        },
      ],
    }));
    const { model } = agentModel(scripts);

    const result = await runChatStream({
      model,
      history: userHistory,
      params: {},
      toolDefinitions: [makeReadTool()],
      agent: makeAgent(approvals, true),
      maxSteps: 3,
    });

    expect(model.calls).toBe(3);
    const toolBlocks = result.blocks.filter(
      (block) => block.type === 'tool_call',
    );
    expect(toolBlocks.length).toBe(3);
    expect(
      toolBlocks.every(
        (block) => block.type === 'tool_call' && block.state === 'done',
      ),
    ).toBe(true);
    expect(result.errorCode).toBeUndefined();
  });

  it('中断时未到达终态的工具块记 error("已中断")，且不视为错误', async () => {
    const approvals = new ApprovalCoordinator();
    // execute 永不 resolve：模拟执行中被中止
    const hangingTool = makeReadTool(() => new Promise<string>(() => {}));
    const { model } = agentModel([
      {
        steps: [
          {
            kind: 'tool',
            toolCallId: 't1',
            toolName: 'read_file',
            input: { path: 'a.txt' },
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
          chunk.type === 'tool-update' &&
          (chunk as { state: string }).state === 'running'
        ) {
          abort.abort();
        }
      },
    });

    expect(result.errorCode).toBeUndefined();
    const toolBlocks = result.blocks.filter(
      (block) => block.type === 'tool_call',
    );
    expect(toolBlocks).toEqual([
      {
        type: 'tool_call',
        toolCallId: 't1',
        toolName: 'read_file',
        args: { path: 'a.txt' },
        state: 'error',
        output: '已中断',
      },
    ]);
  });

  it('allowDangerousTools=false（默认）：run_command 直接拒绝（denied 终态，不执行不审批）', async () => {
    const approvals = new ApprovalCoordinator();
    const commandExecute = jest.fn(() => Promise.resolve('退出码 0'));
    const commandTool: ToolDefinition<{ command: string }> = {
      name: 'run_command',
      description: '测试命令工具',
      parameters: z.object({ command: z.string() }),
      kind: 'write',
      execute: commandExecute,
    };
    const { model, calls } = agentModel([
      {
        steps: [
          {
            kind: 'tool',
            toolCallId: 't1',
            toolName: 'run_command',
            input: { command: 'echo hi' },
          },
        ],
      },
      {
        steps: [{ kind: 'text', delta: '命令不可用，我改用别的方式' }],
        usage: { input: 1, output: 2 },
      },
    ]);
    const chunks: ChatStreamChunk[] = [];

    const result = await runChatStream({
      model,
      history: userHistory,
      params: {},
      toolDefinitions: [commandTool],
      agent: makeAgent(approvals, true, ['run_command']),
      onChunk: (chunk) => chunks.push(chunk),
    });

    // 拒绝 chunk（denied）已推送，工具本体未执行、审批未挂起
    expect(commandExecute).not.toHaveBeenCalled();
    expect(approvals.pendingCount).toBe(0);
    const denied = chunks.find(
      (chunk) =>
        chunk.type === 'tool-update' &&
        (chunk as { state: string }).state === 'denied',
    );
    expect(denied).toMatchObject({ toolCallId: 't1', toolName: 'run_command' });

    // 拒绝文案回喂，循环继续至终文本；块为 denied 终态
    expect(fedToolResult(calls)).toMatchObject({
      toolCallId: 't1',
      value: expect.stringContaining('allowDangerousTools'),
    });
    expect(result.blocks).toEqual([
      {
        type: 'tool_call',
        toolCallId: 't1',
        toolName: 'run_command',
        args: { command: 'echo hi' },
        state: 'denied',
        output: expect.stringContaining('allowDangerousTools'),
      },
      { type: 'text', text: '命令不可用，我改用别的方式' },
      { type: 'usage', input: 1, output: 2 },
    ]);
    expect(result.errorCode).toBeUndefined();
  });
});

/** jest 版 vi.waitFor：轮询断言直至超时（审批挂起等异步时点） */
async function waitFor(assertion: () => void, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (e) {
      if (Date.now() - startedAt > timeoutMs) {
        throw e;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
