// @vitest-environment jsdom
/**
 * PlanViewTabs 视图 Tab 栏测试（jsdom + testing-library，mock 骨架同
 * tests/project/plan-kanban.test.tsx：t 返回 key、sonner、@/i18n 桩、
 * Radix 弹层 ResizeObserver/scrollIntoView/hasPointerCapture 桩）。
 * 组件纯 props 无路由/查询依赖，直接渲染桩回调：
 * - Tab 渲染：默认视图 name 空串 → 本地化类型名兜底（typeTable/typeKanban）、
 *   自定义名优先、激活态 aria-pressed；点击非激活 Tab → onSelect(id)
 * - + 菜单：A 阶段仅「看板」可添加（表格/列表/甘特/日历不在列），
 *   点选 → onAdd("kanban")
 * - Tab `...` 菜单：重命名与删除；删除 → onRemove(id)；
 *   views.length === 1 时删除项不渲染（最后视图保护）
 * - 重命名流：菜单 → PlanViewNameDialog 打开（初始名=当前名），输入新名
 *   确认 → onRename(id, 新名) 且弹窗关闭；纯空白名确认按钮禁用；取消不动数据
 * - isDirty=true 时激活 Tab data-dirty="true" + 未保存圆点（title=unsaved），
 *   非激活 Tab / isDirty=false 无标记
 * - PlanViewNameDialog 直渲染（重命名/保存为新视图共用契约）：open=false
 *   不挂载、确认回传 trim 名
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

// cn 依赖 @/i18n 实例，最小桩避免拉起完整 i18n 栈
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));

import PlanViewTabs from "../../src-react/domains/project/components/PlanViewTabs";
import PlanViewNameDialog from "../../src-react/domains/project/components/PlanViewNameDialog";
import type { PlanViewRecord } from "../../../electron/domains/project/plan-view.entity";

const makeView = (overrides: Partial<PlanViewRecord> = {}): PlanViewRecord => ({
  id: 10,
  projectId: 1,
  name: "",
  type: "table",
  groupBy: null,
  filterJson: "{}",
  sortJson: "[]",
  sortOrder: 0,
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

/** 两默认视图：表格(10) + 看板(11)，name 空串 = 播种默认（UI 类型名兜底） */
const VIEWS: PlanViewRecord[] = [
  makeView({ id: 10, type: "table", sortOrder: 0 }),
  makeView({ id: 11, type: "kanban", sortOrder: 1 }),
];

/** 渲染 Tab 栏（缺省两默认视图 + 激活 10），返回回调桩 */
function renderTabs(
  overrides: Partial<ComponentProps<typeof PlanViewTabs>> = {},
) {
  const props = {
    views: VIEWS,
    activeViewId: 10,
    isDirty: false,
    onSelect: vi.fn(),
    onAdd: vi.fn(),
    onRename: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
  render(<PlanViewTabs {...props} />);
  return props;
}

/** Radix DropdownMenu：pointerDown 展开根菜单 */
async function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  return screen.findByRole("menu");
}

/** 展开第 index 个 Tab 的 `...` 菜单 */
const openTabMenu = (index: number) =>
  openMenu(
    screen.getAllByRole("button", { name: "project:planView.tabMenu" })[index],
  );

afterEach(cleanup);

