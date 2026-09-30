// @vitest-environment jsdom
/**
 * ProjectWorkspaceView 项目工作台测试（jsdom + testing-library，mock 骨架同
 * tests/project/project-hub.test.tsx + tests/ai/chat-view-edit-optimistic.test.tsx，
 * t 直接返回 key；ProjectApi/ProjectChatBar/MarkdownView/能力 api/用户 store/
 * 资产 api 以模块级 mock 替代，MemoryRouter + LocationProbe 断言 ?tab 读写）：
 * - 批 6 三 Tab（计划/任务/资产，缺省 plan）：动态 Tab 已删——无 tabActivity、
 *   无 ChatMessages（消息查看统一走会话域 ChatView）；旧链接 ?tab=activity
 *   非法值回落 plan；底栏 ProjectChatBar mock 收到 detail
 * - 底部快速发起条三 Tab 恒在（任务 Tab 下输入占位仍在）
 * - providers/models 双空：无底栏（PlanPane 正常渲染）
 * - switchTab 合并式写入（回归）：?viewId= 不随 Tab 切换丢失
 * - getDetail 抛 PROJECT_NOT_FOUND → toast + 跳回 /module/project
 * - 配置面板：点击收起按钮隐藏面板，再点展开
 * - 失效挂载语义（Task 6 裁定）：灰显 + invalid 徽标 + X 移除直接 setBindings；
 *   Picker 确认保留失效项（不静默丢弃），其他类型挂载全量透传
 * - 指令：MarkdownView 只读渲染 + 编辑弹窗保存链路（update + toast + invalidate）
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

vi.mock("@/domains/project/api/project.api", () => ({
  default: {
    getDetail: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    setBindings: vi.fn(),
    listMembers: vi.fn(),
  },
}));

// 计划 Tab（PlanPane）与任务 Tab（TasksPane）数据源：list/listFields/listMine，
// key 工厂形状与真实实现一致
vi.mock("@/domains/project/api/plan-item.api", () => ({
  default: { list: vi.fn(), listFields: vi.fn(), listMine: vi.fn() },
  PLAN_ITEMS_KEY: (projectId: number) => ["planItems", projectId],
  PLAN_ITEMS_MINE_KEY: (userId: number) => ["planItemsMine", userId],
  PLAN_FIELDS_KEY: (projectId: number) => ["planFields", projectId],
  PLAN_ITEM_ATTACHMENTS_KEY: (planItemId: number) => [
    "planItemAttachments",
    planItemId,
  ],
}));

// 资产 Tab（AssetsPane）数据源：切 Tab 渲染断言需要可渲染的空态
vi.mock("@/domains/project/api/asset.api", () => ({
  default: { list: vi.fn(), storage: vi.fn() },
}));

// 计划 Tab 视图数据源（PlanPane usePlanViews）：仅 list 消费，key 工厂保留
const planViewMock = vi.hoisted(() => ({ list: vi.fn() }));
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

// 底栏渲染判据能力查询（needsChatSetup，批 6 自 ActivityPane 迁至
// ProjectChatBar 导出）：provider 非空避免落入双空引导态
vi.mock("@/domains/ai/api/provider.api", () => ({
  ProviderApi: { list: vi.fn() },
  default: { list: vi.fn() },
}));
vi.mock("@/domains/ai/api/model.api", () => ({
  ModelApi: { listAll: vi.fn() },
  default: { listAll: vi.fn() },
}));

// 配置面板能力列表（同 CreateProjectDialog 三源）
vi.mock("@/domains/ai/api/assistant.api", () => ({
  AssistantApi: { list: vi.fn() },
  default: { list: vi.fn() },
}));
vi.mock("@/domains/ai/skills/api/skill.api", () => ({
  default: { list: vi.fn() },
}));
vi.mock("@/domains/ai/api/mcp.api", () => ({
  McpServerApi: { list: vi.fn() },
  default: { list: vi.fn() },
}));

// 配置面板定时任务区块（子系统 E）：任务列表数据源 + 新建弹窗桩化
// （区块行为在 tests/project/config-panel-automation.test.tsx 覆盖）
vi.mock("@/domains/ai/automation/api/automation.api", () => ({
  AutomationApi: { list: vi.fn(), toggle: vi.fn(), runNow: vi.fn() },
}));
vi.mock(
  "../../src-react/domains/ai/automation/components/CreateTaskDialog",
  () => ({ CreateTaskDialog: () => null }),
);

vi.mock("@/domains/user/store/user.store", () => ({
  useUserStore: (
    selector?: (state: { user: { id: number; nickname: string } }) => unknown,
  ) =>
    selector
      ? selector({ user: { id: 1, nickname: "小明" } })
      : { user: { id: 1, nickname: "小明" } },
}));

// ProjectChatBar stub：占位（内含输入占位——底栏恒在断言锚点）+ 捕获 props
// （断言 detail 下发；真实底栏行为在 project-chat-bar.test.tsx 覆盖）。
// needsChatSetup/chatSettingsRoute 为纯函数，经 importOriginal 保留真实
// 实现（批 6 自 ActivityPane 迁入此模块，ProjectWorkspaceView 消费）
const chatBarProps = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));
vi.mock(
  "../../src-react/domains/project/components/ProjectChatBar",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../src-react/domains/project/components/ProjectChatBar")
      >();
    const { createElement } = await import("react");
    return {
      ...actual,
      default: (props: Record<string, unknown>) => {
        chatBarProps.current = props;
        return createElement(
          "div",
          null,
          "project-chat-bar-mock",
          createElement("div", null, "chat-input-mock"),
        );
      },
    };
  },
);

// MarkdownView stub：透传原文（断言指令只读渲染，隔离 markdown 渲染管道）
vi.mock("../../src-react/domains/ai/chat/components/MarkdownView", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ text }: { text: string }) =>
      createElement("div", { "data-testid": "instruction-md" }, text),
  };
});

import ProjectWorkspaceView from "../../src-react/domains/project/views/ProjectWorkspaceView";
import PageHeaderHost, {
  PageHeaderRightHost,
} from "../../src-react/components/layout/PageHeaderHost";
import { usePageHeaderStore } from "../../src-react/components/layout/page-header.store";
import ProjectApi from "@/domains/project/api/project.api";
import PlanItemApi from "@/domains/project/api/plan-item.api";
import AssetApi from "@/domains/project/api/asset.api";
import { ProviderApi } from "@/domains/ai/api/provider.api";
import { ModelApi } from "@/domains/ai/api/model.api";
import { AssistantApi } from "@/domains/ai/api/assistant.api";
import SkillApi from "@/domains/ai/skills/api/skill.api";
import { McpServerApi } from "@/domains/ai/api/mcp.api";
import { AutomationApi } from "@/domains/ai/automation/api/automation.api";
import type { ProjectDetail } from "../../../electron/domains/project/project.entity";
import type { PlanViewRecord } from "../../../electron/domains/project/plan-view.entity";

const DETAIL: ProjectDetail = {
  project: {
    id: 1,
    name: "alpha",
    systemPrompt: "角色：项目经理",
    templateKey: null,
    ownerId: 1,
    sessionId: 11,
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
  },
  assetWorkspaceId: 30,
  bindings: [
    {
      id: 101,
      itemType: "assistant",
      itemId: 1,
      itemName: "专家A",
      valid: true,
    },
    {
      id: 102,
      itemType: "assistant",
      itemId: 2,
      itemName: "已删专家",
      valid: false,
    },
    {
      id: 103,
      itemType: "skill",
      itemId: 3,
      itemName: "联网搜索",
      valid: true,
    },
    {
      id: 104,
      itemType: "mcpServer",
      itemId: 4,
      itemName: "github",
      valid: true,
    },
  ],
  session: {
    id: 11,
    // P2 语义：动态流会话挂在资产空间（getDetail 自愈重绑），
    // workspaceId 恒等于 assetWorkspaceId（30）
    workspaceId: 30,
    title: "alpha",
    mode: "agent",
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
  },
};

/** 渲染工作台（MemoryRouter + 位置探针 + 列表页占位路由），返回 client 供 invalidate 断言。
 *  PageHeaderHost 同树挂载：Tab/筛选/面板开关迁入页面顶行（TopBar 中段
 *  替身），getByRole("tab") 等断言经 Host 生效；PageHeaderRightHost 同理
 *  （TopBar 右段替身——配置面板标题 slot.right 在此渲染） */
