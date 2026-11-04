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
// AttachMenu 连接器项用 useNavigate（PlusMenu 对齐），mock 掉 Router 依赖；
// SkillImportDialog 拖入较重依赖（useQueryClient 等），mock 为空组件
// （同 tests/ai/new-task-toolbars.test.tsx）
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/domains/ai/skills/components/SkillImportDialog", () => ({
  default: () => null,
}));
// useQuery 按 queryKey 分流：assistants 供专家名徽章，其余（workspace/
// providers/models 等）空；ModelPicker 需 useQueryClient（草稿分支不触
// 达，空操作桩）
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) =>
    queryKey[0] === "assistants"
      ? { data: [{ id: 7, name: "Al", icon: null }] }
      : { data: [] },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
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

/** 发送按钮（aria-label = newTask:send）的 disabled 断言锚点 */
function sendButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: "newTask:send",
  }) as HTMLButtonElement;
}

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

  it("选中态徽章：专家名可清除；非 agent 模式显示模式徽章", () => {
    // + 菜单草稿的选中反馈（ChatInput 底行 assistantName/ASK|PLAN 徽章同形态）
    useNewTaskStore.getState().setAssistantId(7);
    useNewTaskStore.getState().setMode("plan");
    render(<NewTaskInputCard onSubmit={vi.fn()} />);
    expect(screen.getByText("Al")).toBeTruthy();
    expect(screen.getByText("chat:plus.modePlan")).toBeTruthy();
    // 清除专家：X 点击回 null，徽章消失
    fireEvent.click(
      screen.getByRole("button", { name: "newTask:attach.clearExpert" }),
    );
    expect(useNewTaskStore.getState().assistantId).toBeNull();
    expect(screen.queryByText("Al")).toBeNull();
    // 模式徽章不随专家清除变化（plan 仍在）
    expect(screen.getByText("chat:plus.modePlan")).toBeTruthy();
  });

  it("默认草稿（agent/无专家）不渲染徽章", () => {
    render(<NewTaskInputCard onSubmit={vi.fn()} />);
    expect(
      screen.queryByRole("button", { name: "newTask:attach.clearExpert" }),
    ).toBeNull();
    expect(screen.queryByText("chat:plus.modeAgent")).toBeNull();
  });
});

describe("NewTaskInputCard 发送置灰矩阵（spec §6）", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useNewTaskStore.getState().resetDraft();
    useNewTaskStore.getState().setWorkspaceId(2);
  });

  // 内容经 textarea change 驱动（act 事件流，矩阵即时重算）
  it("可用条件齐备启用；敏感词命中禁用并显示提示", () => {
    const { container } = render(
      <NewTaskInputCard onSubmit={vi.fn()} hasUsableModel />,
    );
    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "普通任务" } });
    expect(sendButton().disabled).toBe(false);
    // 敏感词命中：禁用 + 按钮旁提示（t mock 直返 key）
    fireEvent.change(textarea, {
      target: { value: "包含 赌球 的内容" },
    });
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByText("newTask:sensitiveHit")).toBeTruthy();
  });

  it("无可用模型/空文本禁用；矩阵禁用时 Enter 不触发 onSubmit", () => {
    const onSubmit = vi.fn();
    const { container, rerender } = render(
      <NewTaskInputCard onSubmit={onSubmit} hasUsableModel={false} />,
    );
    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "普通任务" } });
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByText("newTask:modelRequired")).toBeTruthy();
    // 空文本禁用（模型可用时）
    rerender(<NewTaskInputCard onSubmit={onSubmit} hasUsableModel />);
    fireEvent.change(textarea, { target: { value: "" } });
    expect(sendButton().disabled).toBe(true);
    // 矩阵禁用（回填敏感词）时 Enter 不触发
    fireEvent.change(textarea, {
      target: { value: "包含 赌球 的内容" },
    });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
