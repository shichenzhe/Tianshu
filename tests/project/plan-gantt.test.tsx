// @vitest-environment jsdom
/**
 * PlanGanttView 甘特视图测试（渲染部分；mock 骨架同 plan-list.test.tsx：
 * t 返回 key、sonner/@/i18n 桩、Radix 弹层桩；plan-date 真实实现）：
 * - barGeometry 纯函数：left/width 天宽换算
 * - 默认日粒度：60 列头（首列 08-15）；A 项条 data-item-id 跨列几何；
 *   B 项单端钳 1 天；C 项无日期左列行存在且无条形
 * - 切「月」粒度 → 列头出现月份数字「10」
 * - 今天线 data-today-line 落在 diffDays × 28 天宽处
 * - 点 >> → 首列起点后移 60 天（08-15 → 10-14）
 * - 点条形 → onEdit(item)（纯点按不触发 onChangeDates）
 * - dragEdgeFor 纯函数：条内相对 x 左右 6px 热区（start/end）与中段 move
 * - 拖拽提交链：条 pointerDown（jsdom 无布局 rect.left=0 → offsetX=clientX）
 *   + window pointermove（天粒度吸附 dayDelta，条形 left/width 实时预览）
 *   + pointerup → onChangeDates 收 dragToDates 三边缘结果；原地点按不提交；
 *   拖拽后拖尾 click 不触发 onEdit；未传 onChangeDates 不进入拖拽
 * jsdom 无布局且 div 无角色，列头/条形断言走 data 属性
 * （data-column-key/data-item-id）；vi.setSystemTime 固定 2026-09-14
 * 保证今天线/初始视口确定性。
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
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

// cn 依赖 @/i18n 实例，最小桩避免拉起完整 i18n 栈
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));

import PlanGanttView, {
  barGeometry,
  dragEdgeFor,
} from "../../src-react/domains/project/components/PlanGanttView";
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
 * 覆盖度：A 项 09-10~09-14（P0 跨 5 天条）、B 项仅 dueDate 09-20（单端钳
 * 1 天条）、C 项无日期（左列灰显行、无条形）。
 */
const ITEMS: PlanItemRecord[] = [
  makeItem({
    id: 1,
    title: "需求梳理",
    priority: "P0",
    startDate: "2026-09-10T00:00:00.000Z",
    dueDate: "2026-09-14T00:00:00.000Z",
  }),
  makeItem({ id: 2, title: "联调准备", dueDate: "2026-09-20T00:00:00.000Z" }),
  makeItem({ id: 3, title: "无日期事项" }),
];

type GanttProps = ComponentProps<typeof PlanGanttView>;

/** 渲染甘特视图（缺省 fixture），返回回调桩 */
function renderGantt(overrides: Partial<GanttProps> = {}) {
  const props = {
    items: ITEMS,
    onChangeDates: vi.fn(),
    onEdit: vi.fn(),
    ...overrides,
  } as GanttProps & Record<string, ReturnType<typeof vi.fn>>;
  render(<PlanGanttView {...props} />);
  return props;
}

/** 首列头（DOM 序即列序） */
const firstColumn = () =>
  document.querySelector("[data-column-key]") as HTMLElement;

/** 列头总数 */
const columnCount = () => document.querySelectorAll("[data-column-key]").length;

/** 事项条形（jsdom div 无角色，走 data 属性查询） */
const bar = (id: number) => document.querySelector(`[data-item-id="${id}"]`);

// 今日固定 2026-09-14；afterEach 恢复真实时间
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 14));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("barGeometry 纯函数", () => {
  it("left = 距原点天数 × 天宽；width = 跨天数 × 天宽", () => {
    expect(
      barGeometry(
        { id: 1, startKey: "2026-09-10", endKey: "2026-09-14", days: 5 },
        "2026-08-15",
        28,
      ),
    ).toEqual({ left: 26 * 28, width: 5 * 28 });
  });
});

describe("默认日粒度渲染", () => {
  it("60 列头（首列 08-15 文本「15」）；A 条几何 26×28/5×28；B 条单端钳 1 天；C 无日期无条形", () => {
    renderGantt();

    expect(columnCount()).toBe(60);
    expect(firstColumn().getAttribute("data-column-key")).toBe("2026-08-15");
    expect(firstColumn().textContent).toBe("15");

    // A 项条：left = diffDays(08-15, 09-10) × 28 = 728；width = 5 × 28 = 140
    const barA = bar(1);
    expect(barA).toBeTruthy();
    expect((barA as HTMLElement).style.left).toBe("728px");
    expect((barA as HTMLElement).style.width).toBe("140px");

    // B 项条：仅 dueDate 09-20 钳 1 天 → left = 36 × 28，width = 28
    const barB = bar(2);
    expect(barB).toBeTruthy();
    expect((barB as HTMLElement).style.left).toBe("1008px");
    expect((barB as HTMLElement).style.width).toBe("28px");

    // C 项：左列行存在（title 提示无日期），时间轴无条形
    expect(screen.getByTitle("project:planView.noDates")).toBeTruthy();
    expect(screen.getByText("无日期事项")).toBeTruthy();
    expect(bar(3)).toBeNull();
  });
});

describe("粒度切换", () => {
  it("切「月」粒度 → 18 列头，出现月份数字「10」（2026-10 列）", () => {
    renderGantt();

    fireEvent.click(
      screen.getByRole("button", { name: "project:planView.granularityMonth" }),
    );
    expect(columnCount()).toBe(18);
    const october = document.querySelector(
      '[data-column-key="2026-10-01"]',
    ) as HTMLElement;
    expect(october.textContent).toBe("10");
  });
});

