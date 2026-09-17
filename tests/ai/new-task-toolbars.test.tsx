// tests/ai/new-task-toolbars.test.tsx
// @vitest-environment jsdom
/**
 * 新建任务输入卡工具栏测试：PolishButton（通用润色单按钮）、QuickMenu
 * （快捷指令 + 已启用技能）、AttachMenu（PlusMenu 对齐菜单）与字数阈值
 * （1800 显示 / 2000 截断提示）。i18n t mock 直返 key（quick.*.label 渲染 /
 * quick.*.prompt 填入文本，词条为 {label,prompt} 对象结构）；Radix
 * DropdownMenu 经 pointerDown+click 开菜单（同 tests/ai/plus-menu.test.tsx:64）。
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
// tests/ai/new-task-input-card.test.tsx）
afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
// cn 依赖 @/i18n 实例（DropdownMenu→cn），最小桩避免拉起完整 i18n 栈
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));
const { invokeMock, navigateMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  navigateMock: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({ invoke: invokeMock }));
vi.mock("react-router-dom", () => ({ useNavigate: () => navigateMock }));
// SkillImportDialog 拖入较重依赖，mock 为空组件（同 plus-menu.test.tsx）
vi.mock("@/domains/ai/skills/components/SkillImportDialog", () => ({
  default: () => null,
}));
// useQuery 按 queryKey 分流：QuickMenu/SkillSubMenu 走 skillRecords，
// AttachMenu→ExpertSubMenu 走 assistants；QueryClient 仅失效缓存 mock 空操作
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) =>
    queryKey[0] === "assistants"
      ? { data: [{ id: 7, name: "Al", icon: null }] }
      : { data: [{ name: "s1", enabled: true, scenarios: null }] },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
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

import { toast } from "sonner";
import PolishButton from "@/domains/ai/new-task/components/polish-button";
import QuickMenu from "@/domains/ai/new-task/components/QuickMenu";
import AttachMenu from "@/domains/ai/new-task/components/AttachMenu";
import NewTaskInputCard from "@/domains/ai/new-task/components/NewTaskInputCard";
import { useNewTaskStore } from "@/domains/ai/new-task/store/new-task-store";

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

describe("PolishButton", () => {
  /** 润色触发钮（aria-label = newTask:polish.title） */
  function polishButton(): HTMLButtonElement {
    return screen.getByRole("button", {
      name: "newTask:polish.title",
    }) as HTMLButtonElement;
  }

  beforeEach(() => {
    invokeMock.mockReset();
    vi.mocked(toast.error).mockClear();
    useNewTaskStore.getState().resetDraft();
    useNewTaskStore.getState().setWorkspaceId(2);
  });

  it("点击即以通用风格润色并替换文本（无下拉）", async () => {
    useNewTaskStore.getState().setContent("draft");
    invokeMock.mockResolvedValue({ text: "better" });
    render(<PolishButton />);
    fireEvent.click(polishButton());
    await waitFor(() =>
      expect(useNewTaskStore.getState().content).toBe("better"),
    );
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith("chat:polish", {
      workspaceId: 2,
      text: "draft",
      style: "professional",
    });
  });

  it("润色中按钮转圈禁点，完成后恢复可点", async () => {
    useNewTaskStore.getState().setContent("draft");
    let resolve!: (v: { text: string }) => void;
    invokeMock.mockImplementation(
      () =>
        new Promise<{ text: string }>((r) => {
          resolve = r;
        }),
    );
    render(<PolishButton />);
    const button = polishButton();
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    resolve({ text: "better" });
    await waitFor(() =>
      expect(useNewTaskStore.getState().content).toBe("better"),
    );
    expect(polishButton().disabled).toBe(false);
  });

  it("空文本点击不发请求", async () => {
    invokeMock.mockResolvedValue({ text: "better" });
    render(<PolishButton />);
    fireEvent.click(polishButton());
    await waitFor(() => expect(useNewTaskStore.getState().content).toBe(""));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("润色失败 toast 且原文不动", async () => {
    useNewTaskStore.getState().setContent("draft");
    invokeMock.mockRejectedValue(new Error("boom"));
    render(<PolishButton />);
    fireEvent.click(polishButton());
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("newTask:polish.failed"),
    );
    expect(useNewTaskStore.getState().content).toBe("draft");
    expect(polishButton().disabled).toBe(false);
  });

  it("未绑工作空间不发请求，toast 提示", async () => {
    useNewTaskStore.getState().setWorkspaceId(null);
    useNewTaskStore.getState().setContent("draft");
    render(<PolishButton />);
    fireEvent.click(polishButton());
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("newTask:context.noWorkspace"),
    );
    expect(invokeMock).not.toHaveBeenCalled();
    expect(useNewTaskStore.getState().content).toBe("draft");
  });
});

