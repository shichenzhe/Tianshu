// tests/ai/new-task-context-bar.test.tsx
// @vitest-environment jsdom
/**
 * 新建任务配置栏（修订 spec 裁定 11：工作空间显式选择）：未选空间不再
 * 自动跟随列表第一个——保持 null 引导态；持久化脏 id（空间已删/换库）
 * 归零回引导态；合法 id 保留并显示空间名；空列表灰字 noWorkspace 不写
 * store；点击胶囊打开 WorkspacePickerMenu 下拉（下拉交互见
 * workspace-picker-menu.test.tsx）。权限胶囊已随工具栏对齐迁入
 * NewTaskInputCard（用例见 new-task-toolbars.test.tsx）。i18n t mock 直返
 * key；useQuery mock 仅 data（ContextBar/下拉只消费 data）。
 */
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// vitest.config 未开 globals,RTL 自动清理不生效,手动注册（同
// tests/ai/new-task-toolbars.test.tsx）
afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
// cn 依赖 @/i18n 实例（WorkspacePickerMenu→Popover→cn），最小桩避免拉起
// 完整 i18n 栈
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
// 用例可覆写的查询返回（仅 data——ContextBar/下拉只消费 data）；
// WorkspacePickerMenu 还用 useQueryClient（invalidateQueries）
const { queryData, invalidateMock } = vi.hoisted(() => ({
  queryData: {
    data: [
      { id: 1, name: "个人空间" },
      { id: 2, name: "项目组A" },
    ],
  },
  invalidateMock: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryData,
  useQueryClient: () => ({ invalidateQueries: invalidateMock }),
}));
// localStorage stub:store 配置 setter 手写持久化,测试环境无原生 localStorage
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => void memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

import ContextBar from "@/domains/ai/new-task/components/ContextBar";
import { useNewTaskStore } from "@/domains/ai/new-task/store/new-task-store";

const DEFAULT_WORKSPACES = [
  { id: 1, name: "个人空间" },
  { id: 2, name: "项目组A" },
];

describe("ContextBar（工作空间显式选择）", () => {
  beforeEach(() => {
    queryData.data = DEFAULT_WORKSPACES;
    // resetDraft 不清三配置；显式回未选态（引导态）
    useNewTaskStore.getState().resetDraft();
    useNewTaskStore.getState().setWorkspaceId(null);
  });

  it("未选空间不自动跟随第一个：保持 null，胶囊显示引导态", () => {
    render(<ContextBar />);
    expect(useNewTaskStore.getState().workspaceId).toBeNull();
    // 引导态文案 = context.workspace（"选择工作空间"）
    expect(screen.getByText("newTask:context.workspace")).toBeTruthy();
  });

  it("持久化脏 id（列表已无此空间）归零回引导态", async () => {
    useNewTaskStore.getState().setWorkspaceId(99);
    render(<ContextBar />);
    await waitFor(() =>
      expect(useNewTaskStore.getState().workspaceId).toBeNull(),
    );
    expect(screen.getByText("newTask:context.workspace")).toBeTruthy();
  });

  it("合法持久化 id 保留：胶囊显示空间名", () => {
    useNewTaskStore.getState().setWorkspaceId(2);
    render(<ContextBar />);
    expect(useNewTaskStore.getState().workspaceId).toBe(2);
    expect(screen.getByText("项目组A")).toBeTruthy();
  });

  it("空列表显示无工作空间灰字且不写 store", () => {
    queryData.data = [];
    render(<ContextBar />);
    expect(screen.getByText("newTask:context.noWorkspace")).toBeTruthy();
    expect(useNewTaskStore.getState().workspaceId).toBeNull();
  });

  it("点击胶囊打开工作空间选择下拉（搜索框出现）", async () => {
    render(<ContextBar />);
    fireEvent.click(
      screen.getByRole("button", { name: "newTask:context.workspace" }),
    );
    // Radix Popover 打开（面板内搜索框 aria-label 判据）
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", {
          name: "newTask:context.searchWorkspace",
        }),
      ).toBeTruthy(),
    );
    // 列表项与新建/打开本地入口同时渲染
    expect(screen.getByText("项目组A")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "newTask:context.newWorkspace" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "newTask:context.openLocal" }),
    ).toBeTruthy();
  });
});