describe("今天线", () => {
  it("data-today-line 存在，left = diffDays(首列, 今天) × 28 = 840px", () => {
    renderGantt();

    const line = document.querySelector(
      '[data-today-line="true"]',
    ) as HTMLElement;
    expect(line).toBeTruthy();
    expect(line.style.left).toBe("840px"); // 08-15 → 09-14 = 30 天
  });
});

describe("翻页", () => {
  it("点 >> → 首列起点后移 60 天（08-15 → 10-14，文本「14」）", () => {
    renderGantt();

    fireEvent.click(
      screen.getByRole("button", { name: "project:planView.nextPage" }),
    );
    expect(firstColumn().getAttribute("data-column-key")).toBe("2026-10-14");
    expect(firstColumn().textContent).toBe("14");
  });
});

describe("条形交互", () => {
  it("点 A 项条 → onEdit(item)（纯点按不触发 onChangeDates）", () => {
    const props = renderGantt();

    fireEvent.click(bar(1) as HTMLElement);
    expect(props.onEdit).toHaveBeenCalledTimes(1);
    expect(props.onEdit).toHaveBeenCalledWith(ITEMS[0]);
    expect(props.onChangeDates).not.toHaveBeenCalled();
  });
});

describe("dragEdgeFor 纯函数（边缘热区）", () => {
  it("x < 6 → start；x > width-6 → end；中间 move", () => {
    expect(dragEdgeFor(2, 100)).toBe("start");
    expect(dragEdgeFor(98, 100)).toBe("end");
    expect(dragEdgeFor(50, 100)).toBe("move");
    expect(dragEdgeFor(0, 8)).toBe("start"); // 窄条全热区
  });
});

describe("拖拽调期（pointer 提交链）", () => {
  // jsdom 无布局：bar.getBoundingClientRect().left 恒 0 → offsetX = clientX，
  // 中点点按 = clientX = width/2；move/up 由实现的 window 监听器承接
  const BAR_WIDTH = 5 * 28; // A 项 09-10~09-14 五天条（日粒度 dayWidth=28）

  it("中点拖拽 +28px → onChangeDates(1, { 09-11, 09-15 })；拖拽中条形预览 left 平移一天", () => {
    const props = renderGantt();
    const barEl = bar(1) as HTMLElement;

    fireEvent.pointerDown(barEl, { button: 0, clientX: BAR_WIDTH / 2 });
    fireEvent.pointerMove(window, { clientX: BAR_WIDTH / 2 + 28 }); // +28px = +1 天
    // 预览（move 边缘）：left 728 + 28 = 756，宽度不变
    expect(barEl.style.left).toBe("756px");
    expect(barEl.style.width).toBe("140px");

    fireEvent.pointerUp(window);
    expect(props.onChangeDates).toHaveBeenCalledTimes(1);
    expect(props.onChangeDates).toHaveBeenCalledWith(1, {
      startKey: "2026-09-11", // 09-10 + 1 天
      endKey: "2026-09-15",
    });
  });

  it("左缘热区拖拽 +28px → start 拉伸语义（起点 +1 天、终点不动）", () => {
    const props = renderGantt();
    fireEvent.pointerDown(bar(1) as HTMLElement, { button: 0, clientX: 2 });
    fireEvent.pointerMove(window, { clientX: 2 + 28 });
    fireEvent.pointerUp(window);
    expect(props.onChangeDates).toHaveBeenCalledWith(1, {
      startKey: "2026-09-11",
      endKey: "2026-09-14",
    });
  });

  it("原地点按（dayDelta=0）不提交 onChangeDates", () => {
    const props = renderGantt();
    fireEvent.pointerDown(bar(1) as HTMLElement, { button: 0, clientX: 70 });
    fireEvent.pointerUp(window);
    expect(props.onChangeDates).not.toHaveBeenCalled();
  });

  it("拖拽提交后的拖尾 click 不触发 onEdit；再原地点按恢复开编辑", () => {
    const props = renderGantt();
    const barEl = bar(1) as HTMLElement;

    fireEvent.pointerDown(barEl, { button: 0, clientX: 70 });
    fireEvent.pointerMove(window, { clientX: 98 });
    fireEvent.pointerUp(window);
    fireEvent.click(barEl);
    expect(props.onEdit).not.toHaveBeenCalled();

    fireEvent.pointerDown(barEl, { button: 0, clientX: 70 });
    fireEvent.pointerUp(window);
    fireEvent.click(barEl);
    expect(props.onEdit).toHaveBeenCalledWith(ITEMS[0]);
  });

  it("非主键（右键）pointerDown 不开会话，随后的 up 不提交", () => {
    const props = renderGantt();
    fireEvent.pointerDown(bar(1) as HTMLElement, { button: 2, clientX: 70 });
    fireEvent.pointerMove(window, { clientX: 98 });
    fireEvent.pointerUp(window);
    expect(props.onChangeDates).not.toHaveBeenCalled();
  });

  it("pointercancel 中断会话 → 后续全局 up 不提交（陈旧态防护）", () => {
    const props = renderGantt();
    fireEvent.pointerDown(bar(1) as HTMLElement, { button: 0, clientX: 70 });
    fireEvent.pointerMove(window, { clientX: 98 }); // dayDelta=1
    fireEvent.pointerCancel(window);
    fireEvent.pointerUp(window); // 取消后的杂散 up：不得误写
    expect(props.onChangeDates).not.toHaveBeenCalled();
  });

  it("未传 onChangeDates → 条形不进入拖拽（pointerDown/move/up 无副作用）", () => {
    const props = renderGantt({ onChangeDates: undefined });
    fireEvent.pointerDown(bar(1) as HTMLElement, { button: 0, clientX: 70 });
    fireEvent.pointerMove(window, { clientX: 98 });
    fireEvent.pointerUp(window);
    expect(props.onEdit).not.toHaveBeenCalled();
  });
});
