/**
 * 监控统计纯函数（spec §5.2；MO 批 2026-10-27 收编 @tianshu/core 自 mirror
 * electron/domains/ai/monitor/monitor-stats.ts——mirror 原位 re-export）：findMany 读回行 → 内存聚合（7 天窗口
 * 本地单机千级，automation-stats computeStats 同构、skill-stats 决策 4
 * 同判词）。口径：成功率 = done/(done+denied+error)（denied 进分母，
 * 与自动化成功率「skipped 不进分母」不同：工具被拒是可观测结果）；
 * byModel 跳过 modelId=null（graph 场景，今日/趋势已含其 token）；
 * 趋势 7 天含空日补零（旧→新）；avgDurationMs 仅非 null 参与均值。
 */
import type { MonitorStats } from "@tianshu/protocol";

const TREND_DAYS = 7;

/** findMany 产出行（llmCallEvent select 子集） */
export interface LlmEventRow {
  modelId: number | null;
  inputTokens: number;
  outputTokens: number;
  createdAt: Date;
}

/** findMany 产出行（toolCallEvent select 子集） */
export interface ToolEventRow {
  toolName: string;
  state: string;
  durationMs: number | null;
  createdAt: Date;
}

/** model 联查行（名字补位） */
export interface ModelNameRow {
  id: number;
  name: string | null;
  modelId: string;
}

/** 本地日键 yyyy-MM-dd（设备时区，automation-stats 同款） */
function localDateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function emptyTrendDay(date: string): MonitorStats["trend"][number] {
  return { date, inputTokens: 0, outputTokens: 0, llmCalls: 0, toolCalls: 0 };
}

function emptyToolItem(toolName: string): MonitorStats["tools"][number] {
  return {
    toolName,
    total: 0,
    done: 0,
    denied: 0,
    error: 0,
    avgDurationMs: null,
    successRate: 0,
  };
}

function withRate(
  item: MonitorStats["tools"][number],
  durationSum: number,
  durationCount: number,
): MonitorStats["tools"][number] {
  return {
    ...item,
    avgDurationMs:
      durationCount > 0 ? Math.round(durationSum / durationCount) : null,
    successRate: item.total > 0 ? item.done / item.total : 0,
  };
}

export function computeMonitorStats(
  llmRows: LlmEventRow[],
  toolRows: ToolEventRow[],
  models: ModelNameRow[],
  now: Date,
): MonitorStats {
  // —— 趋势骨架：近 7 天含空日补零（旧→新；automation-stats.ts:51-60 同款）——
  const trend = Array.from({ length: TREND_DAYS }, (_, i) =>
    emptyTrendDay(
      localDateKey(
        new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate() - (TREND_DAYS - 1 - i),
        ),
      ),
    ),
  );
  const trendByDate = new Map(trend.map((day) => [day.date, day]));
  for (const row of llmRows) {
    const bucket = trendByDate.get(localDateKey(row.createdAt));
    if (bucket) {
      bucket.inputTokens += row.inputTokens;
      bucket.outputTokens += row.outputTokens;
      bucket.llmCalls += 1;
    }
  }
  // —— 工具趋势分桶 + 今日成功率分子（denied/error 进分母，spec §5.2）——
  let todayToolDone = 0;
  const todayKey = trend[TREND_DAYS - 1].date;
  for (const row of toolRows) {
    const key = localDateKey(row.createdAt);
    const bucket = trendByDate.get(key);
    if (bucket) {
      bucket.toolCalls += 1;
    }
    if (key === todayKey && row.state === "done") {
      todayToolDone += 1;
    }
  }
  const today = trend[TREND_DAYS - 1];
  // —— byModel：null modelId（graph 场景）跳过，今日/趋势已含其 token ——
  const names = new Map(
    models.map((m) => [m.id, m.name ?? m.modelId ?? `#${m.id}`]),
  );
  const byModelMap = new Map<number, MonitorStats["byModel"][number]>();
  for (const row of llmRows) {
    if (row.modelId === null) {
      continue;
    }
    const item = byModelMap.get(row.modelId) ?? {
      modelId: row.modelId,
      name: names.get(row.modelId) ?? `#${row.modelId}`,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    item.calls += 1;
    item.inputTokens += row.inputTokens;
    item.outputTokens += row.outputTokens;
    byModelMap.set(row.modelId, item);
  }
  // —— tools：state 分桶计数，avgDurationMs 仅非 null 参与均值 ——
  const toolsMap = new Map<
    string,
    { item: MonitorStats["tools"][number]; sum: number; cnt: number }
  >();
  for (const row of toolRows) {
    const entry = toolsMap.get(row.toolName) ?? {
      item: emptyToolItem(row.toolName),
      sum: 0,
      cnt: 0,
    };
    entry.item.total += 1;
    if (
      row.state === "done" ||
      row.state === "denied" ||
      row.state === "error"
    ) {
      entry.item[row.state] += 1;
    }
    if (row.durationMs !== null) {
      entry.sum += row.durationMs;
      entry.cnt += 1;
    }
    toolsMap.set(row.toolName, entry);
  }
  return {
    today: {
      inputTokens: today.inputTokens,
      outputTokens: today.outputTokens,
      llmCalls: today.llmCalls,
      toolCalls: today.toolCalls,
      toolSuccessRate:
        today.toolCalls === 0 ? 0 : todayToolDone / today.toolCalls,
    },
    trend,
    byModel: [...byModelMap.values()].sort(
      (a, b) => b.inputTokens - a.inputTokens,
    ),
    tools: [...toolsMap.values()]
      .map((e) => withRate(e.item, e.sum, e.cnt))
      .sort((a, b) => b.total - a.total),
  };
}
