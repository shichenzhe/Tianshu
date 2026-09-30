// @vitest-environment jsdom
/**
 * ChatView 项目会话增强测试（批 4：面包屑 + 任务概览；jsdom +
 * testing-library；mock 骨架同 tests/ai/chat-view-edit-optimistic.test.tsx，
 * t 直接返回 key）：
 * - 面包屑：主会话单段「项目名」/ 任务会话两段「项目名 / 任务标题」，
 *   点击回 /module/project/:id；普通会话无面包屑（现有行为不变）
 * - 任务概览：产物面板顶部 topSection（仅 planItemId 非空）——状态/优先级/
 *   起止日期只读行 + aiSummary（空串不渲染该段）+「在项目中查看」
 * - 能力预设（§3.7 修正）：挂载集是预设而非过滤边界，联想/专家切换
 *   子菜单不做挂载过滤（普通/项目会话行为一致，不传过滤集）
 * - 面板生效空间：项目会话（资产空间不在全局列表）以会话 workspaceId
 *   兜底传 ChatPane/ArtifactsPanel（同项目动态流 spec §3.6 语义）
 * ChatPane/ArtifactsPanel 以捕获 props 的 stub 替代；page-header 用真实
 * store，HeaderHost 订阅 slot.leading 就地渲染（面包屑随查询就绪自动补全）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ReactNode } from "react";

/** 位置探针：读取当前 pathname+search（面包屑/概览链接跳转断言用） */
function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">{`${location.pathname}${location.search}`}</div>
  );
}

/** 顶行宿主（TopBar PageHeaderHost 替身）：订阅真实 page-header store，
 *  就地渲染 slot.leading 与 trailing——面包屑随查询就绪自动补全，转办
 *  入口按钮（trailing）可定位断言 */
function HeaderHost() {
  const slot = usePageHeaderStore((s) => s.slot);
  return (
    <>
      {slot?.leading}
      {slot?.trailing}
    </>
  );
}

// localStorage stub：模块加载链上的 store 在 Node 环境访问原生全局会打
// ExperimentalWarning，先行替换为内存 stub 消除噪音
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
    clear: () => memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

// IPC mock：invoke 按 channel 分发假数据（query 全走此口）
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({
  invoke: (channel: string, ...args: unknown[]) => invokeMock(channel, ...args),
  on: () => () => {},
  send: () => {},
}));

// ChatPane stub：捕获 ChatView 透传的会话/空间/能力过滤集
interface CapturedPaneProps {
  session: {
    id: number;
    projectId?: number | null;
    planItemId?: number | null;
  };
  workspace: { id: number } | null;
  boundAssistantIds?: number[];
  boundSkillNames?: string[];
}
const paneProps = vi.hoisted(() => ({
  current: null as CapturedPaneProps | null,
}));
vi.mock("../../src-react/domains/ai/chat/components/ChatPane", async () => {
  const { createElement } = await import("react");
  return {
    default: (props: CapturedPaneProps) => {
      paneProps.current = props;
      return createElement("div", { "data-testid": "chat-pane-stub" });
    },
  };
});

// ArtifactsPanel stub：捕获 topSection 插槽并渲染（任务概览断言入口）
const panelProps = vi.hoisted(() => ({
  current: null as { topSection?: ReactNode; workspaceId: number } | null,
}));
vi.mock(
  "../../src-react/domains/ai/chat/components/artifacts/ArtifactsPanel",
  async () => {
    const { createElement } = await import("react");
    return {
      default: (props: { topSection?: ReactNode; workspaceId: number }) => {
        panelProps.current = props;
        return createElement(
          "div",
          { "data-testid": "artifacts-panel-stub" },
          props.topSection ?? null,
        );
      },
      ArtifactsPanelToggle: () =>
        createElement("div", { "data-testid": "artifacts-toggle-stub" }),
    };
  },
);

// MarkdownView stub：TaskOverview 摘要段轻渲染（隔离 markdown/shiki 管道）
vi.mock("../../src-react/domains/ai/chat/components/MarkdownView", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ text }: { text: string }) =>
      createElement("div", { "data-testid": "markdown-stub" }, text),
  };
});

import ChatView from "../../src-react/domains/ai/chat/views/ChatView";
import { usePageHeaderStore } from "../../src-react/components/layout/page-header.store";
import { useAiUiStore } from "../../src-react/domains/ai/store/ai-ui.store";
import type { SessionRecord } from "../../src-react/domains/ai/api/session.api";
import type { ProjectDetail } from "../../electron/domains/project/project.entity";

