// @vitest-environment jsdom
/**
 * AI 面板（T10 骨架 + T11 活化 + T22 全功能对齐 + T26 默认完整输入框）：
 * 外壳（头部 新建任务/打开主页/收起/reinject + usePanelWidth 夹取
 * [320, win*0.5]（窗 800 → 夹 400）、拖宽实时变宽且 pointerup/pointercancel
 * 落盘 localStorage、拖过头夹 min 320）；T26（spec §15 项 1）废止空态轻
 * 输入框——无会话恒渲染占位 ChatPane（id=-1）：sessionResolver 接
 * use-file-session prepareFirstSend（session:create + 注入前缀）、
 * onSessionResolved 落 tab 绑定 + sessionCreatedHere 标记（空会话回收
 * 依据）；快捷指令经 ChatPane quickPrompts 胶囊；有会话走真记录（T22
 * ChatPane 分支既有面）；getById 非 SESSION_NOT_FOUND 失败错误态重试
 * （T23 I1）、会话已删清绑定回占位；图片拖入经面板 drop 层
 * pendingImageInjection 受控注入 ChatInput 附件体系（T19/T22）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("react-i18next", async (importOriginal) => {
  // 部分 mock：MessageList 传递链还会引入 initReactI18next 等具名导出
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

// localStorage stub：与 tests/ai/edit-bar.test.tsx 同款内存 stub（本仓库
// 测试环境无原生 localStorage；usePanelWidth 读写面板宽持久化）
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
    clear: () => memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

// 超限/落盘失败 toast 断言（T19 drop 层）
vi.mock("sonner", () => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

// ChatPane → useChatSend 订阅 chat:stream / 消息拉取（ipc.on 必备）
const invokeMock = vi.hoisted(() => vi.fn());
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

// ChatPane 以捕获 props 的 stub 替代（面板测试只验接线；ChatPane 自身
// 行为由 chat-pane-*.test 覆盖）
const paneProps = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));
vi.mock("../../../src-react/domains/ai/chat/components/ChatPane", async () => {
  const { createElement } = await import("react");
  return {
    default: (props: Record<string, unknown>) => {
      paneProps.current = props;
      return createElement(
        "div",
        { "data-testid": "fw-chat-pane" },
        "ChatPane",
      );
    },
  };
});

import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";

import FileChatPanel from "../../../src-react/domains/ai/file-window/components/FileChatPanel";
import { usePanelWidth } from "../../../src-react/domains/ai/file-window/hooks/use-panel-width";
import { toast } from "sonner";

const WIDTH_KEY = "tianshu-file-window-chat-width";

/** session:getById 应答记录（T22 ChatPane 分支数据源；用例可覆写形状/抛错） */
const SESSION_RECORD = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  workspaceId: 7,
  title: "a.md",
  mode: "agent",
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T00:00:00.000Z",
  ...extra,
});
const sessionState = { record: SESSION_RECORD(12) as Record<string, unknown> };
const sessionById = () => sessionState.record;

// FileChatPanel → useQueryClient：面板渲染须在 provider 内
// （生产由 main.tsx 根 provider 保证）
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const renderPanel = (tabId: string) =>
  render(
    <QueryClientProvider client={client}>
      <FileChatPanel tabId={tabId} />
    </QueryClientProvider>,
  );

