// @vitest-environment jsdom
/**
 * TasksPane 任务面板测试（jsdom + testing-library，mock 骨架同
 * tests/project/plan-table.test.tsx：t 返回 key、sonner、Radix 桩、
 * QueryClientProvider；PlanItemApi/ProjectApi 静态类 + key 工厂 + useUserStore
 * 整体 mock（用户恒 id=1）；PlanItemDialog 桩化渲染 props 供 projectId/item
 * 断言；MemoryRouter + LocationProbe 捕获项目任务行导航）：
 * - 列表渲染：来源 Badge 本地 fromLocal/项目名 secondary 分流、状态徽标
 *   四态配色、优先级色点三色、相对时间（zhCN "N 天前"）、私密提示灰字
 * - 范围筛选谓词：assigned=assigneeId 我 / created=createdById 我
 *   （fixture 四行：本地双属/项目仅指派/项目仅创建/本地仅创建）
 * - 来源筛选：local=projectId null / project=projectId 非空分流
 * - 搜索标题包含过滤，空串恢复全量
 * - 本地任务行点击 → PlanItemDialog 编辑态（item 回填断言）；
 *   项目任务行点击 → navigate /module/project/<id>?tab=plan
 * - 「新建本地任务」→ PlanItemDialog projectId=null 新建态
 * - 空态：listMine 空 → tasks.empty，无列表行
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

// Radix DropdownMenu 在 jsdom 的最小桩：popper 定位依赖 ResizeObserver，
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

// 相对时间经 getDateFnsLocale 取 locale（zhCN 断言 "N 天前" 稳定文案）
vi.mock("@/i18n", async () => {
  const { zhCN: locale } = await import("date-fns/locale");
  return {
    default: { t: (key: string) => key },
    getDateFnsLocale: () => locale,
  };
});

// PlanItemApi 静态类 + query key 工厂整体 mock（key 形状与真实实现一致）
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

// ProjectApi 静态类整体 mock：任务面板只消费 list（项目名解析）
vi.mock("@/domains/project/api/project.api", () => ({
  default: {
    list: vi.fn(),
    getDetail: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    setBindings: vi.fn(),
  },
}));

vi.mock("@/domains/user/store/user.store", () => ({
  useUserStore: (selector?: (state: { user: { id: number } }) => unknown) =>
    selector ? selector({ user: { id: 1 } }) : { user: { id: 1 } },
}));

// PlanItemDialog 桩：default 换关键 props 渲染供编辑 item / projectId=null
// 断言；具名导出（STATUS/PRIORITY_LABEL_KEYS 等）保留真实实现——面板行内
// 消费这些映射，直接整体替换会让命名导入变 undefined
interface DialogStubProps {
  open: boolean;
  projectId: number | null;
  item?: { id: number; title: string };
}
vi.mock(
  "../../src-react/domains/project/components/PlanItemDialog",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../src-react/domains/project/components/PlanItemDialog")
      >();
    return {
      ...actual,
      default: ({ open, projectId, item }: DialogStubProps) =>
        open ? (
          <div
            data-testid="plan-item-dialog"
            data-project-id={projectId === null ? "null" : String(projectId)}
          >
            {item ? `edit:${item.id}:${item.title}` : "create"}
          </div>
        ) : null,
    };
  },
);

import TasksPane from "../../src-react/domains/project/components/TasksPane";
import PlanItemApi from "@/domains/project/api/plan-item.api";
import ProjectApi from "@/domains/project/api/project.api";
import type { ProjectRecord } from "../../../electron/domains/project/project.entity";
import type { PlanItemRecord } from "../../../electron/domains/project/plan-item.entity";

const DAY_MS = 24 * 3600 * 1000;

/** N 天前的 ISO 时间（formatDistanceToNow zhCN 断言 "N 天前" 稳定） */
const isoDaysAgo = (days: number) =>
  new Date(Date.now() - days * DAY_MS).toISOString();

const makeItem = (overrides: Partial<PlanItemRecord> = {}): PlanItemRecord => ({
  id: 1,
  projectId: 1,
  title: "任务",
  aiSummary: "",
  status: "not_started",
  priority: "P1",
  assigneeId: 1,
  tags: [],
  customFields: {},
  sortOrder: 0,
  createdById: 1,
  createdAt: isoDaysAgo(9),
  updatedAt: isoDaysAgo(1),
  ...overrides,
});

/**
 * 四行覆盖度（用户恒 id=1）：
 * - 21 本地·双属（指派+创建）in_progress/P0 → 本地 Badge + 主题色状态徽标
 * - 22 项目·仅指派 not_started/P1 → 项目名 Badge secondary
 * - 23 项目·仅创建 done/P2 → muted 状态徽标
 * - 24 本地·仅创建 paused/P1 → 本地 Badge
 */
