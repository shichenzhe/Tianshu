// @vitest-environment jsdom
/**
 * PlanCalendarView 日历视图测试（mock 骨架同 tests/project/plan-list.test.tsx：
 * t 返回 key、sonner/@/i18n 桩、Radix 弹层桩；plan-date 真实实现——农历断言
 * 用真值）：月导航（<< >> 今天）、今日高亮（今日格子 data-today）、农历标注
 * 渲染（2026-09-25 显示 中秋节）、任务 chips（+N 折叠）、点格空白
 * onCreateAt(dateKey)、点 chip onEdit、无日期统计文本。
 * 今日断言改用可控值：组件「今日」用真实 new Date()——测试通过
 * vi.setSystemTime 固定到 2026-09-14（八月初四）再恢复；插值 key
 * （calendarTitle/noDueDateCount）的 t 桩附加有序键值对后缀，供断言
 * year/month/count 实际取值。
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";

// Radix 弹层在 jsdom 的最小桩：popper 定位依赖 ResizeObserver，
// 触发器 pointerDown 分支依赖 hasPointerCapture/scrollIntoView
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.hasPointerCapture = () => false;
  window.HTMLElement.prototype.releasePointerCapture = () => {};
});

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    // 插值 key：key::名=值,... 后缀（calendarTitle 的 year/month、
    // noDueDateCount 的 count），非插值 key 原样返回
    useTranslation: () => ({
      t: (key: string, options?: Record<string, string | number>) =>
        options
          ? `${key}::${Object.entries(options)
              .map(([name, value]) => `${name}=${value}`)
              .join(",")}`
          : key,
    }),
  };
});

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

// cn 依赖 @/i18n 实例，最小桩避免拉起完整 i18n 栈
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));

import PlanCalendarView from "../../src-react/domains/project/components/PlanCalendarView";
import type { PlanItemRecord } from "../../../electron/domains/project/plan-item.entity";

const makeItem = (overrides: Partial<PlanItemRecord> = {}): PlanItemRecord => ({
  id: 1,
  projectId: 1,
  title: "事项",
  status: "not_started",
  priority: "P1",
  assigneeId: 1,
  tags: [],
  customFields: {},
  startDate: "",
  dueDate: "",
  source: "manual",
  sortOrder: 0,
  createdById: 1,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

/**
 * 覆盖度：09-14 ×2 项（需求梳理 P0 + 9 字标题验证截短）、09-20 一项
 * （联调准备，点格新建用）、无日期一项（统计 count=1）。
 */
const ITEMS: PlanItemRecord[] = [
  makeItem({
    id: 1,
    title: "需求梳理",
    priority: "P0",
    dueDate: "2026-09-14T00:00:00.000Z",
  }),
  makeItem({
    id: 2,
    title: "超长标题需要被截断",
    dueDate: "2026-09-14T00:00:00.000Z",
  }),
  makeItem({ id: 3, title: "联调准备", dueDate: "2026-09-20T00:00:00.000Z" }),
  makeItem({ id: 4, title: "无日期事项", dueDate: "" }),
];

type CalendarProps = ComponentProps<typeof PlanCalendarView>;

/** 渲染日历视图（缺省 fixture），返回回调桩 */
function renderCalendar(overrides: Partial<CalendarProps> = {}) {
  const props = {
    items: ITEMS,
    onCreateAt: vi.fn(),
    onEdit: vi.fn(),
    ...overrides,
  } as CalendarProps & Record<string, ReturnType<typeof vi.fn>>;
  render(<PlanCalendarView {...props} />);
  return props;
}

/** 公历数字 → 所在日格容器（数字 span 两级上溯；2026-09 网格内数字唯一） */
const dayCell = (day: number) => {
  const span = screen.getByText(String(day));
  return span.parentElement?.parentElement as HTMLElement;
};

/** 月标题插值文本（断言 year/month 实际取值） */
const calendarTitleText = () =>
  screen.getByText(/calendarTitle/).textContent ?? "";

