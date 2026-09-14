// @vitest-environment jsdom
/**
 * PlanListView 列表视图测试（mock 骨架同 tests/project/plan-view-tabs.test.tsx：
 * t 返回 key、sonner/@/i18n 桩、Radix 弹层桩；引擎/组件真实实现）：
 * - 四状态分组（groupItems 真跑）：组头 状态名+计数；空组（paused 无数据）保留
 * - 组头折叠/展开；组内 + 展开行内快速新增 Input，回车 onQuickCreate(status, title)
 * - 行：checkbox 勾选 → onToggleDone(id, true)；已勾选项再点 → onToggleDone(id, false)
 * - 行字段：标题（点击 onEdit）、优先级色点、标签（2+N）、截止日、处理人头像
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

// cn 依赖 @/i18n 实例，最小桩避免拉起完整 i18n 栈
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));

import PlanListView from "../../src-react/domains/project/components/PlanListView";
import type { ProjectMemberItem } from "../../../electron/domains/project/project.entity";
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
 * 覆盖度：not_started 两项（需求梳理 = 超期截止日 + 3 标签截断 +N、编写文档 =
 * 未来截止日）、in_progress 一项（处理人张三）、paused 空组、done 一项（勾选态）
 */
const ITEMS: PlanItemRecord[] = [
  makeItem({
    id: 1,
    title: "需求梳理",
    priority: "P0",
    tags: ["设计", "研发", "测试"],
    dueDate: "2020-01-01T00:00:00.000Z",
  }),
  makeItem({
    id: 2,
    title: "编写文档",
    dueDate: "2030-01-01T00:00:00.000Z",
  }),
  makeItem({ id: 3, title: "接口联调", status: "in_progress", assigneeId: 2 }),
  makeItem({ id: 4, title: "发布上线", status: "done" }),
];

const MEMBERS: ProjectMemberItem[] = [
  { userId: 1, nickname: "我", username: "me", role: "owner" },
  { userId: 2, nickname: "张三", username: "zhangsan", role: "member" },
];

type ListProps = ComponentProps<typeof PlanListView>;

/** 渲染列表视图（缺省 fixture），返回回调桩 */
function renderList(overrides: Partial<ListProps> = {}) {
  const props = {
    items: ITEMS,
    members: MEMBERS,
    currentUserId: 1,
    onToggleDone: vi.fn(),
    onQuickCreate: vi.fn(),
    onEdit: vi.fn(),
    ...overrides,
  } as ListProps & Record<string, ReturnType<typeof vi.fn>>;
  render(<PlanListView {...props} />);
  return props;
}

/** 组头折叠按钮（aria-label = 状态 i18n key；not_started→statusNotStarted …） */
const groupHeader = (labelKey: string) =>
  screen.getByRole("button", { name: `project:plan.${labelKey}` });

/** 状态组 section（组头向上找） */
const groupSection = (labelKey: string) =>
  groupHeader(labelKey).closest("section") as HTMLElement;

/** 含指定标题文本的清单行（标题按钮的行容器 div） */
const rowContaining = (title: string) =>
  screen.getByRole("button", { name: title }).closest("div") as HTMLElement;

afterEach(cleanup);