const ITEMS: PlanItemRecord[] = [
  makeItem({
    id: 21,
    projectId: null,
    title: "买装修建材",
    status: "in_progress",
    priority: "P0",
    assigneeId: 1,
    createdById: 1,
    updatedAt: isoDaysAgo(3),
  }),
  makeItem({
    id: 22,
    projectId: 10,
    title: "官网首页改版",
    priority: "P1",
    assigneeId: 1,
    createdById: 2,
    updatedAt: isoDaysAgo(2),
  }),
  makeItem({
    id: 23,
    projectId: 10,
    title: "整理部署脚本",
    status: "done",
    priority: "P2",
    assigneeId: null,
    createdById: 1,
    updatedAt: isoDaysAgo(1),
  }),
  makeItem({
    id: 24,
    projectId: null,
    title: "写读书笔记",
    status: "paused",
    priority: "P1",
    assigneeId: 2,
    createdById: 1,
    updatedAt: isoDaysAgo(5),
  }),
];

const makeProject = (id: number, name: string): ProjectRecord => ({
  id,
  name,
  systemPrompt: null,
  templateKey: null,
  ownerId: 1,
  sessionId: id * 100,
  createdAt: isoDaysAgo(20),
  updatedAt: isoDaysAgo(10),
});

const PROJECTS: ProjectRecord[] = [
  makeProject(10, "北斗官网"),
  makeProject(11, "内部工具"),
];

/** 位置探针：path + search 断言（项目任务行导航） */
function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">{`${location.pathname}${location.search}`}</div>
  );
}

/** 渲染任务面板（MemoryRouter 内，返回 client 供失效断言） */
function renderTasksPane() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/tasks"]}>
        <LocationProbe />
        <Routes>
          <Route path="/tasks" element={<TasksPane />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

/** 打开单选下拉并点选一项（pointerDown 展开 + click 选中，菜单自动关闭） */
async function pickMenuItem(triggerName: string, itemName: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name: triggerName }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  const menu = await screen.findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitem", { name: itemName }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

/** 含指定标题文本的任务行 */
const rowOf = (title: string) =>
  screen.getByText(title).closest('[role="listitem"]') as HTMLElement;

/** 等四行任务全部渲染就绪（避开逐行 waitFor） */
const awaitRows = async () => {
  await screen.findByText("买装修建材");
  await screen.findByText("官网首页改版");
  await screen.findByText("整理部署脚本");
  await screen.findByText("写读书笔记");
};

beforeEach(() => {
  vi.mocked(PlanItemApi.listMine).mockReset().mockResolvedValue(ITEMS);
  vi.mocked(ProjectApi.list).mockReset().mockResolvedValue(PROJECTS);
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

afterEach(cleanup);

describe("TasksPane 列表渲染", () => {
  it("行渲染：来源 Badge 本地/项目名分流 + 状态徽标配色 + 优先级色点 + 相对时间 + 私密提示", async () => {
    renderTasksPane();
    await awaitRows();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);

    // 私密提示灰字
    expect(screen.getByText("project:tasks.privateTip")).toBeTruthy();

    // 来源 Badge 分流：本地 → fromLocal ×2；项目 → 项目名 secondary ×2
    expect(screen.getAllByText("project:tasks.fromLocal")).toHaveLength(2);
    const projectBadges = screen.getAllByText("北斗官网");
    expect(projectBadges).toHaveLength(2);
    expect(projectBadges[0].className).toContain("bg-secondary");

    // 状态徽标：进行中 primary-subtle / 完成 muted
    const inProgressBadge = within(rowOf("买装修建材")).getByText(
      "project:plan.statusInProgress",
    );
    expect(inProgressBadge.className).toContain("bg-primary-subtle");
    const doneBadge = within(rowOf("整理部署脚本")).getByText(
      "project:plan.statusDone",
    );
    expect(doneBadge.className).toContain("bg-muted");

    // 优先级色点：P0 destructive / P1 primary / P2 muted-foreground
    const dot = (title: string, priorityKey: string) =>
      within(rowOf(title)).getByTitle(priorityKey);
    expect(dot("买装修建材", "project:plan.priorityP0").className).toContain(
      "bg-destructive",
    );
    expect(dot("官网首页改版", "project:plan.priorityP1").className).toContain(
      "bg-primary",
    );
    expect(dot("整理部署脚本", "project:plan.priorityP2").className).toContain(
      "bg-muted-foreground",
    );

    // 相对时间（zhCN + addSuffix）：各天数互异可逐行断言
    expect(screen.getByText("3 天前")).toBeTruthy();
    expect(screen.getByText("2 天前")).toBeTruthy();
    expect(screen.getByText("1 天前")).toBeTruthy();
    expect(screen.getByText("5 天前")).toBeTruthy();

    // 工具栏：范围/来源筛选触发器 + 搜索 + 新建本地任务
    expect(
      screen.getByRole("button", { name: "project:tasks.mine" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "project:tasks.allSource" }),
    ).toBeTruthy();
    expect(screen.getByPlaceholderText("project:tasks.search")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "project:tasks.newLocalTask" }),
    ).toBeTruthy();
  });

  it("空态：listMine 空 → tasks.empty，无列表行", async () => {
    vi.mocked(PlanItemApi.listMine).mockResolvedValue([]);
    renderTasksPane();
    expect(await screen.findByText("project:tasks.empty")).toBeTruthy();
    expect(screen.queryByRole("listitem")).toBeNull();
  });
});