// 今日固定 2026-09-14（八月初四）；afterEach 恢复真实时间
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 14));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("当月渲染与今日高亮", () => {
  it("默认渲染当月（2026-09）；今日格 data-today=true 且高亮类含 bg-primary-subtle；农历「初四」出现", () => {
    renderCalendar();

    expect(calendarTitleText()).toContain("year=2026");
    expect(calendarTitleText()).toContain("month=9");
    const cell = dayCell(14);
    const today = cell.querySelector('[data-today="true"]');
    expect(today).toBeTruthy();
    expect(today?.className).toContain("bg-primary-subtle");
    expect(screen.getByText("初四")).toBeTruthy();
    // 周表头（一~日，t 桩回显 key）齐全
    for (let weekday = 1; weekday <= 7; weekday += 1) {
      expect(
        screen.getByText(`project:planView.weekday${weekday}`),
      ).toBeTruthy();
    }
  });
});

describe("月导航", () => {
  it("点 >> → 标题变 2026-10（今日格不在网格）；点 今天 → 回 2026-09", () => {
    renderCalendar();

    fireEvent.click(
      screen.getByRole("button", { name: "project:planView.nextMonth" }),
    );
    expect(calendarTitleText()).toContain("month=10");
    expect(document.querySelector('[data-today="true"]')).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "project:planView.today" }),
    );
    expect(calendarTitleText()).toContain("month=9");
    expect(document.querySelector('[data-today="true"]')).toBeTruthy();
  });
});

describe("农历节日", () => {
  it("2026-09-25 格显示「中秋节」（festival 优先）；同格无任务时 chips 空", () => {
    renderCalendar();

    const cell = dayCell(25);
    expect(within(cell).getByText("中秋节")).toBeTruthy();
    expect(within(cell).queryAllByRole("button")).toHaveLength(0);
  });
});

describe("任务 chips", () => {
  it("09-14 格渲染 2 个 chip（9 字标题截短为前 6 字）+ 第 3 项不存在；点 chip → onEdit(item)", () => {
    const props = renderCalendar();

    const cell = dayCell(14);
    expect(within(cell).getAllByRole("button")).toHaveLength(2);
    expect(within(cell).getByRole("button", { name: "需求梳理" })).toBeTruthy();
    // 截短：9 字标题只显示前 6 字，全文不出现
    expect(
      within(cell).getByRole("button", { name: "超长标题需要" }),
    ).toBeTruthy();
    expect(screen.queryByText("超长标题需要被截断")).toBeNull();
    // 第三项（09-20）不在本格
    expect(within(cell).queryByText("联调准备")).toBeNull();

    fireEvent.click(within(cell).getByRole("button", { name: "需求梳理" }));
    expect(props.onEdit).toHaveBeenCalledTimes(1);
    expect(props.onEdit).toHaveBeenCalledWith(ITEMS[0]);
    // chip 点击不冒泡成点格新建
    expect(props.onCreateAt).not.toHaveBeenCalled();
  });

  it("同日 4 项 → 显示 3 chip + 「+1」", () => {
    const fourItems = [1, 2, 3, 4].map((id) =>
      makeItem({
        id,
        title: `任务${id}号`,
        dueDate: "2026-09-14T00:00:00.000Z",
      }),
    );
    renderCalendar({ items: fourItems });

    const cell = dayCell(14);
    expect(within(cell).getAllByRole("button")).toHaveLength(3);
    expect(within(cell).getByText("+1")).toBeTruthy();
  });
});

describe("点格新建", () => {
  it("点格空白 → onCreateAt('2026-09-20')", () => {
    const props = renderCalendar();

    fireEvent.click(dayCell(20));
    expect(props.onCreateAt).toHaveBeenCalledTimes(1);
    expect(props.onCreateAt).toHaveBeenCalledWith("2026-09-20");
  });
});

describe("无日期统计", () => {
  it("顶部渲染「无日期记录」统计（i18n key planView.noDueDateCount 插值 count=1）", () => {
    renderCalendar();

    expect(screen.getByText(/noDueDateCount/).textContent).toContain("count=1");
  });
});
