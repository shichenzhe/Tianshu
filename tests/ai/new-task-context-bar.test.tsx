// tests/ai/new-task-context-bar.test.tsx
// @vitest-environment jsdom
/**
 * 新建任务配置栏（Task 13）：工作空间下拉（默认跟随列表第一个 + 切换写
 * store）与权限下拉两档（standard 直写 default；full 开 FullAccessModal，
 * 勾选免责后确认才写 full）。i18n t mock 直返 key；Radix DropdownMenu 经
 * pointerDown+click 开菜单（同 tests/ai/new-task-toolbars.test.tsx:57）；
 * FullAccessModal 确认钮 disabled={!acknowledged}，需先勾选免责再确认。
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
// cn 依赖 @/i18n 实例（DropdownMenu/AlertDialog→cn），最小桩避免拉起完整 i18n 栈
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
// 用例可覆写的查询返回（仅 data——ContextBar 只消费 data）
const { queryData } = vi.hoisted(() => ({
  queryData: {
    data: [
      { id: 1, name: "个人空间" },
      { id: 2, name: "项目组A" },
    ],
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryData,
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

/** Radix DropdownMenuTrigger 经 pointerDown(主键)+click 打开后等首项出现 */
async function openMenu(
  triggerLabel: string,
  firstItemText: string,
): Promise<void> {
  const trigger = screen.getByRole("button", { name: triggerLabel });
  fireEvent.pointerDown(trigger, { button: 0 });
  fireEvent.click(trigger);
  await waitFor(() => {
    expect(screen.getByText(firstItemText)).toBeTruthy();
  });
}

describe("ContextBar", () => {
  beforeEach(() => {
    queryData.data = DEFAULT_WORKSPACES;
    // resetDraft 不清三配置；显式回首次进入态（workspaceId=null 触发默认兜底）
    useNewTaskStore.getState().resetDraft();
    useNewTaskStore.getState().setWorkspaceId(null);
  });

  it("默认选第一个工作空间；切换写 store", async () => {
    render(<ContextBar />);
    await waitFor(() => expect(useNewTaskStore.getState().workspaceId).toBe(1));
    await openMenu("个人空间", "项目组A");
    fireEvent.click(screen.getByText("项目组A"));
    expect(useNewTaskStore.getState().workspaceId).toBe(2);
  });

  it("选高危弹 FullAccessModal，确认后写 full", async () => {
    render(<ContextBar />);
    await openMenu("newTask:context.standard", "newTask:context.full");
    fireEvent.click(screen.getByText("newTask:context.full"));
    // 免责勾选后确认钮才可用（确认钮文案为 chat:permission.confirmFullAccess）
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /确认|confirm/i }));
    expect(useNewTaskStore.getState().accessMode).toBe("full");
  });

  it("空列表显示无工作空间灰字且不写 store", () => {
    queryData.data = [];
    render(<ContextBar />);
    expect(screen.getByText("newTask:context.noWorkspace")).toBeTruthy();
    expect(useNewTaskStore.getState().workspaceId).toBeNull();
  });
});
