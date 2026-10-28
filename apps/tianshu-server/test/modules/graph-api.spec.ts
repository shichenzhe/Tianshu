// GA-T6：graph/automation 九端点 + 事件 contract（e2e，spec §4.1/§4.2）。
// 覆盖（任务面）：
// 1. capability：GET /info capabilities 含 graph（协议包 CAPABILITIES 联动）
// 2. graph 五端点：query（QueryResult 包装+keyword）/ save（create+update
//    乐观锁）/ delete / run（202 受理 {runId} + graph.run.updated 事件序列
//    running→progress→succeeded + run 行落库）/ runAbort（{runId} →
//    USER_CANCELLED → aborted 投影 + run failed/user_aborted）
// 3. automation 四端点：query / save（create，nextRunAt 初算 + automation.changed
//    事件）/ runNow（202 受理 + manual run 落库 + 收尾 automation.changed）/
//    delete（批量 + 级联 run + 逐 id automation.changed）
// 4. 鉴权：TIANSHU_TOKEN 设置时无 token 401、Bearer 放行（StaticTokenGuard
//    对 @Public 路由仍生效）
// 5. 装配：scheduler 未注入 deps.config 时经 ConfigService（tianshu 段缺席）
//    回退实体缺省 tickMs=30_000（GA-T5 审查移交项——三级回退链直测）
// 假模型注入与 automation-scheduler.spec 同款（模型工厂 jest.mock 是
// executor/chat-runner 唯一 IO 缝）；executor 非流式 invoke 消费面用 plain
// FakeInvokeModel（GA-T4 TDD 证据：ScriptedChatModel 流式钩子在 invoke 路径
// 不可达）。
import request from 'supertest'; // esModuleInterop 开启后 export= 不可命名空间直调
import * as http from 'node:http';
import { INestApplication } from '@nestjs/common';
import { scriptedChatModel } from '../helpers/scripted-chat-model';
import type {
  ServerEvent,
  GraphRunUpdatedPayload,
  AutomationChangedPayload,
} from '@tianshu/protocol';

jest.mock('src/core/provider/model-factory', () => ({
  createChatModel: jest.fn(),
}));

import { createChatModel } from 'src/core/provider/model-factory';
import { EventBusModule } from 'src/commons/event-bus/event-bus.module';
import { EventBusService } from 'src/commons/event-bus/event-bus.service';
import { GraphRepository } from 'src/modules/graph/graph.repository';
import { graphTestInflight } from 'src/core/graph/graph-inflight';
import { InfoModule } from 'src/modules/info/info.module';
import { GraphModule } from 'src/modules/graph/graph.module';
import { AutomationModule } from 'src/modules/automation/automation.module';
import { AutomationScheduler } from 'src/modules/automation/automation-scheduler';
import type { AutomationSchedulerConfig } from 'src/modules/automation/automation-scheduler';
import { createTestDb, type TestDb } from '../support/test-db';
import { createTestApp, type WrappedBody } from '../support/test-app';

const createChatModelMock = createChatModel as jest.Mock;

/** 脚本化 plain 模型（executor invoke 消费面：content + usage_metadata；
 * signalWait=true 挂起至 signal abort——runAbort 用例挂起锚点） */
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

/** 两节点链图 JSON（research → report，模板引用上游 output） */
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

/** 单节点挂起图（runAbort 用例：模型挂起至 USER_CANCELLED abort） */
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

/** 间隔 5 分钟调度（nextRunAt 推进后必在 5 分钟外，测试窗口内不被 tick 触发） */
const INTERVAL_5MIN = {
  mode: 'interval',
  value: 5,
  unit: 'minute',
};

/** 异步断言轮询（异步回调的拒绝会被 support/wait-for 的 try/catch 漏接，
 * automation-scheduler.spec waitForDb 同款） */
