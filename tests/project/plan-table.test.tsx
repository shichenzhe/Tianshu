// @vitest-environment jsdom
/**
 * PlanPane / PlanTableView 计划表格视图测试（jsdom + testing-library，mock 骨架
 * 同 tests/project/plan-item-dialog.test.tsx：t 返回 key、sonner、Radix 桩、
 * QueryClientProvider；PlanItemApi 八静态方法 + key 工厂 + useUserStore 整体
 * mock；PlanViewApi / ProjectApi.listMembers（视图与成员数据源）mock；
 * MemoryRouter + LocationProbe 捕获 ?viewId= 写入）：
 * - 表格渲染全列（标题/状态/处理人/优先级/标签 + 动态自定义字段列与缺值 --）
 * - 行内状态 Select 切换走 move 通道（id + 目标状态 + sortOrder=目标列 max+1，
 *   不调 update）；优先级切换走 update({ id, priority })（不调 move）
 * - 快速新增回车 → create（assigneeId/projectId/title 缺省态，createdById
 *   由 token 注入不透传）+ 双 key 失效；空标题回车忽略
 * - 筛选组合：经组合筛选面板（PlanFilterPopover）施加标签(contains 输入)/
 *   状态(多选)/优先级(多选)条件，跨维度 AND 过滤（draft.conditions 经引擎
 *   filterItems 生效）；搜索标题包含过滤
 * - 视图切换：Tab 点击写 ?viewId= 且保留 ?tab=plan（URL 断言）；非法 ?view=
 *   回落表格；旧参数 ?view=kanban 初始渲染看板（resolveInitialViewId 映射）；
 *   ?viewId=12（type list）渲染列表视图状态分组清单（组头出现、无表格行）；
 *   ?viewId=13（type gantt）渲染甘特时间轴（列头出现、无表格行）
 * - 删除：行尾菜单 → AlertDialog 确认 → remove + planItems/planItemsMine 双失效
 * - 空数据：五视图渲染各自骨架（表格表头+快速新增行/看板列/列表组头/日历月格/甘特时间轴），无空态拦截
 * - AI 执行闭环（子系统 F）：行尾菜单三项（编辑/AI 推进/删除）与列表行 hover 按钮
 *   → usePlanAdvanceStore 预填插值引导语（#id《标题》+模板）；source ai 标题旁 AI Badge
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
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

// advancePrompt 插值断言用真实模板（i18next 语义最小实现；其余 key 原样返回）
import zhProject from "../../src-react/i18n/locales/zh-CN/project.json";

// Radix Select/DropdownMenu 在 jsdom 的最小桩：popper 定位依赖 ResizeObserver，
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
    useTranslation: () => ({
      t: (key: string, options?: Record<string, string | number>) => {
        if (key !== "project:plan.advancePrompt" || !options) {
          return key;
        }
        return zhProject.plan.advancePrompt.replace(
          /\{\{(\w+)\}\}/g,
          (_, name: string) => String(options[name]),
        );
      },
    }),
  };
});

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

// mapIpcError 依赖 @/i18n 实例，最小桩避免拉起完整 i18n 栈
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
    listAttachments: vi.fn().mockResolvedValue([]),
    createAttachment: vi.fn(),
    removeAttachment: vi.fn(),
  },
  PLAN_ITEMS_KEY: (projectId: number) => ["planItems", projectId],
  PLAN_ITEMS_MINE_KEY: (userId: number) => ["planItemsMine", userId],
  PLAN_FIELDS_KEY: (projectId: number) => ["planFields", projectId],
  PLAN_ITEM_ATTACHMENTS_KEY: (planItemId: number) => [
    "planItemAttachments",
    planItemId,
  ],
}));

vi.mock("@/domains/user/store/user.store", () => ({
  useUserStore: (selector?: (state: { user: { id: number } }) => unknown) =>
    selector ? selector({ user: { id: 1 } }) : { user: { id: 1 } },
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

// ProjectApi.listMembers（成员数据源，PlanPane 预取）整体 mock
const projectApiMock = vi.hoisted(() => ({ listMembers: vi.fn() }));
vi.mock("@/domains/project/api/project.api", () => ({
  default: projectApiMock,
}));

import PlanPane from "../../src-react/domains/project/components/PlanPane";
import { usePlanAdvanceStore } from "../../src-react/domains/project/store/plan-advance.store";
import PlanItemApi from "@/domains/project/api/plan-item.api";
import type {
  PlanFieldDef,
  PlanItemRecord,
} from "../../../electron/domains/project/plan-item.entity";
import type { PlanViewRecord } from "../../../electron/domains/project/plan-view.entity";

const FIELD_DEFS: PlanFieldDef[] = [
  { name: "里程碑", type: "text" },
  { name: "预算", type: "number" },
];

const makeItem = (overrides: Partial<PlanItemRecord> = {}): PlanItemRecord => ({
  id: 1,
  projectId: 1,
  title: "事项",
  aiSummary: "",
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
 * 三行覆盖度：需求梳理（in_progress/P0/设计/M1）、接口联调（done/P2/研发/全字段）、
 * 编写文档（not_started/P1/无标签/无自定义值 → 缺值 -- 用例）
 */
