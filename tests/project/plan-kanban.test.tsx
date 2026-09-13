// @vitest-environment jsdom
/**
 * PlanKanbanView 看板视图测试（jsdom + testing-library，mock 骨架同
 * tests/project/plan-table.test.tsx：t 返回 key、sonner、Radix 桩、
 * QueryClientProvider；PlanItemApi 静态方法 + key 工厂 + useUserStore 整体
 * mock；PlanViewApi / ProjectApi.listMembers（视图与成员数据源）mock；
 * MemoryRouter 支撑 PlanPane 集成，缺省 ?view=kanban 旧参数经视图解析映射）：
 * - 落点纯函数 computeDrop（列泛化为 key：status/priority 枚举值、
 *   assignee=unassigned/成员 userId 字符串）：over=列 key（空列/非空列）→
 *   列尾；over=卡片 id 跨列 → 该卡所在列 + afterId；同列原位（自身/前一项/
 *   列背景）→ null；同列重排（后方卡片）→ 同列 key + afterId；active/over
 *   未知 → null；priority/assignee 分组跨列语义同型（key 即字段值）
 * - 序号纯函数 computeSortOrder：无 afterId → 列尾 max+1（空列 1）；
 *   afterId 后无项 → +1；有后项 → 均值取整；afterId 不在列 → 回落列尾；
 *   均值 ≤ 0 → 保底 1
 * - DOM（dnd-kit jsdom 不模拟 pointer 拖拽，落点语义由纯函数覆盖、集成由
 *   手动验收兜底）：status/priority/assignee 三分组列渲染 + 计数 + 列头 +
 *   （onQuickCreate 按分组依据预置 preset 对象）；卡片字段（优先级左色条
 *   class 含 P3 border-l-border/40 / 标签截断 +N / 成员头像：assigneeId →
 *   昵称首字符，null → 未指派灰点）；点击卡片 onEdit
 * - PlanPane 集成：列头 + 打开 PlanItemDialog 且 defaultStatus/defaultPriority
 *   预置该列值；编辑卡片回填自身状态（defaultStatus 被忽略）
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

// ProjectApi.listMembers（处理人选择器成员源 + PlanPane 预取）整体 mock
const projectApiMock = vi.hoisted(() => ({ listMembers: vi.fn() }));
vi.mock("@/domains/project/api/project.api", () => ({
  default: projectApiMock,
}));

// PlanViewApi 静态类整体 mock（视图数据源；key 工厂保留真实实现）
const planViewMock = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  reorder: vi.fn(),
}));
vi.mock("@/domains/project/api/plan-view.api", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/domains/project/api/plan-view.api")
    >();
  return {
    ...actual,
    default: planViewMock,
    PLAN_VIEWS_KEY: actual.PLAN_VIEWS_KEY,
  };
});

import PlanKanbanView, {
  computeDrop,
  computeSortOrder,
} from "../../src-react/domains/project/components/PlanKanbanView";
import PlanPane from "../../src-react/domains/project/components/PlanPane";
import PlanItemApi from "@/domains/project/api/plan-item.api";
import type { KanbanColumnData } from "../../src-react/domains/project/components/PlanKanbanView";
import type { ProjectMemberItem } from "../../../electron/domains/project/project.entity";
import type {
  PlanItemRecord,
  PlanStatus,
} from "../../../electron/domains/project/plan-item.entity";
import type {
  PlanGroupBy,
  PlanViewRecord,
} from "../../../electron/domains/project/plan-view.entity";

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

/** 纯函数用列集（key=status 值）：not_started 三张（sortOrder 1-3）、in_progress 一张、paused 空、done 一张 */
const item = (id: number, status: PlanStatus, sortOrder: number) =>
  makeItem({ id, status, sortOrder, title: `事项${id}` });

const PURE_COLUMNS: KanbanColumnData[] = [
  {
    key: "not_started",
    items: [
      item(1, "not_started", 1),
      item(2, "not_started", 2),
      item(3, "not_started", 3),
    ],
  },
  { key: "in_progress", items: [item(4, "in_progress", 1)] },
  { key: "paused", items: [] },
  { key: "done", items: [item(5, "done", 5)] },
];

