// @vitest-environment jsdom
/**
 * PlanKanbanView 看板视图测试（jsdom + testing-library，mock 骨架同
 * tests/project/plan-table.test.tsx：t 返回 key、sonner、Radix 桩、
 * QueryClientProvider；PlanItemApi 静态方法 + key 工厂 + useUserStore 整体
 * mock；MemoryRouter 支撑 PlanPane 集成）：
 * - 落点纯函数 computeDrop：over=列 id（空列/非空列）→ 列尾；over=卡片 id
 *   跨列 → 该卡所在列 + afterId；同列原位（自身/前一项/列背景）→ null；
 *   同列重排（后方卡片）→ 同状态 + afterId；active/over 未知 → null
 * - 序号纯函数 computeSortOrder：无 afterId → 列尾 max+1（空列 1）；
 *   afterId 后无项 → +1；有后项 → 均值取整；afterId 不在列 → 回落列尾；
 *   均值 ≤ 0 → 保底 1
 * - DOM（dnd-kit jsdom 不模拟 pointer 拖拽，落点语义由纯函数覆盖、集成由
 *   手动验收兜底）：四列渲染 + 计数 + 列头 +（onQuickCreate(status)）；
 *   卡片字段（优先级左色条 class / 标签截断 +N / 我头像点）；点击卡片 onEdit
 * - PlanPane 集成：列头 + 打开 PlanItemDialog 且 defaultStatus 预置该列
 *   状态；编辑卡片回填自身状态（defaultStatus 被忽略）
 * - T6 minor（IME）：PlanTableView 快速新增与 PlanItemDialog 标签输入，
 *   composition 中的 Enter 不触发（event.nativeEvent.isComposing）
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
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

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

// mapIpcError / cn 依赖 @/i18n 实例，最小桩避免拉起完整 i18n 栈
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));

// PlanItemApi 静态类 + 三个 query key 工厂整体 mock（key 形状与真实实现一致）
vi.mock("@/domains/project/api/plan-item.api", () => ({
  default: {
    list: vi.fn(),
    listMine: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    move: vi.fn(),
    listFields: vi.fn(),
    saveFields: vi.fn(),
  },
  PLAN_ITEMS_KEY: (projectId: number) => ["planItems", projectId],
  PLAN_ITEMS_MINE_KEY: (userId: number) => ["planItemsMine", userId],
  PLAN_FIELDS_KEY: (projectId: number) => ["planFields", projectId],
}));

vi.mock("@/domains/user/store/user.store", () => ({
  useUserStore: (
    selector?: (state: { user: { id: number; nickname: string } }) => unknown,
  ) =>
    selector
      ? selector({ user: { id: 1, nickname: "测试用户" } })
      : { user: { id: 1, nickname: "测试用户" } },
}));

import PlanKanbanView, {
  computeDrop,
  computeSortOrder,
} from "../../src-react/domains/project/components/PlanKanbanView";
import PlanPane from "../../src-react/domains/project/components/PlanPane";
import PlanItemApi from "@/domains/project/api/plan-item.api";
import type { KanbanColumnData } from "../../src-react/domains/project/components/PlanKanbanView";
import type {
  PlanItemRecord,
  PlanStatus,
} from "../../../electron/domains/project/plan-item.entity";

const makeItem = (overrides: Partial<PlanItemRecord> = {}): PlanItemRecord => ({
  id: 1,
  projectId: 1,
  title: "事项",
  status: "not_started",
  priority: "P1",
  assigneeId: 1,
  tags: [],
  customFields: {},
  sortOrder: 0,
  createdById: 1,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

/** 纯函数用列集：not_started 三张（sortOrder 1-3）、in_progress 一张、paused 空、done 一张 */
const item = (id: number, status: PlanStatus, sortOrder: number) =>
  makeItem({ id, status, sortOrder, title: `事项${id}` });

const PURE_COLUMNS: KanbanColumnData[] = [
  {
    status: "not_started",
    items: [
      item(1, "not_started", 1),
      item(2, "not_started", 2),
      item(3, "not_started", 3),
    ],
  },
  { status: "in_progress", items: [item(4, "in_progress", 1)] },
  { status: "paused", items: [] },
  { status: "done", items: [item(5, "done", 5)] },
];

