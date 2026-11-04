// computeMonitorStats 纯函数单测（automation-stats.test 同风格）：
// 趋势空日补零、今日口径、成功率分母 0 记 0、byModel 跳过 null、排序
import { describe, expect, it } from "vitest";
import { computeMonitorStats } from "@tianshu/core";
import type {
  LlmEventRow,
  ToolEventRow,
} from "../../electron/domains/ai/monitor/monitor-stats";

const now = new Date("2026-10-06T15:00:00");

function llmRow(over: Partial<LlmEventRow>): LlmEventRow {
  return {
    modelId: 1,
    inputTokens: 0,
    outputTokens: 0,
    createdAt: now,
    ...over,
  };
}
function toolRow(over: Partial<ToolEventRow>): ToolEventRow {
  return {
    toolName: "t",
    state: "done",
    durationMs: null,
    createdAt: now,
    ...over,
  };
}

describe("computeMonitorStats", () => {
  it("空数据：今日全 0、趋势 7 天补零、列表空", () => {
    const s = computeMonitorStats([], [], [], now);
    expect(s.today).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      llmCalls: 0,
      toolCalls: 0,
      toolSuccessRate: 0,
    });
    expect(s.trend).toHaveLength(7);
    expect(s.trend.every((d) => d.llmCalls === 0 && d.toolCalls === 0)).toBe(
      true,
    );
    expect(s.byModel).toEqual([]);
    expect(s.tools).toEqual([]);
  });

  it("今日聚合 + 趋势按本地日分桶（跨日不串桶）", () => {
    const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
    const s = computeMonitorStats(
      [
        llmRow({ inputTokens: 10, outputTokens: 4 }),
        llmRow({ inputTokens: 20, outputTokens: 6, createdAt: yesterday }),
      ],
      [
        toolRow({ state: "done" }),
        toolRow({ state: "error" }),
        toolRow({ state: "denied", createdAt: yesterday }),
      ],
      [],
      now,
    );
    expect(s.today).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      llmCalls: 1,
      toolCalls: 2,
      toolSuccessRate: 0.5,
    });
    expect(s.trend[6].llmCalls).toBe(1);
    expect(s.trend[6].toolCalls).toBe(2);
    expect(s.trend[5].llmCalls).toBe(1);
    expect(s.trend[5].toolCalls).toBe(1);
  });

  it("byModel：null modelId 跳过、名字补位 name→modelId→#id、inputTokens 降序", () => {
    const s = computeMonitorStats(
      [
        llmRow({ modelId: 1, inputTokens: 10, outputTokens: 2 }),
        llmRow({ modelId: 2, inputTokens: 50, outputTokens: 5 }),
        llmRow({ modelId: null, inputTokens: 99, outputTokens: 99 }),
      ],
      [],
      [
        { id: 1, name: null, modelId: "gpt-x" },
        { id: 2, name: "主力模型", modelId: "m2" },
      ],
      now,
    );
    expect(s.byModel).toEqual([
      {
        modelId: 2,
        name: "主力模型",
        calls: 1,
        inputTokens: 50,
        outputTokens: 5,
      },
      { modelId: 1, name: "gpt-x", calls: 1, inputTokens: 10, outputTokens: 2 },
    ]);
  });

  it("tools：state 分桶计数、avgDurationMs 忽略 null、total 降序", () => {
    const s = computeMonitorStats(
      [],
      [
        toolRow({ toolName: "a", state: "done", durationMs: 100 }),
        toolRow({ toolName: "a", state: "done", durationMs: 200 }),
        toolRow({ toolName: "a", state: "error", durationMs: null }),
        toolRow({ toolName: "b", state: "done", durationMs: 5 }),
      ],
      [],
      now,
    );
    expect(s.tools[0]).toEqual({
      toolName: "a",
      total: 3,
      done: 2,
      denied: 0,
      error: 1,
      avgDurationMs: 150,
      successRate: 2 / 3,
    });
    expect(s.tools[1].toolName).toBe("b");
  });
});
