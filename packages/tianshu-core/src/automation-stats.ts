/**
 * 自动化健康度总览聚合纯函数（spec §6；2026-11-10 收编单源——桌面主进程
 * IPC 聚合与渲染层远程态适配器（automation/stats 原始行端点）双消费，
 * mobile 深路径可用；零依赖零 Node API）。
 * 口径:成功率 = success/(success+failed),skipped/running 不进分母;
 * trend 仅数 success/failed;attention = errorTasks 全列 + 近 24h failed。
 * 「今日」/趋势日键取设备本地时区——聚合恒在客户端侧完成,server 端点
 * 只出原始行集（startedAt ISO）,时区口径不跨端假设。
 */

/** 运行状态联合（automation 域 wire 同构字面量） */
export type StatsRunStatus = "running" | "success" | "failed" | "skipped";

/** 健康度总览（桌面 automation.api AutomationStats 同构单源） */
export interface AutomationStats {
  today: {
    total: number;
    success: number;
    failed: number;
    running: number;
    successRate: number;
  };
  trend: Array<{ date: string; success: number; failed: number }>;
  /** 「需要关注」清单：任务级异常 + 近 24h 失败 run */
  attention: Array<
    | {
        kind: "taskError";
        taskId: number;
        name: string;
        statusNote: string;
      }
    | {
        kind: "failedRun";
        runId: number;
        name: string;
        graphId?: number;
        error: string;
        startedAt: string;
      }
  >;
  errorTaskCount: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_DAYS = 7;

/** 聚合查询产出的统计输入行(名称已联查补位:任务 run 取任务名、图试运行取图名) */
export interface StatsRunRow {
  id: number;
  status: StatsRunStatus;
  error?: string;
  startedAt: Date;
  name: string;
  graphId?: number;
}

/** 任务级异常行(status=error 的任务,repo 查询产出) */
export interface StatsErrorTask {
  id: number;
  name: string;
  statusNote: string;
}

/** 每日 rollup 趋势日(批3A §6-6):repo 从 automationStat dailyRollup 行
 * 解析的当前用户桶——过去趋势日单调补全被保留策略裁剪的计数 */
export interface StatsRollupDay {
  date: string;
  success: number;
  failed: number;
}

/** attention 的 failedRun 变体(排序需读 startedAt,收窄联合类型) */
type FailedRunAttention = Extract<
  AutomationStats["attention"][number],
  { kind: "failedRun" }
>;

/** 本地日键 yyyy-MM-dd(设备时区,"今日"与用户直觉一致) */
function localDateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function computeStats(
  runs: StatsRunRow[],
  errorTasks: StatsErrorTask[],
  now: Date,
  rollups: StatsRollupDay[] = [],
): AutomationStats {
  const todayKey = localDateKey(now);
  const trend = Array.from({ length: TREND_DAYS }, (_, i) => {
    const date = localDateKey(
      new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - (TREND_DAYS - 1 - i),
      ),
    );
    return { date, success: 0, failed: 0 };
  });
  const trendByDate = new Map(trend.map((day) => [day.date, day]));
  const today = { total: 0, success: 0, failed: 0, running: 0 };
  const failedRuns: FailedRunAttention[] = [];
  const since24h = now.getTime() - DAY_MS;
  for (const r of runs) {
    const key = localDateKey(r.startedAt);
    if (key === todayKey) {
      today.total += 1;
      if (r.status === "success") {
        today.success += 1;
      } else if (r.status === "failed") {
        today.failed += 1;
      } else if (r.status === "running") {
        today.running += 1;
      }
    }
    const bucket = trendByDate.get(key);
    if (bucket) {
      if (r.status === "success") {
        bucket.success += 1;
      } else if (r.status === "failed") {
        bucket.failed += 1;
      }
    }
    if (r.status === "failed" && r.startedAt.getTime() >= since24h) {
      failedRuns.push({
        kind: "failedRun",
        runId: r.id,
        name: r.name,
        ...(r.graphId !== undefined && { graphId: r.graphId }),
        error: r.error ?? "",
        startedAt: r.startedAt.toISOString(),
      });
    }
  }
  failedRuns.sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
  // 每日 rollup 单调合并(批3A §6-6):过去趋势日以每日汇总行补全被保留
  // 策略裁剪的计数(max——run 仍在即以即时聚合为准);今日恒用即时聚合
  // (rollup 每小时节流写,必然滞后);窗口外日期 trend 不含、天然忽略
  const rollupByDate = new Map(
    rollups.filter((r) => r.date !== todayKey).map((r) => [r.date, r] as const),
  );
  for (const day of trend) {
    const rollup = rollupByDate.get(day.date);
    if (rollup) {
      day.success = Math.max(day.success, rollup.success);
      day.failed = Math.max(day.failed, rollup.failed);
    }
  }
  const denominator = today.success + today.failed;
  return {
    today: {
      ...today,
      successRate: denominator === 0 ? 0 : today.success / denominator,
    },
    trend,
    attention: [
      ...errorTasks.map((task) => ({
        kind: "taskError" as const,
        taskId: task.id,
        name: task.name,
        statusNote: task.statusNote,
      })),
      ...failedRuns,
    ],
    errorTaskCount: errorTasks.length,
  };
}
