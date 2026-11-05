// @vitest-environment jsdom
// MonitorView 渲染：KPI 数字与榜单行来自 monitor.api fixture；
// i18n 未初始化时 t() 返回 key，断言只锚数字/工具名
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";

const fixture = {
  today: {
    inputTokens: 12345,
    outputTokens: 678,
    llmCalls: 9,
    toolCalls: 12,
    toolSuccessRate: 0.5,
  },
  trend: Array.from({ length: 7 }, (_, i) => ({
    date: `2026-09-${30 + i}`,
    inputTokens: 10,
    outputTokens: 5,
    llmCalls: 2,
    toolCalls: 3,
  })),
  byModel: [
    {
      modelId: 1,
      name: "主力模型",
      calls: 7,
      inputTokens: 12345,
      outputTokens: 678,
      cost: 1.5,
    },
    {
      modelId: 2,
      name: "本地模型",
      calls: 2,
      inputTokens: 100,
      outputTokens: 50,
      cost: null,
    },
  ],
  tools: [
    {
      toolName: "write",
      total: 8,
      done: 4,
      denied: 2,
      error: 2,
      avgDurationMs: 150,
      successRate: 0.5,
    },
  ],
  mcpByServer: [
    {
      server: "github",
      total: 5,
      done: 4,
      denied: 0,
      error: 1,
      avgDurationMs: 320,
      successRate: 0.8,
    },
  ],
  totalCost: 1.5,
};

vi.mock("../../src-react/domains/ai/monitor/api/monitor.api", () => ({
  MonitorApi: { stats: vi.fn(async () => fixture) },
}));

import MonitorView from "../../src-react/domains/ai/monitor/views/MonitorView";
import { MonitorApi } from "../../src-react/domains/ai/monitor/api/monitor.api";

afterEach(cleanup);

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MonitorView />
    </QueryClientProvider>,
  );
}

describe("MonitorView", () => {
  it("渲染 KPI 与工具/模型榜单行", async () => {
    renderView();
    expect(await screen.findByText("write")).toBeTruthy();
    expect(await screen.findByText("主力模型")).toBeTruthy();
    // 数字经 formatCount：12345 → 1.2w（zh 缺省 locale 由 Intl 决定，
    // 断言放宽为文本包含 "9"（llmCalls KPI）即可
    expect(screen.getByText("9")).toBeTruthy();
  });

  it("MCP server 维度聚合卡：mcpByServer 行渲染（server 名 + 成功率）", async () => {
    renderView();
    expect(await screen.findByText("github")).toBeTruthy();
    // 成功率 0.8 → 80%
    expect(await screen.findByText("80%")).toBeTruthy();
  });

  it("mcpByServer 缺席（旧远端响应）：MCP 卡不渲染（增量兼容面）", async () => {
    const legacy = { ...fixture, mcpByServer: undefined };
    vi.mocked(MonitorApi.stats).mockImplementationOnce(
      async () => legacy as never,
    );
    renderView();
    expect(await screen.findByText("write")).toBeTruthy();
    expect(screen.queryByText("80%")).toBeNull();
  });

  it("成本折算（批5 P1-3）：totalCost KPI 与 byModel 成本列（未知价标记）", async () => {
    renderView();
    // totalCost KPI 卡 + byModel 成本列各一处 $1.5000（成本格式化非 i18n）；
    // 未知价标记兼容 key 形式（本 suite i18n 未初始化时 t() 返回 key）
    expect(
      (await screen.findAllByText("$1.5000")).length,
    ).toBeGreaterThanOrEqual(2);
    expect(await screen.findByText(/costUnknown|未知价/)).toBeTruthy();
  });

  it("totalCost null（全未知价）：KPI 显示未知价而非 $0", async () => {
    const unknown = { ...fixture, totalCost: null };
    vi.mocked(MonitorApi.stats).mockImplementationOnce(
      async () => unknown as never,
    );
    renderView();
    expect(await screen.findByText("write")).toBeTruthy();
    // KPI 与本地模型行各一处未知价（key 形式兼容）
    expect(
      (await screen.findAllByText(/costUnknown|未知价/)).length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("$0.0000")).toBeNull();
  });
});
