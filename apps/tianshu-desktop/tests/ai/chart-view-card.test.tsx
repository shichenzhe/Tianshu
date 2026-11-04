// @vitest-environment jsdom
/**
 * ChartViewCard（show_chart 工具块渲染的手绘 SVG 图表卡）冒烟：
 * line 型出 polyline+circle（单点退化为独立圆点无连线）、bar 型出 rect、
 * ≥2 系列出图例、空态/running 骨架/error 不渲染。setup 同
 * table-view-card.test.tsx。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
      i18n: { language: "zh-CN" },
    }),
  };
});

import ChartViewCard from "../../src-react/domains/ai/chat/components/ChartViewCard";
import type { ChartPanelItem } from "../../src-react/domains/ai/chat/lib/group-blocks";

afterEach(cleanup);

const item = (over: Partial<ChartPanelItem> = {}): ChartPanelItem => ({
  toolCallId: "c1",
  title: "近 6 个月支出",
  chartType: "line",
  labels: ["5月", "6月", "7月"],
  series: [{ name: "支出", values: [120, 88, 200] }],
  state: "done",
  ...over,
});

describe("ChartViewCard", () => {
  it("line 型渲染折线与数据点（title 悬停读值）", () => {
    const { container } = render(<ChartViewCard item={item()} />);
    expect(screen.getByText("近 6 个月支出")).toBeTruthy();
    const polyline = container.querySelector("polyline");
    expect(polyline).not.toBeNull();
    // 3 个数据点 + 单系列
    expect(container.querySelectorAll("circle")).toHaveLength(3);
    expect(polyline!.getAttribute("points")!.split(" ").length).toBe(3);
    const title = container.querySelector("circle title");
    expect(title?.textContent).toContain("支出 · 5月: 120");
  });

  it("单点退化：无 polyline，独立圆点标记", () => {
    const { container } = render(
      <ChartViewCard
        item={item({
          labels: ["5月"],
          series: [{ name: "支出", values: [120] }],
        })}
      />,
    );
    expect(container.querySelector("polyline")).toBeNull();
    expect(container.querySelectorAll("circle").length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("bar 型渲染柱体 rect（多系列分组）", () => {
    const { container } = render(
      <ChartViewCard
        item={item({
          chartType: "bar",
          labels: ["餐饮", "交通"],
          series: [
            { name: "本月", values: [300, 120] },
            { name: "上月", values: [280, 90] },
          ],
        })}
      />,
    );
    expect(container.querySelector("polyline")).toBeNull();
    expect(container.querySelectorAll("rect")).toHaveLength(4);
    // ≥2 系列：图例（系列名出现在标题栏）
    expect(screen.getByText("本月")).toBeTruthy();
    expect(screen.getByText("上月")).toBeTruthy();
  });

  it("空态（labels/series 空）渲染空态文案不出图形", () => {
    render(<ChartViewCard item={item({ labels: [], series: [] })} />);
    expect(screen.getByText("chat:showChart.empty")).toBeTruthy();
  });

  it("running 骨架占位；error/denied 不渲染", () => {
    render(<ChartViewCard item={item({ state: "running" })} />);
    expect(screen.getByTestId("chart-loading")).toBeTruthy();
    cleanup();
    const { container } = render(
      <ChartViewCard item={item({ state: "error" })} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