/** 视图播种：表格(10) + 看板(11, groupBy null=缺省 status) + 看板(12, priority 分组)，空名 = 默认视图（UI 类型名兜底显示） */
const VIEWS: PlanViewRecord[] = [
  {
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
  },
  {
    id: 11,
    projectId: 1,
    name: "",
    type: "kanban",
    groupBy: null,
    filterJson: "{}",
    sortJson: "[]",
    sortOrder: 1,
    createdAt: "",
    updatedAt: "",
  },
  {
    id: 12,
    projectId: 1,
    name: "优先级看板",
    type: "kanban",
    groupBy: "priority",
    filterJson: "{}",
    sortJson: "[]",
    sortOrder: 2,
    createdAt: "",
    updatedAt: "",
  },
];

beforeEach(() => {
  vi.mocked(PlanItemApi.list).mockReset().mockResolvedValue([]);
  vi.mocked(PlanItemApi.listFields).mockReset().mockResolvedValue([]);
  vi.mocked(PlanItemApi.create).mockReset().mockResolvedValue(makeItem());
  vi.mocked(PlanItemApi.move).mockReset().mockResolvedValue(undefined);
  planViewMock.list.mockReset().mockResolvedValue(VIEWS);
  projectApiMock.listMembers
    .mockReset()
    .mockResolvedValue([
      { userId: 1, nickname: "我", username: "me", role: "owner" },
    ]);
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

afterEach(cleanup);

describe("computeDrop 落点推导（纯函数，列泛化为 key）", () => {
  it("over=列 key → 该列列尾：空列与非空列均 afterId=undefined", () => {
    expect(computeDrop(1, "paused", PURE_COLUMNS)).toEqual({
      columnKey: "paused",
      afterId: undefined,
    });
    expect(computeDrop(1, "in_progress", PURE_COLUMNS)).toEqual({
      columnKey: "in_progress",
      afterId: undefined,
    });
  });

  it("over=卡片 id 跨列 → 卡片所在列 + afterId=该卡片 id", () => {
    expect(computeDrop(1, "4", PURE_COLUMNS)).toEqual({
      columnKey: "in_progress",
      afterId: 4,
    });
    expect(computeDrop(4, "5", PURE_COLUMNS)).toEqual({
      columnKey: "done",
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

  it("同列重排（落点=后方卡片）→ 同列 key + afterId，原位检测不误杀列尾重排", () => {
    // 1 挪到 2 之后 = 真实位移
    expect(computeDrop(1, "2", PURE_COLUMNS)).toEqual({
      columnKey: "not_started",
      afterId: 2,
    });
    // 1 挪到 3 之后（列尾）
    expect(computeDrop(1, "3", PURE_COLUMNS)).toEqual({
      columnKey: "not_started",
      afterId: 3,
    });
  });

  it("active 或 over 未知 → null", () => {
    expect(computeDrop(999, "in_progress", PURE_COLUMNS)).toBeNull();
    expect(computeDrop(1, "999", PURE_COLUMNS)).toBeNull();
    expect(computeDrop(1, "bogus", PURE_COLUMNS)).toBeNull();
  });

  it('priority 分组：跨列（P1 卡拖到 P0 列）→ { columnKey: "P0", afterId }；列背景 → 列尾', () => {
    const columns: KanbanColumnData[] = [
      { key: "P0", items: [makeItem({ id: 11, priority: "P0" })] },
      { key: "P1", items: [makeItem({ id: 12, priority: "P1" })] },
      { key: "P2", items: [] },
      { key: "P3", items: [] },
    ];
    // 落点=P0 列内卡片 → P0 列 + afterId=该卡
    expect(computeDrop(12, "11", columns)).toEqual({
      columnKey: "P0",
      afterId: 11,
    });
    // 落点=P0 列背景 → P0 列尾
    expect(computeDrop(12, "P0", columns)).toEqual({
      columnKey: "P0",
      afterId: undefined,
    });
  });

  it('assignee 分组：拖到 unassigned 列背景 → { columnKey: "unassigned" }', () => {
    const columns: KanbanColumnData[] = [
      { key: "unassigned", items: [] },
      { key: "8", items: [makeItem({ id: 21, assigneeId: 8 })] },
    ];
    expect(computeDrop(21, "unassigned", columns)).toEqual({
      columnKey: "unassigned",
      afterId: undefined,
    });
    // 成员列间跨列：8 的卡拖到成员 9 列背景
    const withNine: KanbanColumnData[] = [
      { key: "unassigned", items: [] },
      { key: "8", items: [makeItem({ id: 21, assigneeId: 8 })] },
      { key: "9", items: [makeItem({ id: 22, assigneeId: 9 })] },
    ];
    expect(computeDrop(21, "9", withNine)).toEqual({
      columnKey: "9",
      afterId: undefined,
    });
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

/** 看板直渲成员集（与 PlanPane listMembers mock 同构，另含成员 8 供头像用例） */
const MEMBERS: ProjectMemberItem[] = [
  { userId: 1, nickname: "我", username: "me", role: "owner" },
  { userId: 8, nickname: "张三", username: "zhangsan", role: "member" },
];

/** 看板直接渲染（纯 props，无路由/查询依赖），返回回调桩 */
function renderKanban(
  items: PlanItemRecord[],
  {
    groupBy = "status",
    members = MEMBERS,
  }: { groupBy?: PlanGroupBy; members?: ProjectMemberItem[] } = {},
) {
  const onMoveItem = vi.fn();
  const onQuickCreate = vi.fn();
  const onEdit = vi.fn();
  render(
    <PlanKanbanView
      items={items}
      groupBy={groupBy}
      members={members}
      currentUserId={1}
      onMoveItem={onMoveItem}
      onQuickCreate={onQuickCreate}
      onEdit={onEdit}
    />,
  );
  return { onMoveItem, onQuickCreate, onEdit };
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
  it("status 分组四列渲染 + 列头计数 + 列头 + 触发 onQuickCreate({ status })", () => {
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

    // 列头 + → onQuickCreate({ status: 该列状态 })
    fireEvent.click(
      within(inProgress).getByRole("button", {
        name: "project:plan.add project:plan.statusInProgress",
      }),
    );
    expect(onQuickCreate).toHaveBeenCalledWith({ status: "in_progress" });
    fireEvent.click(
      within(done).getByRole("button", {
        name: "project:plan.add project:plan.statusDone",
      }),
    );
    expect(onQuickCreate).toHaveBeenCalledWith({ status: "done" });
  });

  it("卡片字段：优先级左色条 / 标题 / 标签截断 +N / 成员头像点", () => {
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

    // 成员头像点：圆形 span，首字符取成员昵称（assigneeId=1 → 成员「我」）
    const avatar = within(reviewCard).getByTitle("我");
    expect(avatar.textContent).toBe("我");
    expect(avatar.className).toContain("rounded-full");
  });

  it("卡片头像：assigneeId=成员 8 → 昵称首字符；null → 未指派灰点", () => {
    renderKanban([
      makeItem({ id: 31, title: "张三事项", assigneeId: 8 }),
      makeItem({ id: 32, title: "无主事项", assigneeId: null }),
      makeItem({
        id: 33,
        title: "离队事项",
        assigneeId: 99,
      }),
    ]);

    // 成员 8（张三）→ 昵称首字符「张」，title=昵称
    const memberAvatar = within(cardOf("张三事项")).getByTitle("张三");
    expect(memberAvatar.textContent).toBe("张");

    // null → 未指派：灰点（无字符）+ unassigned title
    const unassignedDot = within(cardOf("无主事项")).getByTitle(
      "project:plan.unassigned",
    );
    expect(unassignedDot.textContent).toBe("");
    expect(unassignedDot.className).toContain("rounded-full");

    // 不在成员列表的 assigneeId → 同未指派灰点（容错）
    expect(
      within(cardOf("离队事项")).getByTitle("project:plan.unassigned"),
    ).toBeTruthy();
  });

  it("groupBy=priority：P0-P3 四列渲染（空列计数 0）+ 列头 + → onQuickCreate({ priority })", () => {
    const { onQuickCreate } = renderKanban(KANBAN_ITEMS, {
      groupBy: "priority",
    });

    // P0-P3 四列齐全（KANBAN_ITEMS：P0×1 / P1×2 / P2×1 / P3×0）
    const p0 = columnOf("project:plan.priorityP0");
    const p1 = columnOf("project:plan.priorityP1");
    const p2 = columnOf("project:plan.priorityP2");
    const p3 = columnOf("project:plan.priorityP3");
    expect(within(p0).getByText("1")).toBeTruthy();
    expect(within(p1).getByText("2")).toBeTruthy();
    expect(within(p2).getByText("1")).toBeTruthy();
    expect(within(p3).getByText("0")).toBeTruthy();

    // 列头 + → onQuickCreate({ priority: 该列优先级 })
    fireEvent.click(
      within(p1).getByRole("button", {
        name: "project:plan.add project:plan.priorityP1",
      }),
    );
    expect(onQuickCreate).toHaveBeenCalledWith({ priority: "P1" });
  });

  it("groupBy=assignee：未指派列 + 候选成员列（无卡也建列）+ 列头 + → onQuickCreate({})", () => {
    const { onQuickCreate } = renderKanban(
      [
        makeItem({ id: 41, title: "张三事项", assigneeId: 8 }),
        makeItem({ id: 42, title: "无主事项", assigneeId: null }),
      ],
      { groupBy: "assignee" },
    );

    // 未指派列在前，候选成员各建列（成员 1 无卡 → 空列计数 0）
    const unassigned = columnOf("project:plan.unassigned");
    const mine = columnOf("我");
    const zhang = columnOf("张三");
    expect(within(unassigned).getByText("1")).toBeTruthy();
    expect(within(mine).getByText("0")).toBeTruthy();
    expect(within(zhang).getByText("1")).toBeTruthy();

    // 列头 + → 无可预置字段（弹窗走缺省值）
    fireEvent.click(
      within(zhang).getByRole("button", {
        name: "project:plan.add 张三",
      }),
    );
    expect(onQuickCreate).toHaveBeenCalledWith({});
  });

  it("P3 卡片左色条 class 含 border-l-border/40（比 P2 更弱）", () => {
    renderKanban([
      makeItem({
        id: 25,
        title: "P3 事项",
        status: "paused",
        priority: "P3",
        sortOrder: 1,
      }),
    ]);
    const card = cardOf("P3 事项");
    expect(card.className).toContain("border-l-border/40");
    expect(card.className).toContain("border-l-4");
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
    // 视图异步解析（?view=kanban → 激活看板视图），先等看板列挂载
    await screen.findByRole("region", {
      name: "project:plan.statusInProgress",
    });

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

  it("priority 分组视图（?viewId=12）：P0-P3 四列 + 列头 + 预置优先级打开新建弹窗", async () => {
    vi.mocked(PlanItemApi.list).mockResolvedValue(KANBAN_ITEMS);
    vi.mocked(PlanItemApi.listFields).mockResolvedValue([]);
    renderPlanPane({ initialEntry: "/module/project/1?tab=plan&viewId=12" });
    const p1 = await screen.findByRole("region", {
      name: "project:plan.priorityP1",
    });
    expect(
      screen.getByRole("region", { name: "project:plan.priorityP3" }),
    ).toBeTruthy();

    fireEvent.click(
      within(p1).getByRole("button", {
        name: "project:plan.add project:plan.priorityP1",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("combobox", { name: "project:plan.priority" })
        .textContent,
    ).toContain("project:plan.priorityP1");
  });

  it("点击卡片开编辑弹窗回填自身状态（defaultStatus 被忽略）", async () => {
    vi.mocked(PlanItemApi.list).mockResolvedValue(KANBAN_ITEMS);
    vi.mocked(PlanItemApi.listFields).mockResolvedValue([]);
    renderPlanPane();
    await screen.findByRole("region", { name: "project:plan.statusDone" });

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
