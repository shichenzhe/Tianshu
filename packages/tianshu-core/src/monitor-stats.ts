/**
 * 监控统计纯函数（spec §5.2；MO 批 2026-10-27 收编 @tianshu/core 自 mirror
 * electron/domains/ai/monitor/monitor-stats.ts——mirror 原位 re-export）：findMany 读回行 → 内存聚合（7 天窗口
 * 本地单机千级，automation-stats computeStats 同构、skill-stats 决策 4
 * 同判词）。口径：成功率 = done/(done+denied+error)（denied 进分母，
 * 与自动化成功率「skipped 不进分母」不同：工具被拒是可观测结果）；
 * byModel 跳过 modelId=null（graph 场景，今日/趋势已含其 token）；
 * 趋势 7 天含空日补零（旧→新）；avgDurationMs 仅非 null 参与均值。
 * mcpByServer（skills-tools-mcp §6 项 8）：mcp__ 前缀行按 server 段另聚
 * （成功率/延迟/次数），tools 榜单口径不变——协议字段可选（旧端增量兼容）。
 * 成本折算（monitoring §6 P1-3，Task 9 批 5）：byModel.cost 与 totalCost
 * ——单价 DB 显式价（任一列在场即按已知列折算，缺席列记 0 不回落目录）
 * > 内置目录价（./model-catalog）> 未知（null）；totalCost = 有价行和，
 * 全未知/零数据为 null（未知价 ≠ 免费）。
 */
import type { MonitorStats } from "@tianshu/protocol";
import { lookupModelCatalog } from "./model-catalog";

const TREND_DAYS = 7;

/** MCP 工具名前缀（mcp-manager toolPrefix 同款构造 mcp__<server>__<tool>） */
export const MCP_TOOL_PREFIX = "mcp__";

/**
 * mcp__<server>__<tool> 切 server 段：前缀后首个 __ 之前（构造序决定；
 * server 名自身含 __ 时以首个为界）。非 mcp__ 前缀返回 null。
 */
export function mcpServerOf(toolName: string): string | null {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = toolName.slice(MCP_TOOL_PREFIX.length);
  const sep = rest.indexOf("__");
  return sep === -1 ? rest : rest.slice(0, sep);
}

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

/** model 联查行（名字补位 + 成本单价，P1-3：价格列可选——旧调用方/
 * 测试替身不传时按未知价处理，不炸） */
export interface ModelNameRow {
  id: number;
  name: string | null;
  modelId: string;
  /** 输入单价（USD / 1M token）；DB model.priceInPerMTokens */
  priceInPerMTokens?: number | null;
  /** 输出单价（USD / 1M token）；DB model.priceOutPerMTokens */
  priceOutPerMTokens?: number | null;
}

/**
 * 解析模型单价对（USD / 1M token）：DB 显式价任一列在场即按已知列
 * 折算（缺席列记 0——用户选了部分定价，不回落目录防口径混淆）；
 * 否则内置目录价；均无 → null（未知价）。本模型不可计价返回 null
 * 与「免费（0,0）」区分。
 */
export function resolveModelPrices(
  model: Pick<
    ModelNameRow,
    "modelId" | "priceInPerMTokens" | "priceOutPerMTokens"
  >,
): { priceIn: number; priceOut: number } | null {
  if (model.priceInPerMTokens != null || model.priceOutPerMTokens != null) {
    return {
      priceIn: model.priceInPerMTokens ?? 0,
      priceOut: model.priceOutPerMTokens ?? 0,
    };
  }
  const catalog = lookupModelCatalog(model.modelId);
  if (
    catalog?.priceInPerMTokens !== undefined ||
    catalog?.priceOutPerMTokens !== undefined
  ) {
    return {
      priceIn: catalog.priceInPerMTokens ?? 0,
      priceOut: catalog.priceOutPerMTokens ?? 0,
    };
  }
  return null;
}

