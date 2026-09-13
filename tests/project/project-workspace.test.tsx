// @vitest-environment jsdom
/**
 * ProjectWorkspaceView 项目工作台测试（jsdom + testing-library，mock 骨架同
 * tests/project/project-hub.test.tsx + tests/ai/chat-view-edit-optimistic.test.tsx，
 * t 直接返回 key；ProjectApi/ChatPane/MarkdownView/能力 api/用户 store 以模块级
 * mock 替代，MemoryRouter + LocationProbe 断言 ?tab 读写）：
 * - 默认动态 Tab（?tab 缺省）：ChatPane mock 渲染，且收到 valid 过滤后的
 *   boundAssistantIds / boundSkillNames（失效挂载不下发给输入过滤集）
 * - 点击计划 Tab → URL 变 ?tab=plan，渲染 comingSoon 空态且 ChatPane 卸载
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
  default: { getDetail: vi.fn(), update: vi.fn(), setBindings: vi.fn() },
}));

// 动态流能力查询（ActivityPane）：provider 非空避免落入服务商引导卡
vi.mock("@/domains/ai/api/provider.api", () => ({
  ProviderApi: { list: vi.fn() },
  default: { list: vi.fn() },
}));
vi.mock("@/domains/ai/api/model.api", () => ({
  ModelApi: { listAll: vi.fn() },
  default: { listAll: vi.fn() },
}));
vi.mock("@/domains/ai/api/workspace.api", () => ({
  WorkspaceApi: { list: vi.fn() },
  default: { list: vi.fn() },
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

vi.mock("@/domains/user/store/user.store", () => ({
  useUserStore: (
    selector?: (state: { user: { id: number; nickname: string } }) => unknown,
  ) =>
    selector
      ? selector({ user: { id: 1, nickname: "小明" } })
      : { user: { id: 1, nickname: "小明" } },
}));

// ChatPane stub：占位 div + 捕获 props（断言 boundAssistantIds/过滤语义）
const chatPaneProps = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));
vi.mock("../../src-react/domains/ai/chat/components/ChatPane", async () => {
  const { createElement } = await import("react");
  return {
    default: (props: Record<string, unknown>) => {
      chatPaneProps.current = props;
      return createElement("div", null, "chat-pane-mock");
    },
  };
});

// MarkdownView stub：透传原文（断言指令只读渲染，隔离 markdown 渲染管道）
vi.mock("../../src-react/domains/ai/chat/components/MarkdownView", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ text }: { text: string }) =>
      createElement("div", { "data-testid": "instruction-md" }, text),
  };
});

import ProjectWorkspaceView from "../../src-react/domains/project/views/ProjectWorkspaceView";
import ProjectApi from "@/domains/project/api/project.api";
import { ProviderApi } from "@/domains/ai/api/provider.api";
import { ModelApi } from "@/domains/ai/api/model.api";
import { WorkspaceApi } from "@/domains/ai/api/workspace.api";
import { AssistantApi } from "@/domains/ai/api/assistant.api";
import SkillApi from "@/domains/ai/skills/api/skill.api";
import { McpServerApi } from "@/domains/ai/api/mcp.api";
import type { ProjectDetail } from "../../../electron/domains/project/project.entity";

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
    workspaceId: 5,
    title: "alpha",
    mode: "agent",
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
  },
};

/** 渲染工作台（MemoryRouter + 位置探针 + 列表页占位路由），返回 client 供 invalidate 断言 */
function renderWorkspace(initialEntry = "/module/project/1") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LocationProbe />
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

beforeEach(() => {
  vi.mocked(ProjectApi.getDetail).mockReset().mockResolvedValue(DETAIL);
  vi.mocked(ProjectApi.update).mockReset().mockResolvedValue(undefined);
  vi.mocked(ProjectApi.setBindings).mockReset().mockResolvedValue(undefined);
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
  vi.mocked(WorkspaceApi.list)
    .mockReset()
    .mockResolvedValue([
      {
        id: 5,
        name: "默认空间",
        createdAt: "2026-09-12T00:00:00.000Z",
        updatedAt: "2026-09-12T00:00:00.000Z",
      },
    ]);
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
  chatPaneProps.current = null;
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

afterEach(cleanup);

describe("Tab 容器", () => {
  it("?tab 缺省 → 动态 Tab：ChatPane 渲染并收到 valid 过滤后的能力集", async () => {
    renderWorkspace();

    expect(await screen.findByText("chat-pane-mock")).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe(
      "/module/project/1",
    );
    expect(chatPaneProps.current).toMatchObject({
      session: DETAIL.session,
      hasModel: false,
    });
    // 失效挂载（itemId=2）不下发给输入过滤集；技能以 itemName 匹配
    expect(chatPaneProps.current?.boundAssistantIds).toEqual([1]);
    expect(chatPaneProps.current?.boundSkillNames).toEqual(["联网搜索"]);
  });

  it("点击计划 Tab → URL 变 ?tab=plan，显示占位文案且 ChatPane 卸载", async () => {
    renderWorkspace();
    await screen.findByText("chat-pane-mock");

    fireEvent.click(
      screen.getByRole("tab", { name: "project:workspace.tabPlan" }),
    );

    expect(
      await screen.findByText("project:workspace.comingSoon"),
    ).toBeTruthy();
    expect(screen.queryByText("chat-pane-mock")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/module/project/1?tab=plan",
      ),
    );
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
