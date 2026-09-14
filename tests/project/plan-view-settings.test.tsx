// @vitest-environment jsdom
/**
 * PlanViewSettingsPopover 视图设置面板测试（jsdom + testing-library，mock 骨架同
 * tests/project/plan-view-tabs.test.tsx：t 返回 key、sonner、@/i18n 桩、
 * Radix 弹层 ResizeObserver/scrollIntoView/hasPointerCapture 桩）。
 * 组件纯受控 props，直接渲染桩回调：
 * - 触发按钮：齿轮图标 + aria-label=视图设置；点击开面板（role=dialog）
 * - 视图类型组：A 阶段仅 表格/看板 两 radio 项（list/gantt/calendar 不在列），
 *   当前类型 checked 回显；点选「看板」→ onTypeChange("kanban")
 * - 分组依据组：showGroupBy=false（表格）整组不渲染；true（看板）渲染
 *   状态/优先级/处理人 三 radio 项
 * - 分组菜单点选「优先级」→ onGroupByChange("priority")；当前分组 checked 回显
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

import PlanViewSettingsPopover from "../../src-react/domains/project/components/PlanViewSettingsPopover";

type SettingsProps = ComponentProps<typeof PlanViewSettingsPopover>;

/** 渲染视图设置面板（缺省表格视图、未分组、不渲染分组组），返回回调桩 */
function renderSettings(overrides: Partial<SettingsProps> = {}) {
  const props = {
    type: "table",
    groupBy: null,
    showGroupBy: false,
    onTypeChange: vi.fn(),
    onGroupByChange: vi.fn(),
    ...overrides,
  } as SettingsProps & Record<string, ReturnType<typeof vi.fn>>;
  render(<PlanViewSettingsPopover {...props} />);
  return props;
}

/** 点击齿轮触发按钮打开面板，返回 Popover 内容元素 */
async function openPanel() {
  fireEvent.click(
    screen.getByRole("button", { name: "project:planView.settings" }),
  );
  return screen.findByRole("dialog", { name: "project:planView.settings" });
}

/** Radix DropdownMenu：pointerDown 展开菜单（面板内触发器） */
async function openMenu(trigger: HTMLElement) {
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  return screen.findByRole("menu");
}

afterEach(cleanup);

describe("触发按钮与视图类型", () => {
  it("触发按钮含齿轮图标；类型菜单仅 表格/看板 两项（A 阶段），当前项 checked；点选看板 → onTypeChange('kanban')", async () => {
    const props = renderSettings();
    const gear = screen.getByRole("button", {
      name: "project:planView.settings",
    });
    expect(gear.querySelector("svg")).toBeTruthy();

    const panel = await openPanel();
    const menu = await openMenu(
      within(panel).getByRole("button", {
        name: "project:planView.settingsType",
      }),
    );
    const tableItem = within(menu).getByRole("menuitemradio", {
      name: "project:planView.typeTable",
    });
    expect(tableItem.getAttribute("aria-checked")).toBe("true");
    expect(
      within(menu).getByRole("menuitemradio", {
        name: "project:planView.typeKanban",
      }),
    ).toBeTruthy();
    // A 阶段不点亮 list/gantt/calendar（持久化枚举仅展示可选子集，同 Tab 添加菜单策略）
    for (const absent of [
      "project:planView.typeList",
      "project:planView.typeGantt",
      "project:planView.typeCalendar",
    ]) {
      expect(within(menu).queryByText(absent)).toBeNull();
    }

    fireEvent.click(
      within(menu).getByRole("menuitemradio", {
        name: "project:planView.typeKanban",
      }),
    );
    expect(props.onTypeChange).toHaveBeenCalledTimes(1);
    expect(props.onTypeChange).toHaveBeenCalledWith("kanban");
  });

  it("类型触发按钮回显当前类型名", async () => {
    renderSettings({ type: "kanban" });
    const panel = await openPanel();
    const typeTrigger = within(panel).getByRole("button", {
      name: "project:planView.settingsType",
    });
    expect(
      within(typeTrigger).getByText("project:planView.typeKanban"),
    ).toBeTruthy();
  });
});

describe("分组依据（仅看板）", () => {
  it("showGroupBy=false（表格）不渲染分组依据组", async () => {
    renderSettings({ type: "table", showGroupBy: false });
    const panel = await openPanel();
    expect(
      within(panel).queryByRole("button", {
        name: "project:planView.settingsGroupBy",
      }),
    ).toBeNull();
  });

  it("showGroupBy=true（看板）渲染 状态/优先级/处理人 三选项", async () => {
    renderSettings({ type: "kanban", groupBy: "status", showGroupBy: true });
    const panel = await openPanel();
    const menu = await openMenu(
      within(panel).getByRole("button", {
        name: "project:planView.settingsGroupBy",
      }),
    );
    for (const key of [
      "project:plan.status",
      "project:plan.priority",
      "project:plan.handleMan",
    ]) {
      expect(
        within(menu).getByRole("menuitemradio", { name: key }),
      ).toBeTruthy();
    }
  });

  it("groupBy=null（未设置分组）触发按钮回显「状态」（与渲染实际对齐，非 —）", async () => {
    renderSettings({ type: "kanban", groupBy: null, showGroupBy: true });
    const panel = await openPanel();
    const trigger = within(panel).getByRole("button", {
      name: "project:planView.settingsGroupBy",
    });
    expect(trigger.textContent).toContain("project:plan.status");
    expect(trigger.textContent).not.toContain("—");
  });

  it("点选分组「优先级」→ onGroupByChange('priority')；当前分组 checked 回显", async () => {
    const props = renderSettings({
      type: "kanban",
      groupBy: "status",
      showGroupBy: true,
    });
    const panel = await openPanel();
    const menu = await openMenu(
      within(panel).getByRole("button", {
        name: "project:planView.settingsGroupBy",
      }),
    );
    expect(
      within(menu)
        .getByRole("menuitemradio", { name: "project:plan.status" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.click(
      within(menu).getByRole("menuitemradio", {
        name: "project:plan.priority",
      }),
    );
    expect(props.onGroupByChange).toHaveBeenCalledTimes(1);
    expect(props.onGroupByChange).toHaveBeenCalledWith("priority");
  });
});