describe("Tab 渲染与切换", () => {
  it("渲染两个默认 Tab：name 空串 → 类型本地化 key 兜底；激活态 aria-pressed", () => {
    renderTabs();
    const tableTab = screen.getByRole("button", {
      name: "project:planView.typeTable",
    });
    const kanbanTab = screen.getByRole("button", {
      name: "project:planView.typeKanban",
    });
    expect(tableTab.getAttribute("aria-pressed")).toBe("true");
    expect(kanbanTab.getAttribute("aria-pressed")).toBe("false");
  });

  it("自定义名优先于类型兜底显示", () => {
    renderTabs({
      views: [
        makeView({ id: 10, name: "我的表格" }),
        makeView({ id: 11, type: "kanban" }),
      ],
    });
    expect(screen.getByRole("button", { name: "我的表格" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "project:planView.typeTable" }),
    ).toBeNull();
  });

  it("点击第二个 Tab → onSelect(11)", () => {
    const { onSelect } = renderTabs();
    fireEvent.click(
      screen.getByRole("button", { name: "project:planView.typeKanban" }),
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(11);
  });
});

describe("+ 添加视图菜单", () => {
  it("仅含「看板」项（A 阶段无列表/甘特/日历）；点击 → onAdd('kanban')", async () => {
    const { onAdd } = renderTabs();
    const menu = await openMenu(
      screen.getByRole("button", { name: "project:planView.addView" }),
    );

    // 唯一菜单项 = 看板；其余类型不出现
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(1);
    expect(
      within(menu).getByRole("menuitem", {
        name: "project:planView.typeKanban",
      }),
    ).toBeTruthy();
    for (const absent of [
      "project:planView.typeTable",
      "project:planView.typeList",
      "project:planView.typeGantt",
      "project:planView.typeCalendar",
    ]) {
      expect(within(menu).queryByText(absent)).toBeNull();
    }

    fireEvent.click(
      within(menu).getByRole("menuitem", {
        name: "project:planView.typeKanban",
      }),
    );
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith("kanban");
  });
});

describe("Tab `...` 操作菜单", () => {
  it("含重命名与删除；点删除 → onRemove(id)", async () => {
    const { onRemove } = renderTabs();
    const menu = await openTabMenu(0);
    expect(
      within(menu).getByRole("menuitem", { name: "project:planView.rename" }),
    ).toBeTruthy();

    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "common:delete" }),
    );
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith(10);
  });

  it("views.length === 1 时删除项不渲染（重命名仍在）", async () => {
    renderTabs({ views: [makeView({ id: 10 })] });
    const menu = await openMenu(
      screen.getByRole("button", { name: "project:planView.tabMenu" }),
    );
    expect(
      within(menu).getByRole("menuitem", { name: "project:planView.rename" }),
    ).toBeTruthy();
    expect(within(menu).queryByText("common:delete")).toBeNull();
  });
});

describe("重命名（PlanViewNameDialog）", () => {
  it("菜单打开弹窗初始名为当前名；确认 → onRename(id, 新名) 且弹窗关闭", async () => {
    const { onRename } = renderTabs({
      views: [
        makeView({ id: 10, name: "我的表格" }),
        makeView({ id: 11, type: "kanban" }),
      ],
    });
    const menu = await openTabMenu(0);
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "project:planView.rename" }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("project:planView.rename")).toBeTruthy();
    const input = within(dialog).getByRole("textbox");
    expect((input as HTMLInputElement).value).toBe("我的表格");

    fireEvent.change(input, { target: { value: "新名" } });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "common:confirm" }),
    );
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith(10, "新名");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("纯空白名确认按钮禁用；取消关闭不动数据", async () => {
    const { onRename } = renderTabs({
      views: [
        makeView({ id: 10, name: "原名" }),
        makeView({ id: 11, type: "kanban" }),
      ],
    });
    const menu = await openTabMenu(0);
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "project:planView.rename" }),
    );
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByRole("textbox");

    fireEvent.change(input, { target: { value: "   " } });
    const confirm = within(dialog).getByRole("button", {
      name: "common:confirm",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onRename).not.toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "common:cancel" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onRename).not.toHaveBeenCalled();
  });
});

describe("已修改圆点（isDirty）", () => {
  it("isDirty=true → 激活 Tab data-dirty=true + 未保存圆点；非激活 Tab 无标记", () => {
    renderTabs({ isDirty: true });
    expect(
      screen
        .getByRole("button", { name: "project:planView.typeTable" })
        .getAttribute("data-dirty"),
    ).toBe("true");
    expect(screen.getByTitle("project:planView.unsaved")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "project:planView.typeKanban" })
        .getAttribute("data-dirty"),
    ).toBeNull();
  });

  it("isDirty=false → 无 data-dirty 与圆点", () => {
    renderTabs();
    expect(
      screen
        .getByRole("button", { name: "project:planView.typeTable" })
        .getAttribute("data-dirty"),
    ).toBeNull();
    expect(screen.queryByTitle("project:planView.unsaved")).toBeNull();
  });
});

describe("PlanViewNameDialog 直渲染（保存为新视图共用契约）", () => {
  it("open=false 不挂载；open 后确认回传 trim 名、取消只关不回调", () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    const props = {
      title: "外部传入的标题",
      initialName: "初始名",
      onOpenChange,
      onConfirm,
    };
    const { rerender } = render(<PlanViewNameDialog open={false} {...props} />);
    expect(screen.queryByRole("dialog")).toBeNull();

    rerender(<PlanViewNameDialog open {...props} />);
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByRole("textbox");
    expect((input as HTMLInputElement).value).toBe("初始名");

    fireEvent.change(input, { target: { value: "  名字  " } });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "common:confirm" }),
    );
    expect(onConfirm).toHaveBeenCalledWith("名字");
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "common:cancel" }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
