/**
 * 自动化健康度总览纯函数(spec §6):
 * IPC automation:stats 的聚合查询产出输入行,本模块只做口径计算
 * (可测:今日计数/成功率/7 天趋势/24h 关注清单)。
 * 口径:成功率 = success/(success+failed),skipped/running 不进分母;
 * trend 仅数 success/failed;attention = errorTasks 全列 + 近 24h failed。
 */
import type {
  AutomationStats,
  RunStatus,
} from "../../../../src-react/domains/ai/automation/api/automation.api";

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_DAYS = 7;

/** 聚合查询产出的统计输入行(名称已联查补位:任务 run 取任务名、图试运行取图名) */
export interface StatsRunRow {
  id: number;
  status: RunStatus;
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