function renderWorkspace(initialEntry = "/module/project/1") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LocationProbe />
        <PageHeaderHost />
        <PageHeaderRightHost />
        <Routes>
          <Route path="/module/project" element={<div>hub-stub</div>} />
          <Route
            path="/module/project/:projectId"
            element={<ProjectWorkspaceView />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

/** 位置探针：path + search 读写断言（?tab 切换） */
function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">{`${location.pathname}${location.search}`}</div>
  );
}

/** 视图播种：表格(10) + 看板(11)，空名 = 默认视图（UI 类型名兜底显示） */
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
];

beforeEach(() => {
  vi.mocked(ProjectApi.getDetail).mockReset().mockResolvedValue(DETAIL);
  vi.mocked(ProjectApi.list).mockReset().mockResolvedValue([]);
  vi.mocked(PlanItemApi.list).mockReset().mockResolvedValue([]);
  vi.mocked(PlanItemApi.listFields).mockReset().mockResolvedValue([]);
  vi.mocked(PlanItemApi.listMine).mockReset().mockResolvedValue([]);
  vi.mocked(AssetApi.list).mockReset().mockResolvedValue([]);
  vi.mocked(AssetApi.storage)
    .mockReset()
    .mockResolvedValue({ usedBytes: 0, quotaBytes: 5 * 1024 * 1024 * 1024 });
  vi.mocked(ProjectApi.update).mockReset().mockResolvedValue(undefined);
  vi.mocked(ProjectApi.setBindings).mockReset().mockResolvedValue(undefined);
  vi.mocked(ProjectApi.listMembers).mockReset().mockResolvedValue([]);
  planViewMock.list.mockReset().mockResolvedValue(VIEWS);
  vi.mocked(ProviderApi.list)
    .mockReset()
    .mockResolvedValue([
      {
        id: 9,
        name: "demo",
        type: "openai-compatible",
        baseUrl: "https://api.demo.com",
        enabled: true,
        createdAt: "2026-09-12T00:00:00.000Z",
        updatedAt: "2026-09-12T00:00:00.000Z",
      },
    ]);
  vi.mocked(ModelApi.listAll).mockReset().mockResolvedValue([]);
  // 失效挂载 itemId=2 的源已删：专家列表不含 id 2（与后端语义一致）
  vi.mocked(AssistantApi.list)
    .mockReset()
    .mockResolvedValue([
      {
        id: 1,
        name: "专家A",
        systemPrompt: "写作专家",
        builtin: false,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
      {
        id: 5,
        name: "专家C",
        systemPrompt: "测试专家",
        builtin: false,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
  vi.mocked(SkillApi.list)
    .mockReset()
    .mockResolvedValue([
      {
        id: 3,
        name: "联网搜索",
        slug: "web-search",
        version: "1.0.0",
        source: "hub",
        dir: "/skills/web-search",
        description: "搜索网页",
        enabled: true,
        installedAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
  vi.mocked(McpServerApi.list)
    .mockReset()
    .mockResolvedValue([
      {
        id: 4,
        name: "github",
        transport: "http",
        url: "https://api.github.com",
        enabled: true,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
  // 配置面板定时任务区块：本项目任务为空（过滤逻辑在专项测试覆盖）
  vi.mocked(AutomationApi.list).mockReset().mockResolvedValue([]);
  chatBarProps.current = null;
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

afterEach(() => {
  cleanup();
  // page-header store 为模块级单例，防跨用例残留页面注册的顶行
  usePageHeaderStore.setState({ slot: null });
});

describe("Tab 容器（批 6：三 Tab，缺省 plan）", () => {
  it("?tab 缺省 → 计划 Tab：PlanPane 渲染，无动态 Tab 与 ChatMessages，底栏收到 detail", async () => {
    renderWorkspace();

    expect(
      await screen.findByRole("columnheader", { name: "project:plan.title" }),
    ).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe(
      "/module/project/1",
    );
    // 三 Tab：计划/任务/资产（动态 Tab 已删，项目会话统一在会话域查看）
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(
      screen.queryByRole("tab", { name: "project:workspace.tabActivity" }),
    ).toBeNull();
    // 动态流消息区不再渲染（消息查看走 ChatView）
    expect(screen.queryByText("chat-messages-mock")).toBeNull();
    // 底栏（输入过滤集在 ProjectChatBar 内部下发，见 project-chat-bar.test）
    expect(chatBarProps.current).toMatchObject({ detail: DETAIL });
  });

  it("旧链接 ?tab=activity 非法值 → 回落缺省计划 Tab（不渲染动态 Tab）", async () => {
    renderWorkspace("/module/project/1?tab=activity");

    expect(
      await screen.findByRole("columnheader", { name: "project:plan.title" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("tab", { name: "project:workspace.tabActivity" }),
    ).toBeNull();
  });

  it("底部快速发起条三 Tab 恒在（任务/资产 Tab 下输入占位仍存在）", async () => {
    renderWorkspace();
    await screen.findByText("project-chat-bar-mock");

    // 逐 Tab 切换（计划 → 任务 → 资产 → 计划），底栏与输入占位恒在
    for (const labelKey of [
      "project:workspace.tabTasks",
      "project:workspace.tabAssets",
      "project:workspace.tabPlan",
    ]) {
      fireEvent.click(screen.getByRole("tab", { name: labelKey }));
      await waitFor(() =>
        expect(screen.getByText("project-chat-bar-mock")).toBeTruthy(),
      );
      expect(screen.getByText("chat-input-mock")).toBeTruthy();
    }
  });

  it("providers/models 双空：无底栏（PlanPane 正常渲染，无引导卡残留）", async () => {
    // 持久覆盖（非 Once）：双观察者挂载时 staleTime=0 会触发二次拉取，
    // Once 值被首拉消费后回填非空会让引导态闪回
    vi.mocked(ProviderApi.list).mockResolvedValue([]);
    renderWorkspace();

    expect(
      await screen.findByRole("columnheader", { name: "project:plan.title" }),
    ).toBeTruthy();
    // 引导态不渲染快速发起条（needsChatSetup 自 ProjectChatBar 导出）
    expect(screen.queryByText("project-chat-bar-mock")).toBeNull();
    expect(screen.queryByText("chat:setupProviders")).toBeNull();
  });

  it("switchTab 合并式写入：切 Tab 不丢 ?viewId=（回归）", async () => {
    vi.mocked(PlanItemApi.list).mockResolvedValue([
      {
        id: 11,
        projectId: 1,
        title: "需求梳理",
        aiSummary: "",
        status: "not_started",
        priority: "P1",
        assigneeId: 1,
        tags: [],
        customFields: {},
        sortOrder: 0,
        createdById: 1,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
    renderWorkspace();
    await screen.findByRole("columnheader", { name: "project:plan.title" });

    // 切看板视图：plan 为缺省 tab（URL 本无 ?tab），合并式仅写 viewId
    fireEvent.click(
      await screen.findByRole("button", {
        name: "project:planView.typeKanban",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/module/project/1?viewId=11",
      ),
    );
    // 看板视图渲染计划卡片（细节断言在 plan-kanban.test）
    expect(await screen.findByText("需求梳理")).toBeTruthy();

    // 切任务 Tab：只改 tab，viewId 保留（合并式写入；参数序按插入序）
    fireEvent.click(
      screen.getByRole("tab", { name: "project:workspace.tabTasks" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/module/project/1?viewId=11&tab=tasks",
      ),
    );

    // 切回计划 Tab：仍处看板视图（viewId 解析回激活视图）
    fireEvent.click(
      screen.getByRole("tab", { name: "project:workspace.tabPlan" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/module/project/1?viewId=11&tab=plan",
      ),
    );
    expect(
      await screen.findByRole("region", {
        name: "project:plan.statusNotStarted",
      }),
    ).toBeTruthy();
  });

  it("getDetail 抛 PROJECT_NOT_FOUND → toast 提示并跳回 /module/project", async () => {
    vi.mocked(ProjectApi.getDetail).mockRejectedValueOnce(
      new Error("PROJECT_NOT_FOUND"),
    );
    renderWorkspace();

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/module/project",
      ),
    );
    expect(screen.getByText("hub-stub")).toBeTruthy();
    expect(toastMock.error).toHaveBeenCalledWith("project:workspace.notFound");
  });
});

describe("配置面板", () => {
  it("点击收起按钮隐藏面板，再次点击展开", async () => {
    renderWorkspace();
    await screen.findByText("project:panel.title");

    const toggle = screen.getByRole("button", {
      name: "project:workspace.togglePanel",
    });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.queryByText("project:panel.title")).toBeNull(),
    );

    fireEvent.click(toggle);
    expect(await screen.findByText("project:panel.title")).toBeTruthy();
  });

  it("失效挂载灰显 + invalid 徽标，点 X 直接 setBindings 移除该项", async () => {
    renderWorkspace();
    await screen.findByText("已删专家");

    const region = screen.getByRole("region", {
      name: "project:create.experts",
    });
    expect(within(region).getByText("project:create.invalid")).toBeTruthy();

    fireEvent.click(
      within(region).getByRole("button", { name: "common:close" }),
    );

    await waitFor(() =>
      expect(ProjectApi.setBindings).toHaveBeenCalledTimes(1),
    );
    const [, items] = vi.mocked(ProjectApi.setBindings).mock.calls[0];
    expect(items).toEqual([
      { itemType: "assistant", itemId: 1 },
      { itemType: "skill", itemId: 3 },
      { itemType: "mcpServer", itemId: 4 },
    ]);
  });

  it("Picker 确认 → setBindings 全量替换且保留失效项与其他类型挂载", async () => {
    const client = renderWorkspace();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    await screen.findByText("已删专家");

    const region = screen.getByRole("region", {
      name: "project:create.experts",
    });
    fireEvent.click(
      within(region).getByRole("button", { name: "project:create.add" }),
    );
    const picker = await screen.findByRole("dialog", {
      name: "project:create.experts",
    });
    // 初始勾选只含 valid 项（专家A），再勾选专家C
    fireEvent.click(within(picker).getByText("专家C"));
    fireEvent.click(
      within(picker).getByRole("button", { name: "project:picker.confirm" }),
    );

    await waitFor(() =>
      expect(ProjectApi.setBindings).toHaveBeenCalledWith(1, expect.any(Array)),
    );
    const [, items] = vi.mocked(ProjectApi.setBindings).mock.calls[0];
    // 专家行 = picker 确认集 [1,5] + 失效项保留 [2]
    expect(items.filter((i) => i.itemType === "assistant")).toEqual([
      { itemType: "assistant", itemId: 1 },
      { itemType: "assistant", itemId: 5 },
      { itemType: "assistant", itemId: 2 },
    ]);
    // 其他类型挂载原样透传
    expect(items.filter((i) => i.itemType === "skill")).toEqual([
      { itemType: "skill", itemId: 3 },
    ]);
    expect(items.filter((i) => i.itemType === "mcpServer")).toEqual([
      { itemType: "mcpServer", itemId: 4 },
    ]);
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["project", 1] }),
      ),
    );
  });

  it("指令只读渲染 + 编辑弹窗保存 → update + toast + invalidate", async () => {
    const client = renderWorkspace();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    await screen.findByText("project:panel.title");
    expect(screen.getByTestId("instruction-md").textContent).toBe(
      "角色：项目经理",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "project:panel.editInstruction" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "project:panel.editInstruction",
    });
    fireEvent.change(within(dialog).getByDisplayValue("角色：项目经理"), {
      target: { value: "新指令" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "project:panel.saveInstruction",
      }),
    );

    await waitFor(() =>
      expect(ProjectApi.update).toHaveBeenCalledWith({
        id: 1,
        systemPrompt: "新指令",
      }),
    );
    expect(toastMock.success).toHaveBeenCalledWith("project:toast.saved");
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["project", 1] }),
      ),
    );
  });
});