beforeEach(() => {
  listeners.clear();
  // toast mock 全文件共享不清会跨用例累积（T23：sessionGone 否定断言误伤）
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.warning).mockClear();
  // jsdom 未实现 scrollIntoView：MessageList 挂载即 rAF 滚底，不 stub 会以
  // 未捕获异常炸测试（同 message-list-scroll.test）
  Element.prototype.scrollIntoView = vi.fn();
  invokeMock.mockReset().mockImplementation((ch: string) => {
    if (ch === "session:create") return { id: 12, workspaceId: 7 };
    if (ch === "message:listBySession")
      return { items: [], hasMore: false, nextBeforeId: null };
    if (ch === "fileWindow:focusMain") return Promise.resolve(null);
    if (ch === "session:getById") return sessionById();
    if (ch === "fileWindow:openRoute") return Promise.resolve(null);
    if (ch === "file:savePastedImage") return "/att/paste-1.png";
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  client.clear();
  useFileWindowStore.getState().reset();
  localStorage.clear();
});

/** jsdom innerWidth 只读语义不稳，defineProperty 换桩并返回还原函数 */
function stubInnerWidth(w: number) {
  const original = Object.getOwnPropertyDescriptor(window, "innerWidth");
  Object.defineProperty(window, "innerWidth", {
    value: w,
    writable: true,
    configurable: true,
  });
  return () =>
    original && Object.defineProperty(window, "innerWidth", original);
}

function openWorkspaceTab(sessionId?: number, path = "a.md") {
  return useFileWindowStore
    .getState()
    .openTab({ kind: "workspace", workspaceId: 7, path, sessionId }).tabId;
}

describe("FileChatPanel 骨架", () => {
  it("无会话即渲染占位 ChatPane（id=-1，空态轻输入框已废止）；收起写回 store", async () => {
    const tabId = openWorkspaceTab();
    renderPanel(tabId);
    expect(await screen.findByTestId("fw-chat-pane")).toBeTruthy();
    expect((paneProps.current!.session as { id: number }).id).toBe(-1);
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.chat.collapse" }),
    );
    expect(useFileWindowStore.getState().tabs[0].aiPanelOpen).toBe(false);
  });

  it("新建任务：sessionId 置 undefined（原绑定会话解绑，回占位）", async () => {
    const tabId = openWorkspaceTab(9);
    expect(useFileWindowStore.getState().tabs[0].sessionId).toBe(9);
    renderPanel(tabId);
    await screen.findByTestId("fw-chat-pane");
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.chat.newTask" }),
    );
    expect(useFileWindowStore.getState().tabs[0].sessionId).toBeUndefined();
    // 回占位：ChatPane 换哨兵会话（key 重建）
    await waitFor(() =>
      expect((paneProps.current!.session as { id: number }).id).toBe(-1),
    );
  });

  it("打开主页（T18）：按钮在新建任务左侧，点击 invoke fileWindow:focusMain", async () => {
    const tabId = openWorkspaceTab();
    renderPanel(tabId);
    const home = screen.getByRole("button", {
      name: "chat:fileWindow.chat.openHome",
    });
    const newTask = screen.getByRole("button", {
      name: "chat:fileWindow.chat.newTask",
    });
    // 「新建任务」左侧：DOM 文档序 home 在前
    expect(
      home.compareDocumentPosition(newTask) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(home);
    expect(
      invokeMock.mock.calls.some((c) => c[0] === "fileWindow:focusMain"),
    ).toBe(true);
  });

  it("拖宽左缘：pointermove 实时变宽 350，pointerup 落盘 localStorage", () => {
    const tabId = openWorkspaceTab();
    renderPanel(tabId);
    const separator = screen.getByRole("separator", {
      name: "chat:fileWindow.chat.resize",
    });
    fireEvent.pointerDown(separator);
    fireEvent.pointerMove(window, {
      clientX: window.innerWidth - 350,
    });
    // 面板外层行内宽随拖动更新（jsdom 默认窗宽 1024，350 在夹取区间内）
    expect(separator.parentElement?.getAttribute("style")).toContain(
      "width: 350px",
    );
    fireEvent.pointerUp(window);
    expect(localStorage.getItem(WIDTH_KEY)).toBe("350");
  });

  it("拖过头：夹 min 320 并落盘", () => {
    const tabId = openWorkspaceTab();
    renderPanel(tabId);
    const separator = screen.getByRole("separator", {
      name: "chat:fileWindow.chat.resize",
    });
    fireEvent.pointerDown(separator);
    fireEvent.pointerMove(window, { clientX: window.innerWidth });
    expect(separator.parentElement?.getAttribute("style")).toContain(
      "width: 320px",
    );
    fireEvent.pointerUp(window);
    expect(localStorage.getItem(WIDTH_KEY)).toBe("320");
  });

  it("拖动中断（pointercancel/blur）：复位 isResizing 并落盘，后续 move 失效", () => {
    const tabId = openWorkspaceTab();
    renderPanel(tabId);
    const separator = screen.getByRole("separator", {
      name: "chat:fileWindow.chat.resize",
    });
    fireEvent.pointerDown(separator);
    fireEvent.pointerMove(window, { clientX: window.innerWidth - 360 });
    fireEvent(window, new Event("pointercancel"));
    expect(localStorage.getItem(WIDTH_KEY)).toBe("360");
    // 监听已清：后续 pointermove 不再改宽
    fireEvent.pointerMove(window, { clientX: window.innerWidth - 500 });
    expect(separator.parentElement?.getAttribute("style")).toContain(
      "width: 360px",
    );
  });
});

