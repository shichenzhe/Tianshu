// @vitest-environment jsdom
/**
 * FileWindowView 组装（T9）：登录守卫（失效跳 /login）、挂载即发
 * close-ready、tab 条（FileWindowTabBar）+ 空窗居中提示；关闭握手
 * 端到端——close-request → CloseConfirmBar（保存并关闭=经注册表保存流
 * 写盘后关 tab/放弃=直接关/取消=cancelClose）、无 dirty 直接 confirmClose。
 * mock 骨架参照 tests/ai/chat/file-preview.test.tsx（部分 mock i18n：
 * FileWindowTabBar→Button→@/lib/utils→@/i18n 链需 react-i18next 真实导出）；
 * user.store mock 按实际导出校正（仅 useUserStore）。FileTabEditor 用真身
 * （text 类=CM6 .cm-content，role=textbox 取；jsdom 无真实击键，本地输入
 * 经 view.dispatch+userEvent 注解模拟，见 cm-test-utils）——⌘S 激活门
 * （全挂载下并发保存防护）须真监听才可测。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

// localStorage stub：与 tests/ai/edit-bar.test.tsx 同款内存 stub（本仓库
// 测试环境无原生 localStorage；T10 右栏 FileChatPanel → usePanelWidth
// 读写面板宽持久化，经视图传递依赖）
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
// T18 起 seed 会话落 tab → FileChatPanel 挂 MessageList → useChatSend 经
// ipc.on 订阅 chat:stream——ipc mock 须提供 on（hoisted 供 stubGlobal 共用）
const listeners = vi.hoisted(
  () => new Map<string, (e: unknown, p: unknown) => void>(),
);
vi.mock("../../../src-react/lib/ipc", () => ({
  invoke: invokeMock,
  on: (ch: string, cb: (e: unknown, p: unknown) => void) => {
    listeners.set(ch, cb);
    return () => listeners.delete(ch);
  },
}));

const userStore = vi.hoisted(() => ({
  isLoginValid: vi.fn(() => true),
  reset: vi.fn(),
  user: { token: "t" },
}));
vi.mock("../../../src-react/domains/user/store/user.store", () => ({
  useUserStore: () => userStore,
}));

const readFileMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src-react/domains/ai/api/artifact.api", () => ({
  default: {
    readFile: readFileMock,
    revealFile: vi.fn(),
    exportFile: vi.fn(),
  },
}));

vi.stubGlobal("ipcRenderer", {
  on: (ch: string, cb: (e: unknown, p: unknown) => void) => {
    listeners.set(ch, cb);
    return () => listeners.delete(ch);
  },
});

import FileWindowView from "../../../src-react/domains/ai/file-window/views/FileWindowView";
import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";
import { resolveTabClosures } from "../../../src-react/domains/ai/file-window/lib/close-confirm";
import {
  pushRecent,
  recentOf,
} from "../../../src-react/domains/ai/file-window/lib/recent-files";
import { recentSessionOf } from "../../../src-react/domains/ai/file-window/lib/session-map";
import { cmType, cmViewFromContent } from "./cm-test-utils";

const closeRequest = () =>
  listeners.get("fileWindow:close-request")?.(undefined);
const invokedChannels = () => invokeMock.mock.calls.map(([ch]) => ch as string);

/** 视图渲染统一包 QueryClientProvider（T12 起视图挂 useFileChanged →
 *  useQueryClient，无 provider 会抛错）；T26 起无会话 tab 恒渲染
 *  ChatPane（真 ChatInput → ModelPicker/技能子菜单 useNavigate）→
 *  MemoryRouter 提供路由上下文（视图自身直读 window.location.hash，
 *  MemoryRouter 不干预 location；chat-view-edit-optimistic 同款先例） */
function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <FileWindowView />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** 编辑器 textbox（CM6 .cm-content 亦 role=textbox；T26 起无会话 tab 恒
 *  渲染 ChatPane（真 ChatInput 含 autoFocus textarea，亦 textbox role）——
 *  只取 CM6 编辑器内容元素，排除 AI 面板输入） */
