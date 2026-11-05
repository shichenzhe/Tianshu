/** MCP 工具面折叠预算会话级自适应（skills-tools-mcp §6-3）：
 *  surfaceBudgetFor(contextWindow)——4K 静态线按会话 contextWindow 线性
 *  调线（小窗激进折叠 / 大窗保直注），边界与缺省行为单测 */
import { describe, expect, it } from "vitest";
import {
  MCP_TOOL_SURFACE_BUDGET_MAX_TOKENS,
  MCP_TOOL_SURFACE_BUDGET_MIN_TOKENS,
  MCP_TOOL_SURFACE_BUDGET_TOKENS,
  DEFAULT_CONTEXT_WINDOW,
  surfaceBudgetFor,
} from "./mcp-surface-budget";

describe("surfaceBudgetFor（会话级自适应预算线）", () => {
  it("缺省/非法输入回落静态线 4000（与 MCP_TOOL_SURFACE_BUDGET_TOKENS 同源）", () => {
    expect(surfaceBudgetFor(null)).toBe(MCP_TOOL_SURFACE_BUDGET_TOKENS);
    expect(surfaceBudgetFor(undefined)).toBe(MCP_TOOL_SURFACE_BUDGET_TOKENS);
    expect(surfaceBudgetFor(0)).toBe(MCP_TOOL_SURFACE_BUDGET_TOKENS);
    expect(surfaceBudgetFor(Number.NaN)).toBe(MCP_TOOL_SURFACE_BUDGET_TOKENS);
    expect(surfaceBudgetFor(-1)).toBe(MCP_TOOL_SURFACE_BUDGET_TOKENS);
    expect(surfaceBudgetFor(Number.POSITIVE_INFINITY)).toBe(
      MCP_TOOL_SURFACE_BUDGET_TOKENS,
    );
  });

  it("标准窗口（DEFAULT_CONTEXT_WINDOW 128K）恰为静态线 4000——现行为零漂移", () => {
    expect(surfaceBudgetFor(DEFAULT_CONTEXT_WINDOW)).toBe(
      MCP_TOOL_SURFACE_BUDGET_TOKENS,
    );
  });

  it("小窗更激进折叠：32K 窗落至下限 1000", () => {
    expect(surfaceBudgetFor(32 * 1024)).toBe(
      MCP_TOOL_SURFACE_BUDGET_MIN_TOKENS,
    );
  });

  it("大窗保直注：200K 窗预算高于静态线；1M 窗封顶 8000", () => {
    const large = surfaceBudgetFor(200 * 1024);
    expect(large).toBeGreaterThan(MCP_TOOL_SURFACE_BUDGET_TOKENS);
    expect(surfaceBudgetFor(1024 * 1024)).toBe(
      MCP_TOOL_SURFACE_BUDGET_MAX_TOKENS,
    );
    expect(surfaceBudgetFor(8 * 1024 * 1024)).toBe(
      MCP_TOOL_SURFACE_BUDGET_MAX_TOKENS,
    );
  });

  it("单调不减：窗口越大预算不降", () => {
    let prev = 0;
    for (const window of [
      16 * 1024,
      32 * 1024,
      64 * 1024,
      128 * 1024,
      200 * 1024,
      400 * 1024,
      1024 * 1024,
    ]) {
      const budget = surfaceBudgetFor(window);
      expect(budget).toBeGreaterThanOrEqual(prev);
      prev = budget;
    }
  });
});
