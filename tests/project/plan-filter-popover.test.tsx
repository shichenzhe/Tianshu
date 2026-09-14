// @vitest-environment jsdom
/**
 * PlanFilterPopover 组合筛选面板测试（jsdom + testing-library，mock 骨架同
 * tests/project/plan-view-tabs.test.tsx：t 返回 key、sonner、@/i18n 桩、
 * Radix 弹层 ResizeObserver/scrollIntoView/hasPointerCapture 桩）。
 * 组件 conditions 受控，用受控外壳（onChange 本地态回流，模拟 PlanPane
 * wiring）驱动交互，桩回调可断言：
 * - 触发按钮开面板（Popover 内容 role=dialog）；条件计数徽标
 * - 「+ 添加筛选条件」字段菜单六项；已存在字段禁用
 * - 添加「状态」→ 默认 op=in 值空；勾选「进行中」→ onChange updater 产出
 *   {field:"status",op:"in",value:["in_progress"]}
 * - 「标题」条件 Input 输入「方案」→ {field:"title",op:"contains",value:"方案"}
 * - 「处理人」添加后默认 isMe（无值控件）；切「指定成员」出现成员 checkbox
 * - 条件行删除按钮 → onChange 后该条件消失
 * - `...` 菜单三动作：保存为新视图（PlanViewNameDialog → onSaveAsNew(name)）、
 *   覆盖保存（onSaveOverwrite）、重置（onReset）
 * - isDirty=true → `...` 旁 data-dirty 标记 + 未保存圆点
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
import { useState } from "react";
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

import PlanFilterPopover from "../../src-react/domains/project/components/PlanFilterPopover";
import type { FilterCondition } from "../../src-react/domains/project/model/plan-view-engine";
import type { ProjectMemberItem } from "../../../electron/domains/project/project.entity";

const MEMBERS: ProjectMemberItem[] = [
  { userId: 1, nickname: "我", username: "me", role: "owner" },
  { userId: 2, nickname: "张三", username: "zhangsan", role: "member" },
  { userId: 3, nickname: "李四", username: "lisi", role: "member" },
];

type PopoverProps = ComponentProps<typeof PlanFilterPopover>;

interface RenderOverrides {
  initialConditions?: FilterCondition[];
  overrides?: Partial<PopoverProps>;
}

/**
 * 受控外壳：conditions 本地态经 onChange 回流（与 PlanPane wiring 同构），
 * onChange 为桩（记录每次 updater，可对任意 prev 快照求值断言）。
 */
function renderPopover({
  initialConditions = [],
  overrides = {},
}: RenderOverrides = {}) {
  const onChange = vi.fn();
  const props = {
    isDirty: false,
    members: MEMBERS,
    currentUserId: 1,
    onReset: vi.fn(),
    onSaveOverwrite: vi.fn(),
    onSaveAsNew: vi.fn(),
    ...overrides,
    onChange,
  } as PopoverProps & Record<string, ReturnType<typeof vi.fn>>;
  function Harness() {
    const [conditions, setConditions] = useState(initialConditions);
    const applyChange = (
      updater: (prev: FilterCondition[]) => FilterCondition[],
    ) => {
      onChange(updater);
      setConditions((prev) => updater(prev));
    };
    return (
      <PlanFilterPopover
        {...props}
        conditions={conditions}
        onChange={applyChange}
      />
    );
  }
  render(<Harness />);
  return props;
}

/** onChange 最近一次 updater 应用到 prev 快照的产出 */
function lastApplied(
  props: ReturnType<typeof renderPopover>,
  prev: FilterCondition[],
): FilterCondition[] {
  const calls = props.onChange.mock.calls as [
    (prev: FilterCondition[]) => FilterCondition[],
  ][];
  return calls[calls.length - 1][0](prev);
}

/** 点击触发按钮打开面板，返回 Popover 内容元素 */
async function openPanel() {
  fireEvent.click(
    screen.getByRole("button", { name: "project:planView.filter" }),
  );
  return screen.findByRole("dialog", { name: "project:planView.filter" });
}

/** Radix DropdownMenu：pointerDown 展开菜单（面板内触发器） */
async function openMenu(trigger: HTMLElement) {
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  return screen.findByRole("menu");
}