const editorBoxes = () =>
  screen
    .getAllByRole("textbox", { hidden: true })
    .filter((el) => el.classList.contains("cm-content")) as HTMLElement[];

/** 编辑器 doc 文本（box → CM6 视图） */
const cmDocOfBox = (el: HTMLElement) =>
  cmViewFromContent(el).state.doc.toString();

/** 编辑器所属 tab pane 的 display（CM6 自带内联 tab-size，须按 display 取） */
const paneDisplayOf = (el: HTMLElement): string => {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (node.style.display) return node.style.display;
  }
  return "";
};

/** 常规 invoke 桩：verifyToken 有效（防守卫跳登录改 hash 致 windowId 失真）。
 *  未知通道回 Promise——confirmClose/cancelClose/setSessionState 等被
 *  .catch/.then 链消费，回 null 会成 unhandled TypeError */
const okInvoke = () =>
  invokeMock.mockImplementation((ch: string) =>
    ch === "user:verifyToken" ? { userId: 1 } : Promise.resolve(null),
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useFileWindowStore.getState().reset();
  listeners.clear();
  localStorage.clear();
});

/** 脏 workspace tab 就位（内容区挂载 + 编辑出 dirty 草稿） */
async function openDirtyWorkspaceTab() {
  readFileMock.mockResolvedValue({ kind: "text", content: "x", mtime: 100 });
  invokeMock.mockImplementation((ch: string) => {
    if (ch === "user:verifyToken") return { userId: 1 };
    if (ch === "workspace:writeFile")
      return { absPath: "/x/a.txt", mtime: 300 };
    return Promise.resolve(null); // 未知通道回 Promise（链式消费防 unhandled）
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <FileWindowView />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  const { tabId } = useFileWindowStore
    .getState()
    .openTab({ kind: "workspace", workspaceId: 7, path: "a.txt" });
  // 编辑器 textbox 就位（AI 面板输入框非编辑器，editorBoxes 已排除）；
  // 磁盘内容到位（受控 value 同步进 CM6 doc）后再本地输入出脏草稿
  await waitFor(() => expect(editorBoxes()).toHaveLength(1));
  await waitFor(() => expect(cmDocOfBox(editorBoxes()[0])).toBe("x"));
  act(() => cmType(cmViewFromContent(editorBoxes()[0]), "改"));
  expect(
    useFileWindowStore.getState().tabs.find((t) => t.id === tabId)?.dirty,
  ).toBe(true);
  return { tabId };
}

// hash 路由下 query 在 hash 内：组件直接读 window.location.hash，
// 测试不经 Router 渲染（视图不依赖 router hooks）
describe("FileWindowView 组装", () => {
  it("登录有效：tab 条 + 空窗提示，挂载即发 close-ready", async () => {
    window.location.hash = "#/file-window?windowId=fw-1";
    okInvoke();
    renderView();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("fileWindow:close-ready", {
        windowId: "fw-1",
      }),
    );
    // t 返回 key 原值：空窗提示与 tab 条「+」按钮各精确断言
    expect(screen.getByText("chat:fileWindow.emptyHint")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "chat:fileWindow.tab.new" }),
    ).toBeTruthy();
  });

  it("登录失效：守卫早退不 reset（navigate 交给 hash 赋值）", () => {
    window.location.hash = "#/file-window?windowId=fw-1";
    userStore.isLoginValid.mockReturnValueOnce(false);
    renderView();
    expect(userStore.reset).not.toHaveBeenCalled(); // verifyToken 前不 reset
  });

  it("verifyToken 晚到 falsy 不误跳：卸载置 cancelled 后静默", async () => {
    window.location.hash = "#/file-window?windowId=fw-1";
    let resolveVerify: (v: unknown) => void;
    invokeMock.mockImplementation((ch: string) =>
      ch === "user:verifyToken"
        ? new Promise((res) => {
            resolveVerify = res;
          })
        : null,
    );
    const { unmount } = renderView();
    unmount(); // 响应未决时卸载（cancelled 标志）
    await act(async () => {
      resolveVerify!(null);
    });
    expect(userStore.reset).not.toHaveBeenCalled();
  });

  it("多 tab 全挂载：编辑→切走→切回草稿保留且 dirty 仍 true（非 active 隐藏不卸载）", async () => {
    window.location.hash = "#/file-window?windowId=fw-1";
    readFileMock.mockImplementation((_ws: number, p: string) =>
      p === "a.txt"
        ? { kind: "text", content: "甲", mtime: 100 }
        : { kind: "text", content: "乙", mtime: 200 },
    );
    okInvoke();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <FileWindowView />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const s = useFileWindowStore.getState();
    const a = s.openTab({
      kind: "workspace",
      workspaceId: 7,
      path: "a.txt",
    }).tabId;
    const b = s.openTab({
      kind: "workspace",
      workspaceId: 7,
      path: "b.txt",
    }).tabId;
    // 全部 tab 内容区同时挂载（顺序 = store tabs 顺序），各自磁盘内容就位
    // 双 tab 编辑器各自等数据后挂载：显式等两个编辑器 textbox 齐 + 内容到位
    await waitFor(() => expect(editorBoxes()).toHaveLength(2));
    const drafts = editorBoxes();
    await waitFor(() => expect(cmDocOfBox(drafts[0])).toBe("甲"));
    await waitFor(() => expect(cmDocOfBox(drafts[1])).toBe("乙"));
    // 编辑 a 后切到 b：a 隐藏（display none）但组件常驻——草稿不丢
    act(() => cmType(cmViewFromContent(drafts[0]), "改甲"));
    s.activate(b);
    const afterSwitch = editorBoxes();
    expect(paneDisplayOf(afterSwitch[0])).toBe("none");
    expect(paneDisplayOf(afterSwitch[1])).toBe("flex");
    expect(cmDocOfBox(afterSwitch[0])).toBe("改甲");
    // 切回 a：草稿仍在、dirty 仍 true（不被静默判净/丢编辑）
    s.activate(a);
    expect(cmDocOfBox(editorBoxes()[0])).toBe("改甲");
    expect(
      useFileWindowStore.getState().tabs.find((t) => t.id === a)?.dirty,
    ).toBe(true);
  });

  it("⌘S 并存多脏 tab：仅激活 tab 写盘，后台 tab 不写且 dirty 保持", async () => {
    window.location.hash = "#/file-window?windowId=fw-1";
    // 写盘后 readFile 对齐 writeFile 回传的 mtime/内容：写回 invalidate
    // 重取若回旧 mtime，内容区「draft 非空+mtime 换血」守卫会把自身写回
    // 误判外部改（externalChanged 假阳性路径——mock 不对齐时用例仍绿但
    // 走的不是真实链路）
    const files = new Map<string, { content: string; mtime: number }>([
      ["a.txt", { content: "甲", mtime: 100 }],
      ["b.txt", { content: "乙", mtime: 200 }],
    ]);
    readFileMock.mockImplementation((_ws: number, p: string) => ({
      kind: "text",
      ...files.get(p)!,
    }));
    invokeMock.mockImplementation((ch: string, p: Record<string, unknown>) => {
      if (ch === "user:verifyToken") return { userId: 1 };
      if (ch === "workspace:writeFile") {
        files.set(p.path as string, {
          content: p.content as string,
          mtime: 300,
        });
        return { absPath: `/x/${p.path as string}`, mtime: 300 };
      }
      return Promise.resolve(null); // 未知通道回 Promise（链式消费防 unhandled）
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <FileWindowView />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const s = useFileWindowStore.getState();
    s.openTab({ kind: "workspace", workspaceId: 7, path: "a.txt" });
    const b = s.openTab({
      kind: "workspace",
      workspaceId: 7,
      path: "b.txt",
    }).tabId; // 后开者激活
    // 双 tab 编辑器各自等数据后挂载：显式等两个编辑器 textbox 齐 + 内容到位
    await waitFor(() => expect(editorBoxes()).toHaveLength(2));
    const drafts = editorBoxes();
    await waitFor(() => expect(cmDocOfBox(drafts[0])).toBe("甲"));
    await waitFor(() => expect(cmDocOfBox(drafts[1])).toBe("乙"));
    act(() => cmType(cmViewFromContent(drafts[0]), "改甲"));
    act(() => cmType(cmViewFromContent(drafts[1]), "改乙"));
    // ⌘S：仅激活的 b 写盘——后台脏 a 不被静默保存（dirty 仍 true）
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("workspace:writeFile", {
        workspaceId: 7,
        path: "b.txt",
        content: "改乙",
        baselineMtime: 200,
      }),
    );
    const writePaths = invokeMock.mock.calls
      .filter(([ch]) => ch === "workspace:writeFile")
      .map(([, p]) => (p as { path: string }).path);
    expect(writePaths).toEqual(["b.txt"]);
    const tabs = useFileWindowStore.getState().tabs;
    expect(
      tabs.find(
        (t) => t.resource.kind === "workspace" && t.resource.path === "a.txt",
      )?.dirty,
    ).toBe(true);
    expect(tabs.find((t) => t.id === b)?.dirty).toBe(false);
    // 写回重取（mtime 对齐 300）不误判换血：b 不闪外部变更条
    await waitFor(() =>
      expect(
        readFileMock.mock.calls.filter(([, p]) => p === "b.txt").length,
      ).toBeGreaterThanOrEqual(2),
    );
    expect(
      useFileWindowStore.getState().tabs.find((t) => t.id === b)
        ?.externalChanged,
    ).toBeFalsy();
  });

  it("最近打开接线：openTab 经视图订阅 pushRecent（去重置顶）", async () => {
    window.location.hash = "#/file-window?windowId=fw-1";
    okInvoke();
    pushRecent({ kind: "workspace", workspaceId: 7, path: "old.md" });
    renderView();
    await act(async () => {
      useFileWindowStore
        .getState()
        .openTab({ kind: "workspace", workspaceId: 7, path: "new.md" });
    });
    expect(recentOf()).toHaveLength(2);
    expect(recentOf()[0]).toEqual({
      kind: "workspace",
      workspaceId: 7,
      path: "new.md",
    });
  });

  it("窗口标题（T21，spec §13 项 1）：挂载即 document.title=「天枢 {fileWindow.title}」", async () => {
    window.location.hash = "#/file-window?windowId=fw-1";
    okInvoke();
    renderView();
    // t 桩返回 key 原值：前缀「天枢 」+ i18n key
    expect(document.title).toBe("天枢 chat:fileWindow.title");
  });
});

