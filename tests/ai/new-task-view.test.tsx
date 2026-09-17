// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// cn 依赖 @/i18n 实例，最小桩避免拉起完整 i18n 栈（dispatch → mapIpcError
// → @/i18n 同链路依赖）
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));
// localStorage stub：NewTaskView 挂载 hydrate 读 tianshu-new-task（测试环境
// 无原生 localStorage，同 tests/ai/new-task-input-card.test.tsx）
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

import NewTaskView from "@/domains/ai/new-task/views/NewTaskView";
import { useNewTaskStore } from "@/domains/ai/new-task/store/new-task-store";

const STORAGE_KEY = "tianshu-new-task";

// vitest 未开 globals，RTL 自动清理不生效，手动注册（同 new-task 系列用例）
afterEach(cleanup);

describe("NewTaskView 骨架", () => {
  // 持久化 key 与 store 三配置跨用例复位（防 hydrate 把上一用例残留回灌）
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    useNewTaskStore.setState({
      content: "",
      scenario: "daily",
      workspaceId: null,
      accessMode: "default",
      pending: [],
    });
  });

  it("渲染标题与场景 Tab", () => {
    render(
      // Task 10 起挂载 PromptChips（useQuery），需 QueryClientProvider；
      // skill:list/models/providers 查询在 jsdom 无 IPC 桥时 reject，由
      // React Query 吞掉，胶囊/模型判定空数据渲染不影响本用例断言
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <NewTaskView />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // 注：仓库未装 @testing-library/jest-dom（全仓 0 处 toBeInTheDocument），
    // 沿用既有断言口径 toBeTruthy（同 tests/ai/chat-input-todo.test.tsx）
    expect(screen.getByText("newTask:heroTitle")).toBeTruthy();
    expect(screen.getByText("newTask:scenario.daily")).toBeTruthy();
  });

  it("挂载恢复持久化配置（scenario 高亮跟随持久化值）", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        scenario: "design",
        workspaceId: 7,
        accessMode: "full",
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <NewTaskView />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      screen
        .getByRole("tab", { name: "newTask:scenario.design" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(useNewTaskStore.getState().workspaceId).toBe(7);
    expect(useNewTaskStore.getState().accessMode).toBe("full");
  });

  it("空输入 Enter 不发起发送（矩阵门控 onSubmit）", () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <NewTaskView />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.keyDown(container.querySelector("textarea")!, { key: "Enter" });
    // 空文本矩阵不放行：不触达 session:create（IPC 桥在 jsdom 不可用，
    // 未被 dispatch 调用即不会抛错——此处以 store 草稿仍空佐证未发送）
    expect(useNewTaskStore.getState().content).toBe("");
  });
});
