/**
 * 自动化埋点（自 mirror electron/domains/ai/automation/automation-stat.ts
 * 摘取，GA-T5）：仅 create 事件，detail JSON 携带
 * { mode, kind, hasEndAt, tabSwitchCount } 覆盖 PRD 三项统计。
 * 照 skill-stats 先例：fire-and-forget、吞错、delegate 缺席静默。
 * 改造点（GA-T5 登记）：commons/Log → Nest Logger（授权面 prisma/环境
 * 适配同款）。其余逐行保持。
 * T5 消费面备注：mirror 侧由 automation.repo create 通道埋点（GA-T3 摘取
 * 时按「端点面未列」舍去）；T6 automation.controller 任务创建端点接线。
 * 批3A（§6-6，mirror 同款）：每日统计 rollup——automationStat 新 bucket
 * event=dailyRollup，detail=按日 × 按用户聚合桶（纯函数单源
 * @tianshu/core/automation-rollup）；调度器 tick 收尾 1h 节流调
 * maybeRollupAutomationStats，窗口外行冻结为历史快照（行随本表 90 天
 * 保留期统一裁剪——scheduler onApplicationBootstrap）。
 */
import { Logger } from '@nestjs/common';
import {
  AUTOMATION_STAT_ROLLUP_EVENT,
  buildDailyRollups,
  mergeRollupDetail,
  parseRollupDetail,
  ROLLUP_WINDOW_DAYS,
  rollupWindowKeys,
  type DailyRollupDetail,
} from '@tianshu/core';

const logger = new Logger('automation-stat');

export interface AutomationStatPrismaLike {
  automationStat: {
    create(args: { data: { event: string; detail: string } }): Promise<unknown>;
  };
}

export async function recordAutomationEvent(
  prisma: AutomationStatPrismaLike | undefined,
  event: 'create',
  detail: unknown,
): Promise<void> {
  if (!prisma) {
    return;
  }
  try {
    await prisma.automationStat.create({
      data: { event, detail: JSON.stringify(detail) },
    });
  } catch (e) {
    logger.warn('自动化埋点写入失败', event, e);
  }
}

/** rollup 写方消费的库面（结构类型注入，测试替身同构满足） */
export interface AutomationRollupPrismaLike {
  automationRun: {
    findMany(args: {
      where: { startedAt: { gte: Date } };
      select: { startedAt: true; status: true; taskId: true; graphId: true };
    }): Promise<
      Array<{
        startedAt: Date;
        status: string;
        taskId: number | null;
        graphId: number | null;
      }>
    >;
  };
  automationTask: {
    findMany(args: {
      select: { id: true; userId: true };
    }): Promise<Array<{ id: number; userId: number | null }>>;
  };
  graphDefinition: {
    findMany(args: {
      select: { id: true; userId: true };
    }): Promise<Array<{ id: number; userId: number | null }>>;
  };
  automationStat: {
    findMany(args: {
      where: { event: string; createdAt: { gte: Date } };
      select: { id: true; detail: true };
    }): Promise<Array<{ id: number; detail: string }>>;
    create(args: { data: { event: string; detail: string } }): Promise<unknown>;
    update(args: {
      where: { id: number };
      data: { detail: string };
    }): Promise<unknown>;
  };
}

/** 节流：1h 重算一次（小时级快照足够——趋势补全只影响过去日） */
const ROLLUP_INTERVAL_MS = 60 * 60 * 1000;
let lastRollupAtMs = 0;

/** 测试重置节流窗（产线不触） */
export function resetRollupThrottleForTest(): void {
  lastRollupAtMs = 0;
}

/**
 * 每日 rollup 写方（吞错不阻塞调度，mirror 同款）：
 * 1. 窗口 7 天内 run 归属映射（任务 run→task.userId；图试运行→图 userId；
 *    无归属入 "0" 桶）→ buildDailyRollups 聚合；
 * 2. 既有窗口内 rollup 行单调合并（mergeRollupDetail——保留策略先于出窗
 *    裁掉 run 时重算缩水，旧桶保底防历史回退），全等跳写；
 * 3. 窗口外行不触碰（冻结历史）；零运行日不建行。
 */
export async function maybeRollupAutomationStats(
  prisma: AutomationRollupPrismaLike | undefined,
): Promise<void> {
  if (!prisma) {
    return;
  }
  const nowMs = Date.now();
  if (nowMs - lastRollupAtMs < ROLLUP_INTERVAL_MS) {
    return;
  }
  lastRollupAtMs = nowMs;
  try {
    const now = new Date(nowMs);
    const dayKeys = rollupWindowKeys(now, ROLLUP_WINDOW_DAYS);
    const windowStart = new Date(
      nowMs - ROLLUP_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const [runs, tasks, graphs] = await Promise.all([
      prisma.automationRun.findMany({
        where: { startedAt: { gte: windowStart } },
        select: { startedAt: true, status: true, taskId: true, graphId: true },
      }),
      prisma.automationTask.findMany({ select: { id: true, userId: true } }),
      prisma.graphDefinition.findMany({ select: { id: true, userId: true } }),
    ]);
    const taskUser = new Map(tasks.map((t) => [t.id, t.userId]));
    const graphUser = new Map(graphs.map((g) => [g.id, g.userId]));
    const rows = runs.map((run) => ({
      startedAt: run.startedAt,
      status: run.status,
      userKey: String(
        run.taskId !== null
          ? (taskUser.get(run.taskId) ?? 0)
          : run.graphId !== null
            ? (graphUser.get(run.graphId) ?? 0)
            : 0,
      ),
    }));
    const computed = buildDailyRollups(rows, dayKeys);
    if (computed.length === 0) {
      return;
    }
    // 既有行取 14d 超集（行 createdAt ≈ 首写时刻，必在所描述日之后 7d 内），
    // 按解析出的 detail.date 命中当前窗口；窗口外行天然不入选（冻结）
    const existingRows = await prisma.automationStat.findMany({
      where: {
        event: AUTOMATION_STAT_ROLLUP_EVENT,
        createdAt: {
          gte: new Date(nowMs - 2 * ROLLUP_WINDOW_DAYS * 24 * 60 * 60 * 1000),
        },
      },
      select: { id: true, detail: true },
    });
    const existingByDate = new Map<
      string,
      { id: number; rollup: DailyRollupDetail }
    >();
    for (const row of existingRows) {
      const rollup = parseRollupDetail(row.detail);
      if (rollup && dayKeys.includes(rollup.date)) {
        existingByDate.set(rollup.date, { id: row.id, rollup });
      }
    }
    for (const rollup of computed) {
      const existing = existingByDate.get(rollup.date);
      if (!existing) {
        await prisma.automationStat.create({
          data: {
            event: AUTOMATION_STAT_ROLLUP_EVENT,
            detail: JSON.stringify(rollup),
          },
        });
        continue;
      }
      const merged = mergeRollupDetail(existing.rollup, rollup);
      if (JSON.stringify(merged) !== JSON.stringify(existing.rollup)) {
        await prisma.automationStat.update({
          where: { id: existing.id },
          data: { detail: JSON.stringify(merged) },
        });
      }
    }
  } catch (e) {
    logger.warn('自动化每日 rollup 写入失败', e);
  }
}