describe("关闭握手端到端", () => {
  it("close-request → 无 dirty tab → 不弹确认直接 confirmClose", async () => {
    window.location.hash = "#/file-window?windowId=fw-1";
    okInvoke();
    readFileMock.mockResolvedValue({ kind: "text", content: "x", mtime: 1 });
    renderView();
    useFileWindowStore
      .getState()
      .openTab({ kind: "workspace", workspaceId: 7, path: "a.md" });
    closeRequest();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("fileWindow:confirmClose", {
        windowId: "fw-1",
      }),
    );
    expect(screen.queryByText("chat:fileWindow.closeConfirm.title")).toBeNull();
  });

  it("close-request → 整窗关闭空会话回收（T26，spec §15 项 2）：本窗创建且无消息的剩余 tab → 判空后 session:delete", async () => {
    window.location.hash = "#/file-window?windowId=fw-1";
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "user:verifyToken") return { userId: 1 };
      if (ch === "message:listBySession")
        return { items: [], hasMore: false, nextBeforeId: null };
      return Promise.resolve(null);
    });
    readFileMock.mockResolvedValue({ kind: "text", content: "x", mtime: 1 });
    renderView();
    // 非脏 tab（整窗关闭不逐个 closeTab——回收走 resolveDirtyTabs ok 后扫描）
    const { tabId } = useFileWindowStore
      .getState()
      .openTab({ kind: "workspace", workspaceId: 7, path: "a.md" });
    useFileWindowStore
      .getState()
      .patchTab(tabId, { sessionId: 55, sessionCreatedHere: true });
    closeRequest();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("fileWindow:confirmClose", {
        windowId: "fw-1",
      }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("message:listBySession", 55),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("session:delete", 55),
    );
  });

  it("close-request → 保存并关闭：经注册表保存流写盘 → 关 tab → confirmClose", async () => {
    window.location.hash = "#/file-window?windowId=fw-1";
    const { tabId } = await openDirtyWorkspaceTab();
    closeRequest();
    expect(
      await screen.findByText("chat:fileWindow.closeConfirm.title"),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "chat:fileWindow.closeConfirm.saveAndClose",
      }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("workspace:writeFile", {
        workspaceId: 7,
        path: "a.txt",
        content: "改",
        baselineMtime: 100,
      }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("fileWindow:confirmClose", {
        windowId: "fw-1",
      }),
    );
    // 保存成功后 tab 关闭（resolveDirtyTabs ok 路径）
    expect(
      useFileWindowStore.getState().tabs.find((t) => t.id === tabId),
    ).toBeUndefined();
  });

  it("close-request → 放弃：直接关 tab（不写盘）→ confirmClose", async () => {
    window.location.hash = "#/file-window?windowId=fw-1";
    okInvoke();
    readFileMock.mockResolvedValue({ kind: "text", content: "x", mtime: 1 });
    renderView();
    const { tabId } = useFileWindowStore
      .getState()
      .openTab({ kind: "workspace", workspaceId: 7, path: "a.md" });
    useFileWindowStore.getState().patchTab(tabId, { dirty: true });
    closeRequest();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "chat:fileWindow.closeConfirm.discard",
      }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("fileWindow:confirmClose", {
        windowId: "fw-1",
      }),
    );
    expect(useFileWindowStore.getState().tabs).toHaveLength(0);
    expect(invokedChannels()).not.toContain("workspace:writeFile");
  });

  it("close-request → 取消 → cancelClose，tab 保留", async () => {
    window.location.hash = "#/file-window?windowId=fw-1";
    okInvoke();
    readFileMock.mockResolvedValue({ kind: "text", content: "x", mtime: 1 });
    renderView();
    const { tabId } = useFileWindowStore
      .getState()
      .openTab({ kind: "workspace", workspaceId: 7, path: "a.md" });
    useFileWindowStore.getState().patchTab(tabId, { dirty: true });
    closeRequest();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "chat:fileWindow.closeConfirm.cancel",
      }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("fileWindow:cancelClose", {
        windowId: "fw-1",
      }),
    );
    expect(
      useFileWindowStore.getState().tabs.find((t) => t.id === tabId),
    ).toBeTruthy();
    expect(invokedChannels()).not.toContain("fileWindow:confirmClose");
  });

  it("确认叠加：X 键确认未落子时 tab 菜单再确认——前者按取消落子不粘死 close bridge", async () => {
    window.location.hash = "#/file-window?windowId=fw-1";
    const { tabId } = await openDirtyWorkspaceTab();
    closeRequest();
    expect(
      await screen.findByText("chat:fileWindow.closeConfirm.title"),
    ).toBeTruthy();
    // X 键确认在飞时 tab 菜单「关闭」经同一 asker 再问：替换前先按取消
    // 落子上一个 Promise——close bridge 收 cancelled 发 cancelClose（否则
    // 孤儿 Promise 悬置、inFlight 永真后续 close-request 全被吞）
    void resolveTabClosures([tabId], true);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("fileWindow:cancelClose", {
        windowId: "fw-1",
      }),
    );
    // 新确认浮层仍就位照常落子：放弃 → 关 tab（第二条链路完整）
    fireEvent.click(
      screen.getByRole("button", {
        name: "chat:fileWindow.closeConfirm.discard",
      }),
    );
    await waitFor(() =>
      expect(
        useFileWindowStore.getState().tabs.find((t) => t.id === tabId),
      ).toBeUndefined(),
    );
  });
});

