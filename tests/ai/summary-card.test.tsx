// @vitest-environment jsdom
/**
 * SummaryCard（show_summary 工具块渲染的摘要指标卡）冒烟：
 * done 态按 items 渲染 label/value/hint、空 items 出空态、running 态出
 * 骨架占位、error/denied 不渲染。setup 同 table-view-card.test.tsx。
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

import SummaryCard from "../../src-react/domains/ai/chat/components/SummaryCard";
import type { SummaryPanelItem } from "../../src-react/domains/ai/chat/lib/group-blocks";

afterEach(cleanup);

const item = (over: Partial<SummaryPanelItem> = {}): SummaryPanelItem => ({
  toolCallId: "t1",
  title: "月度汇总",
  items: [
    { label: "总支出", value: "¥123.5", hint: "含退款" },
    { label: "笔数", value: 12 },
  ],
  state: "done",
  ...over,
});

describe("SummaryCard", () => {
  it("done 态渲染 label/value/hint（数值 value 原样）", () => {
    render(<SummaryCard item={item()} />);
    expect(screen.getByText("月度汇总")).toBeTruthy();
    expect(screen.getByText("总支出")).toBeTruthy();
    expect(screen.getByText("¥123.5")).toBeTruthy();
    expect(screen.getByText("含退款")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
  });

  it("空 items 渲染空态", () => {
    render(<SummaryCard item={item({ items: [] })} />);
    expect(screen.getByText("chat:showSummary.empty")).toBeTruthy();
    expect(screen.queryByText("总支出")).toBeNull();
  });

  it("running 态渲染骨架占位（不出指标数据）", () => {
    render(<SummaryCard item={item({ state: "running" })} />);
    expect(screen.getByTestId("summary-loading")).toBeTruthy();
    expect(screen.queryByText("¥123.5")).toBeNull();
  });

  it("error/denied 态不渲染（args 不完整无卡可示）", () => {
    const { container } = render(
      <SummaryCard item={item({ state: "denied" })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("标题缺省走默认标题 key", () => {
    render(<SummaryCard item={item({ title: undefined })} />);
    expect(screen.getByText("chat:showSummary.defaultTitle")).toBeTruthy();
  });
});