const ITEMS: PlanItemRecord[] = [
  makeItem({
    id: 11,
    title: "需求梳理",
    status: "in_progress",
    priority: "P0",
    tags: ["设计"],
    customFields: { 里程碑: "M1" },
    sortOrder: 1,
  }),
  makeItem({
    id: 12,
    title: "接口联调",
    status: "done",
    priority: "P2",
    tags: ["研发"],
    customFields: { 里程碑: "M2", 预算: 100 },
    sortOrder: 3,
  }),
  makeItem({
    id: 13,
    title: "编写文档",
    status: "not_started",
    priority: "P1",
  }),
];

/** 位置探针：path + search 读写断言（?view= 切换） */
function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">{`${location.pathname}${location.search}`}</div>
  );
}

interface PlanPaneRenderProps {
  initialEntry?: string;
}

/** 渲染计划面板（MemoryRouter 内 ?tab=plan 语境，返回 client 供失效断言） */
function renderPlanPane({
  initialEntry = "/module/project/1?tab=plan",
}: PlanPaneRenderProps = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LocationProbe />
        <Routes>
          <Route
            path="/module/project/:projectId"
            element={<PlanPane projectId={1} />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

/** Radix Select 选项切换：mouse pointerDown 展开 + click 选中 */
async function selectOption(trigger: HTMLElement, optionName: string) {
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(await screen.findByRole("option", { name: optionName }));
}

/**
 * 经组合筛选面板施加条件（PlanFilterPopover）：开面板 →「+ 添加筛选条件」
 * 菜单选字段 →（枚举字段勾选值 checkbox / 文本字段输入 textbox）。面板为
 * 非模态 Popover，操作期间表格持续可见可断言。
 */
async function openFilterPanel() {
  fireEvent.click(
    screen.getByRole("button", { name: "project:planView.filter" }),
  );
  return screen.findByRole("dialog", { name: "project:planView.filter" });
}

/** 面板内添加一个字段条件（菜单选后自动关闭，面板保持展开） */
async function addFilterCondition(panel: HTMLElement, fieldName: string) {
  fireEvent.pointerDown(
    within(panel).getByRole("button", {
      name: "project:planView.addCondition",
    }),
    { button: 0, pointerType: "mouse" },
  );
  const menu = await screen.findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitem", { name: fieldName }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

/** 含指定标题文本的表格行 */
const rowContaining = (title: string) =>
  screen.getByText(title).closest("tr") as HTMLElement;

/** 行内状态 Select（按行定位） */
const statusSelectOf = (title: string) =>
  within(rowContaining(title)).getByRole("combobox", {
    name: "project:plan.status",
  });

/** 行内优先级 Select（按行定位） */
const prioritySelectOf = (title: string) =>
  within(rowContaining(title)).getByRole("combobox", {
    name: "project:plan.priority",
  });

/** 视图播种：表格(10) + 看板(11) + 列表(12) + 甘特(13)，空名 = 默认视图（UI 类型名兜底显示） */
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
    name: "",
    type: "list",
    groupBy: null,
    filterJson: "{}",
    sortJson: "[]",
    sortOrder: 2,
    createdAt: "",
    updatedAt: "",
  },
  {
    id: 13,
    projectId: 1,
    name: "",
    type: "gantt",
    groupBy: null,
    filterJson: "{}",
    sortJson: "[]",
    sortOrder: 3,
    createdAt: "",
    updatedAt: "",
  },
  {
    id: 14,
    projectId: 1,
    name: "",
    type: "calendar",
    groupBy: null,
    filterJson: "{}",
    sortJson: "[]",
    sortOrder: 4,
    createdAt: "",
    updatedAt: "",
  },
];

/** 项目成员（处理人筛选/看板分组候选） */
const MEMBERS = [{ userId: 1, nickname: "我", username: "me", role: "owner" }];

beforeEach(() => {
  vi.mocked(PlanItemApi.list).mockReset().mockResolvedValue(ITEMS);
  vi.mocked(PlanItemApi.listFields).mockReset().mockResolvedValue(FIELD_DEFS);
  vi.mocked(PlanItemApi.create).mockReset().mockResolvedValue(makeItem());
  vi.mocked(PlanItemApi.update).mockReset().mockResolvedValue(undefined);
  vi.mocked(PlanItemApi.remove).mockReset().mockResolvedValue(undefined);
  vi.mocked(PlanItemApi.move).mockReset().mockResolvedValue(undefined);
  planViewMock.list.mockReset().mockResolvedValue(VIEWS);
  projectApiMock.listMembers.mockReset().mockResolvedValue(MEMBERS);
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

afterEach(cleanup);

describe("PlanPane 表格渲染", () => {
  it("渲染全列：固定列 + 动态自定义字段列，缺值显示 --", async () => {
    renderPlanPane();
    await screen.findByText("需求梳理");

    // 表头：标题/状态/处理人/优先级/标签 + 自定义字段两列
    for (const header of [
      "project:plan.title",
      "project:plan.status",
      "project:plan.handleMan",
      "project:plan.priority",
      "project:plan.tags",
      "里程碑",
      "预算",
    ]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeTruthy();
    }

    // 行值：处理人「我」、标签 Badge、自定义字段值/缺值
    expect(screen.getAllByText("project:plan.me")).toHaveLength(3);
    expect(screen.getByText("设计").className).toContain("bg-secondary");
    expect(screen.getByText("M1")).toBeTruthy();
    expect(screen.getByText("M2")).toBeTruthy();
    expect(screen.getByText("100")).toBeTruthy();
    // 优先级色徽标：P0 destructive / P1 primary / P2 muted（Select 触发器
    // 文本同名，取行内匹配中带徽标 variant 类者）
    const hasBadgeVariant = (title: string, key: string, variant: string) =>
      within(rowContaining(title))
        .getAllByText(key)
        .some((el) => el.className.includes(variant));
    expect(
      hasBadgeVariant("需求梳理", "project:plan.priorityP0", "bg-destructive"),
    ).toBe(true);
    expect(
      hasBadgeVariant("接口联调", "project:plan.priorityP2", "bg-secondary"),
    ).toBe(true);
    expect(
      hasBadgeVariant("编写文档", "project:plan.priorityP1", "bg-primary"),
    ).toBe(true);
    const docRow = rowContaining("编写文档");
    expect(within(docRow).getAllByText("--")).toHaveLength(2);
    // 需求梳理缺「预算」值 → 该行 1 个 --
    expect(within(rowContaining("需求梳理")).getAllByText("--")).toHaveLength(
      1,
    );
  });

  it("表头自定义字段列尾 + 打开字段定义管理弹窗", async () => {
    renderPlanPane();
    await screen.findByText("需求梳理");

    fireEvent.click(
      screen.getByRole("button", { name: "project:plan.manageFields" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "project:plan.manageFields" }),
    ).toBeTruthy();
  });
});

describe("PlanPane 行内编辑", () => {
  it("状态 Select 切换走 move 通道（sortOrder=目标列 max+1）且不调 update", async () => {
    renderPlanPane();
    await screen.findByText("编写文档");

    // done 列现有 max sortOrder=3（接口联调）→ 目标 4
    await selectOption(statusSelectOf("编写文档"), "project:plan.statusDone");

    await waitFor(() =>
      expect(PlanItemApi.move).toHaveBeenCalledWith({
        id: 13,
        status: "done",
        sortOrder: 4,
      }),
    );
    expect(PlanItemApi.update).not.toHaveBeenCalled();
    // 乐观更新：触发器立即显示新状态（不等失效重取）
    expect(statusSelectOf("编写文档").textContent).toContain(
      "project:plan.statusDone",
    );
  });

  it("move 失败 → 回滚失效重取 + toast.error", async () => {
    vi.mocked(PlanItemApi.move).mockRejectedValueOnce(new Error("IPC 断开"));
    const client = renderPlanPane();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    await screen.findByText("编写文档");

    await selectOption(statusSelectOf("编写文档"), "project:plan.statusDone");

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("IPC 断开"),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["planItems", 1],
      }),
    );
    // 回滚：状态恢复 not_started
    await waitFor(() =>
      expect(statusSelectOf("编写文档").textContent).toContain(
        "project:plan.statusNotStarted",
      ),
    );
    invalidateSpy.mockRestore();
  });

  it("优先级 Select 切换走 update({ id, priority }) 且不调 move", async () => {
    renderPlanPane();
    await screen.findByText("需求梳理");

    await selectOption(prioritySelectOf("需求梳理"), "project:plan.priorityP2");

    await waitFor(() =>
      expect(PlanItemApi.update).toHaveBeenCalledWith({
        id: 11,
        priority: "P2",
      }),
    );
    expect(PlanItemApi.move).not.toHaveBeenCalled();
    expect(prioritySelectOf("需求梳理").textContent).toContain(
      "project:plan.priorityP2",
    );
  });
});