describe("FileChatPanel 占位首条（T26，spec §15 项 1）", () => {
  /** 等待 ChatPane 桩挂载并返回捕获 props */
  async function paneMounted() {
    await screen.findByTestId("fw-chat-pane");
    return paneProps.current!;
  }

  it("占位接线：quickPrompts 胶囊/拖入注入/sessionResolver/onSessionResolved 全量下发", async () => {
    const tabId = openWorkspaceTab(undefined, "docs/guide.md");
    renderPanel(tabId);
    const props = await paneMounted();
    expect((props.session as { id: number }).id).toBe(-1);
    // quickPrompts：contentKind 矩阵解析后的 {id,label,prompt}（t 直返 key）
    expect(props.quickPrompts).toEqual([
      {
        id: "summarize",
        label: "chat:fileWindow.prompt.md.summarize.label",
        prompt: "chat:fileWindow.prompt.md.summarize.text",
      },
      {
        id: "proofread",
        label: "chat:fileWindow.prompt.md.proofread.label",
        prompt: "chat:fileWindow.prompt.md.proofread.text",
      },
      {
        id: "polish",
        label: "chat:fileWindow.prompt.md.polish.label",
        prompt: "chat:fileWindow.prompt.md.polish.text",
      },
      {
        id: "outline",
        label: "chat:fileWindow.prompt.md.outline.label",
        prompt: "chat:fileWindow.prompt.md.outline.text",
      },
    ]);
    expect(typeof props.sessionResolver).toBe("function");
    expect(typeof props.onSessionResolved).toBe("function");
    // workspace 占位：workspace 透传 tab 资源空间（@ 联想可用）
    expect(props.workspace).toEqual({ id: 7 });
  });

  it("sessionResolver=prepareFirstSend：建会话 + 注入前缀返回（不直发）；标记随建即写、onSessionResolved 落绑定+失效会话缓存", async () => {
    const tabId = openWorkspaceTab();
    renderPanel(tabId);
    const props = await paneMounted();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const resolved = await (
      props.sessionResolver as () => Promise<{
        session: { id: number };
        contentPrefix?: string;
      }>
    )();
    expect(resolved.session.id).toBe(12);
    // mock t 直返 key：前缀 = injectPrefix key（无插值）
    expect(resolved.contentPrefix).toBe("chat:fileWindow.chat.injectPrefix");
    expect(invokeMock.mock.calls.some((c) => c[0] === "chat:send")).toBe(false);
    // 本窗创建标记随建即写（修复轮 1 Critical 1：send 成功前/失败时也在）
    const createdTab = useFileWindowStore.getState().tabs[0];
    expect(createdTab.sessionId).toBe(12);
    expect(createdTab.sessionCreatedHere).toBe(true);
    // 成功回调：落绑定 + 失效缓存（不再写标记——建会话时已写，防双写）
    (props.onSessionResolved as (s: { id: number }) => void)(resolved.session);
    expect(useFileWindowStore.getState().tabs[0].sessionId).toBe(12);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["sessions", "fw", 12],
    });
    invalidateSpy.mockRestore();
  });

  it("resolver 失败标记码映射：LIBRARY_ITEM_MISSING → 专用 toast（不落 sendFailed 兜底）", async () => {
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "library:tree")
        return [
          {
            id: 3,
            name: "note.md",
            kind: "file",
            fileType: "text/markdown",
            storagePath: null,
            updatedAt: "2026-10-14T00:00:00.000Z",
          },
        ];
      return undefined;
    });
    const tabId = useFileWindowStore
      .getState()
      .openTab({ kind: "library", itemId: 3 }).tabId;
    renderPanel(tabId);
    const props = await paneMounted();
    await expect(
      (props.sessionResolver as () => Promise<unknown>)(),
    ).rejects.toThrow("LIBRARY_ITEM_MISSING");
    expect(toast.error).toHaveBeenCalledWith(
      "chat:fileWindow.chat.itemMissing",
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});