describe("四状态分组渲染", () => {
  it("四组渲染与计数：not_started 组含 2 项、paused 空组保留且计数 0", () => {
    renderList();

    // 四状态组头齐全（groupItems 全枚举组保留）
    for (const labelKey of [
      "statusNotStarted",
      "statusInProgress",
      "statusPaused",
      "statusDone",
    ]) {
      expect(groupHeader(labelKey)).toBeTruthy();
    }
    const notStarted = groupSection("statusNotStarted");
    expect(
      within(notStarted).getByRole("button", { name: "需求梳理" }),
    ).toBeTruthy();
    expect(
      within(notStarted).getByRole("button", { name: "编写文档" }),
    ).toBeTruthy();
    expect(groupHeader("statusNotStarted").textContent).toContain("2");

    // 空组（paused 无数据）保留且计数 0
    expect(groupHeader("statusPaused").textContent).toContain("0");
    expect(
      within(groupSection("statusPaused")).queryByText("需求梳理"),
    ).toBeNull();

    // 行字段：标签 2+N 截断、优先级色点（P0 destructive）、处理人头像首字符
    const row = rowContaining("需求梳理");
    expect(within(row).getByText("设计")).toBeTruthy();
    expect(within(row).getByText("研发")).toBeTruthy();
    expect(within(row).queryByText("测试")).toBeNull();
    expect(within(row).getByText("+1")).toBeTruthy();
    expect(within(row).getByLabelText("P0").className).toContain(
      "bg-destructive",
    );
    expect(within(row).getByText("我")).toBeTruthy();
    // 处理人头像：昵称首字符（title 携带全名）
    const zhangAvatar = within(rowContaining("接口联调")).getByTitle("张三");
    expect(zhangAvatar.textContent).toBe("张");
  });
});

describe("组头折叠/展开", () => {
  it("点击组头折叠 → 组行消失；再点展开", () => {
    renderList();

    fireEvent.click(groupHeader("statusNotStarted"));
    expect(screen.queryByRole("button", { name: "需求梳理" })).toBeNull();
    // 他组不受影响
    expect(screen.getByRole("button", { name: "接口联调" })).toBeTruthy();

    fireEvent.click(groupHeader("statusNotStarted"));
    expect(screen.getByRole("button", { name: "需求梳理" })).toBeTruthy();
  });
});

describe("组内快速新增", () => {
  it("组内 + → Input 出现，输入『写周报』回车 → onQuickCreate('not_started', '写周报') 且 Input 清空", () => {
    const props = renderList();

    fireEvent.click(
      within(groupSection("statusNotStarted")).getByRole("button", {
        name: "project:plan.add",
      }),
    );
    const input = screen.getByPlaceholderText(
      "project:plan.quickAddPlaceholder",
    );
    fireEvent.change(input, { target: { value: "写周报" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(props.onQuickCreate).toHaveBeenCalledTimes(1);
    expect(props.onQuickCreate).toHaveBeenCalledWith("not_started", "写周报");
    expect((input as HTMLInputElement).value).toBe("");
  });
});

describe("完成勾选", () => {
  it("勾选 checkbox → onToggleDone(1, true)；已勾选项再点 → onToggleDone(id, false)", () => {
    const props = renderList();

    fireEvent.click(
      within(rowContaining("需求梳理")).getByRole("checkbox", {
        name: "project:plan.statusDone",
      }),
    );
    expect(props.onToggleDone).toHaveBeenCalledTimes(1);
    expect(props.onToggleDone).toHaveBeenCalledWith(1, true);

    fireEvent.click(
      within(rowContaining("发布上线")).getByRole("checkbox", {
        name: "project:plan.statusDone",
      }),
    );
    expect(props.onToggleDone).toHaveBeenCalledTimes(2);
    expect(props.onToggleDone).toHaveBeenCalledWith(4, false);
  });
});

describe("行编辑入口", () => {
  it("点击标题行 → onEdit(item)", () => {
    const props = renderList();

    fireEvent.click(screen.getByRole("button", { name: "接口联调" }));
    expect(props.onEdit).toHaveBeenCalledTimes(1);
    expect(props.onEdit).toHaveBeenCalledWith(ITEMS[2]);
  });
});

describe("截止日渲染", () => {
  it("超期截止日渲染 text-destructive 类；未来截止日不渲染", () => {
    renderList();

    // 需求梳理 dueDate=2020-01-01（过去、未完成）→ 超期 destructive
    expect(screen.getByText("2020-01-01").className).toContain(
      "text-destructive",
    );
    // 编写文档 dueDate=2030-01-01（未来）→ 非 destructive
    expect(screen.getByText("2030-01-01").className).not.toContain(
      "text-destructive",
    );
  });
});
