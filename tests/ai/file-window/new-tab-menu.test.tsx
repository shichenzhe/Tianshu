// @vitest-environment jsdom
/**
 * NewTabMenu（+ 菜单，Task 15）：新建 Markdown/文本（唯一名 workspace:
 * writeFile 空内容 + openTab + baselineMtime 落库；终审 I2：expectNotExists
 * 撞磁盘既有同名 FILE_EXISTS → 换名 n+2 重试一次，仍冲突 toast 放弃）、
 * 无可用空间禁用+提示、
 * 打开文件（fileWindow:pickFile 相对路径数组逐个 openTab）、最近打开
 * （recentOf 渲染点击 openTab）。网址 tab 已废止（spec §13 项 2）：菜单
 * 无「打开网址」项。recent-files：pushRecent 去重置顶 + 上限 10 + 旧
 * localStorage 残留 url 条目过滤。
 * mock 骨架同 tests/ai/file-window/file-window-view.test.tsx（部分 mock
 * i18n：Button/Input→@/lib/utils→@/i18n 链需 react-i18next 真实导出）；
 * Radix DropdownMenu jsdom 桩同 tests/project/tasks-pane.test.tsx
 * （ResizeObserver/pointerCapture）；localStorage 内存 stub 同 view 测试。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

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

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

// localStorage stub：与 file-window-view.test.tsx 同款内存 stub（recent
// 最近打开持久化读写经组件传递依赖）
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

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src-react/lib/ipc", () => ({ invoke: invokeMock }));

import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";
import NewTabMenu from "../../../src-react/domains/ai/file-window/components/NewTabMenu";
import {
  pushRecent,
  recentOf,
} from "../../../src-react/domains/ai/file-window/lib/recent-files";

/** pointerDown 展开 + 菜单就位（tasks-pane pickMenuItem 同款） */
async function openMenu() {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "chat:fileWindow.tab.new" }),
    { button: 0, ctrlKey: false, pointerType: "mouse" },
  );
  await screen.findByRole("menu");
}

const workspacePaths = () =>
  useFileWindowStore
    .getState()
    .tabs.filter((t) => t.resource.kind === "workspace")
    .map((t) => (t.resource as { path: string }).path);

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
  useFileWindowStore.getState().reset();
  localStorage.clear();
});

