// GA-T4：graph-executor 副本核心链路（临时库 + 假模型经 deps seam 注入）。
// 覆盖（任务面）：
// 1. 两节点图全链：run 表状态机（创建即 running → 终态，经 GA-T3
//    createRun/finishRun 仓储原语落库）+ graph.run.updated 事件序列
//    （running → 节点 progress ×2 → succeeded）+ 节点详情落 graphRunNode
//    （去会话化 2026-10-28：零 session/message 写入）+ trace/tokens 收尾。
// 2. abort 路径：graphTestInflight 注册表 + cancelTestRun 语义
//    （abort(reason=USER_CANCELLED)）→ run failed/user_aborted + aborted
//    事件投影 + 节点 failed progress。
// 注：queued 态不在 executor 生命周期（createRun 原语即落 running，mirror
// createRunRow 同款）——留给 T6 控制层队列语义（executor 头注释改造点 7）。
import { compileStateGraph } from '@tianshu/core';
import { GraphRepository } from 'src/modules/graph/graph.repository';
import { executeGraphRun, type GraphRow } from 'src/core/graph/graph-executor';
import {
  installGraphExecutorRuntime,
  resetGraphExecutorRuntime,
  type GraphRunStore,
  type GraphRunUpdatedPayload,
} from 'src/core/graph/executor-runtime';
import { graphTestInflight } from 'src/core/graph/graph-inflight';
import { toLangChainTools } from 'src/core/tools/langchain-tool-adapter';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createTestDb, type TestDb } from '../support/test-db';
import { waitFor } from '../support/wait-for';

/** 脚本化 plain 模型（executor 非流式 invoke 消费面：content + usage_metadata；
 * signalWait=true 挂起至 signal abort——ScriptedChatModel 的流式钩子在
 * invoke 路径走 _generate 覆写，usage/挂起语义不可达，故用 plain 形态） */
class FakeInvokeModel {
  calls = 0;

  constructor(
    private readonly replies: Array<{
      content: string;
      usage?: { input: number; output: number };
    }>,
    private readonly signalWait = false,
  ) {}

  invoke(
    _messages: unknown,
    opts?: { signal?: AbortSignal },
  ): Promise<{
    content: string;
    usage_metadata?: { input_tokens: number; output_tokens: number };
  }> {
    this.calls += 1;
    if (this.signalWait) {
      return new Promise((_resolve, reject) => {
        if (opts?.signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        opts?.signal?.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true },
        );
      });
    }
    const reply = this.replies[this.calls - 1] ?? { content: '' };
    return Promise.resolve({
      content: reply.content,
      ...(reply.usage
        ? {
            usage_metadata: {
              input_tokens: reply.usage.input,
              output_tokens: reply.usage.output,
            },
          }
        : {}),
    });
  }
}

/** 两节点链图 JSON（research → report，模板引用上游 output 验证节点串联） */
function twoNodeGraphJson(modelId: number): string {
  return JSON.stringify({
    version: 1,
    inputSchema: { topic: 'string' },
    nodes: [
      {
        id: 'research',
        name: '调研',
        kind: 'llm',
        modelId,
        prompt: '调研 {{input.topic}}',
        tools: false,
        outputMode: 'text',
      },
      {
        id: 'report',
        name: '成文',
        kind: 'llm',
        modelId,
        prompt: '基于 {{nodes.research.output}} 成文',
        tools: false,
        outputMode: 'text',
      },
    ],
    edges: [
      { from: 'research', to: 'report' },
      { from: 'report', to: 'END' },
    ],
  });
}

/** 单节点挂起图（abort 用例：模型挂起至 signal 中止） */
function hangGraphJson(modelId: number): string {
  return JSON.stringify({
    version: 1,
    inputSchema: { q: 'string' },
    nodes: [
      {
        id: 'hang',
        name: '挂起',
        kind: 'llm',
        modelId,
        prompt: '回答 {{input.q}}',
        tools: false,
        outputMode: 'text',
      },
    ],
    edges: [{ from: 'hang', to: 'END' }],
  });
}

/** 环图（C1 回归，2026-10-28 终审）：intro 入口 → loop（branch：go 走
 * 回边、stop 收口）→ back 条件回边回 loop——loop 两轮执行，真实库
 * (runId, nodeId) 唯一约束下节点详情行 upsert 聚合（最后一轮为准） */
