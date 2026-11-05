// tests/ai/automation-stat-rollup.test.ts
// 每日统计 rollup 写方（批3A §6-6）：automationStat 新 bucket
// event=dailyRollup——窗口内 run → 按日 × 按用户聚合、单调合并（保留
// 策略裁剪后重算缩水不回退历史）。聚合纯函数在 packages core
// （automation-rollup.test.ts），本文件守护写方接线：归属映射/节流/吞错。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp") },
}));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  maybeRollupAutomationStats,
  resetRollupThrottleForTest,
} from "../../electron/domains/ai/automation/automation-stat";
import {
  AUTOMATION_STAT_ROLLUP_EVENT,
  parseRollupDetail,
  rollupDateKey,
} from "@tianshu/core";

/** prisma 替身：rollup 写方消费的四个模型面（显式参数类型,断言取参可判型） */
type StatCreateArgs = { data: { event: string; detail: string } };
type StatUpdateArgs = { where: { id: number }; data: { detail: string } };
function makePrisma(overrides: {
  runs?: Array<Record<string, unknown>>;
  tasks?: Array<Record<string, unknown>>;
  graphs?: Array<Record<string, unknown>>;
  stats?: Array<Record<string, unknown>>;
} = {}) {
  return {
    automationRun: {
      findMany: vi.fn(async () => overrides.runs ?? []),
    },
    automationTask: {
      findMany: vi.fn(async () => overrides.tasks ?? []),
    },
    graphDefinition: {
      findMany: vi.fn(async () => overrides.graphs ?? []),
    },
    automationStat: {
      findMany: vi.fn(async () => overrides.stats ?? []),
      create: vi.fn(async (_args: StatCreateArgs) => ({})),
      update: vi.fn(async (_args: StatUpdateArgs) => ({})),
    },
  };
}

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 24 * 60 * 60 * 1000);

beforeEach(() => {
  resetRollupThrottleForTest();
});

describe("maybeRollupAutomationStats 写方接线", () => {
  it("窗口内 run 按任务归属 userId 分桶落 dailyRollup 行；图试运行按图归属", async () => {
    const prisma = makePrisma({
      runs: [
        {
          startedAt: new Date(),
          status: "success",
          taskId: 11,
          graphId: null,
        },
        {
          startedAt: new Date(),
          status: "failed",
          taskId: null,
          graphId: 21,
        },
      ],
      tasks: [{ id: 11, userId: 7 }],
      graphs: [{ id: 21, userId: 9 }],
    });
    await maybeRollupAutomationStats(prisma);
    expect(prisma.automationRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { startedAt: true, status: true, taskId: true, graphId: true },
      }),
    );
    expect(prisma.automationStat.create).toHaveBeenCalledTimes(1);
    const created = vi.mocked(prisma.automationStat.create).mock.calls[0][0];
    expect(created.data.event).toBe(AUTOMATION_STAT_ROLLUP_EVENT);
    const rollup = parseRollupDetail(created.data.detail);
    expect(rollup?.byUser["7"]).toEqual({
      total: 1,
      success: 1,
      failed: 0,
      skipped: 0,
    });
    expect(rollup?.byUser["9"]).toEqual({
      total: 1,
      success: 0,
      failed: 1,
      skipped: 0,
    });
  });

  it("既有行单调合并:重算缩水保底(保留策略裁剪后不回退),无变化不落写", async () => {
    // 本地日键(设备时区口径,与写方 rollupWindowKeys 一致——toISOString
    // 是 UTC 日,早八点前会错位)
    const todayKey = rollupDateKey(new Date());
    const existing = {
      date: todayKey,
      byUser: { "7": { total: 6, success: 6, failed: 0, skipped: 0 } },
    };
    const prisma = makePrisma({
      runs: [
        { startedAt: new Date(), status: "success", taskId: 11, graphId: null },
      ],
      tasks: [{ id: 11, userId: 7 }],
      stats: [{ id: 99, detail: JSON.stringify(existing) }],
    });
    await maybeRollupAutomationStats(prisma);
    // 计算值 total 1 < 既有 6 → 旧桶保底,合并结果与旧值全等 → 不写
    expect(prisma.automationStat.update).not.toHaveBeenCalled();
    expect(prisma.automationStat.create).not.toHaveBeenCalled();
  });

  it("计算增长时单调覆盖既有行(update 不另建行)", async () => {
    const todayKey = rollupDateKey(new Date());
    const prisma = makePrisma({
      runs: [
        { startedAt: new Date(), status: "failed", taskId: 11, graphId: null },
        { startedAt: new Date(), status: "success", taskId: 11, graphId: null },
      ],
      tasks: [{ id: 11, userId: 7 }],
      stats: [
        {
          id: 99,
          detail: JSON.stringify({
            date: todayKey,
            byUser: { "7": { total: 1, success: 1, failed: 0, skipped: 0 } },
          }),
        },
      ],
    });
    await maybeRollupAutomationStats(prisma);
    expect(prisma.automationStat.update).toHaveBeenCalledWith({
      where: { id: 99 },
      data: {
        detail: expect.stringContaining('"failed":1'),
      },
    });
    expect(prisma.automationStat.create).not.toHaveBeenCalled();
  });

  it("节流:1h 内第二次直接返回；吞错不抛(写失败仅告警)", async () => {
    const prisma = makePrisma();
    await maybeRollupAutomationStats(prisma);
    const calls = vi.mocked(prisma.automationRun.findMany).mock.calls.length;
    await maybeRollupAutomationStats(prisma);
    expect(prisma.automationRun.findMany).toHaveBeenCalledTimes(calls);

    const broken = {
      automationRun: {
        findMany: vi.fn(async () => {
          throw new Error("db down");
        }),
      },
      automationTask: { findMany: vi.fn(async () => []) },
      graphDefinition: { findMany: vi.fn(async () => []) },
      automationStat: {
        findMany: vi.fn(async () => []),
        create: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
      },
    };
    await expect(maybeRollupAutomationStats(broken)).resolves.toBeUndefined();
    // prisma 缺席静默(照 recordAutomationEvent 先例)
    await expect(maybeRollupAutomationStats(undefined)).resolves.toBeUndefined();
  });

  it("窗口外冻结:仅重算窗口内 7 天,窗口外既有行不触碰", async () => {
    const oldFrozen = {
      id: 55,
      detail: JSON.stringify({
        date: daysAgo(20).toISOString().slice(0, 10),
        byUser: { "7": { total: 9, success: 9, failed: 0, skipped: 0 } },
      }),
    };
    const prisma = makePrisma({
      runs: [],
      stats: [oldFrozen],
    });
    await maybeRollupAutomationStats(prisma);
    expect(prisma.automationStat.update).not.toHaveBeenCalled();
    expect(prisma.automationStat.create).not.toHaveBeenCalled();
  });
});
