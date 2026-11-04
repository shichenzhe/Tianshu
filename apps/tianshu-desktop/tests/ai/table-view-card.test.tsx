// @vitest-environment jsdom
/**
 * TableViewCard（show_table 工具块渲染的数据表格卡）冒烟：
 * done 态按 columns/rows 渲染表头与单元格（null 占位 —）、空 rows 出空态、
 * running 态出骨架占位、error/denied 不渲染。setup 同
 * tests/ai/expert-recommend-card.test.tsx（i18n mock + 手动 cleanup）。
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

import TableViewCard from "../../src-react/domains/ai/chat/components/TableViewCard";
import type { TablePanelItem } from "../../src-react/domains/ai/chat/lib/group-blocks";

afterEach(cleanup);

const item = (over: Partial<TablePanelItem> = {}): TablePanelItem => ({
  toolCallId: "t1",
  title: "支出明细",
  columns: [
    { key: "spent_at", label: "日期" },
    { key: "amount", label: "金额" },
    { key: "note", label: "备注" },
  ],
  rows: [
    { spent_at: "2026-10-28", amount: 35, note: "午饭" },
    { spent_at: "2026-10-27", amount: 12.5, note: null },
  ],
  state: "done",
  ...over,
});

describe("TableViewCard", () => {
  it("done 态渲染表头与单元格（null 备注/缺失键占位 —）", () => {
    render(<TableViewCard item={item()} />);
    expect(screen.getByText("支出明细")).toBeTruthy();
    expect(screen.getByText("日期")).toBeTruthy();
    expect(screen.getByText("金额")).toBeTruthy();
    expect(screen.getByText("午饭")).toBeTruthy();
    expect(screen.getByText("35")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("空 rows 渲染空态（不渲染任何行单元格）", () => {
    render(<TableViewCard item={item({ rows: [] })} />);
    expect(screen.getByText("chat:showTable.empty")).toBeTruthy();
    expect(screen.queryByText("午饭")).toBeNull();
  });

  it("running 态渲染骨架占位（不出表格数据）", () => {
    render(<TableViewCard item={item({ state: "running" })} />);
    expect(screen.getByTestId("table-loading")).toBeTruthy();
    expect(screen.queryByText("午饭")).toBeNull();
  });

  it("error/denied 态不渲染（args 不完整无卡可示）", () => {
    const { container } = render(
      <TableViewCard item={item({ state: "error" })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("标题缺省走默认标题 key", () => {
    render(<TableViewCard item={item({ title: undefined })} />);
    expect(screen.getByText("chat:showTable.defaultTitle")).toBeTruthy();
  });
});
