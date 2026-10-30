// 移动端执行详情批：automation/runNodes 服务级直证——图 run 节点行
// id asc 全量透传（input/output 全文、errorJson/toolCallsJson 序列、
// tokens、ISO startedAt）/prompt run（graphId null）空集/老 run 无节点行
// 空集/归属不符（他人图）空集——语义同桌面 orchestration:runNodes 两段
// 校验（run.graphId → graph.userId，null 视为可查），不暴露存在性。
import type { Prisma } from '@prisma/client';
import { AutomationRepository } from 'src/modules/automation/automation.repository';
import { AutomationService } from 'src/modules/automation/automation.service';
import { EventBusService } from 'src/commons/event-bus/event-bus.service';
import { createTestDb, type TestDb } from '../support/test-db';

describe('automation/runNodes 运行节点详情（移动端执行详情批）', () => {
  let db: TestDb;
  let service: AutomationService;
  let graphRunId: number;
  let otherGraphRunId: number;
  let nullUserGraphRunId: number;
  let promptRunId: number;
  let bareGraphRunId: number;

  beforeAll(async () => {
    db = await createTestDb();
    service = new AutomationService(
      db.prisma,
      new AutomationRepository(db.prisma),
      new EventBusService(),
    );
    const ws = await db.prisma.workspace.create({
      data: { name: 'run-nodes-ws', userId: 1 },
    });
    const task = await db.prisma.automationTask.create({
      data: {
        name: 'prompt 任务',
        prompt: 'p',
        workspaceId: ws.id,
        modelId: 0,
        scheduleJson: '{}',
        scheduleText: 's',
        userId: 1,
      },
    });
    const graph = await db.prisma.graphDefinition.create({
      data: { name: '编排图', graphJson: '{}', userId: 1 },
    });
    const otherGraph = await db.prisma.graphDefinition.create({
      data: { name: '他人图', graphJson: '{}', userId: 2 },
    });
    // 历史 null-userId 图（终审裁定收紧：列表面均精确过滤不可见，节点
    // 详情不得倒置可读）
    const nullUserGraph = await db.prisma.graphDefinition.create({
      data: { name: '无主图', graphJson: '{}', userId: null },
    });
    const mkRun = (
      data: Omit<Prisma.AutomationRunUncheckedCreateInput, 'startedAt' | 'triggerType'>,
    ) =>
      db.prisma.automationRun
        .create({
          data: { triggerType: 'schedule', startedAt: new Date(), ...data },
        })
        .then((row) => row.id);

    // 图试运行：两节点行（先失败后成功，验 id asc 顺序透传）
    graphRunId = await mkRun({
      taskId: null,
      graphId: graph.id,
      status: 'failed',
      error: 'node boom',
    });
    const mkNode = (
      nodeId: string,
      data: Partial<Prisma.GraphRunNodeUncheckedCreateInput>,
    ) =>
      db.prisma.graphRunNode.create({
        data: {
          runId: graphRunId,
          nodeId,
          status: 'success',
          durationMs: 0,
          startedAt: '2026-10-29T08:00:00.000Z',
          ...data,
        },
      });
    await mkNode('llm-1', {
      status: 'failed',
      nodeName: '生成',
      input: '完整输入'.repeat(100),
      output: '失败全貌文本',
      errorJson: '{"code":"llm_error","message":"boom","detail":"d"}',
      toolCallsJson: '[{"name":"read_skill","ok":true,"durationMs":120}]',
      promptTokens: 11,
      completionTokens: 22,
      durationMs: 3400,
    });
    await mkNode('tool-2', { nodeName: '工具', output: 'ok 输出' });
    // 他人图 run：归属不符应空集
    otherGraphRunId = await mkRun({
      taskId: null,
      graphId: otherGraph.id,
      status: 'success',
    });
    // null-userId 图 run：与列表面口径一致（精确匹配），空集——
    // 落节点行以区分「归属拒绝」与「老 run 无行」两种空
    nullUserGraphRunId = await mkRun({
      taskId: null,
      graphId: nullUserGraph.id,
      status: 'success',
    });
    await db.prisma.graphRunNode.create({
      data: {
        runId: nullUserGraphRunId,
        nodeId: 'n-1',
        status: 'success',
        durationMs: 10,
        startedAt: '2026-10-29T08:00:00.000Z',
        output: '无主图节点输出',
      },
    });
    // prompt 任务 run：graphId null 直拒空集
    promptRunId = await mkRun({ taskId: task.id, status: 'success' });
    // 图 run 无节点行（runNodes 前落库的老 run）：空集
    bareGraphRunId = await mkRun({
      taskId: null,
      graphId: graph.id,
      status: 'success',
    });
  }, 120_000);

  afterAll(async () => {
    await db.cleanup();
  });

  it('图 run：节点行 id asc 全量透传（全文/JSON 序列/tokens/ISO startedAt）', async () => {
    const nodes = await service.runNodes(graphRunId);
    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.nodeId)).toEqual(['llm-1', 'tool-2']);
    const first = nodes[0];
    expect(first?.nodeName).toBe('生成');
    expect(first?.status).toBe('failed');
    expect(first?.input).toBe('完整输入'.repeat(100));
    expect(first?.output).toBe('失败全貌文本');
    expect(first?.errorJson).toBe('{"code":"llm_error","message":"boom","detail":"d"}');
    expect(first?.toolCallsJson).toBe(
      '[{"name":"read_skill","ok":true,"durationMs":120}]',
    );
    expect(first?.promptTokens).toBe(11);
    expect(first?.completionTokens).toBe(22);
    expect(first?.durationMs).toBe(3400);
    expect(first?.startedAt).toBe('2026-10-29T08:00:00.000Z');
    expect(first?.runId).toBe(graphRunId);
  });

  it('prompt run（graphId null）：空集', async () => {
    const nodes = await service.runNodes(promptRunId);
    expect(nodes).toEqual([]);
  });

  it('老图 run 无节点行：空集', async () => {
    const nodes = await service.runNodes(bareGraphRunId);
    expect(nodes).toEqual([]);
  });

  it('他人图归属：空集（不暴露存在性）', async () => {
    const nodes = await service.runNodes(otherGraphRunId);
    expect(nodes).toEqual([]);
  });

  it('null-userId 图：空集（与 graph/query、runPage 精确过滤口径一致——实体不可见则详情不可读）', async () => {
    const nodes = await service.runNodes(nullUserGraphRunId);
    expect(nodes).toEqual([]);
  });

  it('run 不存在：空集', async () => {
    const nodes = await service.runNodes(99999);
    expect(nodes).toEqual([]);
  });
});
