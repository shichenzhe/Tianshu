// automation/stats 原始行集端点（automation/library 路由化批挂账收口
// 2026-11-10）：窗口过滤/归属口径（任务集 OR 图集）/error 任务行/
// 非法 since 拒收。时区敏感聚合在客户端 computeStats（core 单源）完成，
// 端点只出精简行集——本测只锁数据面。
import { AutomationRepository } from 'src/modules/automation/automation.repository';
import { AutomationService } from 'src/modules/automation/automation.service';
import { EventBusService } from 'src/commons/event-bus/event-bus.service';
import { createTestDb, type TestDb } from '../support/test-db';

describe('automation/stats 原始行集（挂账收口批）', () => {
  let db: TestDb;
  let repo: AutomationRepository;
  let service: AutomationService;
  let taskOwn: number;
  let taskOther: number;

  beforeAll(async () => {
    db = await createTestDb();
    repo = new AutomationRepository(db.prisma);
    service = new AutomationService(
      db.prisma,
      new AutomationRepository(db.prisma),
      new EventBusService(),
    );
    const mkTask = (name: string, userId: number) =>
      db.prisma.automationTask
        .create({
          data: {
            name,
            prompt: 'p',
            workspaceId: 1,
            modelId: 0,
            scheduleJson: '{}',
            scheduleText: 's',
            userId,
          },
        })
        .then((row) => row.id);
    taskOwn = await mkTask('本人任务', 1);
    taskOther = await mkTask('他人任务', 2);

    const NOW = Date.now();
    await db.prisma.automationRun.createMany({
      data: [
        // 窗口内：本人任务 run + 本人图 run（都该出现）
        {
          taskId: taskOwn,
          triggerType: 'schedule',
          status: 'success',
          startedAt: new Date(NOW - 3600_000),
        },
        {
          taskId: null,
          graphId: 5,
          triggerType: 'manual',
          status: 'failed',
          error: 'boom',
          startedAt: new Date(NOW - 7200_000),
        },
        // 窗口外（8 天前）：不出现
        {
          taskId: taskOwn,
          triggerType: 'schedule',
          status: 'success',
          startedAt: new Date(NOW - 8 * 24 * 3600_000),
        },
        // 他人任务 run：不出现（归属）
        {
          taskId: taskOther,
          triggerType: 'schedule',
          status: 'success',
          startedAt: new Date(NOW - 3600_000),
        },
      ],
    });
    // 图归属（graphId=5 属本人）
    await db.prisma.graphDefinition.create({
      data: { id: 5, name: '本人图', graphJson: '{}', userId: 1 },
    });
    // error 任务行（attention 数据源）
    await db.prisma.automationTask.create({
      data: {
        name: '异常任务',
        prompt: 'p',
        workspaceId: 1,
        modelId: 0,
        scheduleJson: '{}',
        scheduleText: 's',
        userId: 1,
        status: 'error',
        statusNote: '执行失败',
      },
    });
  }, 120_000);

  afterAll(async () => {
    await db.cleanup();
  });

  it('窗口内本人 run（任务+图）出现、窗口外与他人的不出现', async () => {
    const since = new Date(Date.now() - 7 * 24 * 3600_000);
    const result = await repo.statsRaw(since, 1);
    expect(result.runs).toHaveLength(2);
    const statuses = result.runs.map((r) => r.status).sort();
    expect(statuses).toEqual(['failed', 'success']);
    // 图 run 图名补位（hydrateRunNames 同款口径）
    const graphRun = result.runs.find((r) => r.taskId === null);
    expect(graphRun?.taskName).toBe('本人图');
    expect(graphRun?.graphId).toBe(5);
  });

  it('errorTasks：error 任务全列出（id/name/statusNote）', async () => {
    const since = new Date(Date.now() - 7 * 24 * 3600_000);
    const result = await repo.statsRaw(since, 1);
    expect(result.errorTasks).toEqual([
      {
        id: expect.any(Number),
        name: '异常任务',
        statusNote: '执行失败',
      },
    ]);
  });

  it('service 层：非法 since 拒收', async () => {
    await expect(
      service.statsRaw({ since: 'not-a-date' }),
    ).rejects.toThrowError('since 必须是合法的 ISO 时间');
  });
});