const PROJECT_ID = 11;
const ASSET_WORKSPACE_ID = 30;
const PLAN_ITEM_ID = 55;

/** 三类会话夹具：项目主会话/项目任务会话/普通会话 */
const sessionRow = (overrides: Partial<SessionRecord>): SessionRecord =>
  ({
    id: 21,
    workspaceId: ASSET_WORKSPACE_ID,
    title: "官网改版",
    mode: "agent",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    projectId: PROJECT_ID,
    planItemId: null,
    ...overrides,
  }) as SessionRecord;

const MAIN_SESSION = sessionRow({ id: 21 });
const TASK_SESSION = sessionRow({ id: 22, planItemId: PLAN_ITEM_ID });
const NORMAL_SESSION = sessionRow({
  id: 31,
  workspaceId: 2,
  projectId: null,
});

const PLAN_ITEM = {
  id: PLAN_ITEM_ID,
  projectId: PROJECT_ID,
  title: "调研竞品",
  description: "",
  aiSummary: "已完成三成调研",
  status: "in_progress",
  priority: "P1",
  assigneeId: 1,
  tags: [],
  startDate: "2026-09-20",
  dueDate: null,
  sortOrder: 0,
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
};

const PROJECT_DETAIL = {
  project: {
    id: PROJECT_ID,
    name: "官网改版",
    systemPrompt: null,
    templateKey: null,
    ownerId: 1,
    sessionId: 21,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  },
  assetWorkspaceId: ASSET_WORKSPACE_ID,
  bindings: [
    { id: 1, itemType: "assistant", itemId: 1, itemName: "专家A", valid: true },
    {
      id: 2,
      itemType: "assistant",
      itemId: 2,
      itemName: "已删专家",
      valid: false,
    },
    { id: 3, itemType: "skill", itemId: 3, itemName: "联网搜索", valid: true },
    { id: 4, itemType: "skill", itemId: 4, itemName: "已删技能", valid: false },
  ],
  session: MAIN_SESSION,
} as unknown as ProjectDetail;

/** 渲染 ChatView：sessions 为 session:listAll 返回（可按用例覆写 planItem） */
function renderChat(
  sessionId: number,
  options: { planItems?: unknown[] } = {},
) {
  invokeMock.mockImplementation((channel: string) => {
    switch (channel) {
      // 非空 providers：避免 needsSetup 引导态吞掉 ChatPane
      case "provider:list":
        return Promise.resolve([{ id: 1, name: "OpenAI" }]);
      case "model:listAll":
        return Promise.resolve([]);
      case "workspace:list":
        // 资产空间 30 不在全局列表（后端过滤 projectId 非空）
        return Promise.resolve([
          { id: 2, name: "默认工作空间", directoryPath: null },
        ]);
      case "session:listAll":
        return Promise.resolve([MAIN_SESSION, TASK_SESSION, NORMAL_SESSION]);
      case "project:list":
        return Promise.resolve([{ id: PROJECT_ID, name: "官网改版" }]);
      case "planItem:list":
        return Promise.resolve(options.planItems ?? [PLAN_ITEM]);
      case "project:getDetail":
        return Promise.resolve(PROJECT_DETAIL);
      default:
        return Promise.resolve([]);
    }
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[`/module/ai?session=${sessionId}`]}>
        <LocationProbe />
        <HeaderHost />
        <ChatView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  invokeMock.mockReset();
  paneProps.current = null;
  panelProps.current = null;
  useAiUiStore.getState().setArtifactsOpen(false);
});

afterEach(() => {
  cleanup();
  useAiUiStore.getState().setArtifactsOpen(false);
});