describe("PlanPane 快速新增", () => {
  it("回车 → create 缺省态（createdById/assigneeId/projectId/title/status 预置 not_started）+ 双 key 失效 + 清空输入", async () => {
    const client = renderPlanPane();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    await screen.findByText("需求梳理");

    const input = screen.getByPlaceholderText(
      "project:plan.quickAddPlaceholder",
    );
    fireEvent.change(input, { target: { value: " 快速新增事项 " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      // v12：createdById 不再由前端传（token 注入 userId）
      expect(PlanItemApi.create).toHaveBeenCalledWith({
        assigneeId: 1,
        projectId: 1,
        title: "快速新增事项",
        status: "not_started",
      }),
    );
    expect(input.value).toBe("");
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["planItems", 1],
      }),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["planItemsMine", 1],
      }),
    );
    invalidateSpy.mockRestore();
  });

  it("空标题回车忽略，不调 create", async () => {
    renderPlanPane();
    const input = await screen.findByPlaceholderText(
      "project:plan.quickAddPlaceholder",
    );
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(PlanItemApi.create).not.toHaveBeenCalled();
  });
});

describe("PlanPane 筛选与搜索", () => {
  it("标签/状态/优先级多选过滤，跨维度 AND", async () => {
    renderPlanPane();
    await screen.findByText("需求梳理");
    const panel = await openFilterPanel();

    // 标签 contains「设计」（chips 多选）→ 仅需求梳理
    await addFilterCondition(panel, "project:planView.fieldTags");
    fireEvent.click(within(panel).getByRole("button", { name: "设计" }));
    await waitFor(() => expect(screen.queryByText("接口联调")).toBeNull());
    expect(screen.queryByText("编写文档")).toBeNull();
    expect(screen.getByText("需求梳理")).toBeTruthy();

    // 叠加状态 in[进行中] → 仍只剩需求梳理（跨维度 AND）
    await addFilterCondition(panel, "project:planView.fieldStatus");
    fireEvent.click(
      within(panel).getByRole("checkbox", {
        name: "project:plan.statusInProgress",
      }),
    );
    expect(screen.getByText("需求梳理")).toBeTruthy();

    // 叠加优先级 in[P2]（需求梳理为 P0）→ 无匹配行
    await addFilterCondition(panel, "project:planView.fieldPriority");
    fireEvent.click(
      within(panel).getByRole("checkbox", { name: "project:plan.priorityP2" }),
    );
    await waitFor(() => expect(screen.queryByText("需求梳理")).toBeNull());
  });

  it("搜索按标题包含过滤，空串恢复全量", async () => {
    renderPlanPane();
    await screen.findByText("需求梳理");

    const search = screen.getByPlaceholderText("project:plan.search");
    fireEvent.change(search, { target: { value: "接口" } });
    await waitFor(() => expect(screen.queryByText("需求梳理")).toBeNull());
    expect(screen.queryByText("编写文档")).toBeNull();
    expect(screen.getByText("接口联调")).toBeTruthy();

    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect(screen.getByText("需求梳理")).toBeTruthy());
  });
});