describe("FileChatPanel 输入草稿 per-tab（T28，spec §16 项 5）", () => {
  /** 等待 ChatPane 桩挂载并返回捕获 props */
  async function paneMounted() {
    await screen.findByTestId("fw-chat-pane");
    return paneProps.current!;
  }

  it("initialDraft 取 tab.inputDraft；onDraftUnmount 回存瞬态字段（切 tab 存/回灌闭环）", async () => {
    const tabId = openWorkspaceTab();
    useFileWindowStore.getState().patchTab(tabId, { inputDraft: "暂存草稿" });
    const first = renderPanel(tabId);
    const props = await paneMounted();
    expect(props.initialDraft).toBe("暂存草稿");
    // ChatInput 卸载上报（真实链路在 chat-input-file-window-props.test）→
    // 面板回写 store 瞬态字段
    (props.onDraftUnmount as (draft: string) => void)("输入到一半");
    expect(
      useFileWindowStore.getState().tabs.find((t) => t.id === tabId)
        ?.inputDraft,
    ).toBe("输入到一半");
    // 切 tab 场景（卸载本面板 → 挂另一 tab 面板）：各拿各的草稿，互不串
    const otherId = useFileWindowStore
      .getState()
      .openTab({ kind: "workspace", workspaceId: 7, path: "b.md" }).tabId;
    useFileWindowStore.getState().patchTab(otherId, { inputDraft: "b 的草稿" });
    first.unmount();
    renderPanel(otherId);
    expect((await paneMounted()).initialDraft).toBe("b 的草稿");
  });

  it("tab 已删（closeTab 后卸载回调到达）：patchTab 无害 no-op", async () => {
    const tabId = openWorkspaceTab();
    renderPanel(tabId);
    const props = await paneMounted();
    useFileWindowStore.getState().closeTab(tabId);
    expect(() =>
      (props.onDraftUnmount as (draft: string) => void)("孤儿草稿"),
    ).not.toThrow();
    expect(useFileWindowStore.getState().tabs).toHaveLength(0);
  });
});

describe("usePanelWidth 夹取", () => {
  it("窗宽 800：存量宽 500 超 50% 上限，挂载即夹回 400", () => {
    localStorage.setItem(WIDTH_KEY, "500");
    const restore = stubInnerWidth(800);
    const { result } = renderHook(() => usePanelWidth());
    expect(result.current.width).toBe(400);
    restore();
  });
});