describe("⌘⇧]/⌘⇧[ 循环切换（T17）", () => {
  it("next/prev 首尾环回、Ctrl 口径同效；输入框聚焦忽略 + preventDefault", async () => {
    window.location.hash = "#/file-window?windowId=fw-1";
    okInvoke();
    readFileMock.mockResolvedValue({ kind: "text", content: "x", mtime: 1 });
    renderView();
    const s = useFileWindowStore.getState();
    const a = s.openTab({
      kind: "workspace",
      workspaceId: 7,
      path: "a.md",
    }).tabId;
    s.openTab({ kind: "workspace", workspaceId: 7, path: "b.md" });
    const c = s.openTab({
      kind: "workspace",
      workspaceId: 7,
      path: "c.md",
    }).tabId; // 后开者激活=尾
    // T26 起无会话 tab 恒渲染 ChatPane（真 ChatInput autoFocus 抢焦）——
    // 等其挂载抢焦后 blur（焦点不在输入区场景）；「输入框聚焦忽略」断言
    // 在后段以显式聚焦元素覆盖
    await waitFor(() =>
      expect(document.activeElement?.tagName).toBe("TEXTAREA"),
    );
    (document.activeElement as HTMLElement | null)?.blur();
    // ⌘⇧]：尾 → 环回首
    fireEvent.keyDown(window, { key: "]", metaKey: true, shiftKey: true });
    expect(useFileWindowStore.getState().activeTabId).toBe(a);
    // ⌘⇧[：首 → 环回尾
    fireEvent.keyDown(window, { key: "[", metaKey: true, shiftKey: true });
    expect(useFileWindowStore.getState().activeTabId).toBe(c);
    // Ctrl+Shift+]（Windows 口径）
    fireEvent.keyDown(window, { key: "]", ctrlKey: true, shiftKey: true });
    expect(useFileWindowStore.getState().activeTabId).toBe(a);
    // 中位步进（a → b）+ 无修饰 ] 不抢键
    fireEvent.keyDown(window, { key: "]", metaKey: true, shiftKey: true });
    const b = useFileWindowStore.getState().tabs[1].id;
    expect(useFileWindowStore.getState().activeTabId).toBe(b);
    fireEvent.keyDown(window, { key: "]" });
    expect(useFileWindowStore.getState().activeTabId).toBe(b);
    // 焦点在 textarea/input：忽略（编辑器打字场景不切 tab）
    for (const tag of ["textarea", "input"] as const) {
      const el = document.createElement(tag);
      document.body.appendChild(el);
      el.focus();
      fireEvent.keyDown(window, { key: "]", metaKey: true, shiftKey: true });
      expect(useFileWindowStore.getState().activeTabId).toBe(b);
      el.remove();
    }
    // contentEditable：同样忽略（jsdom 未实现 isContentEditable 与
    // contentEditable 元素 focus 语义——tabindex 使 focus 生效 + getter
    // 桩还原真实浏览器状态，只验守卫分支本身）
    const ce = document.createElement("div");
    ce.setAttribute("tabindex", "-1");
    Object.defineProperty(ce, "isContentEditable", { get: () => true });
    document.body.appendChild(ce);
    ce.focus();
    fireEvent.keyDown(window, { key: "]", metaKey: true, shiftKey: true });
    expect(useFileWindowStore.getState().activeTabId).toBe(b);
    ce.remove();
    // 真实键形（审查 I1）：US 布局 Shift 映射下 Chromium 发的 e.key 是
    // } / {（fireEvent 指定 key 不经布局推导，此处直证 }/{ 键形命中）
    fireEvent.keyDown(window, { key: "}", metaKey: true, shiftKey: true });
    expect(useFileWindowStore.getState().activeTabId).toBe(c);
    fireEvent.keyDown(window, { key: "{", metaKey: true, shiftKey: true });
    expect(useFileWindowStore.getState().activeTabId).toBe(b);
    // 匹配快捷键时拦默认行为（含 } 键形）
    const ev = new KeyboardEvent("keydown", {
      key: "}",
      metaKey: true,
      shiftKey: true,
      cancelable: true,
    });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe("文件→会话历史映射 seed/push 接线（T18，spec §12 项 4）", () => {
  const MAP_KEY = "tianshu-file-window-session-map";
  const WS_A = { kind: "workspace", workspaceId: 7, path: "a.md" } as const;

  /** 预置映射 + 渲染视图（message:listBySession 空列表桩——seed 后
   *  FileChatPanel 挂 MessageList 拉消息；jsdom 无 scrollIntoView，不
   *  stub 则 MessageList 挂载（sessionId 落 tab）rAF 滚底未捕获异常炸
   *  测试，同 file-chat-panel.test 口径） */
  const renderWithMap = (map: Record<string, number[]>) => {
    window.location.hash = "#/file-window?windowId=fw-1";
    Element.prototype.scrollIntoView = vi.fn();
    // readFile 回非 undefined：react-query 禁 undefined data，未桩时
    // FileTabContent 查询抛错炸整树（afterEach clearAllMocks 复位后残留）
    readFileMock.mockResolvedValue({ kind: "text", content: "", mtime: 1 });
    localStorage.setItem(MAP_KEY, JSON.stringify(map));
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "user:verifyToken") return { userId: 1 };
      if (ch === "message:listBySession")
        return { items: [], hasMore: false, nextBeforeId: null };
      return Promise.resolve(null);
    });
    renderView();
  };

  it("无 sessionId 开 tab → seed 映射最近会话；映射无记录不 seed；去重打开不重 seed", async () => {
    renderWithMap({ "w:7:a.md": [55, 54] });
    const s = useFileWindowStore.getState();
    const a = s.openTab(WS_A).tabId;
    const b = s.openTab({
      kind: "workspace",
      workspaceId: 7,
      path: "b.md",
    }).tabId;
    await waitFor(() =>
      expect(
        useFileWindowStore.getState().tabs.find((t) => t.id === a)?.sessionId,
      ).toBe(55),
    );
    // b 无映射记录：不 seed
    expect(
      useFileWindowStore.getState().tabs.find((t) => t.id === b)?.sessionId,
    ).toBeUndefined();
    // seed 后写入映射置顶（55 已在首位，去重无变化）
    expect(recentSessionOf(WS_A)).toBe(55);
    // 重复打开既有 tab（去重激活）不新增 tab → 不重 seed
    const again = s.openTab(WS_A);
    expect(again.created).toBe(false);
    expect(
      useFileWindowStore.getState().tabs.find((t) => t.id === again.tabId)
        ?.sessionId,
    ).toBe(55);
  });

  it("「新建任务」解绑后不重 seed（无新 tab）；旧会话留在映射", async () => {
    renderWithMap({ "w:7:a.md": [55] });
    const a = useFileWindowStore.getState().openTab(WS_A).tabId;
    await waitFor(() =>
      expect(
        useFileWindowStore.getState().tabs.find((t) => t.id === a)?.sessionId,
      ).toBe(55),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.chat.newTask" }),
    );
    expect(
      useFileWindowStore.getState().tabs.find((t) => t.id === a)?.sessionId,
    ).toBeUndefined();
    // 微任务轮后仍不重 seed（解绑非新 tab）
    await act(async () => {});
    expect(
      useFileWindowStore.getState().tabs.find((t) => t.id === a)?.sessionId,
    ).toBeUndefined();
    expect(recentSessionOf(WS_A)).toBe(55);
  });

  it("移窗带入 sessionId 首挂 push 置顶；无会话 tab 经 patchTab 落 sessionId（ensureSession 建成同型）也 push", async () => {
    renderWithMap({ "w:7:a.md": [55, 54] });
    // 移窗带入：resource 携带既有 sessionId
    useFileWindowStore.getState().openTab({ ...WS_A, sessionId: 66 });
    await waitFor(() => expect(recentSessionOf(WS_A)).toBe(66));
    expect(JSON.parse(localStorage.getItem(MAP_KEY)!)).toEqual({
      "w:7:a.md": [66, 55, 54],
    });
    // ensureSession 建成 = patchTab sessionId 从无到有
    const b = useFileWindowStore
      .getState()
      .openTab({ kind: "workspace", workspaceId: 7, path: "b.md" }).tabId;
    useFileWindowStore.getState().patchTab(b, { sessionId: 101 });
    await waitFor(() =>
      expect(
        recentSessionOf({ kind: "workspace", workspaceId: 7, path: "b.md" }),
      ).toBe(101),
    );
  });
});
