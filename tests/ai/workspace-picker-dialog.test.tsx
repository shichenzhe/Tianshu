// tests/ai/workspace-picker-dialog.test.tsx
// @vitest-environment jsdom
/**
 * 工作空间选择弹框（修订 spec 裁定 11）：打开以当前 workspaceId 播种选中
 * 态；点击行仅置选中高亮不写 store；确定才写 store 并回调关闭；取消不动
 * store；未选时确定禁用；搜索按名称/目录过滤，无匹配空态 noMatch。
 * i18n t mock 直返 key；useQuery mock 仅 data。
 */
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// vitest.config 未开 globals,RTL 自动清理不生效,手动注册（同
// tests/ai/new-task-context-bar.test.tsx）
afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
// cn 依赖 @/i18n 实例（Dialog→cn），最小桩避免拉起完整 i18n 栈
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
const { queryData } = vi.hoisted(() => ({
  queryData: {
    data: [
      { id: 1, name: "个人空间", directoryPath: "/Users/me/home" },
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

import WorkspacePickerDialog from "@/domains/ai/new-task/components/WorkspacePickerDialog";
import { useNewTaskStore } from "@/domains/ai/new-task/store/new-task-store";

const WORKSPACES = [
  { id: 1, name: "个人空间", directoryPath: "/Users/me/home" },
  { id: 2, name: "项目组A" },
];

/** 行按钮（role=radio；名称含空间名，个人空间行含目录路径） */
function row(name: string | RegExp): HTMLElement {
  return screen.getByRole("radio", { name }) as HTMLElement;
}

describe("WorkspacePickerDialog", () => {
  const onOpenChange = vi.fn();

  beforeEach(() => {
    queryData.data = WORKSPACES;
    onOpenChange.mockClear();
    useNewTaskStore.getState().resetDraft();
    useNewTaskStore.getState().setWorkspaceId(1);
  });

  it("打开播种当前选择；点击行仅切选中不写 store", () => {
    render(<WorkspacePickerDialog open onOpenChange={onOpenChange} />);
    expect(row(/个人空间/).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(row("项目组A"));
    expect(row("项目组A").getAttribute("aria-checked")).toBe("true");
    expect(row(/个人空间/).getAttribute("aria-checked")).toBe("false");
    // 未确定：store 不动
    expect(useNewTaskStore.getState().workspaceId).toBe(1);
  });

  it("确定写 store 并回调关闭", () => {
    render(<WorkspacePickerDialog open onOpenChange={onOpenChange} />);
    fireEvent.click(row("项目组A"));
    fireEvent.click(screen.getByRole("button", { name: "common:confirm" }));
    expect(useNewTaskStore.getState().workspaceId).toBe(2);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("取消不动 store，仅回调关闭", () => {
    render(<WorkspacePickerDialog open onOpenChange={onOpenChange} />);
    fireEvent.click(row("项目组A"));
    fireEvent.click(screen.getByRole("button", { name: "common:cancel" }));
    expect(useNewTaskStore.getState().workspaceId).toBe(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("未选时确定禁用，选择后启用", () => {
    useNewTaskStore.getState().setWorkspaceId(null);
    render(<WorkspacePickerDialog open onOpenChange={onOpenChange} />);
    const confirm = screen.getByRole("button", {
      name: "common:confirm",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(row("项目组A"));
    expect(confirm.disabled).toBe(false);
  });

  it("搜索按名称/目录过滤；无匹配显示空态", () => {
    render(<WorkspacePickerDialog open onOpenChange={onOpenChange} />);
    const search = screen.getByRole("textbox", {
      name: "newTask:context.searchWorkspace",
    });
    fireEvent.change(search, { target: { value: "项目" } });
    expect(screen.queryByRole("radio", { name: /个人空间/ })).toBeNull();
    expect(row("项目组A")).toBeTruthy();
    // 目录路径也可命中
    fireEvent.change(search, { target: { value: "/home" } });
    expect(row(/个人空间/)).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "项目组A" })).toBeNull();
    fireEvent.change(search, { target: { value: "不存在" } });
    expect(screen.getByText("newTask:context.noMatch")).toBeTruthy();
  });
});