describe("PlanPane 视图切换", () => {
  it("Tab 点击写 ?viewId= 且保留 ?tab=plan；切回表格恢复", async () => {
    renderPlanPane();
    await screen.findByText("需求梳理");

    fireEvent.click(
      screen.getByRole("button", { name: "project:planView.typeKanban" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/module/project/1?tab=plan&viewId=11",
      ),
    );
    // 看板视图渲染卡片（四态泳道细节断言在 plan-kanban.test）
    expect(await screen.findByText("需求梳理")).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "project:plan.statusInProgress" }),
    ).toBeTruthy();
    expect(screen.queryByRole("row")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "project:planView.typeTable" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/module/project/1?tab=plan&viewId=10",
      ),
    );
    expect(
      await screen.findByRole("columnheader", { name: "project:plan.title" }),
    ).toBeTruthy();
  });

  it("非法 ?view= 回落表格视图", async () => {
    renderPlanPane({ initialEntry: "/module/project/1?tab=plan&view=bogus" });
    expect(await screen.findByText("需求梳理")).toBeTruthy();
  });

  it("旧参数 ?view=kanban 初始渲染看板视图（resolveInitialViewId 映射）", async () => {
    renderPlanPane({ initialEntry: "/module/project/1?tab=plan&view=kanban" });
    expect(
      await screen.findByRole("region", {
        name: "project:plan.statusNotStarted",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("row")).toBeNull();
    // 视图数据流已换轨：激活视图经 PlanViewApi 解析（而非 ?view= 直读）
    expect(planViewMock.list).toHaveBeenCalledWith(1);
  });

  it("list 类型视图渲染分组清单（状态组头出现）", async () => {
    renderPlanPane({ initialEntry: "/module/project/1?tab=plan&viewId=12" });
    // PlanListView 状态分组清单：组头为折叠按钮（状态名 i18n key）
    expect(
      await screen.findByRole("button", {
        name: "project:plan.statusNotStarted",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "project:plan.statusPaused" }),
    ).toBeTruthy();
    // 可见项按组渲染（清单行，非表格）
    expect(screen.getByRole("button", { name: "需求梳理" })).toBeTruthy();
    expect(screen.queryByRole("row")).toBeNull();
    expect(screen.queryByRole("columnheader")).toBeNull();
  });

  it("gantt 类型视图渲染甘特时间轴（列头出现、无表格行）", async () => {
    renderPlanPane({ initialEntry: "/module/project/1?tab=plan&viewId=13" });
    // 甘特控制栏：粒度切换按钮出现（视图数据流换轨完成）
    expect(
      await screen.findByRole("button", {
        name: "project:planView.granularityDay",
      }),
    ).toBeTruthy();
    // 日粒度 60 列头（jsdom div 无角色，走 data 属性）
    expect(document.querySelectorAll("[data-column-key]")).toHaveLength(60);
    expect(screen.queryByRole("row")).toBeNull();
    expect(screen.queryByRole("columnheader")).toBeNull();
  });

  it("calendar 类型视图：周表头渲染；点今日格 → 新建弹窗预置截止日", async () => {
    renderPlanPane({ initialEntry: "/module/project/1?tab=plan&viewId=14" });
    expect(await screen.findByText("project:planView.weekday1")).toBeTruthy();

    const todayCell = document.querySelector('[data-today="true"]');
    expect(todayCell).toBeTruthy();
    fireEvent.click(todayCell as HTMLElement);

    const dialog = await screen.findByRole("dialog");
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    // 时间输入迁入胶囊 Popover（子系统 D）：先点开时间规划胶囊
    fireEvent.click(
      within(dialog).getByRole("button", { name: "project:plan.timeRange" }),
    );
    const timePanel = await screen.findByRole("dialog", {
      name: "project:plan.timeRange",
    });
    expect(
      (
        within(timePanel).getByLabelText(
          "project:plan.dueDate",
        ) as HTMLInputElement
      ).value,
    ).toBe(todayKey);
  });
});