describe("FileChatPanel library 降级提示（修复轮 2 观察①）", () => {
  const LIB_ITEM = {
    id: 3,
    name: "note.md",
    kind: "file",
    fileType: "text/markdown",
    storagePath: "/root/library/3.md",
    updatedAt: "2026-10-14T00:00:00.000Z",
  };

  function openLibraryTab() {
    return useFileWindowStore.getState().openTab({ kind: "library", itemId: 3 })
      .tabId;
  }

  it("全空间未绑定目录 → 顶部提示条渲染；占位首条 resolver 不拦（会话照建+grant+前缀照算）", async () => {
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "workspace:list") return [{ id: 11, directoryPath: null }];
      if (ch === "library:tree") return [LIB_ITEM];
      if (ch === "session:create") return { id: 21, workspaceId: 11 };
      if (ch === "fileWindow:grantFilePath") return null;
      if (ch === "file:readExternalFile")
        return { kind: "text", content: "# 全文" };
      if (ch === "message:listBySession")
        return { items: [], hasMore: false, nextBeforeId: null };
      return undefined;
    });
    renderPanel(openLibraryTab());
    expect(
      await screen.findByText("chat:fileWindow.chat.noBoundWorkspace"),
    ).toBeTruthy();
    // 占位首条不拦：会话照建（挂未绑定空间）、授权照注、前缀照算
    await screen.findByTestId("fw-chat-pane");
    const resolved = await (
      paneProps.current!.sessionResolver as () => Promise<{
        session: { id: number };
        contentPrefix?: string;
      }>
    )();
    expect(resolved.session.id).toBe(21);
    expect(resolved.contentPrefix).toContain(
      "chat:fileWindow.chat.injectPrefixLibrary",
    );
    expect(
      invokeMock.mock.calls.some((c) => c[0] === "fileWindow:grantFilePath"),
    ).toBe(true);
  });

  it("存在绑定空间 → 不渲染提示条", async () => {
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "workspace:list")
        return [
          { id: 11, directoryPath: null },
          { id: 12, directoryPath: "/ws/root" },
        ];
      return undefined;
    });
    renderPanel(openLibraryTab());
    await waitFor(() =>
      expect(invokeMock.mock.calls.some((c) => c[0] === "workspace:list")).toBe(
        true,
      ),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(
      screen.queryByText("chat:fileWindow.chat.noBoundWorkspace"),
    ).toBeNull();
  });
});

