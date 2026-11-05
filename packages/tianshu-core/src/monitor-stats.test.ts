// computeMonitorStats MCP server 维度聚合单测（skills-tools-mcp §6 项 8：
// mcp__ 前缀切分组 + 按 server 聚合成功率/延迟/次数）。toolName 形态
// mcp__<server>__<tool>（mcp-manager toolPrefix 构造）；server 段取前缀后
// 首个 __ 之前（构造序决定，server 名自身含 __ 时以首个为界）。
import { describe, expect, it } from "vitest";
import { computeMonitorStats } from "./monitor-stats";
import type { ToolEventRow } from "./monitor-stats";

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
      [
        toolRow({ toolName: "mcp__github__create_issue", state: "done" }),
      ],
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
      [
        toolRow({ toolName: "mcp__my__srv__tool", state: "done" }),
      ],
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
