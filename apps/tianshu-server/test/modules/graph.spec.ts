// GA-T3 graph/automation 仓储副本 CRUD 闭环（真实临时库，createTestDb 先例）：
// graph——create/query/getById/update（乐观锁）/delete（引用检查+级联）+ run 行
// 写入/状态更新（createRun/finishRun 原语，摘自 mirror graph-executor）；
// automation——任务基本 CRUD（create/list/update/toggle/delete + 归属隔离）。
import { GraphRepository } from 'src/modules/graph/graph.repository';
import {
  AutomationRepository,
  type TaskCreateParams,
} from 'src/modules/automation/automation.repository';
import { COMPANION_USER_ID } from 'src/commons/config/tianshu-config.entity';
import { createTestDb, type TestDb } from '../support/test-db';

/** 伴生用户；越权用例对照用户 */
const UID = COMPANION_USER_ID;
const OTHER = 2;

/** 合法图（双节点串行，唯一入口 collect）——mirror graph-repo.test 同款基准 */
const validGraphJson = JSON.stringify({
  version: 1,
  inputSchema: {},
  nodes: [
    {
      id: 'collect',
      name: 'collect',
      kind: 'llm',
      modelId: 3,
      prompt: '汇总要点',
      tools: false,
      outputMode: 'text',
    },
    {
      id: 'report',
      name: 'report',
      kind: 'llm',
      modelId: 3,
      prompt: '成文',
      tools: false,
      outputMode: 'text',
    },
  ],
  edges: [
    { from: 'collect', to: 'report' },
    { from: 'report', to: 'END' },
  ],
});

/** prompt 任务创建入参（mirror buildTaskData 用例同款调度） */
const taskParams = (): TaskCreateParams => ({
  name: '早报',
  prompt: '总结 {{date}} 资讯',
  workspaceId: 0, // 由 beforeEach 造数后回填
  modelId: 0, // 同上
  temperature: 0.7,
  schedule: { mode: 'periodic', kind: 'daily', time: '09:00' },
  scheduleText: '每天 09:00',
  missedPolicy: 'skip',
});