describe("FileChatPanel ChatPane 分支（T22，spec §13 项 3）", () => {
  /** 开 tab（带 sessionId）并渲染面板；返回 tabId */
  function openSessionTab(sessionId = 12, path = "docs/guide.md") {
    const tabId = useFileWindowStore
      .getState()
      .openTab({ kind: "workspace", workspaceId: 7, path, sessionId }).tabId;
    renderPanel(tabId);
    return tabId;
  }

  /** 等待 ChatPane 桩挂载并返回捕获 props */
  async function paneMounted() {
    await screen.findByTestId("fw-chat-pane");
    return paneProps.current!;
  }

  beforeEach(() => {
    sessionState.record = SESSION_RECORD(12);
  });

  it("有 session → 内嵌完整 ChatPane（session/workspace/quickPrompts 接线），轻输入框与自制消息流不渲染", async () => {
    openSessionTab(12, "docs/guide.md");
    const props = await paneMounted();
    expect((props.session as { id: number }).id).toBe(12);
    expect(props.workspace).toEqual({ id: 7 });
    // quickPrompts：contentKind 矩阵解析后的 {id,label,prompt}（t 直返 key）
    expect(props.quickPrompts).toEqual([
      {
        id: "summarize",
        label: "chat:fileWindow.prompt.md.summarize.label",
        prompt: "chat:fileWindow.prompt.md.summarize.text",
      },
      {
        id: "proofread",
        label: "chat:fileWindow.prompt.md.proofread.label",
        prompt: "chat:fileWindow.prompt.md.proofread.text",
      },
      {
        id: "polish",
        label: "chat:fileWindow.prompt.md.polish.label",
        prompt: "chat:fileWindow.prompt.md.polish.text",
      },
      {
        id: "outline",
        label: "chat:fileWindow.prompt.md.outline.label",
        prompt: "chat:fileWindow.prompt.md.outline.text",
      },
    ]);
  });

  it("hasModel 照 ChatView：会话当前模型 → 工作空间默认模型", async () => {
    sessionState.record = SESSION_RECORD(12);
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "session:getById") return sessionById();
      if (ch === "workspace:list")
        return [{ id: 7, directoryPath: "/ws/root", defaultModelId: 55 }];
      if (ch === "message:listBySession")
        return { items: [], hasMore: false, nextBeforeId: null };
      return undefined;
    });
    openSessionTab();
    expect((await paneMounted()).hasModel).toBe(true);

    // 会话/空间均无模型 → false（输入禁用提示口径）；占位期（无会话）
    // 同口径按 tab 资源空间解析
    sessionState.record = SESSION_RECORD(12, { currentModelId: undefined });
    useFileWindowStore.getState().reset();
    cleanup();
    client.clear(); // fw-workspaces 等共享缓存防串场
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "session:getById")
        return SESSION_RECORD(13, { currentModelId: undefined });
      if (ch === "workspace:list")
        return [{ id: 7, directoryPath: "/ws/root" }];
      return undefined;
    });
    const tabId = useFileWindowStore.getState().openTab({
      kind: "workspace",
      workspaceId: 7,
      path: "a.md",
      sessionId: 13,
    }).tabId;
    renderPanel(tabId);
    expect((await paneMounted()).hasModel).toBe(false);
    // 占位（解绑）同空间解析：hasModel 仍 false
    useFileWindowStore.getState().patchTab(tabId, { sessionId: undefined });
    await waitFor(() =>
      expect((paneProps.current!.session as { id: number }).id).toBe(-1),
    );
    expect(paneProps.current!.hasModel).toBe(false);
  });

  it("新建任务 → sessionId 解绑回占位（ChatPane 换哨兵会话，轻输入框不回归）", async () => {
    openSessionTab(12);
    await paneMounted();
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.chat.newTask" }),
    );
    expect(useFileWindowStore.getState().tabs[0].sessionId).toBeUndefined();
    expect(
      useFileWindowStore.getState().tabs[0].sessionCreatedHere,
    ).toBeUndefined();
    await waitFor(() =>
      expect((paneProps.current!.session as { id: number }).id).toBe(-1),
    );
    // 占位也恒渲染 ChatPane（空态轻输入框已废止）
    expect(screen.getByTestId("fw-chat-pane")).toBeTruthy();
  });

  it("reinject 按钮保留在面板头部（会话存在时）：直发 chat:send 贴最新路径", async () => {
    openSessionTab(12);
    await paneMounted();
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.chat.reinject" }),
    );
    await waitFor(() =>
      expect(invokeMock.mock.calls.some((c) => c[0] === "chat:send")).toBe(
        true,
      ),
    );
  });

  it("会话已删（getById 报 SESSION_NOT_FOUND）→ 清绑定回占位 + 专用提示", async () => {
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "session:getById")
        return Promise.reject(new Error("SESSION_NOT_FOUND"));
      return undefined;
    });
    openSessionTab(12);
    await waitFor(() =>
      expect(useFileWindowStore.getState().tabs[0].sessionId).toBeUndefined(),
    );
    expect(toast.error).toHaveBeenCalledWith(
      "chat:fileWindow.chat.sessionGone",
    );
    await waitFor(() =>
      expect((paneProps.current!.session as { id: number }).id).toBe(-1),
    );
  });

  it("getById 非 SESSION_NOT_FOUND 失败（T23 I1）→ 保留绑定 + 错误态重试恢复，不误判已删", async () => {
    invokeMock.mockImplementation((ch: string) => {
      // token 失效/网络瞬断等任意非「会话已删」失败（重试关闭无缓冲）
      if (ch === "session:getById")
        return Promise.reject(new Error("NETWORK_DOWN"));
      return undefined;
    });
    openSessionTab(12);
    // 错误态：不闪占位也不渲染 ChatPane（绑定还在，占位语义「首条惰建」会误导）
    expect(
      await screen.findByText("chat:fileWindow.chat.loadFailed"),
    ).toBeTruthy();
    expect(screen.queryByTestId("fw-chat-pane")).toBeNull();
    // 绑定保留（不清）：无 sessionGone 善后（不 toast、sessionId 原样）
    expect(toast.error).not.toHaveBeenCalledWith(
      "chat:fileWindow.chat.sessionGone",
    );
    expect(useFileWindowStore.getState().tabs[0].sessionId).toBe(12);
    // 重试：getById 转成功 → ChatPane 分支恢复（绑定未动，无缝续会话）
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "session:getById") return sessionById();
      return undefined;
    });
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.chat.retry" }),
    );
    expect(await screen.findByTestId("fw-chat-pane")).toBeTruthy();
    expect(useFileWindowStore.getState().tabs[0].sessionId).toBe(12);
  });

  it("drop→注入链：面板容器拖入图片落盘后经 pendingImageInjection 并入 ChatInput（consumed 回调清空）", async () => {
    const png = new File([new Uint8Array(8)], "shot.png", {
      type: "image/png",
    });
    openSessionTab(12);
    await paneMounted();
    const zone = screen.getByTestId("file-chat-pane-drop-zone");
    fireEvent.drop(zone, { dataTransfer: { files: [png] } });
    await waitFor(() => {
      const save = invokeMock.mock.calls.find(
        (c) => c[0] === "file:savePastedImage",
      );
      expect(save?.[1]).toBe("shot.png");
    });
    await waitFor(() =>
      expect(paneProps.current?.pendingImageInjection).toEqual([
        { name: "shot.png", absPath: "/att/paste-1.png" },
      ]),
    );
    // 消费回调：面板注入态清空（ChatInput 侧并入自身附件体系）
    (paneProps.current?.onPendingImageInjectionConsumed as () => void)();
    await waitFor(() =>
      expect(paneProps.current?.pendingImageInjection).toEqual([]),
    );
  });

  it("占位分支拖入同链：无会话时 drop 层同样落盘注入（T26 恒渲染后空态不丢拖入）", async () => {
    const png = new File([new Uint8Array(8)], "shot.png", {
      type: "image/png",
    });
    const tabId = openWorkspaceTab();
    renderPanel(tabId);
    await paneMounted();
    const zone = screen.getByTestId("file-chat-pane-drop-zone");
    fireEvent.drop(zone, { dataTransfer: { files: [png] } });
    await waitFor(() =>
      expect(paneProps.current?.pendingImageInjection).toEqual([
        { name: "shot.png", absPath: "/att/paste-1.png" },
      ]),
    );
  });

  it("onOpenSettings：invoke fileWindow:openRoute 聚焦主窗跳对应路由（providers/mcp）", async () => {
    openSessionTab(12);
    const props = await paneMounted();
    const openSettings = props.onOpenSettings as (
      target: "providers" | "assistants" | "mcp",
    ) => void;
    openSettings("providers");
    openSettings("mcp");
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter((c) => c[0] === "fileWindow:openRoute"),
      ).toHaveLength(2),
    );
    const hashes = invokeMock.mock.calls
      .filter((c) => c[0] === "fileWindow:openRoute")
      .map((c) => c[1].hash);
    expect(hashes).toEqual([
      "/module/ai/providers",
      "/module/ai/experts?tab=connectors",
    ]);
  });

  it("library tab ChatPane 分支：会话就位即补注册路径授权（grantFilePath，spec §6.4）", async () => {
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "session:getById") return SESSION_RECORD(21);
      if (ch === "library:tree")
        return [
          {
            id: 3,
            name: "note.md",
            kind: "file",
            fileType: "text/markdown",
            storagePath: "/root/library/3.md",
            updatedAt: "2026-10-14T00:00:00.000Z",
          },
        ];
      if (ch === "fileWindow:grantFilePath") return null;
      if (ch === "workspace:list") return [{ id: 11, directoryPath: "/ws" }];
      return undefined;
    });
    const tabId = useFileWindowStore
      .getState()
      .openTab({ kind: "library", itemId: 3, sessionId: 21 }).tabId;
    renderPanel(tabId);
    await paneMounted();
    await waitFor(() => {
      const grant = invokeMock.mock.calls.find(
        (c) => c[0] === "fileWindow:grantFilePath",
      );
      expect(grant?.[1]).toEqual({
        sessionId: 21,
        absPath: "/root/library/3.md",
      });
    });
  });
});