/** 成本折算（token/1M × 单价，in+out），六位小数截噪 */
export function llmCostUsd(
  inputTokens: number,
  outputTokens: number,
  prices: { priceIn: number; priceOut: number },
): number {
  const cost =
    (inputTokens / 1_000_000) * prices.priceIn +
    (outputTokens / 1_000_000) * prices.priceOut;
  return Math.round(cost * 1e6) / 1e6;
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

function emptyMcpServerItem(
  server: string,
): NonNullable<MonitorStats["mcpByServer"]>[number] {
  return {
    server,
    total: 0,
    done: 0,
    denied: 0,
    error: 0,
    avgDurationMs: null,
    successRate: 0,
  };
}

function withRate<T extends { total: number; done: number }>(
  item: T,
  durationSum: number,
  durationCount: number,
): T & { avgDurationMs: number | null; successRate: number } {
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
  // 成本单价对（P1-3）：DB 显式价 > 目录价 > 未知（null）
  const prices = new Map(
    models.map((m) => [m.id, resolveModelPrices(m)] as const),
  );
  const byModelMap = new Map<
    number,
    MonitorStats["byModel"][number] & { costSum: number | null }
  >();
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
      costSum: null,
    };
    item.calls += 1;
    item.inputTokens += row.inputTokens;
    item.outputTokens += row.outputTokens;
    const pricePair = prices.get(row.modelId);
    if (pricePair) {
      const cost = llmCostUsd(row.inputTokens, row.outputTokens, pricePair);
      item.costSum = (item.costSum ?? 0) + cost;
    }
    byModelMap.set(row.modelId, item);
  }
  const byModel = [...byModelMap.values()]
    .map(({ costSum, ...item }) => ({
      ...item,
      cost: costSum === null ? null : Math.round(costSum * 1e6) / 1e6,
    }))
    .sort((a, b) => b.inputTokens - a.inputTokens);
  // totalCost = 有价行和；全未知/零数据 null（未知价 ≠ 免费）
  const costKnown = byModel.filter(
    (m): m is typeof m & { cost: number } =>
      m.cost !== null && m.cost !== undefined,
  );
  const totalCost = costKnown.length
    ? Math.round(costKnown.reduce((sum, m) => sum + m.cost, 0) * 1e6) / 1e6
    : null;
  // —— tools：state 分桶计数，avgDurationMs 仅非 null 参与均值 ——
  const toolsMap = new Map<
    string,
    { item: MonitorStats["tools"][number]; sum: number; cnt: number }
  >();
  // —— mcpByServer：mcp__ 前缀行另按 server 段聚合（tools 榜单口径不变，
  //    双面并存——server 维度看整体健康度，tools 看 single 工具排行）——
  const mcpMap = new Map<
    string,
    {
      item: NonNullable<MonitorStats["mcpByServer"]>[number];
      sum: number;
      cnt: number;
    }
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
    const server = mcpServerOf(row.toolName);
    if (server !== null) {
      const mcpEntry = mcpMap.get(server) ?? {
        item: emptyMcpServerItem(server),
        sum: 0,
        cnt: 0,
      };
      mcpEntry.item.total += 1;
      if (
        row.state === "done" ||
        row.state === "denied" ||
        row.state === "error"
      ) {
        mcpEntry.item[row.state] += 1;
      }
      if (row.durationMs !== null) {
        mcpEntry.sum += row.durationMs;
        mcpEntry.cnt += 1;
      }
      mcpMap.set(server, mcpEntry);
    }
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
    byModel,
    tools: [...toolsMap.values()]
      .map((e) => withRate(e.item, e.sum, e.cnt))
      .sort((a, b) => b.total - a.total),
    mcpByServer: [...mcpMap.values()]
      .map((e) => withRate(e.item, e.sum, e.cnt))
      .sort((a, b) => b.total - a.total),
    totalCost,
  };
}