describe("PlanPane 甘特拖拽调期", () => {
  /** 播种单条带日期事项（09-10~09-14 五天条），渲染 gantt 视图返回条形与 client */
  async function renderGanttWithDatedBar() {
    vi.mocked(PlanItemApi.list).mockResolvedValue([
      makeItem({
        id: 21,
        title: "排期事项",
        startDate: "2026-09-10T00:00:00.000Z",
        dueDate: "2026-09-14T00:00:00.000Z",
      }),
    ]);
    const client = renderPlanPane({
      initialEntry: "/module/project/1?tab=plan&viewId=13",
    });
    await screen.findByRole("button", {
      name: "project:planView.granularityDay",
    });
    const barEl = document.querySelector('[data-item-id="21"]') as HTMLElement;
    return { barEl, client };
  }

  it("条形中点拖 +28px → update 携 dateKeyToIso 起止（+1 天）+ 乐观平移", async () => {
    const { barEl } = await renderGanttWithDatedBar();
    const leftBefore = parseFloat(barEl.style.left);

    // 五天条 140px；jsdom 无布局 rect.left=0 → 中点 clientX=70，+28px=+1 天
    fireEvent.pointerDown(barEl, { button: 0, clientX: 70 });
    fireEvent.pointerMove(window, { clientX: 70 + 28 });
    fireEvent.pointerUp(window);

    await waitFor(() =>
      expect(PlanItemApi.update).toHaveBeenCalledWith({
        id: 21,
        startDate: "2026-09-11T00:00:00.000Z",
        dueDate: "2026-09-15T00:00:00.000Z",
      }),
    );
    // 乐观更新：条形立即平移一天（不等失效重取）
    expect(parseFloat(barEl.style.left)).toBe(leftBefore + 28);
  });

  it("update 失败 → 失效回滚 + toast.error", async () => {
    vi.mocked(PlanItemApi.update).mockRejectedValueOnce(new Error("IPC 断开"));
    const { barEl, client } = await renderGanttWithDatedBar();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    fireEvent.pointerDown(barEl, { button: 0, clientX: 70 });
    fireEvent.pointerMove(window, { clientX: 70 + 28 });
    fireEvent.pointerUp(window);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("IPC 断开"),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["planItems", 1],
      }),
    );
    invalidateSpy.mockRestore();
  });
});

