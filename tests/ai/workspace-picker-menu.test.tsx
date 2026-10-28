// tests/ai/workspace-picker-menu.test.tsx
// @vitest-environment jsdom
/**
 * 工作空间选择下拉（修订 spec 裁定 11：显式选择）：点击胶囊弹出 Popover
 * 下拉——搜索按名称/目录过滤、无匹配空态 noMatch；点击行即写 store 并
 * 关闭（无二次确认）；分割线下「+ 新建空间」弹名称对话框（创建 →
 * invalidate → 自动选中新空间，取消不动）与「打开本地空间」（成功选中、
 * 取消 null 静默、失败 toast）。i18n t mock 直返 key；useQuery mock 仅
 * data；WorkspaceApi/sonner mock。
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
// tests/ai/new-task-context-bar.test.tsx）
afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
// cn 依赖 @/i18n 实例（Popover/Dialog→cn），最小桩避免拉起完整 i18n 栈
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
const { queryData, invalidateMock, createMock, openLocalMock, toastErrorMock } =
  vi.hoisted(() => ({
    queryData: { data: [] as unknown[] },
    invalidateMock: vi.fn(),
    createMock: vi.fn(),
    openLocalMock: vi.fn(),
    toastErrorMock: vi.fn(),
  }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryData,
  useQueryClient: () => ({ invalidateQueries: invalidateMock }),
}));
vi.mock("@/domains/ai/api/workspace.api", () => ({
  default: { list: vi.fn(), create: createMock, openLocal: openLocalMock },
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
vi.mock("sonner", () => ({ toast: { error: toastErrorMock } }));

import WorkspacePickerMenu from "@/domains/ai/new-task/components/WorkspacePickerMenu";
import { useNewTaskStore } from "@/domains/ai/new-task/store/new-task-store";

const WORKSPACES = [
  { id: 1, name: "个人空间", directoryPath: "/Users/me/home" },
  { id: 2, name: "项目组A" },
];

/** 触发胶囊：未选态文案为引导 key，已选态为空间名 */
function trigger(): HTMLElement {
  return screen.getByRole("button", {
    name: /个人空间|newTask:context\.workspace/,
  });
}

/** 打开下拉并等列表首项出现 */
async function openMenu(): Promise<void> {
  fireEvent.click(trigger());
  await waitFor(() => expect(screen.getByText("项目组A")).toBeTruthy());
}

/** 面板内搜索框（不存在时返回 null，供存在性断言） */
function searchBox(): HTMLElement | null {
  return screen.queryByRole("textbox", {
    name: "newTask:context.searchWorkspace",
  });
}

describe("WorkspacePickerMenu", () => {
  beforeEach(() => {
    queryData.data = WORKSPACES;
    invalidateMock.mockClear();
    createMock.mockReset();
    openLocalMock.mockReset();
    toastErrorMock.mockClear();
    useNewTaskStore.getState().resetDraft();
    useNewTaskStore.getState().setWorkspaceId(null);
  });

  it("点击行即写 store 并关闭（无二次确认）；当前选中行带 Check", async () => {
    useNewTaskStore.getState().setWorkspaceId(1);
    render(<WorkspacePickerMenu />);
    await openMenu();
    fireEvent.click(screen.getByText("项目组A"));
    expect(useNewTaskStore.getState().workspaceId).toBe(2);
    // 菜单关闭（搜索框随之消失）
    await waitFor(() => expect(searchBox()).toBeNull());
  });

  it("搜索按名称/目录过滤；无匹配显示空态", async () => {
    render(<WorkspacePickerMenu />);
    await openMenu();
    fireEvent.change(searchBox(), { target: { value: "项目" } });
    expect(screen.queryByText("个人空间")).toBeNull();
    expect(screen.getByText("项目组A")).toBeTruthy();
    // 目录路径也可命中
    fireEvent.change(searchBox(), { target: { value: "/home" } });
    expect(screen.getByText("个人空间")).toBeTruthy();
    expect(screen.queryByText("项目组A")).toBeNull();
    fireEvent.change(searchBox(), { target: { value: "不存在" } });
    expect(screen.getByText("newTask:context.noMatch")).toBeTruthy();
  });

  it("「+ 新建空间」：名称对话框创建后 invalidate 并自动选中新空间", async () => {
    createMock.mockResolvedValue({ id: 3, name: "新空间" });
    render(<WorkspacePickerMenu />);
    await openMenu();
    fireEvent.click(
      screen.getByRole("button", { name: "newTask:context.newWorkspace" }),
    );
    // 菜单关闭、名称对话框打开且焦点默认落在输入框
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(searchBox()).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByLabelText("ai:provider.name"),
    );
    fireEvent.change(screen.getByLabelText("ai:provider.name"), {
      target: { value: "新空间" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common:confirm" }));
    await waitFor(() => expect(useNewTaskStore.getState().workspaceId).toBe(3));
    expect(createMock).toHaveBeenCalledWith({ name: "新空间" });
    expect(invalidateMock).toHaveBeenCalledWith({
      queryKey: ["workspaces"],
    });
    // 对话框关闭
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("新建对话框取消不创建、不动 store", async () => {
    render(<WorkspacePickerMenu />);
    await openMenu();
    fireEvent.click(
      screen.getByRole("button", { name: "newTask:context.newWorkspace" }),
    );
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "common:cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(createMock).not.toHaveBeenCalled();
    expect(useNewTaskStore.getState().workspaceId).toBeNull();
  });

  it("「打开本地空间」成功：invalidate 并选中返回空间", async () => {
    openLocalMock.mockResolvedValue({ id: 5, name: "local-dir" });
    render(<WorkspacePickerMenu />);
    await openMenu();
    fireEvent.click(
      screen.getByRole("button", { name: "newTask:context.openLocal" }),
    );
    await waitFor(() => expect(useNewTaskStore.getState().workspaceId).toBe(5));
    expect(invalidateMock).toHaveBeenCalledWith({
      queryKey: ["workspaces"],
    });
  });

  it("「打开本地空间」取消（null）静默：不动 store 无 toast", async () => {
    openLocalMock.mockResolvedValue(null);
    render(<WorkspacePickerMenu />);
    await openMenu();
    fireEvent.click(
      screen.getByRole("button", { name: "newTask:context.openLocal" }),
    );
    await waitFor(() => expect(openLocalMock).toHaveBeenCalled());
    expect(useNewTaskStore.getState().workspaceId).toBeNull();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("「打开本地空间」失败：toast 且不动 store", async () => {
    openLocalMock.mockRejectedValue(new Error("disk"));
    render(<WorkspacePickerMenu />);
    await openMenu();
    fireEvent.click(
      screen.getByRole("button", { name: "newTask:context.openLocal" }),
    );
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(useNewTaskStore.getState().workspaceId).toBeNull();
  });
});
