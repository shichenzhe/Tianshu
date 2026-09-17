// tests/ai/new-task-input-card.test.tsx
// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// vitest.config 未开 globals,RTL 自动清理不生效,手动注册（同
// tests/ai/chat-input-todo.test.tsx:152）
afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
// cn 依赖 @/i18n 实例（AttachMenu→dropdown-menu→cn），最小桩避免拉起完整
// i18n 栈（同 tests/ai/new-task-view.test.tsx）
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ invoke: invokeMock }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: [] }) }));
vi.stubGlobal("filePath", {
  getPathForFile: (f: File) => (f as { path?: string }).path ?? f.name,
});
// localStorage stub:与 tests/ai/new-task-store.test.ts 同款内存 stub
// (beforeEach setWorkspaceId 触发 store 手写持久化,本仓库测试环境无原生
// localStorage)
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

import NewTaskInputCard from "@/domains/ai/new-task/components/NewTaskInputCard";
import { useNewTaskStore } from "@/domains/ai/new-task/store/new-task-store";

describe("NewTaskInputCard", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useNewTaskStore.getState().resetDraft();
    useNewTaskStore.getState().setWorkspaceId(2);
  });

  it("@ 触发文件联想面板，选中转 pending pill", async () => {
    invokeMock.mockImplementation((channel: string) => {
      if (channel === "file:listWorkspaceFiles")
        return Promise.resolve(["docs/a.md"]);
      return Promise.resolve([]);
    });
    const { container } = render(<NewTaskInputCard onSubmit={vi.fn()} />);
    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "看 @doc" } });
    fireEvent.keyUp(textarea, { key: "ArrowLeft" });
    const option = await screen.findByText("docs/a.md");
    fireEvent.mouseDown(option);
    const state = useNewTaskStore.getState();
    expect(state.pending).toEqual([
      { label: "docs/a.md", ref: "docs/a.md", kind: "file" },
    ]);
  });

  it("pending pill 的 x 点击移除", async () => {
    useNewTaskStore
      .getState()
      .addPending({ label: "a.md", ref: "docs/a.md", kind: "file" });
    render(<NewTaskInputCard onSubmit={vi.fn()} />);
    fireEvent.click(
      screen
        .getByRole("button", { name: /a\.md/ })
        .querySelector("svg:last-child")!,
    );
    expect(useNewTaskStore.getState().pending).toHaveLength(0);
  });
});
