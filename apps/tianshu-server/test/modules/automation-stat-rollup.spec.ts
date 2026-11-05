// 批3A §6-6：每日统计 rollup 写方（automation-stat.ts maybeRollupAutomationStats）
// ——聚合纯函数在 @tianshu/core（automation-rollup），本文件守护 server 副本
// 接线：归属映射/单调合并/节流/吞错（mirror tests/ai/automation-stat-rollup
// .test.ts 同构对齐——drift 双份语义的行内回归网）。
import {
  maybeRollupAutomationStats,
  resetRollupThrottleForTest,
} from 'src/modules/automation/automation-stat';
import {
  AUTOMATION_STAT_ROLLUP_EVENT,
  parseRollupDetail,
  rollupDateKey,
} from '@tianshu/core';

type StatCreateArgs = { data: { event: string; detail: string } };
type StatUpdateArgs = { where: { id: number }; data: { detail: string } };
type RollupRunRow = {
  startedAt: Date;
  status: string;
  taskId: number | null;
  graphId: number | null;
};
type OwnerRow = { id: number; userId: number | null };
type StatRow = { id: number; detail: string };

/** prisma 替身（rollup 写方消费的四个模型面；返回类型对齐
 * AutomationRollupPrismaLike 结构类型,jest 严格 TS 不放行宽 Record） */
function makePrisma(overrides: {
  runs?: RollupRunRow[];
  tasks?: OwnerRow[];
  graphs?: OwnerRow[];
  stats?: StatRow[];
} = {}) {
  return {
    automationRun: {
      findMany: jest.fn(
        async (): Promise<RollupRunRow[]> => overrides.runs ?? [],
      ),
    },
    automationTask: {
      findMany: jest.fn(async (): Promise<OwnerRow[]> => overrides.tasks ?? []),
    },
    graphDefinition: {
      findMany: jest.fn(async (): Promise<OwnerRow[]> => overrides.graphs ?? []),
    },
    automationStat: {
      findMany: jest.fn(async (): Promise<StatRow[]> => overrides.stats ?? []),
      create: jest.fn(async (_args: StatCreateArgs) => ({})),
      update: jest.fn(async (_args: StatUpdateArgs) => ({})),
    },
  };
}

beforeEach(() => {
  resetRollupThrottleForTest();
});

describe('maybeRollupAutomationStats（server 副本）', () => {
  it('窗口内 run 按归属分桶落 dailyRollup 行', async () => {
    const prisma = makePrisma({
      runs: [
        { startedAt: new Date(), status: 'success', taskId: 11, graphId: null },
        { startedAt: new Date(), status: 'skipped', taskId: null, graphId: 21 },
      ],
      tasks: [{ id: 11, userId: 1 }],
      graphs: [{ id: 21, userId: null }],
    });
    await maybeRollupAutomationStats(prisma);
    expect(prisma.automationStat.create).toHaveBeenCalledTimes(1);
    const created = prisma.automationStat.create.mock.calls[0][0];
    expect(created.data.event).toBe(AUTOMATION_STAT_ROLLUP_EVENT);
    const rollup = parseRollupDetail(created.data.detail);
    // 伴生单用户 userId=1；图试运行无归属入 "0" 桶
    expect(rollup?.byUser['1']).toEqual({
      total: 1,
      success: 1,
      failed: 0,
      skipped: 0,
    });
    expect(rollup?.byUser['0'].skipped).toBe(1);
  });

  it('单调合并：重算缩水保底不写、增长 update 既有行', async () => {
    const todayKey = rollupDateKey(new Date());
    const shrink = makePrisma({
      runs: [
        { startedAt: new Date(), status: 'success', taskId: 11, graphId: null },
      ],
      tasks: [{ id: 11, userId: 1 }],
      stats: [
        {
          id: 99,
          detail: JSON.stringify({
            date: todayKey,
            byUser: { '1': { total: 6, success: 6, failed: 0, skipped: 0 } },
          }),
        },
      ],
    });
    await maybeRollupAutomationStats(shrink);
    expect(shrink.automationStat.update).not.toHaveBeenCalled();
    expect(shrink.automationStat.create).not.toHaveBeenCalled();
  });

  it('单调合并：计算增长 update 既有行（不另建行）', async () => {
    const todayKey = rollupDateKey(new Date());
    const grow = makePrisma({
      runs: [
        { startedAt: new Date(), status: 'failed', taskId: 11, graphId: null },
      ],
      tasks: [{ id: 11, userId: 1 }],
      stats: [
        {
          id: 99,
          detail: JSON.stringify({
            date: todayKey,
            byUser: { '1': { total: 0, success: 0, failed: 0, skipped: 0 } },
          }),
        },
      ],
    });
    await maybeRollupAutomationStats(grow);
    expect(grow.automationStat.update).toHaveBeenCalledWith({
      where: { id: 99 },
      data: { detail: expect.stringContaining('"failed":1') },
    });
  });

  it('节流 1h；吞错不抛；prisma 缺席静默', async () => {
    const prisma = makePrisma();
    await maybeRollupAutomationStats(prisma);
    const calls = prisma.automationRun.findMany.mock.calls.length;
    await maybeRollupAutomationStats(prisma);
    expect(prisma.automationRun.findMany).toHaveBeenCalledTimes(calls);
    const broken = makePrisma();
    broken.automationRun.findMany = jest.fn(async (): Promise<RollupRunRow[]> => {
      throw new Error('db down');
    });
    await expect(maybeRollupAutomationStats(broken)).resolves.toBeUndefined();
    await expect(
      maybeRollupAutomationStats(undefined),
    ).resolves.toBeUndefined();
  });
});