describe("NewTabMenu", () => {
  it("新建 Markdown：唯一名写入 workspace 并开 tab（baselineMtime 落库）", async () => {
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "workspace:writeFile")
        return { absPath: "/ws/未命名-1.md", mtime: 123 };
      if (ch === "workspace:list") return [{ id: 7, directoryPath: "/ws" }];
      return null;
    });
    useFileWindowStore
      .getState()
      .openTab({ kind: "workspace", workspaceId: 7, path: "seed.md" });
    render(<NewTabMenu />);
    await openMenu();
    fireEvent.click(screen.getByText("chat:fileWindow.file.newMarkdown"));
    await waitFor(() => {
      const call = invokeMock.mock.calls.find(
        (c) => c[0] === "workspace:writeFile",
      );
      expect(call?.[1]).toMatchObject({
        workspaceId: 7,
        path: "未命名-1.md",
        content: "",
        baselineMtime: null,
        expectNotExists: true,
      });
    });
    await waitFor(() =>
      expect(useFileWindowStore.getState().tabs).toHaveLength(2),
    );
    const created = useFileWindowStore
      .getState()
      .tabs.find(
        (t) => (t.resource as { path: string }).path === "未命名-1.md",
      );
    expect(created?.baselineMtime).toBe(123);
  });

  it("新建撞磁盘既有同名（终审 I2）：FILE_EXISTS → 换名 n+2 重试成功开 tab", async () => {
    let writeCount = 0;
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "workspace:writeFile") {
        // 首选 未命名-1 撞名拒绝（探测仅扫本窗 tabs，磁盘既有不可见）
        if (writeCount++ === 0) return Promise.reject(new Error("FILE_EXISTS"));
        return { absPath: "/ws/未命名-2.md", mtime: 9 };
      }
      if (ch === "workspace:list") return [{ id: 7, directoryPath: "/ws" }];
      return null;
    });
    // seed 空间 tab（无 未命名-N 标题 → 首选 未命名-1）
    useFileWindowStore
      .getState()
      .openTab({ kind: "workspace", workspaceId: 7, path: "seed.md" });
    render(<NewTabMenu />);
    await openMenu();
    fireEvent.click(screen.getByText("chat:fileWindow.file.newMarkdown"));
    await waitFor(() =>
      expect(workspacePaths()).toEqual(["seed.md", "未命名-2.md"]),
    );
    const writes = invokeMock.mock.calls.filter(
      (c) => c[0] === "workspace:writeFile",
    );
    expect(writes).toHaveLength(2);
    expect(writes[0]?.[1]).toMatchObject({
      path: "未命名-1.md",
      expectNotExists: true,
    });
    expect(writes[1]?.[1]).toMatchObject({
      path: "未命名-2.md",
      expectNotExists: true,
    });
    // 换名成功后基线回填
    expect(
      useFileWindowStore
        .getState()
        .tabs.find(
          (t) => (t.resource as { path: string }).path === "未命名-2.md",
        )?.baselineMtime,
    ).toBe(9);
  });

  it("重试仍撞名 → toast 报错放弃（不开 tab，不覆写磁盘）", async () => {
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "workspace:writeFile")
        return Promise.reject(new Error("FILE_EXISTS"));
      if (ch === "workspace:list") return [{ id: 7, directoryPath: "/ws" }];
      return null;
    });
    useFileWindowStore
      .getState()
      .openTab({ kind: "workspace", workspaceId: 7, path: "seed.md" });
    render(<NewTabMenu />);
    await openMenu();
    fireEvent.click(screen.getByText("chat:fileWindow.file.newText"));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("chat:errors.FILE_EXISTS"),
    );
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "workspace:writeFile"),
    ).toHaveLength(2); // 首选 + 换名各一次，之后放弃
    expect(workspacePaths()).toEqual(["seed.md"]);
  });

  it("唯一名探测：已有 未命名-2 占位时新建文本得 未命名-3.txt", async () => {
    invokeMock.mockImplementation((ch: string) =>
      ch === "workspace:writeFile"
        ? { absPath: "/ws/x", mtime: 1 }
        : ch === "workspace:list"
          ? [{ id: 7, directoryPath: "/ws" }]
          : null,
    );
    useFileWindowStore
      .getState()
      .openTab({ kind: "workspace", workspaceId: 7, path: "未命名-2.md" });
    render(<NewTabMenu />);
    await openMenu();
    fireEvent.click(screen.getByText("chat:fileWindow.file.newText"));
    await waitFor(() => expect(workspacePaths()).toContain("未命名-3.txt"));
  });

  it("无可用工作空间（无 workspace tab 且 list 无绑定空间）：新建/打开禁用 + 提示", async () => {
    invokeMock.mockImplementation((ch: string) =>
      ch === "workspace:list" ? [] : null,
    );
    render(<NewTabMenu />);
    await openMenu();
    const item = screen
      .getByText("chat:fileWindow.file.newMarkdown")
      .closest('[role="menuitem"]');
    expect(item?.getAttribute("data-disabled")).toBe("");
    expect(
      screen
        .getByText("chat:fileWindow.file.openFile")
        .closest('[role="menuitem"]')
        ?.getAttribute("data-disabled"),
    ).toBe("");
    expect(screen.getByText("chat:fileWindow.file.needWorkspace")).toBeTruthy();
    fireEvent.click(screen.getByText("chat:fileWindow.file.newMarkdown"));
    expect(
      invokeMock.mock.calls.some((c) => c[0] === "workspace:writeFile"),
    ).toBe(false);
  });

  it("打开文件：pickFile 返回相对路径数组逐个 openTab", async () => {
    invokeMock.mockImplementation((ch: string) =>
      ch === "fileWindow:pickFile" ? ["b.md", "sub/c.txt"] : null,
    );
    useFileWindowStore
      .getState()
      .openTab({ kind: "workspace", workspaceId: 7, path: "a.md" });
    render(<NewTabMenu />);
    await openMenu();
    fireEvent.click(screen.getByText("chat:fileWindow.file.openFile"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("fileWindow:pickFile", {
        workspaceId: 7,
      }),
    );
    await waitFor(() =>
      expect(workspacePaths()).toEqual(["a.md", "b.md", "sub/c.txt"]),
    );
  });

  it("最近打开：渲染 recentOf 条目，点击 openTab 去重打开", async () => {
    pushRecent({ kind: "library", itemId: 3 });
    pushRecent({ kind: "workspace", workspaceId: 7, path: "a.md" });
    render(<NewTabMenu />);
    await openMenu();
    // 条目标题 = titleOfResource（workspace→basename / library→#itemId）
    fireEvent.click(screen.getByText("a.md"));
    await waitFor(() => expect(workspacePaths()).toEqual(["a.md"]));
  });

  it("网址 tab 已废止（spec §13 项 2）：菜单不出现「打开网址」项", async () => {
    render(<NewTabMenu />);
    await openMenu();
    expect(screen.queryByText("chat:fileWindow.file.openUrl")).toBeNull();
  });
});

describe("recent-files", () => {
  it("pushRecent 去重置顶", () => {
    pushRecent({ kind: "workspace", workspaceId: 7, path: "a.md" });
    pushRecent({ kind: "workspace", workspaceId: 7, path: "a.md" });
    pushRecent({ kind: "workspace", workspaceId: 7, path: "b.md" });
    expect(recentOf()[0]).toEqual({
      kind: "workspace",
      workspaceId: 7,
      path: "b.md",
    });
    expect(recentOf()).toHaveLength(2);
  });

  it("超上限 10 条截尾（最旧的挤掉）", () => {
    for (let i = 1; i <= 12; i++)
      pushRecent({ kind: "workspace", workspaceId: 7, path: `f${i}.md` });
    const recent = recentOf();
    expect(recent).toHaveLength(10);
    expect(recent[0]).toEqual({
      kind: "workspace",
      workspaceId: 7,
      path: "f12.md",
    });
    expect(
      recent.some((r) => r.kind === "workspace" && r.path === "f1.md"),
    ).toBe(false);
  });

  it("损坏数据兜底空数组（不抛错）", () => {
    localStorage.setItem("tianshu-file-window-recent", "{oops");
    expect(recentOf()).toEqual([]);
    pushRecent({ kind: "workspace", workspaceId: 7, path: "a.md" });
    expect(recentOf()).toHaveLength(1);
  });

  it("旧 localStorage 残留 url 条目读取时丢弃（spec §13 项 2）", () => {
    localStorage.setItem(
      "tianshu-file-window-recent",
      JSON.stringify([
        { kind: "url", url: "https://t.cn" },
        { kind: "workspace", workspaceId: 7, path: "a.md" },
        { kind: "weird" },
      ]),
    );
    expect(recentOf()).toEqual([
      { kind: "workspace", workspaceId: 7, path: "a.md" },
    ]);
  });
});