describe("PlanPane 添加视图", () => {
  it("+ 菜单点「看板」→ create 携带类型本地化名（后端重名 (n) 后缀，Tab 可区分）", async () => {
    renderPlanPane();
    await screen.findByText("需求梳理");
    planViewMock.create
      .mockReset()
      .mockResolvedValue({ ...VIEWS[1], id: 12, name: "看板(2)" });

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "project:planView.addView" }),
      { button: 0, pointerType: "mouse" },
    );
    const menu = await screen.findByRole("menu");
    fireEvent.click(
      within(menu).getByRole("menuitem", {
        name: "project:planView.typeKanban",
      }),
    );

    // t 返回 key：名称经 PlanPane 以 t(PLAN_VIEW_NAME_KEYS[type]) 传入，
    // 非空名 → 后端 (n) 后缀机制生效（缺省空名则所有新增 Tab 同名不可区分）
    await waitFor(() =>
      expect(planViewMock.create).toHaveBeenCalledWith({
        projectId: 1,
        type: "kanban",
        name: "project:planView.typeKanban",
      }),
    );
  });
});

describe("PlanPane 删除", () => {
  it("行尾菜单 → AlertDialog 确认 → remove + 双 key 失效", async () => {
    const client = renderPlanPane();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    await screen.findByText("接口联调");

    fireEvent.pointerDown(
      within(rowContaining("接口联调")).getByRole("button", {
        name: "common:operation",
      }),
    );
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByText("project:plan.delete"));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("project:plan.confirmDelete")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "common:delete" }),
    );

    await waitFor(() => expect(PlanItemApi.remove).toHaveBeenCalledWith(12));
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["planItems", 1],
      }),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["planItemsMine", 1],
      }),
    );
    invalidateSpy.mockRestore();
  });
});