describe("ChatView 项目会话增强（批 4）", () => {
  it("项目主会话：面包屑单段项目名，点击回项目页；无任务概览插槽", async () => {
    renderChat(MAIN_SESSION.id);
    await waitFor(() => expect(paneProps.current).not.toBeNull());
    // 项目名经 projects 缓存解析（不再为能力过滤查 getDetail——预设≠过滤）
    await waitFor(() =>
      expect(invokeMock).not.toHaveBeenCalledWith(
        "project:getDetail",
        PROJECT_ID,
      ),
    );

    expect(await screen.findByText("官网改版")).toBeTruthy();
    expect(screen.queryByText("调研竞品")).toBeNull();
    fireEvent.click(screen.getByText("官网改版"));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        `/module/project/${PROJECT_ID}`,
      ),
    );
  });

  it("项目任务会话：面包屑两段「项目名 / 任务标题」", async () => {
    renderChat(TASK_SESSION.id);
    await waitFor(() => expect(paneProps.current).not.toBeNull());

    expect(await screen.findByText("官网改版")).toBeTruthy();
    expect(await screen.findByText("调研竞品")).toBeTruthy();
  });

  it("普通会话：无面包屑、不查 getDetail、过滤集不传（AI 模块行为不变）", async () => {
    renderChat(NORMAL_SESSION.id);
    await waitFor(() => expect(paneProps.current).not.toBeNull());

    // 无面包屑（项目名/事项查询均未触发）；过滤集不传
    await act(async () => {});
    expect(screen.queryByText("官网改版")).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("project:getDetail");
    expect(paneProps.current?.boundAssistantIds).toBeUndefined();
    expect(paneProps.current?.boundSkillNames).toBeUndefined();
    cleanup();
  });

  it("能力不做挂载过滤（§3.7 修正：预设≠围墙）；资产空间 id 兜底", async () => {
    renderChat(TASK_SESSION.id);
    await waitFor(() => expect(paneProps.current).not.toBeNull());
    // 联想/专家切换子菜单不收挂载集，预设外能力会话中按需可选
    expect(paneProps.current?.boundAssistantIds).toBeUndefined();
    expect(paneProps.current?.boundSkillNames).toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalledWith("project:getDetail");
    // 资产空间不在全局列表：以会话自身 workspaceId 兜底传 id（spec §3.6）
    expect(paneProps.current?.workspace).toEqual({ id: ASSET_WORKSPACE_ID });
  });

  it("任务概览：产物面板顶部渲染只读行 + aiSummary +「在项目中查看」", async () => {
    renderChat(TASK_SESSION.id);
    await waitFor(() => expect(paneProps.current).not.toBeNull());
    // ChatView 挂载即重置收起——展开后再断言插槽渲染
    act(() => {
      useAiUiStore.setState({ artifactsOpen: true });
    });

    expect(await screen.findByTestId("artifacts-panel-stub")).toBeTruthy();
    expect(screen.getByText("chat:taskOverview.title")).toBeTruthy();
    // 只读行：字段名 + 取值（t 返回 key；空截止日期显示 —）
    expect(screen.getByText("project:plan.statusInProgress")).toBeTruthy();
    expect(screen.getByText("project:plan.priorityP1")).toBeTruthy();
    expect(screen.getByText("2026-09-20")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByTestId("markdown-stub").textContent).toBe(
      "已完成三成调研",
    );
    // 在项目中查看：回项目页
    fireEvent.click(screen.getByText("chat:taskOverview.viewInProject"));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        `/module/project/${PROJECT_ID}`,
      ),
    );
  });

  it("任务概览：主会话无插槽；aiSummary 空串不渲染摘要段", async () => {
    // 主会话：topSection 缺席
    renderChat(MAIN_SESSION.id);
    await waitFor(() => expect(paneProps.current).not.toBeNull());
    act(() => {
      useAiUiStore.setState({ artifactsOpen: true });
    });
    await waitFor(() => expect(panelProps.current).not.toBeNull());
    expect(panelProps.current?.topSection).toBeUndefined();
    cleanup();

    // 任务会话但 aiSummary 为空：摘要段不渲染（其余只读行在）
    renderChat(TASK_SESSION.id, {
      planItems: [{ ...PLAN_ITEM, aiSummary: "" }],
    });
    await waitFor(() => expect(paneProps.current).not.toBeNull());
    act(() => {
      useAiUiStore.setState({ artifactsOpen: true });
    });
    expect(await screen.findByText("chat:taskOverview.title")).toBeTruthy();
    expect(screen.queryByText("chat:taskOverview.aiSummary")).toBeNull();
    expect(screen.queryByTestId("markdown-stub")).toBeNull();
  });
});

describe("ChatView 转办入口（批 12：项目会话顶行 trailing）", () => {
  it("项目会话：搜索与产物开关之间渲染转办按钮，点击打开弹框", async () => {
    renderChat(TASK_SESSION.id);
    const handover = await screen.findByRole("button", {
      name: "chat:handover.action",
    });
    // 位置：在产物面板开关（trailing 末位）之前
    const toggle = screen.getByTestId("artifacts-toggle-stub");
    const relative = handover.compareDocumentPosition(toggle);
    expect(relative & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(handover);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("project:handover.title")).toBeTruthy();
  });

  it("普通会话：无转办按钮（入口仅项目会话渲染）", async () => {
    renderChat(NORMAL_SESSION.id);
    await waitFor(() => expect(paneProps.current).not.toBeNull());
    expect(
      screen.queryByRole("button", { name: "chat:handover.action" }),
    ).toBeNull();
  });
});