function cyclicGraphJson(modelId: number): string {
  return JSON.stringify({
    version: 1,
    inputSchema: { topic: 'string' },
    nodes: [
      {
        id: 'intro',
        name: '开场',
        kind: 'llm',
        modelId,
        prompt: '开场 {{input.topic}}',
        tools: false,
        outputMode: 'text',
      },
      {
        id: 'loop',
        name: '循环判定',
        kind: 'llm',
        modelId,
        prompt: '判定 {{nodes.intro.output}}',
        tools: false,
        outputMode: 'branch',
        branchOptions: ['go', 'stop'],
      },
      {
        id: 'back',
        name: '回边',
        kind: 'llm',
        modelId,
        prompt: '补充 {{nodes.loop.output}}',
        tools: false,
        outputMode: 'text',
      },
    ],
    edges: [
      { from: 'intro', to: 'loop' },
      { from: 'loop', to: 'back', condition: { type: 'branch', value: 'go' } },
      { from: 'loop', to: 'END', condition: { type: 'branch', value: 'stop' } },
      { from: 'back', to: 'loop' },
    ],
  });
}

describe('graph-executor 副本（GA-T4）', () => {
  let db: TestDb;
  let repo: GraphRepository;
  let events: GraphRunUpdatedPayload[];
  /** run 行状态快照序列（状态机直证：createRun 后/finishRun 后各拍一次） */
  let runRowStates: string[];
  let ws: { id: number };
  let modelRowId: number;
  let graphRow: GraphRow;
  let hangGraphRow: GraphRow;
  let cyclicGraphRow: GraphRow;

  beforeAll(async () => {
    db = await createTestDb();
    repo = new GraphRepository(db.prisma);
    events = [];
    runRowStates = [];
    const provider = await db.prisma.provider.create({
      data: {
        name: 'p1',
        type: 'openai-compatible',
        baseUrl: 'http://localhost:9',
        apiKey: 'k',
        userId: 1,
      },
    });
    const modelRow = await db.prisma.model.create({
      data: { providerId: provider.id, modelId: 'test-model' },
    });
    modelRowId = modelRow.id;
    ws = await db.prisma.workspace.create({
      data: { name: 'graph-exec-ws', userId: 1 },
    });
    graphRow = await db.prisma.graphDefinition.create({
      data: {
        name: 'demo 图',
        graphJson: twoNodeGraphJson(modelRowId),
        userId: 1,
      },
    });
    hangGraphRow = await db.prisma.graphDefinition.create({
      data: { name: '挂起图', graphJson: hangGraphJson(modelRowId), userId: 1 },
    });
    cyclicGraphRow = await db.prisma.graphDefinition.create({
      data: {
        name: '环图',
        graphJson: cyclicGraphJson(modelRowId),
        userId: 1,
      },
    });
    // run 原语包装：透传 GA-T3 仓储，同时快照 run 行状态（状态机观察面）
    const statefulRuns: GraphRunStore = {
      createRun: async (p) => {
        const id = await repo.createRun(p);
        const row = await db.prisma.automationRun.findUniqueOrThrow({
          where: { id },
        });
        runRowStates.push(row.status);
        return id;
      },
      finishRun: async (p) => {
        await repo.finishRun(p);
        const row = await db.prisma.automationRun.findUniqueOrThrow({
          where: { id: p.runId },
        });
        runRowStates.push(row.status);
      },
    };
    installGraphExecutorRuntime({
      db: db.prisma,
      runs: statefulRuns,
      publishRunUpdated: (payload) => events.push(payload),
    });
  }, 120_000);

  afterAll(async () => {
    resetGraphExecutorRuntime();
    await db.cleanup();
  });

  /** deps seam：假模型注入（mirror executor 测试同款注入面）——plain 模型
   * 经结构兼容断言转 BaseChatModel（createChatModel 返回面仅消费 invoke） */

  const makeDeps = (model: FakeInvokeModel | BaseChatModel) => ({
    createChatModel: () => model as unknown as BaseChatModel,
    toLangChainTools,
    compileStateGraph,
  });

  it('两节点图：run 表 running→success、事件 running→progress→succeeded、节点行/trace/tokens 落库（零 session/message）', async () => {
    const model = new FakeInvokeModel([
      { content: '调研结果', usage: { input: 3, output: 5 } },
      { content: '最终报告', usage: { input: 7, output: 11 } },
    ]);

    const outcome = await executeGraphRun(
      {
        graph: graphRow,
        task: null,
        inputs: { topic: 'AI' },
        triggerType: 'manual',
        attempt: 1,
        abort: new AbortController().signal,
        workspace: { id: ws.id, directoryPath: null },
      },
      makeDeps(model),
    );
    expect(outcome).toBe('success');

    // run 表状态机：创建即 running（GA-T3 createRun 原语）→ 收尾 success
    expect(runRowStates).toEqual(['running', 'success']);

    // 事件序列：run running → 两节点各 running/success progress → succeeded
    expect(
      events.map((e) => ({
        state: e.state,
        ...e.progress,
        output: e.output,
      })),
    ).toEqual([
      { state: 'running', output: undefined },
      {
        state: 'running',
        nodeId: 'research',
        nodeStatus: 'running',
        output: undefined,
      },
      {
        state: 'running',
        nodeId: 'research',
        nodeStatus: 'success',
        output: undefined,
      },
      {
        state: 'running',
        nodeId: 'report',
        nodeStatus: 'running',
        output: undefined,
      },
      {
        state: 'running',
        nodeId: 'report',
        nodeStatus: 'success',
        output: undefined,
      },
      { state: 'succeeded', output: '最终报告' },
    ]);
    const runId = events[0].runId;
    expect(
      events.every((e) => e.runId === runId && e.graphId === graphRow.id),
    ).toBe(true);

    // run 行收尾全量字段
    const run = await db.prisma.automationRun.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(run.status).toBe('success');
    expect(run.graphId).toBe(graphRow.id);
    expect(run.taskId).toBeNull();
    expect(run.triggerType).toBe('manual');
    expect(run.promptTokens).toBe(10);
    expect(run.completionTokens).toBe(16);
    // 去会话化 2026-10-28：graph 路径不再写 sessionId（列保留恒 null）
    expect(run.sessionId).toBeNull();
    expect(run.finishedAt).not.toBeNull();
    expect(run.error).toBeNull();
    const trace = JSON.parse(run.graphTrace ?? '[]') as Array<{
      status: string;
    }>;
    expect(trace.map((t) => t.status)).toEqual(['success', 'success']);

    // 去会话化：零会话/消息写入（原「图会话 + 节点消息对」路径已拆除）
    expect(await db.prisma.sessionRecord.count()).toBe(0);
    expect(await db.prisma.messageRecord.count()).toBe(0);

    // 节点详情落 graphRunNode（Coze 式运行记录；模板渲染 + 上游引用串联）
    const nodeRows = await db.prisma.graphRunNode.findMany({
      where: { runId },
      orderBy: { id: 'asc' },
    });
    expect(nodeRows).toHaveLength(2);
    expect(nodeRows[0]).toMatchObject({
      runId,
      nodeId: 'research',
      nodeName: '调研',
      status: 'success',
      input: '调研 AI',
      output: '调研结果',
      promptTokens: 3,
      completionTokens: 5,
    });
    expect(nodeRows[1]).toMatchObject({
      runId,
      nodeId: 'report',
      nodeName: '成文',
      status: 'success',
      input: '基于 调研结果 成文',
      output: '最终报告',
      promptTokens: 7,
      completionTokens: 11,
    });
    expect(nodeRows[1].toolCallsJson).toBeNull();
    expect(nodeRows[1].errorJson).toBeNull();
    expect(nodeRows[1].fallbackJson).toBeNull();
  });

  it('abort 路径：inflight 注册表 + USER_CANCELLED → run failed/user_aborted + aborted 事件投影', async () => {
    const model = new FakeInvokeModel([], true);
    events = [];
    const controller = new AbortController();
    // mirror graph.repo launchTestRun/cancelTestRun 语义：注册表互斥占位 +
    // abort(reason=USER_CANCELLED) 区分用户中断
    graphTestInflight.set(hangGraphRow.id, controller);
    const promise = executeGraphRun(
      {
        graph: hangGraphRow,
        task: null,
        inputs: { q: 'hi' },
        triggerType: 'manual',
        attempt: 1,
        abort: controller.signal,
        workspace: { id: ws.id, directoryPath: null },
      },
      makeDeps(model),
    );
    await waitFor(() => {
      if (model.calls < 1) throw new Error('模型未进入');
    });
    controller.abort(new Error('USER_CANCELLED'));
    const outcome = await promise;
    expect(outcome).toBe('failed');
    graphTestInflight.delete(hangGraphRow.id);

    // run 表：failed + error 归一 user_aborted（trace 含节点 failed 条目）
    const runId = events[0].runId;
    const run = await db.prisma.automationRun.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(run.status).toBe('failed');
    expect(run.error).toBe('user_aborted: 已被用户中断');
    const trace = JSON.parse(run.graphTrace ?? '[]') as Array<{
      id: string;
      status: string;
    }>;
    expect(trace[0]).toMatchObject({ id: 'hang', status: 'failed' });

    // 去会话化：失败节点同样落 graphRunNode 行（status=failed +
    // errorJson 同 trace error 形状），且全程零 session/message 写入
    const failedRow = await db.prisma.graphRunNode.findFirstOrThrow({
      where: { runId, nodeId: 'hang' },
    });
    expect(failedRow.status).toBe('failed');
    expect(JSON.parse(failedRow.errorJson ?? '{}')).toMatchObject({
      code: 'UNKNOWN',
      message: 'aborted',
    });
    expect(failedRow.output).toContain('UNKNOWN: aborted');
    expect(await db.prisma.sessionRecord.count()).toBe(0);
    expect(await db.prisma.messageRecord.count()).toBe(0);

    // 事件投影：running（run）→ running（节点挂起）→ running（节点 failed）
    // → aborted（user_aborted 的展示精化态，run 表单一状态源仍 failed）
    expect(events.map((e) => e.state)).toEqual([
      'running',
      'running',
      'running',
      'aborted',
    ]);
    expect(events[2].progress).toEqual({
      nodeId: 'hang',
      nodeStatus: 'failed',
    });
    expect(events[3].error).toBe('user_aborted: 已被用户中断');
    expect(events[3].output).toBeUndefined();
  });

  it('环图重入：同 nodeId 两轮执行真实库唯一约束下聚合一行（最后一轮为准），run success', async () => {
    events = [];
    const model = new FakeInvokeModel([
      { content: '开场白' }, // intro
      { content: 'go', usage: { input: 2, output: 3 } }, // loop 第一轮 → 回边
      { content: '补充材料' }, // back
      { content: 'stop', usage: { input: 5, output: 7 } }, // loop 第二轮 → END
    ]);

    const outcome = await executeGraphRun(
      {
        graph: cyclicGraphRow,
        task: null,
        inputs: { topic: 'AI' },
        triggerType: 'manual',
        attempt: 1,
        abort: new AbortController().signal,
        workspace: { id: ws.id, directoryPath: null },
      },
      makeDeps(model),
    );
    // 旧 create 实现第二轮 loop 落库撞 UNIQUE (runId, nodeId) → run 以
    // 晦涩 sqlite 约束错误失败；upsert 聚合后业务结果照常
    expect(outcome).toBe('success');
    const runId = events[0].runId;

    // trace 逐轮追加：intro → loop(go) → back → loop(stop) 共 4 条
    const run = await db.prisma.automationRun.findUniqueOrThrow({
      where: { id: runId },
    });
    const trace = JSON.parse(run.graphTrace ?? '[]') as Array<{
      id: string;
      status: string;
    }>;
    expect(trace.map((t) => t.id)).toEqual([
      'intro',
      'loop',
      'back',
      'loop',
    ]);

    // 节点详情行：intro/back 各一，loop 两轮聚合一行且最后一轮覆盖
    const nodeRows = await db.prisma.graphRunNode.findMany({
      where: { runId },
      orderBy: { id: 'asc' },
    });
    expect(nodeRows.filter((r) => r.nodeId === 'loop')).toHaveLength(1);
    expect(
      nodeRows.find((r) => r.nodeId === 'loop'),
    ).toMatchObject({
      status: 'success',
      output: 'stop',
      promptTokens: 5,
      completionTokens: 7,
    });
    expect(nodeRows).toHaveLength(3); // intro + loop(聚合) + back
  });
});