describe("TasksPane 范围筛选", () => {
  it("assigned=指派给我的（assigneeId=1），created=我创建的（createdById=1）行分流", async () => {
    renderTasksPane();
    await awaitRows();

    // 指派给我的：21/22 留，23（未指派）/24（指派他人）隐
    await pickMenuItem("project:tasks.mine", "project:tasks.assigned");
    await waitFor(() => expect(screen.queryByText("整理部署脚本")).toBeNull());
    expect(screen.queryByText("写读书笔记")).toBeNull();
    expect(screen.getByText("买装修建材")).toBeTruthy();
    expect(screen.getByText("官网首页改版")).toBeTruthy();

    // 我创建的：21/23/24 留，22（他人创建）隐
    await pickMenuItem("project:tasks.assigned", "project:tasks.created");
    await waitFor(() => expect(screen.queryByText("官网首页改版")).toBeNull());
    expect(screen.getByText("买装修建材")).toBeTruthy();
    expect(screen.getByText("整理部署脚本")).toBeTruthy();
    expect(screen.getByText("写读书笔记")).toBeTruthy();
  });
});

describe("TasksPane 来源筛选", () => {
  it("local=projectId null，project=projectId 非空分流", async () => {
    renderTasksPane();
    await awaitRows();

    // 本地任务：21/24 留
    await pickMenuItem("project:tasks.allSource", "project:tasks.local");
    await waitFor(() => expect(screen.queryByText("官网首页改版")).toBeNull());
    expect(screen.queryByText("整理部署脚本")).toBeNull();
    expect(screen.getByText("买装修建材")).toBeTruthy();
    expect(screen.getByText("写读书笔记")).toBeTruthy();

    // 项目任务：22/23 留
    await pickMenuItem("project:tasks.local", "project:tasks.project");
    await waitFor(() => expect(screen.queryByText("买装修建材")).toBeNull());
    expect(screen.queryByText("写读书笔记")).toBeNull();
    expect(screen.getByText("官网首页改版")).toBeTruthy();
    expect(screen.getByText("整理部署脚本")).toBeTruthy();
  });
});

describe("TasksPane 搜索", () => {
  it("标题包含过滤，空串恢复全量", async () => {
    renderTasksPane();
    await awaitRows();

    const search = screen.getByPlaceholderText("project:tasks.search");
    fireEvent.change(search, { target: { value: "改版" } });
    await waitFor(() => expect(screen.queryByText("买装修建材")).toBeNull());
    expect(screen.queryByText("整理部署脚本")).toBeNull();
    expect(screen.getByText("官网首页改版")).toBeTruthy();

    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect(screen.getByText("买装修建材")).toBeTruthy());
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });
});

describe("TasksPane 行为", () => {
  it("本地任务行点击 → PlanItemDialog 编辑态（item 回填）", async () => {
    renderTasksPane();
    await awaitRows();

    fireEvent.click(screen.getByText("买装修建材"));
    const dialog = screen.getByTestId("plan-item-dialog");
    expect(dialog.textContent).toBe("edit:21:买装修建材");
    expect(dialog.dataset.projectId).toBe("null");
  });

  it("项目任务行点击 → navigate /module/project/<id>?tab=plan", async () => {
    renderTasksPane();
    await awaitRows();

    fireEvent.click(screen.getByText("官网首页改版"));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/module/project/10?tab=plan",
      ),
    );
  });

  it("「新建本地任务」→ PlanItemDialog 新建态 projectId=null", async () => {
    renderTasksPane();
    await awaitRows();

    fireEvent.click(
      screen.getByRole("button", { name: "project:tasks.newLocalTask" }),
    );
    const dialog = screen.getByTestId("plan-item-dialog");
    expect(dialog.textContent).toBe("create");
    expect(dialog.dataset.projectId).toBe("null");
  });
});