/** 展开「+ 添加筛选条件」菜单并点选字段（菜单自动关闭，面板保持） */
async function addCondition(panel: HTMLElement, fieldName: string) {
  const menu = await openMenu(
    within(panel).getByRole("button", {
      name: "project:planView.addCondition",
    }),
  );
  fireEvent.click(within(menu).getByRole("menuitem", { name: fieldName }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

/** 展开面板右上角 `...` 菜单 */
const openActionsMenu = (panel: HTMLElement) =>
  openMenu(within(panel).getByRole("button", { name: "common:operation" }));

/** Radix Select 选项切换：mouse pointerDown 展开 + click 选中 */
async function selectOption(trigger: HTMLElement, optionName: string) {
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(await screen.findByRole("option", { name: optionName }));
}

afterEach(cleanup);

describe("面板打开与字段菜单", () => {
  it("打开面板：「+ 添加筛选条件」显示 6 个字段（标题/状态/处理人/来源/优先级/标签）", async () => {
    renderPopover();
    const panel = await openPanel();
    const menu = await openMenu(
      within(panel).getByRole("button", {
        name: "project:planView.addCondition",
      }),
    );
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(6);
    for (const key of [
      "fieldTitle",
      "fieldStatus",
      "fieldAssignee",
      "fieldSource",
      "fieldPriority",
      "fieldTags",
    ]) {
      expect(
        within(menu).getByRole("menuitem", { name: `project:planView.${key}` }),
      ).toBeTruthy();
    }
  });

  it("触发按钮：有条件时显示计数徽标", () => {
    renderPopover({
      initialConditions: [{ field: "priority", op: "in", value: ["P0"] }],
    });
    const trigger = screen.getByRole("button", {
      name: "project:planView.filter",
    });
    expect(within(trigger).getByText("1")).toBeTruthy();
  });

  it("触发按钮：无条件时无计数徽标", () => {
    renderPopover();
    const trigger = screen.getByRole("button", {
      name: "project:planView.filter",
    });
    expect(within(trigger).queryByText("1")).toBeNull();
  });
});

describe("条件增删与值控件", () => {
  it("添加「状态」默认 op=in 值空；勾选「进行中」→ onChange 携带对应条件；已存在字段禁用", async () => {
    const props = renderPopover();
    const panel = await openPanel();
    await addCondition(panel, "project:planView.fieldStatus");

    expect(lastApplied(props, [])).toEqual([
      { field: "status", op: "in", value: [] },
    ]);

    fireEvent.click(
      within(panel).getByRole("checkbox", {
        name: "project:plan.statusInProgress",
      }),
    );
    expect(
      lastApplied(props, [{ field: "status", op: "in", value: [] }]),
    ).toContainEqual({ field: "status", op: "in", value: ["in_progress"] });

    const menu = await openMenu(
      within(panel).getByRole("button", {
        name: "project:planView.addCondition",
      }),
    );
    expect(
      within(menu)
        .getByRole("menuitem", { name: "project:planView.fieldStatus" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("「标题」条件输入「方案」→ onChange 携带 {field:'title',op:'contains',value:'方案'}", async () => {
    const props = renderPopover();
    const panel = await openPanel();
    await addCondition(panel, "project:planView.fieldTitle");

    const input = within(panel).getByRole("textbox");
    fireEvent.change(input, { target: { value: "方案" } });
    expect((input as HTMLInputElement).value).toBe("方案");
    expect(
      lastApplied(props, [{ field: "title", op: "contains", value: "" }]),
    ).toContainEqual({ field: "title", op: "contains", value: "方案" });
  });

  it("「处理人」添加后默认 isMe 无值控件；切「指定成员」出现成员 checkbox", async () => {
    const props = renderPopover();
    const panel = await openPanel();
    await addCondition(panel, "project:planView.fieldAssignee");

    expect(within(panel).queryByRole("checkbox")).toBeNull();
    await selectOption(
      within(panel).getByRole("combobox", { name: "project:planView.opIsMe" }),
      "project:planView.opIn",
    );

    fireEvent.click(within(panel).getByRole("checkbox", { name: "张三" }));
    expect(
      lastApplied(props, [{ field: "assigneeId", op: "in", value: [] }]),
    ).toContainEqual({ field: "assigneeId", op: "in", value: ["2"] });
  });

  it("「处理人」切「不是我」→ onChange 携带 notMe 且无值控件", async () => {
    const props = renderPopover();
    const panel = await openPanel();
    await addCondition(panel, "project:planView.fieldAssignee");

    await selectOption(
      within(panel).getByRole("combobox", { name: "project:planView.opIsMe" }),
      "project:planView.opNotMe",
    );
    expect(
      lastApplied(props, [{ field: "assigneeId", op: "isMe", value: "" }]),
    ).toContainEqual({ field: "assigneeId", op: "notMe", value: "" });
    expect(within(panel).queryByRole("checkbox")).toBeNull();
  });

  it("标签条件渲染 chips 多选：遗留单值容错选中；点选追加成数组；再点取消其一", async () => {
    const legacy: FilterCondition[] = [
      { field: "tags", op: "contains", value: "前端" },
    ];
    const props = renderPopover({
      initialConditions: legacy,
      overrides: { tagOptions: ["前端", "产品", "联调"] },
    });
    const panel = await openPanel();

    expect(
      within(panel)
        .getAllByRole("button", { pressed: true })
        .map((chip) => chip.textContent),
    ).toEqual(["前端"]);

    fireEvent.click(within(panel).getByRole("button", { name: "产品" }));
    expect(lastApplied(props, legacy)).toContainEqual({
      field: "tags",
      op: "contains",
      value: ["前端", "产品"],
    });

    fireEvent.click(within(panel).getByRole("button", { name: "前端" }));
    expect(
      lastApplied(props, [
        { field: "tags", op: "contains", value: ["前端", "产品"] },
      ]),
    ).toContainEqual({ field: "tags", op: "contains", value: ["产品"] });
  });

  it("条件行删除按钮 → onChange 后该条件消失", async () => {
    const initial: FilterCondition[] = [
      { field: "priority", op: "in", value: ["P0"] },
    ];
    const props = renderPopover({ initialConditions: initial });
    const panel = await openPanel();

    fireEvent.click(
      within(panel).getByRole("button", { name: "common:delete" }),
    );
    expect(lastApplied(props, initial)).toEqual([]);
    await waitFor(() =>
      expect(within(panel).queryByRole("checkbox")).toBeNull(),
    );
  });
});

describe("`...` 菜单三动作", () => {
  it("「保存为新视图」打开命名弹窗，确认 → onSaveAsNew(高优) 且弹窗关闭", async () => {
    const props = renderPopover();
    const panel = await openPanel();
    const menu = await openActionsMenu(panel);
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(3);

    fireEvent.click(
      within(menu).getByRole("menuitem", {
        name: "project:planView.saveAsNew",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "project:planView.saveAsNewTitle",
    });
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "高优" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "common:confirm" }),
    );
    expect(props.onSaveAsNew).toHaveBeenCalledTimes(1);
    expect(props.onSaveAsNew).toHaveBeenCalledWith("高优");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", {
          name: "project:planView.saveAsNewTitle",
        }),
      ).toBeNull(),
    );
  });

  it("「覆盖保存」→ onSaveOverwrite；「重置」→ onReset", async () => {
    const props = renderPopover();
    const panel = await openPanel();

    let menu = await openActionsMenu(panel);
    fireEvent.click(
      within(menu).getByRole("menuitem", {
        name: "project:planView.overwriteSave",
      }),
    );
    await waitFor(() => expect(props.onSaveOverwrite).toHaveBeenCalledTimes(1));

    menu = await openActionsMenu(panel);
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "project:planView.reset" }),
    );
    await waitFor(() => expect(props.onReset).toHaveBeenCalledTimes(1));
  });
});

describe("isDirty 圆点", () => {
  it("isDirty=true → `...` 旁 data-dirty 标记 + 未保存圆点", async () => {
    renderPopover({ overrides: { isDirty: true } });
    const panel = await openPanel();
    expect(within(panel).getByTitle("project:planView.unsaved")).toBeTruthy();
    expect(document.querySelector('[data-dirty="true"]')).toBeTruthy();
  });

  it("isDirty=false → 无圆点与 data-dirty 标记", async () => {
    renderPopover();
    const panel = await openPanel();
    expect(within(panel).queryByTitle("project:planView.unsaved")).toBeNull();
    expect(document.querySelector('[data-dirty="true"]')).toBeNull();
  });
});
