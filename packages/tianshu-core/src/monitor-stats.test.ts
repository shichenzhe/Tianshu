// computeMonitorStats MCP server 维度聚合单测（skills-tools-mcp §6 项 8：
// mcp__ 前缀切分组 + 按 server 聚合成功率/延迟/次数）。toolName 形态
// mcp__<server>__<tool>（mcp-manager toolPrefix 构造）；server 段取前缀后
// 首个 __ 之前（构造序决定，server 名自身含 __ 时以首个为界）。
// 成本折算口径（monitoring §6 P1-3，Task 9 批 5）：DB 显式价 > 内置目录价
// > 未知（null）；byModel.cost 未知 null、totalCost 全未知 null。
import { describe, expect, it } from "vitest";
import { computeMonitorStats } from "./monitor-stats";
import type { LlmEventRow, ToolEventRow } from "./monitor-stats";

const now = new Date("2026-11-05T15:00:00");

function toolRow(over: Partial<ToolEventRow>): ToolEventRow {
  return {
    toolName: "write",
    state: "done",
    durationMs: null,
    createdAt: now,
    ...over,
  };
}

function llmRow(over: Partial<LlmEventRow>): LlmEventRow {
  return {
    modelId: 1,
    inputTokens: 0,
    outputTokens: 0,
    createdAt: now,
    ...over,
  };
}

describe("computeMonitorStats mcpByServer", () => {
  it("空数据：mcpByServer 为空数组", () => {
    const s = computeMonitorStats([], [], [], now);
    expect(s.mcpByServer).toEqual([]);
  });

  it("mcp__ 前缀按 server 分桶：计数/成功率/平均延迟/total 降序", () => {
    const s = computeMonitorStats(
      [],
      [
        toolRow({
          toolName: "mcp__github__create_issue",
          state: "done",
          durationMs: 100,
        }),
        toolRow({
          toolName: "mcp__github__get_file",
          state: "done",
          durationMs: 300,
        }),
        toolRow({
          toolName: "mcp__github__create_issue",
          state: "error",
          durationMs: null,
        }),
        toolRow({
          toolName: "mcp__jira__search",
          state: "denied",
          durationMs: 50,
        }),
      ],
      [],
      now,
    );
    expect(s.mcpByServer).toEqual([
      {
        server: "github",
        total: 3,
        done: 2,
        denied: 0,
        error: 1,
        avgDurationMs: 200,
        successRate: 2 / 3,
      },
      {
        server: "jira",
        total: 1,
        done: 0,
        denied: 1,
        error: 0,
        avgDurationMs: 50,
        successRate: 0,
      },
    ]);
  });

  it("非 mcp 工具不进 mcpByServer（tools 榜单口径不变）", () => {
    const s = computeMonitorStats(
      [],
      [
        toolRow({ toolName: "write", state: "done" }),
        toolRow({ toolName: "bash", state: "denied" }),
      ],
      [],
      now,
    );
    expect(s.mcpByServer).toEqual([]);
    expect(s.tools.map((t) => t.toolName).sort()).toEqual(["bash", "write"]);
  });

  it("mcp 工具同时保留在 tools 榜单（双面互不挤占）", () => {
    const s = computeMonitorStats(
      [],
      [toolRow({ toolName: "mcp__github__create_issue", state: "done" })],
      [],
      now,
    );
    expect(s.tools.map((t) => t.toolName)).toEqual([
      "mcp__github__create_issue",
    ]);
    expect(s.mcpByServer?.map((m) => m.server)).toEqual(["github"]);
  });

  it("server 名含 __ 时以首个 __ 为界（构造序 mcp__<server>__<tool>）", () => {
    const s = computeMonitorStats(
      [],
      [toolRow({ toolName: "mcp__my__srv__tool", state: "done" })],
      [],
      now,
    );
    expect(s.mcpByServer?.[0]?.server).toBe("my");
    expect(s.mcpByServer).toHaveLength(1);
  });

  it("残缺形态 mcp__<server>（无工具段）归入该 server 桶不炸", () => {
    const s = computeMonitorStats(
      [],
      [toolRow({ toolName: "mcp__orphan", state: "done" })],
      [],
      now,
    );
    expect(s.mcpByServer?.[0]).toMatchObject({ server: "orphan", total: 1 });
  });
});

describe("computeMonitorStats 成本折算（P1-3）", () => {
  it("DB 显式价折算：token/1M × 单价（in+out），byModel.cost 与 totalCost", () => {
    const s = computeMonitorStats(
      [
        // 1M in + 0.5M out → 1×0.5 + 0.5×2 = 1.5
        llmRow({ modelId: 1, inputTokens: 1_000_000, outputTokens: 500_000 }),
      ],
      [],
      [
        {
          id: 1,
          name: null,
          modelId: "custom",
          priceInPerMTokens: 0.5,
          priceOutPerMTokens: 2,
        },
      ],
      now,
    );
    expect(s.byModel[0]?.cost).toBe(1.5);
    expect(s.totalCost).toBe(1.5);
  });

  it("DB 无价回退内置目录价（gpt-4o：2.5/10）", () => {
    const s = computeMonitorStats(
      // 0.4M in + 0.1M out → 1 + 1 = 2
      [llmRow({ modelId: 1, inputTokens: 400_000, outputTokens: 100_000 })],
      [],
      [{ id: 1, name: null, modelId: "gpt-4o" }],
      now,
    );
    expect(s.byModel[0]?.cost).toBe(2);
    expect(s.totalCost).toBe(2);
  });

  it("无价模型 byModel.cost 为 null；全未知 totalCost 为 null（未知价）", () => {
    const s = computeMonitorStats(
      [
        llmRow({ modelId: 1, inputTokens: 100, outputTokens: 100 }),
        // graph 场景行：modelId 恒 null（byModel 跳过，无法计价）
        llmRow({ modelId: null, inputTokens: 99, outputTokens: 99 }),
      ],
      [],
      [{ id: 1, name: null, modelId: "my-private-model" }],
      now,
    );
    expect(s.byModel[0]?.cost).toBeNull();
    expect(s.totalCost).toBeNull();
  });

  it("混合有价/无价：totalCost 为有价部分和（部分计价），无价行 cost null", () => {
    const s = computeMonitorStats(
      [
        // gpt-4o-mini：0.15/0.6 → 1M×0.15 + 1M×0.6 = 0.75
        llmRow({ modelId: 1, inputTokens: 1_000_000, outputTokens: 1_000_000 }),
        llmRow({ modelId: 2, inputTokens: 500_000, outputTokens: 500_000 }),
      ],
      [],
      [
        { id: 1, name: null, modelId: "gpt-4o-mini" },
        { id: 2, name: null, modelId: "local-llm" },
      ],
      now,
    );
    expect(s.byModel.map((m) => [m.modelId, m.cost])).toEqual([
      [1, 0.75],
      [2, null],
    ]);
    expect(s.totalCost).toBe(0.75);
  });

  it("DB 价部分列（仅 priceIn）：按已知列折算，缺席列记 0 不回落目录", () => {
    const s = computeMonitorStats(
      [llmRow({ modelId: 1, inputTokens: 1_000_000, outputTokens: 1_000_000 })],
      [],
      [{ id: 1, name: null, modelId: "gpt-4o", priceInPerMTokens: 1 }],
      now,
    );
    expect(s.byModel[0]?.cost).toBe(1);
    expect(s.totalCost).toBe(1);
  });

  it("零数据 totalCost 为 null 而非 0（无调用 = 未知而非免费）", () => {
    const s = computeMonitorStats([], [], [], now);
    expect(s.totalCost).toBeNull();
  });
});