beforeEach(() => {
  vi.mocked(PlanItemApi.list).mockReset().mockResolvedValue([]);
  vi.mocked(PlanItemApi.listFields).mockReset().mockResolvedValue([]);
  vi.mocked(PlanItemApi.create).mockReset().mockResolvedValue(makeItem());
  vi.mocked(PlanItemApi.move).mockReset().mockResolvedValue(undefined);
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

afterEach(cleanup);

describe("computeDrop 落点推导（纯函数）", () => {
  it("over=列 id → 该列列尾：空列与非空列均 afterId=undefined", () => {
    expect(computeDrop(1, "paused", PURE_COLUMNS)).toEqual({
      status: "paused",
      afterId: undefined,
    });
    expect(computeDrop(1, "in_progress", PURE_COLUMNS)).toEqual({
      status: "in_progress",
      afterId: undefined,
    });
  });

  it("over=卡片 id 跨列 → 卡片所在列 + afterId=该卡片 id", () => {
    expect(computeDrop(1, "4", PURE_COLUMNS)).toEqual({
      status: "in_progress",
      afterId: 4,
    });
    expect(computeDrop(4, "5", PURE_COLUMNS)).toEqual({
      status: "done",
      afterId: 5,
    });
  });

  it("同列原位 no-op：落点=自身 / 前一项 / 本列背景 → null", () => {
    // 落点=自身（拖到 3 号卡正上方释放）
    expect(computeDrop(3, "3", PURE_COLUMNS)).toBeNull();
    // 落点=前一项（3 挪到 2 之后 = 原位）
    expect(computeDrop(3, "2", PURE_COLUMNS)).toBeNull();
    // 拖回本列背景（无卡片落点）
    expect(computeDrop(1, "not_started", PURE_COLUMNS)).toBeNull();
  });

  it("同列重排（落点=后方卡片）→ 同状态 + afterId，原位检测不误杀列尾重排", () => {
    // 1 挪到 2 之后 = 真实位移
    expect(computeDrop(1, "2", PURE_COLUMNS)).toEqual({
      status: "not_started",
      afterId: 2,
    });
    // 1 挪到 3 之后（列尾）
    expect(computeDrop(1, "3", PURE_COLUMNS)).toEqual({
      status: "not_started",
      afterId: 3,
    });
  });

  it("active 或 over 未知 → null", () => {
    expect(computeDrop(999, "in_progress", PURE_COLUMNS)).toBeNull();
    expect(computeDrop(1, "999", PURE_COLUMNS)).toBeNull();
    expect(computeDrop(1, "bogus", PURE_COLUMNS)).toBeNull();
  });
});

describe("computeSortOrder 列内序号（纯函数）", () => {
  // 列内 sortOrder 1 / 2 / 4（留均值空间）
  const column = [
    makeItem({ id: 10, sortOrder: 1 }),
    makeItem({ id: 11, sortOrder: 2 }),
    makeItem({ id: 12, sortOrder: 4 }),
  ];

  it("无 afterId → 列尾 max+1；空列 → 1", () => {
    expect(computeSortOrder(column, undefined)).toBe(5);
    expect(computeSortOrder([], undefined)).toBe(1);
  });

  it("afterId 后无项 → after.sortOrder + 1", () => {
    expect(computeSortOrder(column, 12)).toBe(5);
  });

  it("afterId 有后项 → 均值取整（首位插入 / 中位插入）", () => {
    // 首位：10 与 11 之间 → floor((1+2)/2)=1
    expect(computeSortOrder(column, 10)).toBe(1);
    // 中位：11 与 12 之间 → floor((2+4)/2)=3
    expect(computeSortOrder(column, 11)).toBe(3);
  });

  it("afterId 不在列 → 回落列尾 max+1（容错）", () => {
    expect(computeSortOrder(column, 999)).toBe(5);
  });

  it("均值取整 ≤ 0 → 保底 1（首项/2 取整 >0 规则）", () => {
    const tight = [
      makeItem({ id: 20, sortOrder: 0 }),
      makeItem({ id: 21, sortOrder: 1 }),
    ];
    // floor((0+1)/2)=0 → 保底 1
    expect(computeSortOrder(tight, 20)).toBe(1);
  });
});

/** 看板直接渲染（纯 props，无路由/查询依赖），返回回调桩 */
function renderKanban(items: PlanItemRecord[]) {
  const onMove = vi.fn();
  const onQuickCreate = vi.fn();
  const onEdit = vi.fn();
  render(
    <PlanKanbanView
      items={items}
      onMove={onMove}
      onQuickCreate={onQuickCreate}
      onEdit={onEdit}
    />,
  );
  return { onMove, onQuickCreate, onEdit };
}

/** 四态覆盖：not_started 两张（含 5 标签截断用例）、in_progress 一张、paused 空、done 一张 */
const KANBAN_ITEMS: PlanItemRecord[] = [
  makeItem({
    id: 21,
    title: "需求评审",
    status: "not_started",
    priority: "P0",
    tags: ["核心", "设计", "研发", "联调", "发布"],
    sortOrder: 1,
  }),
  makeItem({
    id: 22,
    title: "接口联调",
    status: "not_started",
    priority: "P1",
    tags: ["研发"],
    sortOrder: 2,
  }),
  makeItem({
    id: 23,
    title: "联调验收",
    status: "in_progress",
    priority: "P2",
    sortOrder: 1,
  }),
  makeItem({
    id: 24,
    title: "发布上线",
    status: "done",
    priority: "P1",
    tags: ["发布"],
    sortOrder: 1,
  }),
];

/** 含指定标题的看板卡片（标题 span 的外层 button） */
const cardOf = (title: string) =>
  screen.getByText(title).closest("button") as HTMLElement;

/** 状态列（section aria-label = 状态名） */
const columnOf = (statusLabelKey: string) =>
  screen.getByRole("region", { name: statusLabelKey });

describe("PlanKanbanView 渲染（DOM）", () => {
  it("四列渲染 + 列头计数 + 列头 + 触发 onQuickCreate(status)", () => {
    const { onQuickCreate } = renderKanban(KANBAN_ITEMS);

    // 四列齐全（PLAN_STATUSES 序）
    const notStarted = columnOf("project:plan.statusNotStarted");
    const inProgress = columnOf("project:plan.statusInProgress");
    const paused = columnOf("project:plan.statusPaused");
    const done = columnOf("project:plan.statusDone");

    // 列头计数：2 / 1 / 0 / 1
    expect(within(notStarted).getByText("2")).toBeTruthy();
    expect(within(inProgress).getByText("1")).toBeTruthy();
    expect(within(paused).getByText("0")).toBeTruthy();
    expect(within(done).getByText("1")).toBeTruthy();

    // 列头 + → onQuickCreate(该列状态)
    fireEvent.click(
      within(inProgress).getByRole("button", {
        name: "project:plan.add project:plan.statusInProgress",
      }),
    );
    expect(onQuickCreate).toHaveBeenCalledWith("in_progress");
    fireEvent.click(
      within(done).getByRole("button", {
        name: "project:plan.add project:plan.statusDone",
      }),
    );
    expect(onQuickCreate).toHaveBeenCalledWith("done");
  });

  it("卡片字段：优先级左色条 / 标题 / 标签截断 +N / 我头像点", () => {
    renderKanban(KANBAN_ITEMS);

    // 优先级左色条：P0 destructive / P1 primary / P2 muted
    for (const card of [cardOf("需求评审"), cardOf("接口联调")]) {
      expect(card.className).toContain("border-l-4");
    }
    expect(cardOf("需求评审").className).toContain("border-l-destructive");
    expect(cardOf("接口联调").className).toContain("border-l-primary");
    expect(cardOf("联调验收").className).toContain(
      "border-l-muted-foreground/40",
    );

    // 标签：最多 3 个 + "+N"（需求评审 5 标签 → 3 显 +2）
    const reviewCard = cardOf("需求评审");
    expect(within(reviewCard).getByText("核心")).toBeTruthy();
    expect(within(reviewCard).getByText("设计")).toBeTruthy();
    expect(within(reviewCard).getByText("研发")).toBeTruthy();
    expect(within(reviewCard).queryByText("联调")).toBeNull();
    expect(within(reviewCard).queryByText("发布")).toBeNull();
    expect(within(reviewCard).getByText("+2")).toBeTruthy();

    // 我头像点：圆形 div，首字符取昵称（测试用户 → 测）
    const avatar = within(reviewCard).getByTitle("project:plan.me");
    expect(avatar.textContent).toBe("测");
    expect(avatar.className).toContain("rounded-full");
  });

  it("点击卡片 → onEdit(item)", () => {
    const { onEdit } = renderKanban(KANBAN_ITEMS);

    fireEvent.click(cardOf("需求评审"));
    expect(onEdit).toHaveBeenCalledWith(KANBAN_ITEMS[0]);
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});

/** PlanPane 集成渲染（MemoryRouter + QueryClient，缺省 ?view=kanban） */
function renderPlanPane({
  initialEntry = "/module/project/1?tab=plan&view=kanban",
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/module/project/:projectId"
            element={<PlanPane projectId={1} />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PlanPane 看板集成", () => {
  it("列头 + 打开 PlanItemDialog 且 defaultStatus 预置该列状态", async () => {
    vi.mocked(PlanItemApi.list).mockResolvedValue(KANBAN_ITEMS);
    vi.mocked(PlanItemApi.listFields).mockResolvedValue([]);
    renderPlanPane();
    await screen.findByText("需求评审");

    fireEvent.click(
      within(columnOf("project:plan.statusInProgress")).getByRole("button", {
        name: "project:plan.add project:plan.statusInProgress",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("combobox", { name: "project:plan.status" })
        .textContent,
    ).toContain("project:plan.statusInProgress");
  });

  it("点击卡片开编辑弹窗回填自身状态（defaultStatus 被忽略）", async () => {
    vi.mocked(PlanItemApi.list).mockResolvedValue(KANBAN_ITEMS);
    vi.mocked(PlanItemApi.listFields).mockResolvedValue([]);
    renderPlanPane();
    await screen.findByText("发布上线");

    fireEvent.click(cardOf("发布上线"));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("combobox", { name: "project:plan.status" })
        .textContent,
    ).toContain("project:plan.statusDone");
  });
});

describe("IME 组合输入（T6 minor 修复）", () => {
  it("PlanTableView 快速新增：composition 中的 Enter 不触发 create，普通 Enter 正常创建", async () => {
    vi.mocked(PlanItemApi.list).mockResolvedValue(KANBAN_ITEMS);
    renderPlanPane({ initialEntry: "/module/project/1?tab=plan" });
    const input = await screen.findByPlaceholderText(
      "project:plan.quickAddPlaceholder",
    );

    fireEvent.change(input, { target: { value: "组合中的标题" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(PlanItemApi.create).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(PlanItemApi.create).toHaveBeenCalledTimes(1));
  });

  it("PlanItemDialog 标签输入：composition 中的 Enter 不添加标签，普通 Enter 添加", async () => {
    vi.mocked(PlanItemApi.list).mockResolvedValue(KANBAN_ITEMS);
    renderPlanPane({ initialEntry: "/module/project/1?tab=plan" });
    await screen.findByText("需求评审");

    fireEvent.click(screen.getByRole("button", { name: "project:plan.add" }));
    const dialog = await screen.findByRole("dialog");
    const tagInput = within(dialog).getByPlaceholderText(
      "project:plan.tagPlaceholder",
    );

    fireEvent.change(tagInput, { target: { value: "新标签" } });
    fireEvent.keyDown(tagInput, { key: "Enter", isComposing: true });
    expect(tagInput.value).toBe("新标签");
    expect(within(dialog).queryByText("新标签")).toBeNull();

    fireEvent.keyDown(tagInput, { key: "Enter" });
    expect(within(dialog).getByText("新标签")).toBeTruthy();
    expect(tagInput.value).toBe("");
  });
});