describe("QuickMenu", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useNewTaskStore.getState().resetDraft();
  });

  it("快捷指令点击填模板；技能点击加 pending", async () => {
    render(<QuickMenu />);
    await openMenu("newTask:quick.title", "newTask:quick.summarize.label");
    fireEvent.click(screen.getByText("newTask:quick.summarize.label"));
    expect(useNewTaskStore.getState().content).toContain(
      "newTask:quick.summarize.prompt",
    );
    // Radix 项点击后关菜单，技能项需重开再点
    await openMenu("newTask:quick.title", "newTask:quick.summarize.label");
    fireEvent.click(screen.getByText("s1"));
    expect(useNewTaskStore.getState().pending[0].ref).toBe("s1");
    expect(useNewTaskStore.getState().pending[0]).toMatchObject({
      label: "s1",
      ref: "s1",
      kind: "skill",
    });
  });
});

describe("AttachMenu（PlusMenu 对齐）", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    navigateMock.mockReset();
    useNewTaskStore.getState().resetDraft();
    useNewTaskStore.getState().setWorkspaceId(2);
  });

  it("菜单六项齐备：文件两项 + 模式/专家/技能 + 连接器（无历史对话项）", async () => {
    render(<AttachMenu />);
    await openMenu("newTask:attach.title", "chat:plus.addFile");
    expect(screen.getByText("newTask:attach.workspaceFile")).toBeTruthy();
    expect(screen.queryByText("newTask:attach.historyChat")).toBeNull();
    expect(screen.getByText("chat:plus.mode")).toBeTruthy();
    expect(screen.getByText("chat:plus.expert")).toBeTruthy();
    expect(screen.getByText("chat:plus.skill")).toBeTruthy();
    expect(screen.getByText("chat:plus.connector")).toBeTruthy();
  });

  it("模式子菜单：选中写草稿 store（不碰 IPC）", async () => {
    render(<AttachMenu />);
    await openMenu("newTask:attach.title", "chat:plus.addFile");
    fireEvent.pointerMove(screen.getByText("chat:plus.mode"), {
      pointerType: "mouse",
    });
    await waitFor(() =>
      expect(screen.getByText("chat:plus.modePlan")).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("chat:plus.modePlan"));
    expect(useNewTaskStore.getState().mode).toBe("plan");
    expect(
      invokeMock.mock.calls.filter((c) => c[0].startsWith("session:")),
    ).toHaveLength(0);
  });

  it("专家面板：选中写草稿 store（onPick 模式不写会话）", async () => {
    render(<AttachMenu />);
    await openMenu("newTask:attach.title", "chat:plus.addFile");
    fireEvent.pointerMove(screen.getByText("chat:plus.expert"), {
      pointerType: "mouse",
    });
    await waitFor(() => expect(screen.getByText("Al")).toBeTruthy());
    fireEvent.click(screen.getByText("Al"));
    expect(useNewTaskStore.getState().assistantId).toBe(7);
    expect(invokeMock).not.toHaveBeenCalledWith(
      "session:setAssistant",
      expect.anything(),
      expect.anything(),
    );
  });

  it("连接器项：导航专家页 connectors Tab", async () => {
    render(<AttachMenu />);
    await openMenu("newTask:attach.title", "chat:plus.addFile");
    fireEvent.click(screen.getByText("chat:plus.connector"));
    expect(navigateMock).toHaveBeenCalledWith(
      "/module/ai/experts?tab=connectors",
    );
  });
});

describe("NewTaskInputCard 工具栏与字数", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useNewTaskStore.getState().resetDraft();
    useNewTaskStore.getState().setWorkspaceId(2);
  });

  it("底行挂载 AttachMenu/PolishMenu/QuickMenu/发送", () => {
    render(<NewTaskInputCard />);
    expect(
      screen.getByRole("button", { name: "newTask:attach.title" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "newTask:polish.title" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "newTask:quick.title" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "newTask:send" })).toBeTruthy();
  });

  it("字数 ≤1800 不显示；>1800 显示；≥2000 附截断提示", () => {
    const { container } = render(<NewTaskInputCard />);
    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "a".repeat(1800) } });
    expect(screen.queryByText("newTask:charCount")).toBeNull();
    fireEvent.change(textarea, { target: { value: "a".repeat(1801) } });
    expect(screen.getByText("newTask:charCount")).toBeTruthy();
    expect(screen.queryByText("newTask:truncateHint")).toBeNull();
    fireEvent.change(textarea, { target: { value: "a".repeat(2000) } });
    expect(screen.getByText("newTask:charCount")).toBeTruthy();
    expect(screen.getByText("newTask:truncateHint")).toBeTruthy();
  });
});