async function waitFor(check: () => void | Promise<void>, ms = 5000) {
  const startedAt = Date.now();
  for (;;) {
    try {
      await check();
      return;
    } catch (e) {
      if (Date.now() - startedAt > ms) throw e;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

describe('graph/automation 九端点 + 事件（GA-T6 e2e）', () => {
  let app: INestApplication;
  let server: http.Server;
  let db: TestDb;
  let modelId: number;
  let wsId: number;
  let graphId: number;
  let hangGraphId: number;
  /** 协议事件捕获（graph.run.updated / automation.changed） */
  let runEvents: GraphRunUpdatedPayload[];
  let changedEvents: AutomationChangedPayload[];

  beforeAll(async () => {
    db = await createTestDb();
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
    modelId = modelRow.id;
    const ws = await db.prisma.workspace.create({
      data: { name: 'graph-api-ws', userId: 1 },
    });
    wsId = ws.id;
    graphId = (
      await db.prisma.graphDefinition.create({
        data: {
          name: 'demo 图',
          graphJson: twoNodeGraphJson(modelId),
          userId: 1,
        },
      })
    ).id;
    hangGraphId = (
      await db.prisma.graphDefinition.create({
        data: { name: '挂起图', graphJson: hangGraphJson(modelId), userId: 1 },
      })
    ).id;

    const built = await createTestApp(db.prisma, [
      EventBusModule,
      InfoModule,
      GraphModule,
      AutomationModule,
    ]);
    app = built.app;
    server = built.server;
    runEvents = [];
    changedEvents = [];
    app.get(EventBusService).subscribe((event: ServerEvent) => {
      if (event.type === 'graph.run.updated') runEvents.push(event.payload);
      if (event.type === 'automation.changed')
        changedEvents.push(event.payload);
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await db.cleanup();
  });

  beforeEach(() => {
    createChatModelMock.mockReset();
  });

  const post = (path: string, body?: Record<string, unknown>) =>
    request(server)
      .post(path)
      .send(body ?? {});

  it('GET /info：capabilities 含 graph（capability 协商）', async () => {
    const res = await request(server).get('/info').expect(200);
    const body = res.body as WrappedBody<{ capabilities: string[] }>;
    expect(body.code).toBe('2000');
    expect(body.data.capabilities).toEqual(
      expect.arrayContaining(['chat', 'provider', 'graph']),
    );
  });

  it('graph/query：统一包装 QueryResult，keyword 内存过滤', async () => {
    const res = await post('/graph/query', {}).expect(200);
    const body = res.body as WrappedBody<{
      records: Array<{ id: number; name: string; nodeCount: number }>;
      total: number;
    }>;
    expect(body.code).toBe('2000');
    expect(body.data.total).toBeGreaterThanOrEqual(2);
    const demo = body.data.records.find((r) => r.id === graphId);
    expect(demo?.name).toBe('demo 图');
    expect(demo?.nodeCount).toBe(2);

    const filtered = await post('/graph/query', { keyword: '挂起' });
    const filteredBody = filtered.body as WrappedBody<{
      records: Array<{ id: number; name: string }>;
    }>;
    // GA-T6 审查修：原 every(() => true) 恒真——改为真过滤断言
    expect(
      filteredBody.data.records.every((r) => r.name.includes('挂起')),
    ).toBe(true);
    expect(filteredBody.data.records.some((r) => r.id === graphId)).toBe(false);
  });

  it('graph/save：create 落库 version=1；update 乐观锁 version+1；旧版本 VERSION_CONFLICT', async () => {
    const created = await post('/graph/save', {
      name: '新图',
      graphJson: twoNodeGraphJson(modelId),
    }).expect(200);
    const createdBody = created.body as WrappedBody<{
      id: number;
      version: number;
      nodeCount: number;
    }>;
    expect(createdBody.code).toBe('2000');
    expect(createdBody.data.version).toBe(1);
    expect(createdBody.data.nodeCount).toBe(2);

    const updated = await post('/graph/save', {
      id: createdBody.data.id,
      version: 1,
      name: '新图改',
      graphJson: twoNodeGraphJson(modelId),
    }).expect(200);
    const updatedBody = updated.body as WrappedBody<{ version: number }>;
    expect(updatedBody.data.version).toBe(2);

    const conflicted = await post('/graph/save', {
      id: createdBody.data.id,
      version: 1, // 旧版本
      name: '新图改',
      graphJson: twoNodeGraphJson(modelId),
    }).expect(200);
    const conflictBody = conflicted.body as WrappedBody<null>;
    expect(conflictBody.success).toBe(false);
    expect(String(conflictBody.message)).toContain('VERSION_CONFLICT');
  });

  it('graph/run：202 受理返回 {runId}，事件序列 running→progress→succeeded，run 行终态 success', async () => {
    // 共享单实例：两节点各自 resolve 模型（createChatModel 每节点一调），
    // replies 按调用次序消费（GA-T4 executor spec makeDeps 同款）
    const model = new FakeInvokeModel([
      { content: '调研结果', usage: { input: 3, output: 5 } },
      { content: '最终报告', usage: { input: 7, output: 11 } },
    ]);
    createChatModelMock.mockImplementation(() => model);
    const res = await post('/graph/run', {
      graphId,
      inputs: { topic: 'AI' },
    }).expect(202);
    const body = res.body as WrappedBody<{ runId: number }>;
    expect(body.code).toBe('2000');
    expect(typeof body.data.runId).toBe('number');
    const runId = body.data.runId;

    await waitFor(() => {
      if (runEvents[runEvents.length - 1]?.state !== 'succeeded') {
        throw new Error('run 未到终态');
      }
    });
    // 首事件即 running（受理即发射，run 生命周期从 running 起——不合成 queued）
    expect(runEvents[0]).toMatchObject({ runId, graphId, state: 'running' });
    // 节点 progress 序列（两节点各 running/success）后 succeeded 带 output
    expect(runEvents.map((e) => ({ state: e.state, ...e.progress }))).toEqual([
      { state: 'running' },
      { state: 'running', nodeId: 'research', nodeStatus: 'running' },
      { state: 'running', nodeId: 'research', nodeStatus: 'success' },
      { state: 'running', nodeId: 'report', nodeStatus: 'running' },
      { state: 'running', nodeId: 'report', nodeStatus: 'success' },
      { state: 'succeeded' },
    ]);
    expect(runEvents[runEvents.length - 1].output).toBe('最终报告');

    const run = await db.prisma.automationRun.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(run.status).toBe('success');
    expect(run.graphId).toBe(graphId);
    expect(run.taskId).toBeNull();
    expect(run.triggerType).toBe('manual');
  });

  it('graph/run createRun 抛错：桥拒绝回传 HTTP 5000、inflight 恒清、无 unhandledRejection（GA-T6 审查修直证）', async () => {
    // GA-T6 审查 Important：launched 仅在 createRun 前失败时拒绝——单链
    // 收口后该拒绝必须既有 HTTP 回传路径（桥）又有 handler（防
    // unhandledRejection 进程崩溃），cleanup 恒执行
    const spy = jest
      .spyOn(app.get(GraphRepository), 'createRun')
      .mockRejectedValueOnce(new Error('db down'));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const res = await post('/graph/run', {
        graphId,
        inputs: { topic: 'x' },
      }).expect(200); // 异常过滤器：非 HttpException → 200 + code 5000
      const body = res.body as WrappedBody<null>;
      expect(body.success).toBe(false);
      expect(body.code).toBe('5000');
      expect(String(body.message)).toContain('db down');

      // cleanup 恒执行（finally 链段）
      await waitFor(() => {
        if (graphTestInflight.has(graphId)) {
          throw new Error('inflight 未清理');
        }
      });
      // 拒绝派生 promise 的 unhandledRejection 在事件循环回合后触发——
      // 留足窗口后断言零未处理拒绝
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      spy.mockRestore();
    }
    // 恢复后链路完好（once 语义之外的真实 createRun 可用；两节点同回复，
    // 不依赖跨节点共享实例的调用次序）
    createChatModelMock.mockImplementation(
      () => new FakeInvokeModel([{ content: '恢复后' }, { content: '恢复后' }]),
    );
    await post('/graph/run', { graphId, inputs: { topic: 'y' } }).expect(202);
  });

  it('graph/runAbort：{runId} 中止在途 run → aborted 投影 + run failed/user_aborted', async () => {
    const model = new FakeInvokeModel([], true);
    createChatModelMock.mockImplementation(() => model);
    runEvents = [];
    const res = await post('/graph/run', {
      graphId: hangGraphId,
      inputs: { q: 'hi' },
    }).expect(202);
    const runId = (res.body as WrappedBody<{ runId: number }>).data.runId;
    await waitFor(() => {
      if (model.calls < 1) throw new Error('模型未进入');
    });

    const aborted = await post('/graph/runAbort', { runId }).expect(200);
    const abortedBody = aborted.body as WrappedBody<{ aborted: boolean }>;
    expect(abortedBody.code).toBe('2000');
    expect(abortedBody.data).toEqual({ aborted: true });

    await waitFor(() => {
      if (runEvents[runEvents.length - 1]?.state !== 'aborted') {
        throw new Error('run 未到 aborted 终态');
      }
    });
    expect(runEvents[runEvents.length - 1].error).toBe(
      'user_aborted: 已被用户中断',
    );
    const run = await db.prisma.automationRun.findUniqueOrThrow({
      where: { id: runId },
    });
    // run 表单一状态源：aborted 为展示精化投影，落库仍 failed
    expect(run.status).toBe('failed');
    expect(run.error).toBe('user_aborted: 已被用户中断');
  });

  it('automation/save：create 任务 + nextRunAt 初算 + automation.changed 事件', async () => {
    changedEvents = [];
    const res = await post('/automation/save', {
      name: '定时摘要',
      prompt: '摘要 {{time}}',
      workspaceId: wsId,
      modelId,
      schedule: INTERVAL_5MIN,
      scheduleText: '每 5 分钟',
      missedPolicy: 'skip',
    }).expect(200);
    const body = res.body as WrappedBody<{
      id: number;
      nextRunAt?: string;
      enabled: boolean;
      targetKind: string;
    }>;
    expect(body.code).toBe('2000');
    expect(body.data.enabled).toBe(true);
    expect(body.data.targetKind).toBe('prompt');
    expect(typeof body.data.nextRunAt).toBe('string');
    const taskId = body.data.id;

    await waitFor(() => {
      if (changedEvents.length < 1) throw new Error('事件未到');
    });
    expect(changedEvents[0]).toMatchObject({ taskId });
    expect(typeof changedEvents[0].nextRunAt).toBe('string');

    // query 可见
    const queried = await post('/automation/query', {}).expect(200);
    const queriedBody = queried.body as WrappedBody<{
      records: Array<{ id: number; name: string }>;
      total: number;
    }>;
    expect(queriedBody.data.records.some((r) => r.id === taskId)).toBe(true);
  });

  it('automation/save enabled：显式携 enabled 写入开关（Ruling 12/14），缺省不碰开关（DTO+ValidationPipe 契约面）', async () => {
    const full = {
      name: '启停任务',
      prompt: 'p',
      workspaceId: wsId,
      modelId,
      schedule: INTERVAL_5MIN,
      scheduleText: '每 5 分钟',
      missedPolicy: 'skip',
    };
    const created = await post('/automation/save', full).expect(200);
    const taskId = (created.body as WrappedBody<{ id: number }>).data.id;
    expect(
      (created.body as WrappedBody<{ enabled: boolean }>).data.enabled,
    ).toBe(true);

    // 控制端启停载荷（GA-T8 toTaskSaveParams 形态）：全量 + enabled 翻转
    const off = await post('/automation/save', {
      id: taskId,
      ...full,
      enabled: false,
    }).expect(200);
    const offBody = off.body as WrappedBody<{ enabled: boolean }>;
    expect(offBody.code).toBe('2000');
    expect(offBody.data.enabled).toBe(false);
    const rowOff = await db.prisma.automationTask.findUniqueOrThrow({
      where: { id: taskId },
    });
    expect(rowOff.enabled).toBe(false);

    // 缺省不碰开关（repo buildTaskData「编辑不重置用户开关」默认路径不变）
    const untouched = await post('/automation/save', {
      id: taskId,
      ...full,
    }).expect(200);
    expect(
      (untouched.body as WrappedBody<{ enabled: boolean }>).data.enabled,
    ).toBe(false);

    // 重启用（toggleTask 恢复语义：status 回 active）
    const on = await post('/automation/save', {
      id: taskId,
      ...full,
      enabled: true,
    }).expect(200);
    expect((on.body as WrappedBody<{ enabled: boolean }>).data.enabled).toBe(
      true,
    );
    const rowOn = await db.prisma.automationTask.findUniqueOrThrow({
      where: { id: taskId },
    });
    expect(rowOn.enabled).toBe(true);
    expect(rowOn.status).toBe('active');
  });

  it('automation/runNow：202 受理 + manual run 落库 success + 收尾 automation.changed', async () => {
    const saved = await post('/automation/save', {
      name: '手动任务',
      prompt: '回答问题',
      workspaceId: wsId,
      modelId,
      schedule: INTERVAL_5MIN,
      scheduleText: '每 5 分钟',
      missedPolicy: 'skip',
    });
    const taskId = (saved.body as WrappedBody<{ id: number }>).data.id;

    // helper 返回 {model, modelCallCount} 包装——注入面是 model 本体
    const { model: scripted } = scriptedChatModel([
      { steps: [{ kind: 'text', delta: '手动结果' }] },
    ]);
    createChatModelMock.mockImplementation(() => scripted);
    changedEvents = [];
    const res = await post('/automation/runNow', { taskId }).expect(202);
    const body = res.body as WrappedBody<{ accepted: boolean }>;
    expect(body.code).toBe('2000');
    expect(body.data).toEqual({ accepted: true });

    await waitFor(() => {
      const run = db.prisma.automationRun.findFirst({
        where: { taskId, triggerType: 'manual' },
      });
      return run.then((row) => {
        if (!row || row.status !== 'success') throw new Error('run 未完成');
      });
    });
    // 手动触发不消耗调度字段（mirror 语义）
    const task = await db.prisma.automationTask.findUniqueOrThrow({
      where: { id: taskId },
    });
    expect(task.status).toBe('active');
    expect(task.lastRunAt).toBeNull();

    await waitFor(() => {
      if (!changedEvents.some((e) => e.taskId === taskId)) {
        throw new Error('automation.changed 未到');
      }
    });
  });

  it('automation/delete：批量删除 + run 级联 + 逐 id automation.changed', async () => {
    const ids: number[] = [];
    for (const name of ['批删一', '批删二']) {
      const saved = await post('/automation/save', {
        name,
        prompt: 'p',
        workspaceId: wsId,
        modelId,
        schedule: INTERVAL_5MIN,
        scheduleText: '每 5 分钟',
        missedPolicy: 'skip',
      });
      ids.push((saved.body as WrappedBody<{ id: number }>).data.id);
    }
    changedEvents = [];
    const res = await post('/automation/delete', { ids }).expect(200);
    const body = res.body as WrappedBody<null>;
    expect(body.code).toBe('2000');

    const remaining = await db.prisma.automationTask.findMany({
      where: { id: { in: ids } },
    });
    expect(remaining).toHaveLength(0);
    const runs = await db.prisma.automationRun.findMany({
      where: { taskId: { in: ids } },
    });
    expect(runs).toHaveLength(0);
    expect(changedEvents.map((e) => e.taskId).sort()).toEqual([...ids].sort());
  });

  it('graph/delete：删除图 + run 级联', async () => {
    const created = await post('/graph/save', {
      name: '待删图',
      graphJson: twoNodeGraphJson(modelId),
    });
    const id = (created.body as WrappedBody<{ id: number }>).data.id;

    const res = await post('/graph/delete', { id }).expect(200);
    expect((res.body as WrappedBody<null>).code).toBe('2000');
    const gone = await db.prisma.graphDefinition.findUnique({ where: { id } });
    expect(gone).toBeNull();
  });

  it('鉴权：TIANSHU_TOKEN 设置时无 token 401，Bearer 放行（@Public 不豁免静态 token）', async () => {
    process.env.TIANSHU_TOKEN = 'ga-t6-secret';
    try {
      const denied = await post('/graph/query', {}).expect(401);
      expect((denied.body as WrappedBody<null>).success).toBe(false);

      const allowed = await request(server)
        .post('/graph/query')
        .set('Authorization', 'Bearer ga-t6-secret')
        .send({})
        .expect(200);
      expect((allowed.body as WrappedBody<unknown>).code).toBe('2000');
    } finally {
      delete process.env.TIANSHU_TOKEN;
    }
  });

  it('装配：scheduler 未注入 deps.config 时 ConfigService 回退链终点 = 实体缺省 tickMs 30_000（GA-T5 移交项）', () => {
    const scheduler = app.get(AutomationScheduler);
    // deps 为 private：测试经结构收窄读 config 解析结果（三级链直测——
    // 测试容器 ConfigService 仅 auth 段，tianshu 缺席 → 实体缺省）
    const deps = (
      scheduler as unknown as {
        deps: { config: () => AutomationSchedulerConfig };
      }
    ).deps;
    expect(deps.config().tickMs).toBe(30_000);
    expect(deps.config().allowDangerousTools).toBe(false);
    expect(deps.config().deleteProtection).toBe(true);
  });
});