describe("PlanPane 空数据渲染视图骨架", () => {
  beforeEach(() => {
    vi.mocked(PlanItemApi.list).mockResolvedValue([]);
  });

  it("默认表格视图：渲染表头与快速新增行骨架（无空态居中提示）", async () => {
    renderPlanPane();
    expect(
      await screen.findByRole("columnheader", { name: "project:plan.title" }),
    ).toBeTruthy();
    expect(
      screen.getByPlaceholderText("project:plan.quickAddPlaceholder"),
    ).toBeTruthy();
    expect(screen.queryByText("project:plan.empty")).toBeNull();
  });

  it.each([
    [
      "看板",
      "11",
      async () => screen.findByLabelText("project:plan.statusNotStarted"),
    ],
    [
      "列表",
      "12",
      async () => screen.findByText("project:plan.statusNotStarted"),
    ],
    ["日历", "14", async () => screen.findByText("project:planView.weekday1")],
    [
      "甘特",
      "13",
      async () =>
        screen.findByRole("button", {
          name: "project:planView.granularityDay",
        }),
    ],
  ])(
    "%s视图空数据渲染骨架（无 plan.empty）",
    async (_name, viewId, findAnchor) => {
      renderPlanPane({
        initialEntry: `/module/project/1?tab=plan&viewId=${viewId}`,
      });
      expect(await findAnchor()).toBeTruthy();
      expect(screen.queryByText("project:plan.empty")).toBeNull();
    },
  );
});

describe("PlanPane AI 推进入口与呈现（子系统 F）", () => {
  beforeEach(() => {
    usePlanAdvanceStore.setState({ prompt: null });
  });

  it("表格行尾菜单三项（编辑/AI 推进/删除），点「AI 推进」→ 预填 store 写入插值引导语", async () => {
    renderPlanPane();
    await screen.findByText("需求梳理");

    fireEvent.pointerDown(
      within(rowContaining("需求梳理")).getByRole("button", {
        name: "common:operation",
      }),
      { button: 0, pointerType: "mouse" },
    );
    const menu = await screen.findByRole("menu");
    // 三项有序：编辑 / AI 推进 / 删除
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((el) => el.textContent),
    ).toEqual([
      "project:plan.edit",
      "project:plan.aiAdvance",
      "project:plan.delete",
    ]);

    fireEvent.click(within(menu).getByText("project:plan.aiAdvance"));
    expect(usePlanAdvanceStore.getState().prompt).toBe(
      "请推进 #11《需求梳理》：结合项目上下文与此任务的进展记录，推进下一步工作，并更新任务状态与进展。",
    );
  });

  it("列表视图行 hover「AI 推进」按钮 → 同款预填（#id《标题》插值 + 模板文案）", async () => {
    renderPlanPane({ initialEntry: "/module/project/1?tab=plan&viewId=12" });
    const row = (
      await screen.findByRole("button", { name: "接口联调" })
    ).closest("div") as HTMLElement;
    const advanceButton = within(row).getByRole("button", {
      name: "project:plan.aiAdvance",
    });
    // AssetFileTable 先例：hover 渐显类
    expect(advanceButton.className).toContain("group-hover/row:opacity-100");

    fireEvent.click(advanceButton);
    expect(usePlanAdvanceStore.getState().prompt).toBe(
      "请推进 #12《接口联调》：结合项目上下文与此任务的进展记录，推进下一步工作，并更新任务状态与进展。",
    );
  });

  it("source ai → 标题旁 AI Badge；manual → 无", async () => {
    vi.mocked(PlanItemApi.list).mockResolvedValueOnce([
      makeItem({ id: 11, title: "AI 生成项", source: "ai" }),
      makeItem({ id: 12, title: "手动项" }),
    ]);
    renderPlanPane();
    await screen.findByText("AI 生成项");

    expect(within(rowContaining("AI 生成项")).getAllByText("AI")).toHaveLength(
      1,
    );
    expect(within(rowContaining("手动项")).queryByText("AI")).toBeNull();
  });
});