describe('GraphRepository / AutomationRepository（GA-T3 摘表副本）', () => {
  let db: TestDb;
  let graphs: GraphRepository;
  let automations: AutomationRepository;
  /** 伴生用户可见的 workspace/model（assertTaskRefsOwned 校验链） */
  let fixture: { workspaceId: number; modelId: number };

  beforeAll(async () => {
    db = await createTestDb();
    graphs = new GraphRepository(db.prisma);
    automations = new AutomationRepository(db.prisma);
    const provider = await db.prisma.provider.create({
      data: {
        name: 'p1',
        type: 'openai-compatible',
        baseUrl: 'http://localhost:9/v1',
        userId: UID,
      },
    });
    const model = await db.prisma.model.create({
      data: { providerId: provider.id, modelId: 'test-model' },
    });
    const workspace = await db.prisma.workspace.create({
      data: { name: 'ws-graph-spec', userId: UID },
    });
    fixture = { workspaceId: workspace.id, modelId: model.id };
  });

  afterAll(async () => {
    await db.cleanup();
  });

  describe('graph CRUD 闭环', () => {
    it('create：校验通过落库，nodeCount 派生；非法图保存期即拒', async () => {
      const bad = JSON.stringify({
        version: 1,
        inputSchema: {},
        nodes: [
          {
            id: 'a',
            name: 'a',
            kind: 'llm',
            modelId: 1,
            prompt: 'x',
            tools: false,
            outputMode: 'text',
          },
          {
            id: 'b',
            name: 'b',
            kind: 'llm',
            modelId: 1,
            prompt: 'y',
            tools: false,
            outputMode: 'text',
          },
        ],
        edges: [],
      });
      await expect(
        graphs.createGraph({ name: '坏图', graphJson: bad }, UID),
      ).rejects.toThrowError('uniqueEntry');
      expect(await db.prisma.graphDefinition.count()).toBe(0);

      const created = await graphs.createGraph(
        { name: '调研成文', description: '备注', graphJson: validGraphJson },
        UID,
      );
      expect(created.id).toBeGreaterThan(0);
      expect(created.nodeCount).toBe(2);
      expect(created.version).toBe(1);
      expect(created.description).toBe('备注');
    });

    it('query：listGraphs 按 userId 隔离，createdAt 倒序', async () => {
      await graphs.createGraph(
        { name: '第二张', graphJson: validGraphJson },
        UID,
      );
      await graphs.createGraph(
        { name: '他人图', graphJson: validGraphJson },
        OTHER,
      );

      const mine = await graphs.listGraphs(UID);
      expect(mine.map((g) => g.name)).toEqual(['第二张', '调研成文']);
      expect(await graphs.listGraphs(OTHER)).toHaveLength(1);
    });

    it('getById：findById 命中本人行；他人行不可见', async () => {
      const mine = (await graphs.listGraphs(UID))[0];
      expect((await graphs.findById(mine.id, UID))?.name).toBe('第二张');
      expect(await graphs.findById(mine.id, OTHER)).toBeNull();
      expect(await graphs.findById(999999, UID)).toBeNull();
    });

    it('update：乐观锁 version 不符 → VERSION_CONFLICT；相符 → version+1', async () => {
      const row = (await graphs.listGraphs(UID))[0];
      await expect(
        graphs.updateGraph(
          row.id,
          { name: '改名', graphJson: validGraphJson, version: row.version + 5 },
          UID,
        ),
      ).rejects.toThrowError('VERSION_CONFLICT');

      const updated = await graphs.updateGraph(
        row.id,
        { name: '改名', graphJson: validGraphJson, version: row.version },
        UID,
      );
      expect(updated.name).toBe('改名');
      expect(updated.version).toBe(row.version + 1);
      // 他人更新被归属校验拦截（不泄露存在性）
      await expect(
        graphs.updateGraph(
          row.id,
          { name: '越权', graphJson: validGraphJson, version: updated.version },
          OTHER,
        ),
      ).rejects.toThrowError('GRAPH_NOT_FOUND');
    });

    it('run 行写入/状态更新：createRun 落 running → finishRun 落终态全量字段', async () => {
      const row = (await graphs.listGraphs(UID))[0];
      const runId = await graphs.createRun({
        taskId: null,
        graphId: row.id,
        attempt: 1,
        triggerType: 'manual',
      });
      const running = await db.prisma.automationRun.findUniqueOrThrow({
        where: { id: runId },
      });
      expect(running.status).toBe('running');
      expect(running.graphId).toBe(row.id);
      expect(running.finishedAt).toBeNull();

      await graphs.finishRun({
        runId,
        status: 'failed',
        graphTrace: JSON.stringify([{ nodeId: 'collect' }]),
        error: 'node:collect model_error: boom',
        durationMs: 1234,
        promptTokens: 10,
        completionTokens: 20,
      });
      const done = await db.prisma.automationRun.findUniqueOrThrow({
        where: { id: runId },
      });
      expect(done.status).toBe('failed');
      expect(done.graphTrace).toBe(JSON.stringify([{ nodeId: 'collect' }]));
      expect(done.error).toBe('node:collect model_error: boom');
      expect(done.durationMs).toBe(1234);
      expect(done.promptTokens).toBe(10);
      expect(done.completionTokens).toBe(20);
      expect(done.finishedAt).not.toBeNull();

      // finishRun 对已删除 run 行不抛（在途删图先删 run 的预期冲突）
      await db.prisma.automationRun.delete({ where: { id: runId } });
      await expect(
        graphs.finishRun({
          runId,
          status: 'failed',
          graphTrace: '[]',
          error: null,
          durationMs: 1,
        }),
      ).resolves.toBeUndefined();
    });

    it('delete：被 graph 任务引用 → GRAPH_IN_USE；无引用 → 事务先删 run 再删图', async () => {
      const target = (await graphs.listGraphs(UID))[0];
      const blocker = await automations.createTask(
        {
          ...taskParams(),
          workspaceId: fixture.workspaceId,
          modelId: fixture.modelId,
          targetKind: 'graph',
          graphId: target.id,
        },
        UID,
      );
      await expect(graphs.deleteGraph(target.id, UID)).rejects.toThrowError(
        /GRAPH_IN_USE:.*早报/,
      );
      expect(
        await db.prisma.graphDefinition.findUnique({
          where: { id: target.id },
        }),
      ).not.toBeNull();

      // 解除引用后删除：预置一条 run 行随图级联
      await automations.deleteTasks([blocker.id], UID);
      const runId = await graphs.createRun({
        taskId: null,
        graphId: target.id,
        attempt: 1,
        triggerType: 'manual',
      });
      // 去会话化 2026-10-28（spec §3.1）：run 的节点详情行随 run 级联删
      await db.prisma.graphRunNode.create({
        data: {
          runId,
          nodeId: 'collect',
          nodeName: '采集',
          status: 'success',
          input: 'x',
          output: 'y',
          durationMs: 5,
          startedAt: new Date().toISOString(),
        },
      });
      await graphs.deleteGraph(target.id, UID);
      expect(
        await db.prisma.graphDefinition.findUnique({
          where: { id: target.id },
        }),
      ).toBeNull();
      expect(
        await db.prisma.automationRun.findUnique({ where: { id: runId } }),
      ).toBeNull();
      expect(
        await db.prisma.graphRunNode.findFirst({ where: { runId } }),
      ).toBeNull();
      // 他人图删除被归属校验拦截
      const others = (await graphs.listGraphs(OTHER))[0];
      await expect(graphs.deleteGraph(others.id, UID)).rejects.toThrowError(
        'GRAPH_NOT_FOUND',
      );
    });

    it('toggle：启停翻转并回读', async () => {
      const row = (await graphs.listGraphs(UID))[0];
      const off = await graphs.toggleGraph(row.id, false, UID);
      expect(off.enabled).toBe(false);
      const on = await graphs.toggleGraph(row.id, true, UID);
      expect(on.enabled).toBe(true);
    });
  });

  describe('automation 仓储基本 CRUD', () => {
    it('createTask：归属校验链通过落库，nextRunAt 初算，graph 任务 prompt 清空', async () => {
      const created = await automations.createTask(
        {
          ...taskParams(),
          workspaceId: fixture.workspaceId,
          modelId: fixture.modelId,
        },
        UID,
      );
      expect(created.id).toBeGreaterThan(0);
      expect(created.enabled).toBe(true);
      expect(created.status).toBe('active');
      expect(created.scheduleJson).toBe(
        '{"mode":"periodic","kind":"daily","time":"09:00"}',
      );
      expect(created.nextRunAt).toBeTruthy();
      expect(created.workspaceName).toBe('ws-graph-spec');
      expect(created.source).toBe('local');

      // workspace 不归本人 → WORKSPACE_NOT_FOUND
      await expect(
        automations.createTask(
          { ...taskParams(), workspaceId: 999999, modelId: fixture.modelId },
          UID,
        ),
      ).rejects.toThrowError('WORKSPACE_NOT_FOUND');
    });

    it('listTasks：按 userId 隔离', async () => {
      const mine = await automations.listTasks(UID);
      expect(mine.length).toBeGreaterThanOrEqual(1);
      expect(await automations.listTasks(OTHER)).toHaveLength(0);
    });

    it('updateTask：全量更新语义，nextRunAt 重算', async () => {
      const row = (await automations.listTasks(UID))[0];
      const updated = await automations.updateTask(
        row.id,
        {
          ...taskParams(),
          workspaceId: fixture.workspaceId,
          modelId: fixture.modelId,
          name: '早报改',
          schedule: { mode: 'periodic', kind: 'daily', time: '10:30' },
        },
        UID,
      );
      expect(updated.name).toBe('早报改');
      // nextRunAt 按新调度时刻重算（本地时区取 HH:mm，跨时区稳健）
      const next = new Date(updated.nextRunAt as string);
      const hhmm = `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`;
      expect(hhmm).toBe('10:30');
      expect(next.getTime()).toBeGreaterThan(Date.now() - 60_000);
      await expect(
        automations.updateTask(row.id, taskParams(), OTHER),
      ).rejects.toThrowError(`automation task ${row.id} not found`);
    });

    it('toggleTask：停用保留 status；重新启用恢复 active 并清 statusNote', async () => {
      const row = (await automations.listTasks(UID))[0];
      const paused = await automations.toggleTask(row.id, false, UID);
      expect(paused.enabled).toBe(false);
      expect(paused.status).toBe('active');

      // 造 error 态验证恢复路径
      await db.prisma.automationTask.update({
        where: { id: row.id },
        data: { status: 'error', statusNote: '连续失败' },
      });
      const resumed = await automations.toggleTask(row.id, true, UID);
      expect(resumed.status).toBe('active');
      expect(resumed.statusNote).toBeUndefined();
    });

    it('deleteTasks：仅删本人任务，run 与节点行随任务级联', async () => {
      const created = await automations.createTask(
        {
          ...taskParams(),
          workspaceId: fixture.workspaceId,
          modelId: fixture.modelId,
          name: '待删',
        },
        UID,
      );
      const run = await db.prisma.automationRun.create({
        data: {
          taskId: created.id,
          attempt: 1,
          triggerType: 'manual',
          status: 'success',
        },
      });
      // De-sessionization 2026-10-28 (spec §3.1): node detail rows are deleted along with the run
      await db.prisma.graphRunNode.create({
        data: {
          runId: run.id,
          nodeId: 'n1',
          status: 'success',
          durationMs: 1,
          startedAt: new Date().toISOString(),
        },
      });
      // Foreign ids mixed in are filtered out (silently skipped without throwing)
      await automations.deleteTasks([created.id, 999999], OTHER);
      expect(
        await db.prisma.automationTask.findUnique({
          where: { id: created.id },
        }),
      ).not.toBeNull();

      await automations.deleteTasks([created.id], UID);
      expect(
        await db.prisma.automationTask.findUnique({
          where: { id: created.id },
        }),
      ).toBeNull();
      expect(
        await db.prisma.automationRun.findUnique({ where: { id: run.id } }),
      ).toBeNull();
      expect(
        await db.prisma.graphRunNode.findFirst({ where: { runId: run.id } }),
      ).toBeNull();
    });
  });
});
