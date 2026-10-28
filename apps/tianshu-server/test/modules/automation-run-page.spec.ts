// 移动端 CRUD+运行历史批：automation/runPage 服务级直证——排序/total/
// taskId 任务口径（归属校验、不并图试运行）/status 下推/图试运行全量
// 并入（图名补位）/graphTrace 剔除（wire = 协议包 AutomationRunRecord
// 精简面，协议包 graph-contract.ts 同源注释）。
import type { Prisma } from '@prisma/client';
import { AutomationRepository } from 'src/modules/automation/automation.repository';
import { AutomationService } from 'src/modules/automation/automation.service';
import { EventBusService } from 'src/commons/event-bus/event-bus.service';
import { createTestDb, type TestDb } from '../support/test-db';

describe('automation/runPage 运行历史分页（移动端 CRUD 批）', () => {
  let db: TestDb;
  let service: AutomationService;
  let taskA: number;
  let taskB: number;
  let graphId: number;

  beforeAll(async () => {
    db = await createTestDb();
    service = new AutomationService(
      db.prisma,
      new AutomationRepository(db.prisma),
      new EventBusService(),
    );
    const ws = await db.prisma.workspace.create({
      data: { name: 'runs-ws', userId: 1 },
    });
    const mkTask = (name: string) =>
      db.prisma.automationTask
        .create({
          data: {
            name,
            prompt: 'p',
            workspaceId: ws.id,
            modelId: 0,
            scheduleJson: '{}',
            scheduleText: 's',
            userId: 1,
          },
        })
        .then((row) => row.id);
    taskA = await mkTask('任务甲');
    taskB = await mkTask('任务乙');
    graphId = (
      await db.prisma.graphDefinition.create({
        data: { name: '编排图一', graphJson: '{}', userId: 1 },
      })
    ).id;

    const T0 = Date.now() - 10 * 3600_000;
    const mkRun = (
      i: number,
      data: Omit<Prisma.AutomationRunUncheckedCreateInput, 'startedAt' | 'triggerType'>,
    ) =>
      db.prisma.automationRun.create({
        data: { triggerType: 'schedule', startedAt: new Date(T0 + i * 3600_000), ...data },
      });
    // 甲三 run（success 最新档/failed 中档/running 再早）+ 乙一 run（最早）
    await mkRun(1, { taskId: taskA, status: 'running' });
    await mkRun(2, { taskId: taskA, status: 'failed', error: 'boom' });
    await mkRun(3, {
      taskId: taskA,
      status: 'success',
      durationMs: 1500,
      promptTokens: 10,
      completionTokens: 20,
    });
    await mkRun(0, { taskId: taskB, status: 'success' });
    // 图试运行：taskId=null + graphTrace 全量口径应并入（图名补位）、
    // 任务口径不应并入；graphTrace 落库但 wire 必须剔除
    await mkRun(4, {
      taskId: null,
      graphId,
      status: 'success',
      graphTrace: '{"steps":[]}',
    });
    // 翻页直证：补 20 条乙 run，page1 满页 20 / page2 余量（25 总-20=5）
    await db.prisma.automationRun.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        taskId: taskB,
        triggerType: 'schedule',
        status: 'success',
        startedAt: new Date(T0 - (i + 1) * 60_000),
      })),
    });
  }, 120_000);

  afterAll(async () => {
    await db.cleanup();
  });

  it('全量列表：startedAt desc + total 25 + 图试运行图名补位 + graphTrace 剔除', async () => {
    const page = await service.runPage({ page: 1 });
    expect(page.total).toBe(25);
    expect(page.items).toHaveLength(20);
    const graphRun = page.items.find((r) => r.taskId === null);
    expect(graphRun).toBeDefined();
    expect(graphRun?.taskName).toBe('编排图一');
    expect(graphRun?.graphId).toBe(graphId);
    // wire 精简面：全量行无 graphTrace 键（落库有、出参必无）
    expect(page.items.every((r) => !('graphTrace' in r))).toBe(true);
    // desc：首行 = 图试运行（最新档）
    expect(page.items[0]?.taskId).toBeNull();
  });

  it('翻页：page2 取回余量 5 条', async () => {
    const page = await service.runPage({ page: 2 });
    expect(page.total).toBe(25);
    expect(page.items).toHaveLength(5);
  });

  it('taskId 任务口径：只回该任务 run、不并图试运行、taskName 联查', async () => {
    const page = await service.runPage({ page: 1, taskId: taskA });
    expect(page.total).toBe(3);
    expect(page.items.every((r) => r.taskId === taskA)).toBe(true);
    expect(page.items.every((r) => r.taskName === '任务甲')).toBe(true);
  });

  it('taskId 不存在：空页（列表语义不暴露存在性）', async () => {
    const page = await service.runPage({ page: 1, taskId: 99999 });
    expect(page.total).toBe(0);
    expect(page.items).toEqual([]);
  });

  it('status 下推筛选：failed 只回失败 run（含 error）', async () => {
    const page = await service.runPage({ page: 1, status: 'failed' });
    expect(page.total).toBe(1);
    expect(page.items[0]?.error).toBe('bo' + 'om');
  });

  it('契约字段直证：耗时/tokens/attempt/triggerType/ISO 时间', async () => {
    const page = await service.runPage({ page: 1, taskId: taskA, status: 'success' });
    const run = page.items[0];
    expect(run?.durationMs).toBe(1500);
    expect(run?.promptTokens).toBe(10);
    expect(run?.completionTokens).toBe(20);
    expect(run?.attempt).toBe(1);
    expect(run?.triggerType).toBe('schedule');
    expect(run?.startedAt).toEqual(new Date(run!.startedAt).toISOString());
  });
});
