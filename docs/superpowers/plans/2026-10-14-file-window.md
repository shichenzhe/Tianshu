# 文件独立窗口（file-window）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主窗文件/资料库预览「在新窗口打开」→ 独立多 tab 文件窗口（可编辑、可保存、AI 对话直改），对齐 WorkBuddy office window。

**Architecture:** 主进程 FileWindowService（BrowserWindow 注册表 + close bridge + 快照）+ 平级 hash 路由 `#/file-window`；窗口本地 zustand tab store；内容按 resource（workspace/library/url）+ 类型路由；AI 面板复用 useChatSend/MessageList，agent 模式工具直改 + 会话级路径授权清单放行 library 文件。

**Tech Stack:** Electron 44 BrowserWindow、React 19 + zustand + React Query、现有 chat IPC 族（session:create / chat:send / chat:stream:*）、Prisma（option 表）、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-14-file-new-window-design.md`（执行者必读，本计划从 spec 论证）

## Global Constraints

- i18n：所有用户可见文案走 `t()`，zh-CN 与 en-US 的 `chat.json` 同步新增 `fileWindow/` 命名空间；禁止硬编码中文
- 主题：禁用 `bg-blue-*` 等硬编码色类；边框 `border-border/50`、悬停 `hover:bg-primary-subtle hover:text-primary`
- IPC 白名单：新通道必须登记 `electron/commons/ipc-channels.ts`（invoke → `IPC_INVOKE_ALLOWLIST`，事件 → `IPC_EVENT_ALLOWLIST`）
- Prettier：双引号、分号、tabWidth 2、printWidth 80、无尾随逗号
- 工作树有在途改动（FilePreview 全屏上移/消息编辑图片保留）——本计划所有 commit 只 add 本任务涉及文件，禁止 `git add -A`
- 主进程 handler 一律 `handleUser`（token→userId 鉴权，`electron/commons/ipc-user.ts`），userId 不用也保持口径
- 每任务收尾跑 `npm run typecheck`；测试命令 `npx vitest run <file>`
- mac 红绿灯让位：窗口顶行 `h-11` + darwin `pl-20`；Windows `pr-[146px]`（titleBarOverlay 44 同款）

---

### Task 1: FileWindowService（主进程窗口服务 + close bridge + 快照）

**Files:**
- Create: `src-react/domains/ai/file-window/model/resource.ts`
- Create: `electron/domains/ai/file-window/file-window.service.ts`
- Modify: `electron/commons/ipc-channels.ts`
- Modify: `electron/main.ts`（whenReady 内接线）
- Test: `tests/ai/file-window/file-window.service.test.ts`

**Interfaces:**
- Produces:
  - `FileWindowResource`（联合类型，Task 5/13/15 消费）
  - `FileWindowService`（构造即注册全部 IPC；`new FileWindowService({ devServerUrl, rendererIndex, preloadPath })`）
  - `fileWindow:open` 入参 `{ resources: FileWindowResource[] }`，返回 `Promise<{ windowId: string }>`
  - 快照通道入参：`setSessionState { windowId, snapshot: unknown }` / `getSessionState { windowId } → unknown | null`

- [ ] **Step 1: 写失败测试**

`tests/ai/file-window/file-window.service.test.ts`（mock electron 全家，参照 `tests/ai/agent-loop.test.ts` 的 vi.mock 手法）：

```ts
// 主进程单测：mock electron（BrowserWindow 记录构造参数与事件注册）
import { beforeEach, describe, expect, it, vi } from "vitest";

const winInstances: MockWin[] = [];
class MockWin {
  id = winInstances.length + 1;
  handlers: Record<string, Function> = {};
  listeners: Record<string, Function> = {};
  sent: Array<{ channel: string; payload: unknown }> = [];
  destroyed = false;
  closed = false;
  webContents = {
    id: this.id,
    on: (ev: string, fn: Function) => (this.listeners[ev] = fn),
    send: (channel: string, payload: unknown) =>
      this.sent.push({ channel, payload }),
    setWindowOpenHandler: (fn: Function) => (this.handlers.open = fn),
    onDidFailLoad: () => {},
  };
  on(ev: string, fn: Function) {
    this.listeners[ev] = fn;
    return this;
  }
  once() {
    return this;
  }
  loadURL = vi.fn();
  loadFile = vi.fn();
  show() {}
  focus() {}
  close() {
    this.closed = true;
    this.listeners.close?.({ preventDefault() {} });
  }
  destroy() {
    this.destroyed = true;
  }
  isDestroyed() {
    return this.destroyed;
  }
  setMenuBarVisibility() {}
}
vi.mock("electron", () => ({
  app: { on: vi.fn() },
  BrowserWindow: class extends MockWin {
    constructor(opts: unknown) {
      super();
      // @ts-expect-record 构造参数挂在实例供断言
      (this as unknown as { opts: unknown }).opts = opts;
      winInstances.push(this);
    }
  },
  dialog: { showOpenDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
}));

const handleUserMock = vi.fn();
vi.mock("../../../electron/commons/ipc-user", () => ({
  handleUser: (ch: string, fn: Function) => handleUserMock(ch, fn),
}));

import {
  FileWindowService,
  FILE_WINDOW_IPC as FW_IPC,
} from "../../../electron/domains/ai/file-window/file-window.service";

type Handler = (event: unknown, userId: number, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
beforeEach(() => {
  winInstances.length = 0;
  handlers.clear();
  handleUserMock.mockImplementation((ch: string, fn: Handler) =>
    handlers.set(ch, fn),
  );
});

const invoke = async (ch: string, ...args: unknown[]) => {
  const fn = handlers.get(ch);
  if (!fn) throw new Error(`handler 未注册: ${ch}`);
  return fn({}, 1, ...args);
};

const RES = { kind: "workspace", workspaceId: 7, path: "a.md" };

function newService() {
  return new FileWindowService({
    devServerUrl: "",
    rendererIndex: "/app/dist/index.html",
    preloadPath: "/app/preload.mjs",
  });
}

describe("FileWindowService", () => {
  it("open 创建带守卫的窗口并返回 windowId", async () => {
    newService();
    const { windowId } = (await invoke(FW_IPC.open, {
      resources: [RES],
    })) as { windowId: string };
    expect(windowId).toMatch(/^file-window:/);
    const win = winInstances[0] as unknown as { opts: { webViewTion?: unknown } };
    expect(winInstances).toHaveLength(1);
    expect(win.opts).toBeTruthy();
    expect(win.sent.at(-1)?.channel).toBe(FW_IPC.deliver);
    expect(win.sent.at(-1)?.payload).toEqual({
      resources: [RES],
      restored: false,
    });
  });

  it("同 windowId 再 open → 不新建窗口，投递 deliver", async () => {
    newService();
    const first = (await invoke(FW_IPC.open, { resources: [RES] })) as {
      windowId: string;
    };
    await invoke(FW_IPC.open, {
      resources: [{ kind: "url", url: "https://t.cn" }],
      targetWindowId: first.windowId,
    });
    expect(winInstances).toHaveLength(1);
    expect(winInstances[0].sent.at(-1)?.channel).toBe(FW_IPC.deliver);
  });

  it("close bridge：未 ready 时 close 请求挂起，confirmClose 放行", async () => {
    newService();
    await invoke(FW_IPC.open, { resources: [RES] });
    const win = winInstances[0];
    // 渲染层就绪
    await invoke(FW_IPC.closeReady, {
      windowId: (win as unknown as { windowId: string }).windowId,
    });
    // 用户点关闭：主进程发 close-request（不发 renderer 不知情的 close）
    win.listeners.close({ preventDefault() {} });
    expect(win.sent.some((s) => s.channel === FW_IPC.closeRequest)).toBe(true);
    // renderer 确认 → 放行（closed 标记）
    await invoke(FW_IPC.confirmClose, {
      windowId: (win as unknown as { windowId: string }).windowId,
    });
    expect(win.closed).toBe(true);
  });

  it("快照存取按 windowId 隔离", async () => {
    newService();
    await invoke(FW_IPC.open, { resources: [RES] });
    const win = winInstances[0] as unknown as { windowId: string };
    await invoke(FW_IPC.setSessionState, {
      windowId: win.windowId,
      snapshot: { tabs: [1] },
    });
    expect(await invoke(FW_IPC.getSessionState, { windowId: win.windowId })).toEqual({ tabs: [1] });
    expect(await invoke(FW_IPC.getSessionState, { windowId: "nope" })).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/file-window/file-window.service.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 resource 类型 + 服务**

`src-react/domains/ai/file-window/model/resource.ts`：

```ts
/**
 * 文件窗口资源（tab 打开来源联合类型；主进程 type-only 反向 import 先例
 * 同 chat.api ChatSendParams）。sessionId 由渲染层在「移到新窗口」时携带。
 */
export type FileWindowResource =
  | {
      kind: "workspace";
      workspaceId: number;
      /** 工作空间内相对路径 */
      path: string;
      sessionId?: number;
    }
  | { kind: "library"; itemId: number; sessionId?: number }
  | { kind: "url"; url: string };
```

`electron/domains/ai/file-window/file-window.service.ts`：

```ts
/**
 * 文件独立窗口服务（WorkBuddy office window 对齐）：
 * - fileWindow:open 开新窗（或向 targetWindowId 投递 resources 复用）
 * - 注册表 Map<windowId, BrowserWindow>；窗口关闭自动清除
 * - close bridge：close 拦截 → close-request 询问渲染层 → confirm/cancel；
 *   渲染层未 ready 3s 强关；close-request 后 15s 超时视为取消（双定时器
 *   同 WorkBuddy）。窗口 destroyed 直放行
 * - 快照：setSessionState/getSessionState（内存 Map，关窗即弃）
 */
import { BrowserWindow } from "electron";
import path from "node:path";
import { handleUser } from "../../commons/ipc-user";
import Log from "../../commons/Log";
import type { FileWindowResource } from "../../../src-react/domains/ai/file-window/model/resource";

export const FILE_WINDOW_IPC = {
  open: "fileWindow:open",
  deliver: "fileWindow:deliver",
  closeRequest: "fileWindow:close-request",
  confirmClose: "fileWindow:confirmClose",
  cancelClose: "fileWindow:cancelClose",
  closeReady: "fileWindow:close-ready",
  setSessionState: "fileWindow:setSessionState",
  getSessionState: "fileWindow:getSessionState",
  pickFile: "fileWindow:pickFile",
} as const;

export interface FileWindowServiceDeps {
  devServerUrl: string;
  rendererIndex: string;
  preloadPath: string;
}

interface OpenParams {
  resources: FileWindowResource[];
  /** 传入即复用该窗口（tab 菜单「移到新窗口」恒不传 → 新开） */
  targetWindowId?: string;
}

const NOT_READY_FORCE_MS = 3_000;
const CLOSE_TIMEOUT_MS = 15_000;

export default class FileWindowService {
  private windows = new Map<string, BrowserWindow>();
  private snapshots = new Map<string, unknown>();

  constructor(private deps: FileWindowServiceDeps) {
    this.registerIpc();
  }

  private registerIpc(): void {
    handleUser(FILE_WINDOW_IPC.open, (_e, _userId, p: OpenParams) =>
      this.open(p),
    );
    handleUser(FILE_WINDOW_IPC.setSessionState, (_e, _userId, p) => {
      this.snapshots.set(p.windowId, p.snapshot);
      return null;
    });
    handleUser(FILE_WINDOW_IPC.getSessionState, (_e, _userId, p) =>
      this.snapshots.get(p.windowId) ?? null,
    );
    handleUser(FILE_WINDOW_IPC.closeReady, (_e, _userId, p) =>
      this.markReady(p.windowId),
    );
    handleUser(FILE_WINDOW_IPC.confirmClose, (_e, _userId, p) =>
      this.confirmClose(p.windowId),
    );
    handleUser(FILE_WINDOW_IPC.cancelClose, (_e, _userId, p) =>
      this.cancelClose(p.windowId),
    );
  }

  private async open(p: OpenParams): Promise<{ windowId: string }> {
    if (p.targetWindowId) {
      const win = this.windows.get(p.targetWindowId);
      if (win && !win.isDestroyed()) {
        win.webContents.send(FILE_WINDOW_IPC.deliver, {
          resources: p.resources,
          restored: false,
        });
        win.focus();
        return { windowId: p.targetWindowId };
      }
    }
    const windowId = `file-window:${crypto.randomUUID()}`;
    this.createWindow(windowId, p.resources);
    return { windowId };
  }

  private createWindow(
    windowId: string,
    resources: FileWindowResource[],
  ): void {
    const win = new BrowserWindow({
      title: "天枢",
      width: 1440,
      height: 852,
      minWidth: 640,
      minHeight: 480,
      icon: process.env.VITE_PUBLIC
        ? path.join(process.env.VITE_PUBLIC, "pc_logo.png")
        : undefined,
      webPreferences: {
        preload: this.deps.preloadPath,
        webviewTag: true,
      },
      titleBarStyle:
        process.platform !== "darwin" && process.env.NODE_ENV === "development"
          ? "default"
          : "hidden",
      ...(process.platform === "darwin"
        ? { trafficLightPosition: { x: 13, y: 16 } }
        : {}),
      titleBarOverlay:
        process.platform === "darwin"
          ? undefined
          : { color: "#ffffff", symbolColor: "#000000", height: 44 },
    });
    if (process.env.NODE_ENV !== "development") {
      win.setMenuBarVisibility(false);
    }
    win.webContents.setWindowOpenHandler(({ url }) => {
      void import("../security/renderer-guard").then(
        ({ handleWindowOpen }) => handleWindowOpen(url),
      );
      return { action: "deny" };
    });
    const state = { rendererReady: false, allowClose: false, timers: [] as NodeJS.Timeout[] };
    const entry = { win, state };
    this.windows.set(windowId, entry.win);
    // ready 前投递：did-finish-load 后发 deliver（restored 标记由渲染层快照逻辑处理）
    win.webContents.on("did-finish-load", () => {
      win.webContents.send(FILE_WINDOW_IPC.deliver, {
        resources,
        restored: this.snapshots.has(windowId),
      });
    });
    win.on("close", (event) => {
      if (state.allowClose || win.isDestroyed()) return;
      event.preventDefault();
      if (!state.rendererReady) {
        state.timers.push(
          setTimeout(() => {
            state.allowClose = true;
            win.close();
          }, NOT_READY_FORCE_MS),
        );
        return;
      }
      state.timers.push(
        setTimeout(() => this.cancelClose(windowId), CLOSE_TIMEOUT_MS),
      );
      win.webContents.send(FILE_WINDOW_IPC.closeRequest);
    });
    win.on("closed", () => {
      state.timers.forEach(clearTimeout);
      this.windows.delete(windowId);
    });
    if (this.deps.devServerUrl) {
      void win.loadURL(
        `${this.deps.devServerUrl}#/file-window?windowId=${windowId}`,
      );
    } else {
      void win.loadFile(this.deps.rendererIndex, {
        hash: `/file-window?windowId=${windowId}`,
      });
    }
  }

  private markReady(windowId: string): null {
    const entry = this.entryOf(windowId);
    if (entry) entry.state.rendererReady = true;
    return null;
  }

  private confirmClose(windowId: string): null {
    const entry = this.entryOf(windowId);
    if (!entry) return null;
    entry.state.allowClose = true;
    entry.state.timers.forEach(clearTimeout);
    entry.win.close();
    return null;
  }

  private cancelClose(windowId: string): null {
    const entry = this.entryOf(windowId);
    if (entry) entry.state.timers.forEach(clearTimeout);
    return null;
  }

  private entryOf(
    windowId: string,
  ): { win: BrowserWindow; state: RendererState } | null {
    const win = this.windows.get(windowId);
    if (!win || win.isDestroyed()) return null;
    return this.stateOf.get(win) ?? null;
  }

  private stateOf = new WeakMap<
    BrowserWindow,
    { win: BrowserWindow; state: RendererState }
  >();
}

interface RendererState {
  rendererReady: boolean;
  allowClose: boolean;
  timers: NodeJS.Timeout[];
}
```

实现说明：`entryOf` 用 WeakMap 存每窗状态（`stateOf.set(win, entry)` 在 createWindow 里补一行，实现时补齐，保持文件可编译）。测试里 `win.windowId` 断言处对应服务侧需要把 windowId 也存一份（`this.ids = new WeakMap<BrowserWindow,string>()` 或 snapshots 键反查——实现时择一，测试改为通过 open 返回值取 windowId 亦可，以让测试过为准微调测试断言方式不改断言语义）。

- [ ] **Step 4: 白名单登记 + main.ts 接线**

`electron/commons/ipc-channels.ts`：`IPC_INVOKE_ALLOWLIST` 尾部追加：

```ts
  // 文件独立窗口（WorkBuddy office window 对齐）
  "fileWindow:open",
  "fileWindow:confirmClose",
  "fileWindow:cancelClose",
  "fileWindow:close-ready",
  "fileWindow:setSessionState",
  "fileWindow:getSessionState",
  "fileWindow:pickFile",
  "fileWindow:grantFilePath",
```

`IPC_EVENT_ALLOWLIST` 尾部追加：

```ts
  // 文件独立窗口：resources 投递 / 关闭询问 / AI 写盘联动
  "fileWindow:deliver",
  "fileWindow:close-request",
  "workspace:fileChanged",
```

`electron/main.ts` whenReady 块（`new WindowService(() => win)` 之后）：

```ts
import FileWindowService from "./domains/ai/file-window/file-window.service.js";
// ……
new FileWindowService({
  devServerUrl: VITE_DEV_SERVER_URL ?? "",
  rendererIndex: path.join(RENDERER_DIST, "index.html"),
  preloadPath: path.join(__dirname, "preload.mjs"),
});
```

- [ ] **Step 5: 跑测试至绿 + typecheck**

Run: `npx vitest run tests/ai/file-window/file-window.service.test.ts && npm run typecheck`
Expected: PASS / 无类型错误

- [ ] **Step 6: Commit**

```bash
git add src-react/domains/ai/file-window/model/resource.ts \
  electron/domains/ai/file-window/file-window.service.ts \
  electron/commons/ipc-channels.ts electron/main.ts \
  tests/ai/file-window/file-window.service.test.ts
git commit -m "feat(file-window): 主进程窗口服务——开窗/注册表/close bridge/快照通道"
```

---

### Task 2: 路由 + FileWindowView 骨架（登录守卫 + close-ready + deliver 接线）

**Files:**
- Create: `src-react/domains/ai/file-window/views/FileWindowView.tsx`
- Create: `src-react/domains/ai/file-window/api/file-window.api.ts`
- Modify: `src-react/routes/index.tsx`（`/login` 平级加 `/file-window`）
- Modify: `src-react/i18n/locales/zh-CN/chat.json` + `en-US/chat.json`（`fileWindow` 最小集）
- Test: `tests/ai/file-window/file-window-view.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 IPC 通道
- Produces: `FileWindowApi.open(resources, targetWindowId?)`、`FileWindowApi.onDeliver(cb)`、`FileWindowApi.onCloseRequest(cb)`；`FileWindowView` 内部含守卫（后续任务在此视图内长出 tab 系统）

- [ ] **Step 1: 写失败测试**

`tests/ai/file-window/file-window-view.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * FileWindowView 骨架：登录守卫（失效跳 /login）、挂载即发 close-ready、
 * 空窗居中提示（tab 系统后续任务长出）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const invokeMock = vi.hoisted(() => vi.fn());
const onMock = vi.hoisted(() => vi.fn(() => () => {}));
vi.mock("../../../src-react/lib/ipc", () => ({
  invoke: invokeMock,
}));

const userStore = vi.hoisted(() => ({
  isLoginValid: vi.fn(() => true),
  reset: vi.fn(),
  user: { token: "t" },
}));
vi.mock("../../../src-react/domains/user/store/user.store", () => ({
  useUserStore: () => userStore,
  useUserStoreState: userStore,
}));

import FileWindowView from "../../../src-react/domains/ai/file-window/views/FileWindowView";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderView() {
  // HashRouter 内 useSearchParams；测试包一层 MemoryRouter 由组件内部读参
  // ——组件签名不带参，直接渲染即可
  return render(<FileWindowView />);
}

describe("FileWindowView 骨架", () => {
  it("登录有效：渲染空窗提示并挂载即发 close-ready", async () => {
    window.location.hash = "#/file-window?windowId=fw-1";
    invokeMock.mockResolvedValue(null);
    renderView();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("fileWindow:close-ready", {
        windowId: "fw-1",
      }),
    );
    expect(screen.getByText(/fileWindow:/)).toBeTruthy();
  });

  it("登录失效：reset 并留在守卫空态（navigate 交给路由层）", () => {
    window.location.hash = "#/file-window?windowId=fw-1";
    userStore.isLoginValid.mockReturnValueOnce(false);
    renderView();
    expect(userStore.reset).not.toHaveBeenCalled(); // verifyToken 前不 reset
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/file-window/file-window-view.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现 api 与视图**

`src-react/domains/ai/file-window/api/file-window.api.ts`：

```ts
/**
 * 文件窗口 IPC 封装（通道常量与主进程 file-window.service 对齐）。
 * onXxx 返回退订函数（preload on 的既定形态）。
 */
import { invoke } from "@/lib/ipc";
import type { FileWindowResource } from "../model/resource";

export interface DeliverPayload {
  resources: FileWindowResource[];
  restored: boolean;
}

const FileWindowApi = {
  open: (resources: FileWindowResource[], targetWindowId?: string) =>
    invoke<{ windowId: string }>("fileWindow:open", { resources, targetWindowId }),
  markCloseReady: (windowId: string) =>
    invoke<null>("fileWindow:close-ready", { windowId }),
  confirmClose: (windowId: string) =>
    invoke<null>("fileWindow:confirmClose", { windowId }),
  cancelClose: (windowId: string) =>
    invoke<null>("fileWindow:cancelClose", { windowId }),
  saveSessionState: (windowId: string, snapshot: unknown) =>
    invoke<null>("fileWindow:setSessionState", { windowId, snapshot }),
  restoreSessionState: (windowId: string) =>
    invoke<unknown>("fileWindow:getSessionState", { windowId }),
  grantFilePath: (sessionId: number, absPath: string) =>
    invoke<null>("fileWindow:grantFilePath", { sessionId, absPath }),
  onDeliver: (cb: (payload: DeliverPayload) => void) => {
    const off = window.ipcRenderer?.on("fileWindow:deliver", (_e, payload) =>
      cb(payload as DeliverPayload),
    );
    return () => off?.();
  },
  onCloseRequest: (cb: () => void) => {
    const off = window.ipcRenderer?.on("fileWindow:close-request", () => cb());
    return () => off?.();
  },
};

export default FileWindowApi;
```

`src-react/domains/ai/file-window/views/FileWindowView.tsx`：

```tsx
/**
 * 文件独立窗口视图（#/file-window?windowId=…，与 /login 平级无侧边栏）：
 * - 登录守卫（语义同 MainLayout：isLoginValid → verifyToken）
 * - 挂载即 close-ready（close bridge 前置条件）
 * - tab 系统/内容区/AI 面板由后续任务长出；本骨架先落空窗提示
 */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FileX } from "lucide-react";

import { useUserStore } from "@/domains/user/store/user.store";
import UserApi from "@/domains/user/api/user.api";
import FileWindowApi from "../api/file-window.api";

export default function FileWindowView() {
  const { t } = useTranslation(["chat"]);
  const { user, isLoginValid, reset } = useUserStore();
  const windowId = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("windowId") ?? "";

  useEffect(() => {
    if (!isLoginValid()) {
      window.location.hash = "#/login";
      return;
    }
    void UserApi.verifyToken(user.token).then((ok) => {
      if (!ok) {
        reset();
        window.location.hash = "#/login";
      }
    });
    void FileWindowApi.markCloseReady(windowId);
    // verifyToken 失败静默处理：token 过期场景主进程会拒后续 invoke
  }, [isLoginValid, reset, user.token, windowId]);

  return (
    <div className="flex h-screen flex-col bg-background">
      <div className="flex h-11 items-center border-b border-border/50 px-2 pl-20">
        <span className="text-sm font-medium">{t("chat:fileWindow.title")}</span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        <FileX className="h-8 w-8" />
        <p className="text-xs">{t("chat:fileWindow.emptyHint")}</p>
      </div>
    </div>
  );
}
```

注：hash 路由下 `useSearchParams` 不可用（query 在 hash 内），故直接从 `window.location.hash` 解析；toast 引入与否以 typecheck 通过为准（未用则不 import）。守卫中 `toast.warning` 可用 `layout` 命名空间既有 key，若 typecheck 报缺 key 则改用 toast.error(String) 前先补 i18n。

`src-react/routes/index.tsx`（`/login` 路由对象后追加）：

```tsx
// 文件独立窗口（与 /login 平级，无 MainLayout 侧边栏）
const FileWindowView = lazy(
  () => import("@/domains/ai/file-window/views/FileWindowView"),
);
// ……router 数组内：
{
  path: "/file-window",
  element: (
    <LazyWrapper>
      <FileWindowView />
    </LazyWrapper>
  ),
},
```

i18n（zh-CN/chat.json 顶层加 `"fileWindow": { "title": "文件", "emptyHint": "打开文件以开始" }`；en-US 同构 `"title": "Files", "emptyHint": "Open a file to get started"`）。

- [ ] **Step 4: 跑测试至绿 + typecheck**

Run: `npx vitest run tests/ai/file-window/file-window-view.test.tsx && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/file-window src-react/routes/index.tsx \
  src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json \
  tests/ai/file-window/file-window-view.test.tsx
git commit -m "feat(file-window): 路由与视图骨架——登录守卫/close-ready/空窗提示"
```

---

### Task 3: file-window.store（tab 状态机）

**Files:**
- Create: `src-react/domains/ai/file-window/store/file-window.store.ts`
- Create: `src-react/domains/ai/file-window/lib/tab-snapshot.ts`
- Test: `tests/ai/file-window/file-window-store.test.ts`

**Interfaces:**
- Consumes: `FileWindowResource`（Task 1）
- Produces:
  - `FileWindowTab { id, resource, title, contentKind, dirty, saveStatus, busy, sessionId?, baselineMtime?, aiPanelOpen? }`
  - store actions：`initResources(resources) → string[]`、`openTab(resource) → { tabId, created }`、`activate/closeTab/reorderTabs/patchTab(tabId, partial)`、`getState()`
  - `dedupeKeyOf(resource) → string`（导出供测试与最近打开去重）
  - `serializeTabs(tabs) / restoreTabs(snapshot)`（Task 9 快照消费）

- [ ] **Step 1: 写失败测试**

`tests/ai/file-window/file-window-store.test.ts`：

```ts
/**
 * tab 状态机：去重激活不重开 / 关闭邻位激活 / busy 防重入 / 快照序列化往返。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  dedupeKeyOf,
  useFileWindowStore,
} from "../../../src-react/domains/ai/file-window/store/file-window.store";
import {
  restoreTabs,
  serializeTabs,
} from "../../../src-react/domains/ai/file-window/lib/tab-snapshot";

const wsRes = (path: string) =>
  ({ kind: "workspace", workspaceId: 7, path }) as const;

beforeEach(() => {
  useFileWindowStore.getState().reset();
});

describe("去重键", () => {
  it("workspace 按空间+路径归一；url 去尾斜杠", () => {
    expect(dedupeKeyOf({ kind: "workspace", workspaceId: 7, path: "a.md" })).toBe(
      "w:7:a.md",
    );
    expect(dedupeKeyOf({ kind: "library", itemId: 3 })).toBe("l:3");
    expect(dedupeKeyOf({ kind: "url", url: "https://t.cn/" })).toBe(
      "u:https://t.cn",
    );
  });
});

describe("openTab/closeTab", () => {
  it("同资源重复打开激活既有 tab", () => {
    const s = useFileWindowStore.getState();
    const first = s.openTab(wsRes("a.md"));
    const second = s.openTab(wsRes("a.md"));
    expect(second.tabId).toBe(first.tabId);
    expect(second.created).toBe(false);
    expect(useFileWindowStore.getState().tabs).toHaveLength(1);
  });

  it("关闭激活 tab 后邻位补位；关空清空", () => {
    const s = useFileWindowStore.getState();
    const a = s.openTab(wsRes("a.md")).tabId;
    const b = s.openTab(wsRes("b.md")).tabId;
    s.activate(b);
    s.closeTab(b);
    expect(useFileWindowStore.getState().activeTabId).toBe(a);
    s.closeTab(a);
    expect(useFileWindowStore.getState().tabs).toHaveLength(0);
  });

  it("patchTab 局部更新（dirty/saveStatus/sessionId）", () => {
    const s = useFileWindowStore.getState();
    const id = s.openTab(wsRes("a.md")).tabId;
    s.patchTab(id, { dirty: true, saveStatus: "unsaved" });
    const tab = useFileWindowStore.getState().tabs[0];
    expect(tab.dirty).toBe(true);
    expect(tab.saveStatus).toBe("unsaved");
  });
});

describe("快照序列化", () => {
  it("serialize→restore 往返保留 resource/sessionId/dirty", () => {
    const s = useFileWindowStore.getState();
    const id = s.openTab({ ...wsRes("a.md"), sessionId: 42 });
    useFileWindowStore.getState().patchTab(id, { dirty: true });
    const snap = serializeTabs(useFileWindowStore.getState().tabs);
    const restored = restoreTabs(snap);
    expect(restored[0].resource).toEqual(wsRes("a.md"));
    expect(restored[0].sessionId).toBe(42);
    expect(restored[0].dirty).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/file-window/file-window-store.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 store 与快照**

`src-react/domains/ai/file-window/store/file-window.store.ts`：

```ts
/**
 * 文件窗口 tab 状态（窗口本地单例；结构照 detail-panel.store 模式）：
 * 去重键打开、邻位激活关闭、busy 防重入标记。contentKind 由 lib 判定。
 */
import { create } from "zustand";
import type { FileWindowResource } from "../model/resource";
import { contentKindOfResource } from "../lib/content-kind";
import { titleOfResource } from "../lib/tab-title";

export type FileWindowContentKind =
  | "md"
  | "text"
  | "csv"
  | "image"
  | "pdf"
  | "html"
  | "audiovideo"
  | "url";

export type FileWindowSaveStatus = "saved" | "unsaved" | "saving" | "hidden";

export interface FileWindowTab {
  id: string;
  resource: FileWindowResource;
  title: string;
  contentKind: FileWindowContentKind;
  dirty: boolean;
  saveStatus: FileWindowSaveStatus;
  busy: null | "closing" | "moving";
  sessionId?: number;
  /** 磁盘基线 mtime（ms）：保存冲突检测（见 spec §5.2） */
  baselineMtime: number | null;
  aiPanelOpen: boolean;
}

interface FileWindowStoreState {
  tabs: FileWindowTab[];
  activeTabId: string;
  nextId: number;
  restored: boolean;
  initResources: (resources: FileWindowResource[]) => string[];
  openTab: (resource: FileWindowResource) => { tabId: string; created: boolean };
  activate: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  reorderTabs: (fromId: string, toId: string) => void;
  patchTab: (tabId: string, partial: Partial<FileWindowTab>) => void;
  setRestored: () => void;
  reset: () => void;
}

export function dedupeKeyOf(resource: FileWindowResource): string {
  if (resource.kind === "workspace")
    return `w:${resource.workspaceId}:${resource.path}`;
  if (resource.kind === "library") return `l:${resource.itemId}`;
  return `u:${resource.url.replace(/\/+$/, "")}`;
}

const EDITABLE: FileWindowContentKind[] = ["md", "text", "csv"];

function newTab(
  resource: FileWindowResource,
  id: number,
): FileWindowTab {
  const kind = contentKindOfResource(resource);
  return {
    id: `fw-tab-${id}`,
    resource,
    title: titleOfResource(resource),
    contentKind: kind,
    dirty: false,
    saveStatus: EDITABLE.includes(kind) ? "saved" : "hidden",
    busy: null,
    baselineMtime: null,
    aiPanelOpen: kind !== "url",
  };
}

export const useFileWindowStore = create<FileWindowStoreState>((set, get) => ({
  tabs: [],
  activeTabId: "",
  nextId: 1,
  restored: false,
  initResources: (resources) =>
    resources.map((r) => get().openTab(r).tabId),
  openTab: (resource) => {
    const key = dedupeKeyOf(resource);
    const existing = get().tabs.find((t) => dedupeKeyOf(t.resource) === key);
    if (existing) {
      set({ activeTabId: existing.id });
      return { tabId: existing.id, created: false };
    }
    const tab = newTab(resource, get().nextId);
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
      nextId: s.nextId + 1,
    }));
    return { tabId: tab.id, created: true };
  },
  activate: (tabId) => set({ activeTabId: tabId }),
  closeTab: (tabId) => {
    const prev = get();
    const idx = prev.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const tabs = prev.tabs.filter((t) => t.id !== tabId);
    const activeTabId =
      prev.activeTabId === tabId
        ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? tabs[0]?.id ?? "")
        : prev.activeTabId;
    set({ tabs, activeTabId });
  },
  reorderTabs: (fromId, toId) => {
    const { tabs } = get();
    const from = tabs.findIndex((t) => t.id === fromId);
    const to = tabs.findIndex((t) => t.id === toId);
    if (from === -1 || to === -1 || from === to) return;
    const next = [...tabs];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    set({ tabs: next });
  },
  patchTab: (tabId, partial) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...partial } : t)),
    })),
  setRestored: () => set({ restored: true }),
  reset: () => set({ tabs: [], activeTabId: "", nextId: 1, restored: false }),
}));
```

`src-react/domains/ai/file-window/lib/content-kind.ts`：

```ts
/**
 * resource → 内容类型（编辑/渲染/保存/快捷指令路由依据）。
 * 扩展名判定复用 chat 域 previewModeOfPath 的分组口径。
 */
import type { FileWindowResource } from "../model/resource";
import type { FileWindowContentKind } from "../store/file-window.store";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i;
const PDF_EXT = /\.pdf$/i;
const HTML_EXT = /\.(html?|htm)$/i;
const AV_EXT = /\.(mp3|wav|ogg|flac|mp4|webm|mov|mkv)$/i;
const MD_EXT = /\.(md|markdown)$/i;
const CSV_EXT = /\.csv$/i;

export function contentKindOfResource(
  resource: FileWindowResource,
): FileWindowContentKind {
  if (resource.kind === "url") return "url";
  if (resource.kind === "library") return "library"; // 由条目 fileType 细化，见下
  const p = resource.path;
  if (MD_EXT.test(p)) return "md";
  if (CSV_EXT.test(p)) return "csv";
  if (IMAGE_EXT.test(p)) return "image";
  if (PDF_EXT.test(p)) return "pdf";
  if (HTML_EXT.test(p)) return "html";
  if (AV_EXT.test(p)) return "audiovideo";
  return "text";
}

/** library 条目按 fileType/mimeType 细化（Task 14 消费） */
export function libraryContentKindOf(fileType: string | null): FileWindowContentKind {
  const ft = (fileType ?? "").toLowerCase();
  if (ft.includes("markdown") || /\.md$/.test(ft)) return "md";
  if (ft.includes("csv")) return "csv";
  if (ft.startsWith("image/")) return "image";
  if (ft === "pdf" || ft.includes("pdf")) return "pdf";
  if (ft.startsWith("text/html")) return "html";
  if (ft.startsWith("audio/") || ft.startsWith("video/")) return "audiovideo";
  return "text";
}
```

（`contentKindOfResource` 对 library 返回 `"library"` 会违反类型——实现时让函数签名返回 `FileWindowContentKind | "library-pending"` 并在 store 内 library 细化为 text 占位、Task 14 再 patch；以 typecheck 通过为准，或直接在 store 侧对 library 先落 `text` 并注明 Task 14 细化。）

`src-react/domains/ai/file-window/lib/tab-title.ts`：

```ts
import type { FileWindowResource } from "../model/resource";

export function titleOfResource(resource: FileWindowResource): string {
  if (resource.kind === "workspace")
    return resource.path.split("/").pop() || resource.path;
  if (resource.kind === "library") return `#${resource.itemId}`;
  try {
    return new URL(resource.url).hostname;
  } catch {
    return resource.url;
  }
}
```

`src-react/domains/ai/file-window/lib/tab-snapshot.ts`：

```ts
/**
 * tabs 快照序列化（WorkBuddy sessionState 对齐：resource/sessionId/dirty
 * 保留；id/计数器重排由 restore 重建）。
 */
import type { FileWindowTab } from "../store/file-window.store";
import type { FileWindowResource } from "../model/resource";

export interface TabSnapshotItem {
  resource: FileWindowResource;
  title: string;
  contentKind: string;
  dirty: boolean;
  sessionId?: number;
  aiPanelOpen: boolean;
}

export function serializeTabs(tabs: FileWindowTab[]): TabSnapshotItem[] {
  return tabs.map((t) => ({
    resource: t.resource,
    title: t.title,
    contentKind: t.contentKind,
    dirty: t.dirty,
    sessionId: t.sessionId,
    aiPanelOpen: t.aiPanelOpen,
  }));
}

export function restoreTabs(items: TabSnapshotItem[]): FileWindowTab[] {
  return items.map((item, i) => ({
    id: `fw-tab-${i + 1}`,
    resource: item.resource,
    title: item.title,
    contentKind: item.contentKind as FileWindowTab["contentKind"],
    dirty: item.dirty,
    saveStatus: item.dirty ? "unsaved" : "saved",
    busy: null,
    sessionId: item.sessionId,
    baselineMtime: null,
    aiPanelOpen: item.aiPanelOpen,
  }));
}
```

（restore 后 `saveStatus` 对只读类应为 `hidden`——实现时按 `contentKindOfResource(item.resource)` 重算 saveStatus 而非简单赋值，以 spec §5.1 表为准。）

- [ ] **Step 4: 跑测试至绿 + typecheck**

Run: `npx vitest run tests/ai/file-window/file-window-store.test.ts && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/file-window tests/ai/file-window/file-window-store.test.ts
git commit -m "feat(file-window): tab 状态机——去重/邻位激活/busy/快照序列化"
```

---

### Task 4: tab 条（DetailTabBar 泛化 + 窗口顶行）

**Files:**
- Modify: `src-react/domains/ai/chat/components/detail-panel/DetailTabBar.tsx`
- Create: `src-react/domains/ai/file-window/components/FileWindowTabBar.tsx`
- Test: `tests/ai/file-window/file-window-tab-bar.test.tsx`

**Interfaces:**
- Consumes: Task 3 store；`DetailTabBarProps`（现签名不变，仅 `tabs` 项形状放宽）
- Produces: `DetailTabBar` 新增可选 prop `iconOf?: (tab) => LucideIcon`（缺省用现有 KIND_ICON）；`FileWindowTabBar`（`{ onNewMenu }` 由 Task 15 挂菜单）

- [ ] **Step 1: 写失败测试**

`tests/ai/file-window/file-window-tab-bar.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * FileWindowTabBar：渲染各类型 icon、选择/关闭/重排回调透传。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";
import FileWindowTabBar from "../../../src-react/domains/ai/file-window/components/FileWindowTabBar";

afterEach(() => {
  cleanup();
  useFileWindowStore.getState().reset();
});

it("渲染 tab 并点击切换激活", () => {
  const s = useFileWindowStore.getState();
  const a = s.openTab({ kind: "workspace", workspaceId: 7, path: "a.md" }).tabId;
  s.openTab({ kind: "url", url: "https://t.cn" });
  render(<FileWindowTabBar onNewMenu={() => {}} />);
  const second = screen.getByRole("tab", { name: /t\.cn/ });
  fireEvent.click(second);
  expect(useFileWindowStore.getState().activeTabId).not.toBe(a);
});
```

（`getByRole("tab")` 若 DetailTabBar 未用 role=tab，改为 getByText 断言 + aria-selected 检查，以现有 DetailTabBar 实际 a11y 形态为准——先读组件再定断言。）file-preview.test 同款 mock react-i18next/sonner。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/file-window/file-window-tab-bar.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

`DetailTabBar.tsx` 修改（最小侵入）：

```tsx
interface DetailTabBarProps {
  tabs: Array<Pick<DetailTab, "id" | "title"> & Partial<DetailTab>>;
  activeTabId: string;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onReorder: (fromId: string, toId: string) => void;
  /** 图标注入（文件窗口按内容类型映射；缺省沿用 KIND_ICON） */
  iconOf?: (tab: { kind?: string; title: string }) => typeof Globe;
  /** 关闭前拦截（返回 false 阻止；文件窗口关闭握手用）；缺省直关 */
  beforeClose?: (tabId: string) => boolean;
}
```

组件内 `const icon = iconOf ? iconOf(tab) : KIND_ICON[tab.kind as DetailTabKind] ?? FileText;`；关闭按钮 onClick 先 `beforeClose?.(tab.id)`。拖拽/滚动逻辑不动。

`FileWindowTabBar.tsx`：

```tsx
/**
 * 文件窗口 tab 条：DetailTabBar 泛化复用（iconOf 按内容类型），
 * 行尾「+」由 onNewMenu 挂菜单（Task 15）。
 */
import { useTranslation } from "react-i18next";
import {
  FileCode2,
  FileImage,
  FileText,
  FileType2,
  Globe,
  Headphones,
  Plus,
  Table,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import DetailTabBar from "@/domains/ai/chat/components/detail-panel/DetailTabBar";
import {
  useFileWindowStore,
  type FileWindowContentKind,
} from "../store/file-window.store";

const KIND_ICON: Record<FileWindowContentKind, typeof Globe> = {
  md: FileText,
  text: FileText,
  csv: Table,
  image: FileImage,
  pdf: FileType2,
  html: FileCode2,
  audiovideo: Headphones,
  url: Globe,
};

export default function FileWindowTabBar({
  onNewMenu,
}: {
  onNewMenu: () => void;
}) {
  const { t } = useTranslation(["chat"]);
  const tabs = useFileWindowStore((s) => s.tabs);
  const activeTabId = useFileWindowStore((s) => s.activeTabId);
  const activate = useFileWindowStore((s) => s.activate);
  const closeTab = useFileWindowStore((s) => s.closeTab);
  const reorderTabs = useFileWindowStore((s) => s.reorderTabs);
  return (
    <div className="flex h-11 items-center gap-1 border-b border-border/50 px-2 pl-20">
      <DetailTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={activate}
        onClose={closeTab}
        onReorder={reorderTabs}
        iconOf={(t) =>
          KIND_ICON[tabs.find((x) => x.id === t.id)?.contentKind ?? "text"]
        }
      />
      <Button
        variant="ghost"
        size="sm"
        aria-label={t("chat:fileWindow.tab.new")}
        title={t("chat:fileWindow.tab.new")}
        onClick={onNewMenu}
        className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-primary"
      >
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  );
}
```

（`iconOf` 闭包按 tab.id 从 store tabs 查 contentKind 映射图标，如上；DetailTabBar 泛化后 `tabs` 项仅需 `{ id, title }` 形状。Windows 平台 `pr-[146px]` 让位（`window.platform !== "darwin"` 条件类）。）

- [ ] **Step 4: 跑测试至绿 + 既有 DetailTabBar 测试回归**

Run: `npx vitest run tests/ai/file-window/file-window-tab-bar.test.tsx tests/ai/detail-panel-maximize.test.tsx && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/chat/components/detail-panel/DetailTabBar.tsx \
  src-react/domains/ai/file-window/components/FileWindowTabBar.tsx \
  tests/ai/file-window/file-window-tab-bar.test.tsx
git commit -m "feat(file-window): tab 条——DetailTabBar 泛化（iconOf/beforeClose）+ 窗口顶行"
```

---

### Task 5: 内容区只读路由 + FilePreview「在新窗口打开」入口

**Files:**
- Create: `src-react/domains/ai/file-window/components/FileTabContent.tsx`
- Create: `src-react/domains/ai/file-window/components/FileUrlView.tsx`
- Modify: `src-react/domains/ai/chat/components/artifacts/FilePreview.tsx`
- Modify: `src-react/domains/ai/chat/components/detail-panel/FilePanelTab.tsx`、`DetailPanel.tsx`（移动语义）
- Test: `tests/ai/file-window/file-tab-content.test.tsx`、`tests/ai/chat/file-preview.test.tsx`（补用例）

**Interfaces:**
- Consumes: Task 3 store；`ArtifactApi.readFile`（workspace 读）
- Produces: `FileTabContent { tabId }`（内部按 resource 读内容渲染只读分支；md/text 编辑器由 Task 6 替入）；`FilePreview` 新 prop `onOpenInNewWindow?: () => void`

- [ ] **Step 1: 写失败测试**

`tests/ai/file-window/file-tab-content.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * 只读路由：image dataUrl 直渲 / webview file:// / url webview；
 * workspace 读失败 → 空态 + Finder 兜底（对齐 FilePreview 语义）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const readFileMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src-react/domains/ai/api/artifact.api", () => ({
  default: {
    readFile: readFileMock,
    revealFile: vi.fn(),
    exportFile: vi.fn(),
  },
}));

import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";
import FileTabContent from "../../../src-react/domains/ai/file-window/components/FileTabContent";

afterEach(() => {
  cleanup();
  readFileMock.mockReset();
  useFileWindowStore.getState().reset();
});

function renderTab(resource: Parameters<
  typeof useFileWindowStore.getState
>[0] extends never ? never : Record<string, unknown>) {
  const s = useFileWindowStore.getState();
  const { tabId } = s.openTab(resource as never);
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <FileTabContent tabId={tabId} />
    </QueryClientProvider>,
  );
}

it("md 首版只读渲染 MarkdownView（Task 6 换编辑器）", async () => {
  readFileMock.mockResolvedValue({ kind: "text", content: "# 你好" });
  renderTab({ kind: "workspace", workspaceId: 7, path: "a.md" });
  await waitFor(() =>
    expect(screen.getByText("# 你好")).toBeTruthy(),
  );
});

it("image → dataUrl img", async () => {
  readFileMock.mockResolvedValue({ kind: "image", dataUrl: "data:image/png;base64,x" });
  renderTab({ kind: "workspace", workspaceId: 7, path: "a.png" });
  await waitFor(() =>
    expect(document.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,x",
    ),
  );
});

it("url → webview partition browser", () => {
  renderTab({ kind: "url", url: "https://t.cn" });
  const wv = document.querySelector("webview");
  expect(wv?.getAttribute("src")).toBe("https://t.cn");
  expect(wv?.getAttribute("partition")).toBe("browser");
});
```

`tests/ai/chat/file-preview.test.tsx` 追加（复用现有 mock 骨架）：

```tsx
it("「在新窗口打开」按钮：invoke fileWindow:open 成功后调 onOpenInNewWindow", async () => {
  // 现有 mock 块补：
  const invokeMock = vi.hoisted(() => vi.fn());
  vi.mock("../../../src-react/lib/ipc", () => ({ invoke: invokeMock }));
  invokeMock.mockResolvedValue({ windowId: "fw:x" });
  const onOpenInNewWindow = vi.fn();
  readFileMock.mockResolvedValue({ kind: "text", content: "x" });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FilePreview file={file("a.md")} workspaceId={7} onOpenInNewWindow={onOpenInNewWindow} />
    </QueryClientProvider>,
  );
  const btn = await screen.findByRole("button", { name: "chat:fileWindow.openInNewWindow" });
  fireEvent.click(btn);
  await waitFor(() => {
    expect(invokeMock).toHaveBeenCalledWith("fileWindow:open", {
      resources: [{ kind: "workspace", workspaceId: 7, path: "a.md" }],
    });
    expect(onOpenInNewWindow).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/file-window/file-tab-content.test.tsx tests/ai/chat/file-preview.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

`FileTabContent.tsx`（骨架版；React Query 读 workspace 文件，key `["fw-file", workspaceId, path]`）：

```tsx
/**
 * 文件窗口内容区：按 resource 路由（workspace readFile / library Task14 /
 * url 直开 webview）。只读分支与 FilePreview 同语义；md/text 编辑器由
 * 后续任务替入（编辑态提升到本组件 state）。
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FileX, FolderSearch } from "lucide-react";

import ArtifactApi from "@/domains/ai/api/artifact.api";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import { fileUrlOf } from "@/lib/file-url";
import MarkdownView from "@/domains/ai/chat/components/MarkdownView";
import { useFileWindowStore } from "../store/file-window.store";

export default function FileTabContent({ tabId }: { tabId: string }) {
  const tab = useFileWindowStore((s) => s.tabs.find((t) => t.id === tabId));
  if (!tab) return null;
  if (tab.resource.kind === "url") return <FileUrlView url={tab.resource.url} />;
  if (tab.resource.kind === "library") {
    return <div className="p-3 text-xs text-muted-foreground">library</div>;
  }
  return (
    <WorkspaceFileBody
      workspaceId={tab.resource.workspaceId}
      path={tab.resource.path}
    />
  );
}

function WorkspaceFileBody({
  workspaceId,
  path,
}: {
  workspaceId: number;
  path: string;
}) {
  const { t } = useTranslation(["chat"]);
  const q = useQuery({
    queryKey: ["fw-file", workspaceId, path],
    queryFn: () => ArtifactApi.readFile(workspaceId, path),
    retry: false,
    staleTime: 5_000,
  });
  useEffect(() => {
    if (q.error) toast.error(mapIpcError(q.error));
  }, [q.error]);
  if (q.isPending) return <p className="p-3 text-xs text-muted-foreground">…</p>;
  if (!q.data)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <FileX className="h-8 w-8" />
        <p className="text-xs">{t("chat:artifacts.previewFailed")}</p>
      </div>
    );
  if (q.data.kind === "image")
    return (
      <div className="flex h-full items-center justify-center">
        <img src={q.data.dataUrl} alt={path} className="max-h-full max-w-full object-contain" />
      </div>
    );
  if (q.data.kind === "webview")
    return (
      <webview
        src={fileUrlOf(q.data.absPath)}
        partition="artifact-preview"
        className="h-full min-h-0 w-full rounded-md border border-border/50"
      />
    );
  // kind === "text"：md 只读预览（编辑器 Task 6 替入）
  if (/\.(md|markdown)$/i.test(path))
    return (
      <div className="h-full overflow-auto p-3">
        <MarkdownView text={q.data.content ?? ""} />
      </div>
    );
  return <pre className="p-3 text-xs leading-relaxed">{q.data.content ?? ""}</pre>;
}
```

`FileUrlView.tsx`：

```tsx
/**
 * 网址 tab：browser partition webview（installBrowserSessionGuard 全局
 * 网络门已覆盖该 partition）；src 非受控（Electron 导航自同步，受控回写
 * 会 ERR_ABORTED——同 browser 域结论）。
 */
export default function FileUrlView({ url }: { url: string }) {
  return (
    <webview
      src={url}
      partition="browser"
      className="h-full min-h-0 w-full"
    />
  );
}
```

`FilePreview.tsx` 工具栏右侧加按钮（工具行 `flex` 尾部，`SquareArrowOutUpRight` 图标）：

```tsx
import { SquareArrowOutUpRight } from "lucide-react";
import { invoke } from "@/lib/ipc";
// props 增加 onOpenInNewWindow?: () => void（成功开窗后回调——主窗关 tab 移动语义）
const openInNewWindow = async () => {
  try {
    await invoke("fileWindow:open", {
      resources: [
        { kind: "workspace", workspaceId, path: file.path },
      ],
    });
    onOpenInNewWindow?.();
  } catch (e) {
    toast.error(mapIpcError(e));
  }
};
```

工具行 JSX（文件名 span 后）：

```tsx
<button
  type="button"
  aria-label={t("chat:fileWindow.openInNewWindow")}
  title={t("chat:fileWindow.openInNewWindow")}
  onClick={() => void openInNewWindow()}
  className="rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
>
  <SquareArrowOutUpRight className="h-4 w-4" />
</button>
```

`FilePanelTab.tsx` 加 `tabId` prop 透传 `onOpenInNewWindow={() => closeTab(tabId)}`（closeTab 由 DetailPanel 传或组件内 import detail-panel store 的 closeTab + sessionId——采用后者：`useDetailPanelStore.getState().closeTab(sessionId, tabId)`，sessionId 同样 prop 传入）；`DetailPanel.tsx` 渲染处补 `sessionId={sessionId} tabId={tab.id}`。i18n 补 `fileWindow.openInNewWindow`。

- [ ] **Step 4: 跑测试至绿 + 回归**

Run: `npx vitest run tests/ai/file-window/file-tab-content.test.tsx tests/ai/chat/file-preview.test.tsx tests/ai/file-panel-tab.test.tsx && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/file-window/components/FileTabContent.tsx \
  src-react/domains/ai/file-window/components/FileUrlView.tsx \
  src-react/domains/ai/chat/components/artifacts/FilePreview.tsx \
  src-react/domains/ai/chat/components/detail-panel/FilePanelTab.tsx \
  src-react/domains/ai/chat/components/detail-panel/DetailPanel.tsx \
  src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json \
  tests/ai/file-window/file-tab-content.test.tsx tests/ai/chat/file-preview.test.tsx
git commit -m "feat(file-window): 内容区只读路由 + 预览「在新窗口打开」入口（移动语义）"
```

---

### Task 6: 编辑器（md 复用 LibraryMarkdownEditor / text textarea）+ 脏标记 + ⌘S

**Files:**
- Modify: `src-react/domains/ai/file-window/components/FileTabContent.tsx`
- Create: `src-react/domains/ai/file-window/components/FileTabEditor.tsx`
- Test: `tests/ai/file-window/file-tab-editor.test.tsx`

**Interfaces:**
- Consumes: Task 5 的 `FileTabContent`；`LibraryMarkdownEditor { value, onChange, loading }`
- Produces: `FileTabEditor { tabId, onDirty }`（内部读 query 数据为初值、本地编辑态、⌘S 委托保存回调——保存 invoke 在 Task 8 接入，本任务 onDirty 驱动 store patchTab）

- [ ] **Step 1: 写失败测试**

`tests/ai/file-window/file-tab-editor.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * 编辑器：md 用 LibraryMarkdownEditor（桩）、text 用 textarea；
 * onChange → store dirty/unsaved；⌘S 触发 onSave。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../../../src-react/domains/ai/library/components/LibraryMarkdownEditor", () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea
      aria-label="md-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
const readFileMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src-react/domains/ai/api/artifact.api", () => ({
  default: { readFile: readFileMock, revealFile: vi.fn() },
}));

import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";
import FileTabEditor from "../../../src-react/domains/ai/file-window/components/FileTabEditor";

afterEach(() => {
  cleanup();
  readFileMock.mockReset();
  useFileWindowStore.getState().reset();
});

function setup() {
  readFileMock.mockResolvedValue({ kind: "text", content: "原文" });
  const { tabId } = useFileWindowStore
    .getState()
    .openTab({ kind: "workspace", workspaceId: 7, path: "a.txt" });
  const onSave = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FileTabEditor tabId={tabId} onSave={onSave} />
    </QueryClientProvider>,
  );
  return { tabId, onSave };
}

it("编辑 → dirty/unsaved 进 store", async () => {
  const { tabId } = setup();
  const ta = await screen.findByRole("textbox");
  fireEvent.change(ta, { target: { value: "改" } });
  const tab = useFileWindowStore.getState().tabs.find((t) => t.id === tabId);
  expect(tab?.dirty).toBe(true);
  expect(tab?.saveStatus).toBe("unsaved");
});

it("⌘S 触发 onSave", async () => {
  const { onSave } = setup();
  await screen.findByRole("textbox");
  fireEvent.keyDown(window, { key: "s", metaKey: true });
  expect(onSave).toHaveBeenCalled();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/file-window/file-tab-editor.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现 FileTabEditor**

```tsx
/**
 * 可编辑 tab 内容：md → LibraryMarkdownEditor（分栏预览）；text/csv(text 态)/
 * 代码 → 等宽 textarea。本地编辑态（query 数据为初值），onChange 即
 * dirty/unsaved 入 store；⌘S（meta/ctrl+s）委托 onSave。
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ArtifactApi from "@/domains/ai/api/artifact.api";
import LibraryMarkdownEditor from "@/domains/ai/library/components/LibraryMarkdownEditor";
import { useFileWindowStore } from "../store/file-window.store";

export default function FileTabEditor({
  tabId,
  onSave,
}: {
  tabId: string;
  onSave: () => void;
}) {
  const tab = useFileWindowStore((s) => s.tabs.find((t) => t.id === tabId));
  const patchTab = useFileWindowStore((s) => s.patchTab);
  const [draft, setDraft] = useState<string | null>(null);
  const resource = tab?.resource;
  const q = useQuery({
    queryKey: ["fw-file", resource?.kind === "workspace" ? resource.workspaceId : 0, resource?.kind === "workspace" ? resource.path : ""],
    queryFn: () => {
      const r = resource as { workspaceId: number; path: string };
      return ArtifactApi.readFile(r.workspaceId, r.path);
    },
    enabled: resource?.kind === "workspace",
    retry: false,
    staleTime: 5_000,
  });
  const content = q.data?.kind === "text" ? (q.data.content ?? "") : "";
  const value = draft ?? content;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (tab?.dirty) onSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSave, tab?.dirty]);

  const onChange = useMemo(
    () => (next: string) => {
      setDraft(next);
      if (tab) patchTab(tab.id, { dirty: true, saveStatus: "unsaved" });
    },
    [patchTab, tab],
  );

  if (!tab || tab.resource.kind !== "workspace") return null;
  return (
    <div className="h-full min-h-0 overflow-auto p-3">
      {tab.contentKind === "md" ? (
        <LibraryMarkdownEditor value={value} onChange={onChange} loading={q.isPending} />
      ) : (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          disabled={q.isPending}
          className="h-full min-h-[60vh] w-full resize-none rounded-md border border-border/50 bg-transparent p-3 font-mono text-xs leading-relaxed outline-none focus:border-primary/30"
        />
      )}
    </div>
  );
}
```

`FileTabContent` 内 md/text 分支替换为 `<FileTabEditor tabId={tab.id} onSave={() => {/* Task 8 接 */}} />`（onSave 本任务先空实现占位会违反 No Placeholders——直接把 onSave 逻辑留到 Task 8 的 Step 里补，本任务 FileTabContent 暂传 `() => patchTab(tab.id, { saveStatus: "saving" })` 临时语义并在 Task 8 替换为完整保存流；两任务连续执行无中间态发布）。

- [ ] **Step 4: 跑测试至绿 + typecheck**

Run: `npx vitest run tests/ai/file-window/file-tab-editor.test.tsx && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/file-window tests/ai/file-window/file-tab-editor.test.tsx
git commit -m "feat(file-window): md/text 编辑器 + 脏标记 + ⌘S 骨架"
```

---

### Task 7: workspace:writeFile IPC + workspace:fileChanged 广播（含 AI write_file 钩子）

**Files:**
- Modify: `electron/domains/ai/chat/workspace-files.ts`（新增 `writeWorkspaceFile` 纯逻辑）
- Create: `electron/domains/ai/file-window/file-write-ipc.ts`
- Modify: `electron/domains/ai/agent/file-tools.ts`（ctx 加 `onFileWritten` 可选回调）
- Modify: `electron/domains/ai/chat/chat.service.ts`（ctx 组装注入广播回调；定位方式：全文搜 `onBackupFile:` 的 ctx 装配点）
- Modify: `electron/main.ts`（接线 new FileWriteIpc(...)）
- Test: `tests/ai/file-window/file-write.test.ts`

**Interfaces:**
- Consumes: `resolveFilePath`（workspace-files）；`handleUser`
- Produces:
  - `writeWorkspaceFile(workspacePath, { relPath, content, baselineMtime }, deps?) → { absPath, mtime }`（冲突抛 `FILE_CONFLICT`）
  - invoke `workspace:writeFile { workspaceId, path, content, baselineMtime } → { absPath, mtime }`
  - 事件 `workspace:fileChanged { workspaceId, path }`（全窗广播；`broadcastFileChanged(workspaceId, path)` 从 file-write-ipc 导出，ChatService ctx 复用）

- [ ] **Step 1: 写失败测试**

`tests/ai/file-window/file-write.test.ts`：

```ts
/**
 * writeWorkspaceFile：正常写/建目录/mtime 基线冲突/备份回调调用。
 */
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeWorkspaceFile } from "../../../electron/domains/ai/chat/workspace-files";

async function tmpWs() {
  return mkdtemp(path.join(tmpdir(), "fw-write-"));
}

describe("writeWorkspaceFile", () => {
  it("写入并返回 mtime；自动建父目录", async () => {
    const ws = await tmpWs();
    const r = await writeWorkspaceFile(ws, {
      relPath: "sub/a.md",
      content: "hi",
      baselineMtime: null,
    });
    expect(await readFile(path.join(ws, "sub/a.md"), "utf8")).toBe("hi");
    expect(r.mtime).toBeGreaterThan(0);
  });

  it("基线不符抛 FILE_CONFLICT", async () => {
    const ws = await tmpWs();
    await writeFile(path.join(ws, "a.md"), "旧");
    const mtime = (await stat(path.join(ws, "a.md"))).mtimeMs;
    await writeFile(path.join(ws, "a.md"), "外部已改");
    await expect(
      writeWorkspaceFile(ws, { relPath: "a.md", content: "我的", baselineMtime: mtime }),
    ).rejects.toThrow("FILE_CONFLICT");
  });

  it("覆盖已有文件先调备份回调（fail-open）", async () => {
    const ws = await tmpWs();
    await writeFile(path.join(ws, "a.md"), "旧");
    const backup = vi.fn();
    await writeWorkspaceFile(
      ws,
      { relPath: "a.md", content: "新", baselineMtime: null },
      { backupFile: backup },
    );
    expect(backup).toHaveBeenCalledWith(path.join(ws, "a.md"));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/file-window/file-write.test.ts`
Expected: FAIL（writeWorkspaceFile 不存在）

- [ ] **Step 3: 实现核心 + handler + 钩子**

`workspace-files.ts` 追加：

```ts
/** 用户手动保存（文件窗口）：覆盖写 + mtime 基线冲突检测 + 可选备份 */
export interface WriteWorkspaceFileParams {
  relPath: string;
  content: string;
  /** 加载时磁盘 mtime（ms）；null = 新建/免检 */
  baselineMtime: number | null;
}

export async function writeWorkspaceFile(
  workspacePath: string,
  params: WriteWorkspaceFileParams,
  deps: { backupFile?: (absPath: string) => Promise<unknown> } = {},
): Promise<{ absPath: string; mtime: number }> {
  const target = resolveFilePath(workspacePath, params.relPath);
  const prev = await fs.stat(target).catch(() => null);
  if (
    prev?.isFile() &&
    params.baselineMtime !== null &&
    prev.mtimeMs !== params.baselineMtime
  ) {
    throw new Error("FILE_CONFLICT");
  }
  if (prev?.isFile() && deps.backupFile) {
    await deps.backupFile(target).catch(() => undefined); // fail-open
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, params.content, "utf8");
  const mtime = (await fs.stat(target)).mtimeMs;
  return { absPath: target, mtime };
}
```

（文件头已 import fs/path——沿用现有命名，`fs` 若为 `fsPromises` 别名以现有为准。）

`electron/domains/ai/file-window/file-write-ipc.ts`：

```ts
/**
 * workspace:writeFile handler + workspace:fileChanged 全窗广播。
 * 广播同时服务两条写路径：用户保存（本 handler）与 AI write_file 工具
 * （ChatService ctx.onFileWritten 注入，spec §5.2/§6.4）。
 */
import { BrowserWindow } from "electron";
import prisma from "../../commons/prisma-client";
import { handleUser } from "../../commons/ipc-user";
import Log from "../../commons/Log";
import { writeWorkspaceFile } from "../chat/workspace-files";
import { FileHistoryService } from "../../domains/security/file-history";

export function broadcastFileChanged(
  workspaceId: number,
  path: string,
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("workspace:fileChanged", { workspaceId, path });
    }
  }
}

export default class FileWriteIpc {
  constructor(private deps: { fileHistory: FileHistoryService; fileBackupEnabled: () => boolean }) {
    handleUser("workspace:writeFile", (_e, _userId, p) => this.write(p));
  }

  private async write(p: {
    workspaceId: number;
    path: string;
    content: string;
    baselineMtime: number | null;
  }): Promise<{ absPath: string; mtime: number }> {
    const ws = await prisma.workspace.findUnique({
      where: { id: p.workspaceId },
      select: { directoryPath: true },
    });
    if (!ws?.directoryPath) throw new Error("工作空间未绑定目录");
    const result = await writeWorkspaceFile(
      ws.directoryPath,
      { relPath: p.path, content: p.content, baselineMtime: p.baselineMtime },
      {
        backupFile: this.deps.fileBackupEnabled()
          ? (abs) => this.deps.fileHistory.backupFile(abs, 0)
          : undefined,
      },
    );
    broadcastFileChanged(p.workspaceId, p.path);
    Log.info(`[file-window] 写入 ${p.path}（${result.absPath}）`);
    return result;
  }
}
```

（`backupFile` 第二参 sessionId 用 0 表示手动保存——若 FileHistoryService 校验非零 session，改为方法签名允许的哨兵或透传 -1，以该服务实际签名为准。）

`electron/commons/ipc-channels.ts` invoke 尾部追加 `"workspace:writeFile",`。

`file-tools.ts`：`FileToolContext` 接口（文件内搜 `onBackupFile?:` 所在 interface）追加：

```ts
/** 写盘后回调（文件窗口 fileChanged 广播用；缺席不通知） */
onFileWritten?: (absPath: string) => void;
```

`writeFileTool` 的 `await fs.writeFile(...)` 之后追加：

```ts
ctx.onFileWritten?.(target);
```

`chat.service.ts` ctx 装配点（搜 `onBackupFile:` 的对象字面量处）追加：

```ts
onFileWritten: (absPath: string) => {
  broadcastFileChanged(sessionWorkspaceId, path.relative(sessionWorkspaceDir, absPath));
},
```

（实现时按该装配点既有变量名取 workspaceId/workspaceDir——上下文里已能取到 session 的 workspace；import broadcastFileChanged。）`main.ts` 在 `new FileWindowService(...)` 后追加 `new FileWriteIpc({ fileHistory, fileBackupEnabled: () => securityConfig?.fileBackupEnabled ?? true })`——fileHistory/securityService 目前是 Application.registerServices 局部量，main.ts 拿不到；改为在 `Application.registerServices` 末尾接线 FileWriteIpc（该处两者均在作用域），import 即可。

- [ ] **Step 4: 跑测试至绿 + typecheck**

Run: `npx vitest run tests/ai/file-window/file-write.test.ts tests/ai/chat.service.test.ts && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/chat/workspace-files.ts \
  electron/domains/ai/file-window/file-write-ipc.ts \
  electron/domains/ai/agent/file-tools.ts electron/domains/ai/chat/chat.service.ts \
  electron/Application.ts electron/commons/ipc-channels.ts \
  tests/ai/file-window/file-write.test.ts
git commit -m "feat(file-window): workspace:writeFile + fileChanged 全窗广播（AI 工具写盘联动）"
```

---

### Task 8: 保存工具行（saveStatus 徽标/另存为/Finder）+ 冲突确认

**Files:**
- Create: `src-react/domains/ai/file-window/components/FileTabHeader.tsx`
- Create: `src-react/domains/ai/file-window/hooks/use-save-tab.ts`
- Modify: `src-react/domains/ai/file-window/components/FileTabContent.tsx`（接入 header + 真保存流替换 Task 6 占位）
- Test: `tests/ai/file-window/use-save-tab.test.ts`、`tests/ai/file-window/file-tab-header.test.tsx`

**Interfaces:**
- Consumes: Task 7 invoke `workspace:writeFile`；`ArtifactApi.revealFile/exportFile`；Task 3 store
- Produces: `useSaveTab(tabId) → { save, saving, conflict }`（`conflict` 非空时 header 弹确认条，resolveConflict(mode: "overwrite" | "reload")）

- [ ] **Step 1: 写失败测试**

`tests/ai/file-window/use-save-tab.test.ts`：

```ts
/**
 * 保存流：dirty → saving → 写成功 saved + baselineMtime 更新；
 * FILE_CONFLICT → conflict 态；overwrite 以 baselineMtime=null 重写；
 * reload 重读清 dirty。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const invokeMock = vi.fn();
vi.mock("../../../src-react/lib/ipc", () => ({ invoke: invokeMock }));
const readFileMock = vi.fn();
vi.mock("../../../src-react/domains/ai/api/artifact.api", () => ({
  default: { readFile: readFileMock, revealFile: vi.fn(), exportFile: vi.fn() },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";
import { useSaveTab } from "../../../src-react/domains/ai/file-window/hooks/use-save-tab";

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

beforeEach(() => {
  useFileWindowStore.getState().reset();
  invokeMock.mockReset();
  readFileMock.mockReset();
});

it("保存成功链路", async () => {
  const { tabId } = useFileWindowStore
    .getState()
    .openTab({ kind: "workspace", workspaceId: 7, path: "a.md" });
  useFileWindowStore.getState().patchTab(tabId, { dirty: true, saveStatus: "unsaved" });
  invokeMock.mockResolvedValue({ absPath: "/x/a.md", mtime: 12345 });
  const { result } = renderHook(() => useSaveTab(tabId), { wrapper });
  act(() => {
    void result.current.save("新内容");
  });
  await waitFor(() => {
    const tab = useFileWindowStore.getState().tabs[0];
    expect(tab.saveStatus).toBe("saved");
    expect(tab.dirty).toBe(false);
    expect(tab.baselineMtime).toBe(12345);
  });
  expect(invokeMock).toHaveBeenCalledWith("workspace:writeFile", {
    workspaceId: 7,
    path: "a.md",
    content: "新内容",
    baselineMtime: null,
  });
});

it("冲突 → overwrite 重写", async () => {
  const { tabId } = useFileWindowStore
    .getState()
    .openTab({ kind: "workspace", workspaceId: 7, path: "a.md" });
  useFileWindowStore.getState().patchTab(tabId, { dirty: true, baselineMtime: 1 });
  invokeMock
    .mockRejectedValueOnce(new Error("FILE_CONFLICT"))
    .mockResolvedValue({ absPath: "/x/a.md", mtime: 2 });
  const { result } = renderHook(() => useSaveTab(tabId), { wrapper });
  act(() => {
    void result.current.save("我的");
  });
  await waitFor(() => expect(result.current.conflict).toBe(true));
  act(() => {
    void result.current.resolveConflict("overwrite", "我的");
  });
  await waitFor(() => {
    expect(useFileWindowStore.getState().tabs[0].saveStatus).toBe("saved");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/file-window/use-save-tab.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 hook + header**

`use-save-tab.ts`：

```ts
/**
 * tab 保存流（spec §5.2）：dirty→saving→写回 saved；FILE_CONFLICT 转
 * conflict 态由 UI 确认（overwrite=免基线重写 / reload=放弃本地重读）。
 */
import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { invoke } from "@/lib/ipc";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import { useFileWindowStore } from "../store/file-window.store";

export function useSaveTab(tabId: string) {
  const [conflict, setConflict] = useState(false);
  const queryClient = useQueryClient();

  const write = useCallback(
    async (tab: { resource: { kind: string; workspaceId: number; path: string } }, content: string, baselineMtime: number | null) => {
      useFileWindowStore.getState().patchTab(tabId, { saveStatus: "saving" });
      const r = (await invoke("workspace:writeFile", {
        workspaceId: tab.resource.workspaceId,
        path: tab.resource.path,
        content,
        baselineMtime,
      })) as { absPath: string; mtime: number };
      useFileWindowStore
        .getState()
        .patchTab(tabId, { saveStatus: "saved", dirty: false, baselineMtime: r.mtime });
      void queryClient.invalidateQueries({ queryKey: ["fw-file"] });
      void queryClient.invalidateQueries({ queryKey: ["artifact-file"] });
    },
    [queryClient, tabId],
  );

  const save = useCallback(
    async (content: string) => {
      const tab = useFileWindowStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab || tab.resource.kind !== "workspace") return;
      try {
        await write(tab, content, tab.baselineMtime);
      } catch (e) {
        if (e instanceof Error && e.message.includes("FILE_CONFLICT")) {
          setConflict(true);
          return;
        }
        useFileWindowStore.getState().patchTab(tabId, { saveStatus: "unsaved" });
        toast.error(mapIpcError(e));
      }
    },
    [tabId, write],
  );

  const resolveConflict = useCallback(
    async (mode: "overwrite" | "reload", draft: string) => {
      setConflict(false);
      if (mode === "overwrite") {
        await saveAfterConflict(draft);
      } else {
        const tab = useFileWindowStore.getState().tabs.find((t) => t.id === tabId);
        if (!tab) return;
        void queryClient.invalidateQueries({ queryKey: ["fw-file"] });
        useFileWindowStore
          .getState()
          .patchTab(tabId, { dirty: false, saveStatus: "saved" });
      }
    },
    // overwrite：免基线重写（用户已知外部修改，选择覆盖）
    [queryClient, tabId],
  );

  const saveAfterConflict = useCallback(
    async (content: string) => {
      const tab = useFileWindowStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab || tab.resource.kind !== "workspace") return;
      try {
        await write(tab, content, null);
      } catch (e) {
        useFileWindowStore.getState().patchTab(tabId, { saveStatus: "unsaved" });
        toast.error(mapIpcError(e));
      }
    },
    [tabId, write],
  );

  return { save, conflict, resolveConflict };
}
```

（`resolveConflict` 依赖数组漏 `saveAfterConflict`——实现时补齐引用依赖，ELint exhaustive-deps 以 lint 通过为准。）

`FileTabHeader.tsx`：

```tsx
/**
 * tab 头行（工具栏）：文件名 + 保存状态徽标 + 保存/另存为/Finder/
 * AI 对话开关（AI 开关 Task 10 接入）；冲突确认条内嵌。
 */
import { useTranslation } from "react-i18next";
import { FolderSearch, MessageSquare, Save, SaveAll } from "lucide-react";
import { toast } from "sonner";
import ArtifactApi from "@/domains/ai/api/artifact.api";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import { useFileWindowStore } from "../store/file-window.store";

export default function FileTabHeader({
  tabId,
  onSave,
  conflict,
  onResolveConflict,
}: {
  tabId: string;
  onSave: () => void;
  conflict: boolean;
  onResolveConflict: (mode: "overwrite" | "reload") => void;
}) {
  const { t } = useTranslation(["chat"]);
  const tab = useFileWindowStore((s) => s.tabs.find((x) => x.id === tabId));
  if (!tab || tab.resource.kind !== "workspace") return null;
  const statusKey =
    tab.saveStatus === "hidden" ? "" : `chat:fileWindow.saveStatus.${tab.saveStatus}`;
  return (
    <div className="flex flex-col border-b border-border/50">
      <div className="flex h-9 items-center gap-1 px-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {tab.resource.path}
        </span>
        {statusKey && (
          <span className="text-xs text-muted-foreground">{t(statusKey)}</span>
        )}
        {tab.dirty && (
          <button
            type="button"
            aria-label={t("chat:fileWindow.action.save")}
            title={t("chat:fileWindow.action.save")}
            onClick={onSave}
            className="rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
          >
            <Save className="h-4 w-4" />
          </button>
        )}
        {/* 另存为：exportFile 副本到任意位置（不动原文件，WorkBuddy office.action.saveAs 同语义） */}
        <button
          type="button"
          aria-label={t("chat:fileWindow.action.saveAs")}
          title={t("chat:fileWindow.action.saveAs")}
          onClick={() =>
            void ArtifactApi.exportFile(tab.resource.workspaceId, tab.resource.path)
              .then(() => toast.success(t("chat:artifacts.exportSuccess")))
              .catch((e) => toast.error(mapIpcError(e)))
          }
          className="rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        >
          <SaveAll className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label={t("chat:fileWindow.action.reveal")}
          title={t("chat:fileWindow.action.reveal")}
          onClick={() =>
            void ArtifactApi.revealFile(tab.resource.workspaceId, tab.resource.path)
              .catch((e) => toast.error(mapIpcError(e)))
          }
          className="rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        >
          <FolderSearch className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label={t("chat:fileWindow.action.aiChat")}
          title={t("chat:fileWindow.action.aiChat")}
          onClick={() =>
            useFileWindowStore.getState().patchTab(tabId, {
              aiPanelOpen: !tab.aiPanelOpen,
            })
          }
          className="rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        >
          <MessageSquare className="h-4 w-4" />
        </button>
      </div>
      {conflict && (
        <div className="flex items-center gap-2 border-t border-border/50 bg-primary-subtle/50 px-3 py-1.5 text-xs">
          <span className="flex-1">{t("chat:fileWindow.conflict.title")}</span>
          <button type="button" onClick={() => onResolveConflict("overwrite")}
            className="rounded border border-border/50 px-2 py-0.5 hover:bg-primary-subtle hover:text-primary">
            {t("chat:fileWindow.conflict.overwrite")}
          </button>
          <button type="button" onClick={() => onResolveConflict("reload")}
            className="rounded border border-border/50 px-2 py-0.5 hover:bg-primary-subtle hover:text-primary">
            {t("chat:fileWindow.conflict.reload")}
          </button>
        </div>
      )}
    </div>
  );
}
```

i18n 追加（zh）：`fileWindow.saveStatus.{saved:已保存,unsaved:未保存,saving:保存中}`、`fileWindow.action.{save:保存,reveal:在 Finder 中显示,aiChat:AI 对话}`、`fileWindow.conflict.{title:文件已被外部修改,overwrite:覆盖磁盘版本,reload:放弃我的修改并重载}`；en 对应 `Saved/Unsaved/Saving`、`Save/Reveal in Finder/AI Chat`、`File changed on disk/Overwrite/Discard and reload`。`FileTabContent` 组合 header + editor（onSave 调 useSaveTab.save(draft)，draft 状态从 FileTabEditor 提升——编辑器 onChange 时缓存最新草稿到组件级 ref 供保存取值）。

- [ ] **Step 4: 跑测试至绿 + typecheck**

Run: `npx vitest run tests/ai/file-window/use-save-tab.test.ts tests/ai/file-window/file-tab-editor.test.tsx && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/file-window tests/ai/file-window/use-save-tab.test.ts \
  src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json
git commit -m "feat(file-window): 保存工具行 + mtime 冲突确认（覆盖/重载）"
```

---

### Task 9: 关闭握手 + 快照持久化 + 空窗自动关

**Files:**
- Create: `src-react/domains/ai/file-window/hooks/use-window-close-bridge.ts`
- Create: `src-react/domains/ai/file-window/hooks/use-session-snapshot.ts`
- Modify: `src-react/domains/ai/file-window/views/FileWindowView.tsx`
- Test: `tests/ai/file-window/close-bridge.test.ts`

**Interfaces:**
- Consumes: Task 1 通道（onCloseRequest/confirmClose/cancelClose/setSessionState/getSessionState）；Task 3 serializeTabs/restoreTabs；Task 8 保存流（确认对话框按钮：保存并关闭/放弃/取消）
- Produces: `useCloseBridge({ windowId, resolveDirtyTabs })`（`resolveDirtyTabs` 返回 Promise<"ok" | "cancelled">——dirty tab 的确认对话框由调用方渲染）；`useSessionSnapshot(windowId)`（store 变更防抖 500ms 落快照）

- [ ] **Step 1: 写失败测试**

`tests/ai/file-window/close-bridge.test.ts`：

```ts
/**
 * 关闭握手：close-request → 全 tab 处理完 confirmClose；任一取消 cancelClose；
 * 快照：restoreSessionState 恢复 tabs；deliver 事件开 tab。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
const listeners = new Map<string, (payload: unknown) => void>();
vi.mock("../../../src-react/lib/ipc", () => ({ invoke: invokeMock }));
vi.stubGlobal("ipcRenderer", {
  on: (ch: string, cb: (e: unknown, p: unknown) => void) => {
    listeners.set(ch, cb as (p: unknown) => void);
    return () => listeners.delete(ch);
  },
});

import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";
import { useCloseBridge } from "../../../src-react/domains/ai/file-window/hooks/use-window-close-bridge";

beforeEach(() => {
  useFileWindowStore.getState().reset();
  invokeMock.mockReset().mockResolvedValue(null);
  listeners.clear();
});

it("close-request → resolveDirtyTabs ok → confirmClose", async () => {
  const resolveDirtyTabs = vi.fn().mockResolvedValue("ok");
  renderHook(() =>
    useCloseBridge({ windowId: "fw-1", resolveDirtyTabs }),
  );
  listeners.get("fileWindow:close-request")?.(undefined);
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("fileWindow:confirmClose", { windowId: "fw-1" }),
  );
});

it("close-request → cancelled → cancelClose", async () => {
  const resolveDirtyTabs = vi.fn().mockResolvedValue("cancelled");
  renderHook(() =>
    useCloseBridge({ windowId: "fw-1", resolveDirtyTabs }),
  );
  listeners.get("fileWindow:close-request")?.(undefined);
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("fileWindow:cancelClose", { windowId: "fw-1" }),
  );
});

it("最后一个 tab 关闭 → 空窗自动关（confirmClose）", async () => {
  renderHook(() =>
    useCloseBridge({ windowId: "fw-1", resolveDirtyTabs: vi.fn().mockResolvedValue("ok") }),
  );
  const s = useFileWindowStore.getState();
  const { tabId } = s.openTab({ kind: "workspace", workspaceId: 7, path: "a.md" });
  s.closeTab(tabId);
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("fileWindow:confirmClose", { windowId: "fw-1" }),
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/file-window/close-bridge.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现两个 hook + 视图接线**

`use-window-close-bridge.ts`：

```ts
/**
 * close bridge 渲染层（spec §4.4）：订阅 close-request → resolveDirtyTabs
 * （调用方逐 dirty tab 弹确认）→ ok=confirmClose / cancelled=cancelClose；
 * 最后一个 tab 关闭 = 空窗自动关。
 */
import { useEffect } from "react";
import FileWindowApi from "../api/file-window.api";
import { useFileWindowStore } from "../store/file-window.store";

export function useCloseBridge(opts: {
  windowId: string;
  resolveDirtyTabs: () => Promise<"ok" | "cancelled">;
}): void {
  useEffect(() => {
    const off = FileWindowApi.onCloseRequest(() => {
      void opts.resolveDirtyTabs().then((r) =>
        r === "ok"
          ? FileWindowApi.confirmClose(opts.windowId)
          : FileWindowApi.cancelClose(opts.windowId),
      );
    });
    return off;
  }, [opts]);

  // 空窗自动关：restored 完成后 tabs 归零即关（WorkBuddy 同款）
  useEffect(() => {
    const unsub = useFileWindowStore.subscribe((s, prev) => {
      if (s.restored && prev.tabs.length > 0 && s.tabs.length === 0) {
        void FileWindowApi.confirmClose(opts.windowId);
      }
    });
    return unsub;
  }, [opts.windowId]);
}
```

`use-session-snapshot.ts`：

```ts
/**
 * 快照持久化：store 变更防抖 500ms setSessionState；bootstrap 取快照
 * restoreTabs（恢复后 setRestored）。deliver 事件（新 resources）同 hook
 * 内消费——统一窗口入口编排。
 */
import { useEffect } from "react";
import FileWindowApi from "../api/file-window.api";
import { serializeTabs } from "../lib/tab-snapshot";
import { useFileWindowStore } from "../store/file-window.store";

export function bootstrapWindow(windowId: string): () => void {
  return FileWindowApi.onDeliver(async (payload) => {
    const s = useFileWindowStore.getState();
    if (payload.restored && !s.restored) return; // 初始投递由快照恢复替代
    payload.resources.forEach((r) => s.openTab(r));
    if (!useFileWindowStore.getState().restored) {
      const snap = (await FileWindowApi.restoreSessionState(windowId)) as
        | { tabs: ReturnType<typeof serializeTabs>; activeTabId: string }
        | null;
      if (snap?.tabs?.length) {
        const tabs = snap.tabs.map((item, i) => ({
          ...item,
          id: `fw-tab-${i + 1}`,
        }));
        useFileWindowStore.setState({
          tabs: tabs as never,
          activeTabId: snap.activeTabId || tabs[0]?.id,
          nextId: tabs.length + 1,
        });
      }
      useFileWindowStore.getState().setRestored();
    }
  });
}

export function useSessionSnapshot(windowId: string): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = useFileWindowStore.subscribe((s) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void FileWindowApi.saveSessionState(windowId, {
          tabs: serializeTabs(s.tabs),
          activeTabId: s.activeTabId,
        });
      }, 500);
    });
    return () => {
      clearTimeout(timer);
      unsub();
    };
  }, [windowId]);
}
```

（bootstrap 逻辑与 deliver 恢复交织较细：restored 投递时若本地已有快照 tabs 则跳过 resources 重放（去重键兜底亦可）。实现时以「先快照后投递、openTab 去重兜底」为准，测试覆盖恢复 + 追加两路径。）`FileWindowView` 接线：`useCloseBridge({ windowId, resolveDirtyTabs })`（resolveDirtyTabs 遍历 dirty tabs 渲染确认对话框——用 window.confirm 档次的轻量自绘 dialog：状态机 `confirmingTabId`，按钮 保存并关闭（调保存流后关闭）/放弃/取消；实现为视图内小组件 `CloseConfirmBar`，文案 `fileWindow.closeConfirm.{title,saveAndClose,discard,cancel}`）；`useSessionSnapshot(windowId)` + `bootstrapWindow(windowId)`；顶行 `pl-20`（darwin）/`pr-[146px]`（win）按平台。

- [ ] **Step 4: 跑测试至绿 + typecheck**

Run: `npx vitest run tests/ai/file-window/close-bridge.test.ts && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/file-window tests/ai/file-window/close-bridge.test.ts \
  src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json
git commit -m "feat(file-window): 关闭握手 + 快照持久化 + 空窗自动关"
```

---

### Task 10: AI 面板骨架（收起/拖宽/头部按钮）

**Files:**
- Create: `src-react/domains/ai/file-window/components/FileChatPanel.tsx`
- Create: `src-react/domains/ai/file-window/hooks/use-panel-width.ts`
- Modify: `src-react/domains/ai/file-window/views/FileWindowView.tsx`（右栏布局）
- Test: `tests/ai/file-window/file-chat-panel.test.tsx`

**Interfaces:**
- Consumes: store `tab.aiPanelOpen` / `patchTab`
- Produces: `FileChatPanel { tabId }`（内部 Task 11 填会话与消息流；本任务收起/拖宽/头部）；`usePanelWidth() → { width, startResize }`（min 320 / max 50% 窗宽，localStorage `tianshu-file-window-chat-width`）

- [ ] **Step 1: 写失败测试**

`tests/ai/file-window/file-chat-panel.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * 面板：默认宽 400 夹取 [320, win*0.5]；收起按钮 patchTab(aiPanelOpen:false)；
 * url tab 不渲染面板（消费方保证，本测 store 层）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";
import FileChatPanel from "../../../src-react/domains/ai/file-window/components/FileChatPanel";

afterEach(() => {
  cleanup();
  useFileWindowStore.getState().reset();
  localStorage.clear();
});

it("渲染空态标题与收起按钮；收起写回 store", () => {
  const { tabId } = useFileWindowStore
    .getState()
    .openTab({ kind: "workspace", workspaceId: 7, path: "a.md" });
  render(<FileChatPanel tabId={tabId} />);
  expect(screen.getByText("chat:fileWindow.chat.emptyTitle")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "chat:fileWindow.chat.collapse" }));
  expect(
    useFileWindowStore.getState().tabs[0].aiPanelOpen,
  ).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/file-window/file-chat-panel.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

`use-panel-width.ts`：

```ts
/**
 * 面板宽度：默认 400，夹取 [320, 窗宽50%]，localStorage 持久化
 * （WorkBuddy storage.device 同语义）。拖动期全局遮罩 col-resize。
 */
import { useCallback, useEffect, useState } from "react";

const KEY = "tianshu-file-window-chat-width";
const MIN = 320;

export function usePanelWidth() {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(KEY));
    return Number.isFinite(saved) && saved >= MIN ? saved : 400;
  });

  useEffect(() => {
    const clamp = () => {
      const max = Math.max(MIN, Math.floor(window.innerWidth / 2));
      setWidth((w) => Math.min(Math.max(w, MIN), max));
    };
    window.addEventListener("resize", clamp);
    clamp();
    return () => window.removeEventListener("resize", clamp);
  }, []);

  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const onMove = (ev: PointerEvent) => {
      const max = Math.floor(window.innerWidth / 2);
      const next = Math.min(
        Math.max(window.innerWidth - ev.clientX, MIN),
        max,
      );
      setWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setWidth((w) => {
        localStorage.setItem(KEY, String(w));
        return w;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  return { width, startResize };
}
```

`FileChatPanel.tsx`：

```tsx
/**
 * AI 对话面板（WorkBuddy office chat pane 对齐）：头部（新建任务/收起）+
 * 空态（快捷指令 Task 11）+ 消息流/输入框（Task 11）。宽度拖拽左缘。
 */
import { useTranslation } from "react-i18next";
import { PanelRightClose, SquarePen } from "lucide-react";
import { useFileWindowStore } from "../store/file-window.store";
import { usePanelWidth } from "../hooks/use-panel-width";

export default function FileChatPanel({ tabId }: { tabId: string }) {
  const { t } = useTranslation(["chat"]);
  const tab = useFileWindowStore((s) => s.tabs.find((x) => x.id === tabId));
  const patchTab = useFileWindowStore((s) => s.patchTab);
  const { width, startResize } = usePanelWidth();
  if (!tab) return null;
  return (
    <div className="flex h-full min-h-0" style={{ width }}>
      <div
        role="separator"
        aria-label={t("chat:fileWindow.chat.resize")}
        onPointerDown={startResize}
        className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-primary/30"
      />
      <div className="flex min-w-0 flex-1 flex-col border-l border-border/50">
        <div className="flex h-9 items-center gap-1 border-b border-border/50 px-2">
          <button
            type="button"
            aria-label={t("chat:fileWindow.chat.newTask")}
            title={t("chat:fileWindow.chat.newTask")}
            onClick={() => patchTab(tabId, { sessionId: undefined })}
            className="rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
          >
            <SquarePen className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={t("chat:fileWindow.chat.collapse")}
            title={t("chat:fileWindow.chat.collapse")}
            onClick={() => patchTab(tabId, { aiPanelOpen: false })}
            className="ml-auto rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
          >
            <PanelRightClose className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
          <p className="text-sm font-medium">
            {t("chat:fileWindow.chat.emptyTitle")}
          </p>
          <p className="text-xs">{t("chat:fileWindow.chat.emptyHint")}</p>
        </div>
      </div>
    </div>
  );
}
```

i18n 追加（zh）：`chat.emptyTitle:AI, 我帮你`、`chat.emptyHint:围绕当前文件帮你处理各种需求`、`chat.placeholder:让我帮你处理这份文件...`、`chat.newTask:新建任务`、`chat.collapse:收起对话`、`chat.resize:调整对话面板宽度`；en：`AI at your service`、`Handle anything around the current file`、`Ask me to work on this file...`、`New task`、`Collapse chat`、`Resize chat panel`。`FileWindowView` 布局：内容区 `<div className="flex min-h-0 flex-1">` 左 FileTabContent `flex-1` + 右 `tab.aiPanelOpen && contentKind !== "url" && <FileChatPanel tabId />`。

- [ ] **Step 4: 跑测试至绿 + typecheck**

Run: `npx vitest run tests/ai/file-window/file-chat-panel.test.tsx && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/file-window tests/ai/file-window/file-chat-panel.test.tsx \
  src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json
git commit -m "feat(file-window): AI 面板骨架——收起/拖宽(320~50%)/头部按钮"
```

---

### Task 11: 会话惰建 + 消息流 + 首条注入 + 快捷指令

**Files:**
- Modify: `src-react/domains/ai/file-window/components/FileChatPanel.tsx`
- Create: `src-react/domains/ai/file-window/lib/quick-prompts.ts`
- Create: `src-react/domains/ai/file-window/hooks/use-file-session.ts`
- Test: `tests/ai/file-window/use-file-session.test.ts`、`tests/ai/file-window/quick-prompts.test.ts`

**Interfaces:**
- Consumes: `SessionApi.create`、`useChatSend`、`MessageList`、`ChatApi.send`
- Produces:
  - `useFileSession(tabId) → { sessionId, ensureSession, sendWithFile, sending, stop }`（`ensureSession` 惰建+挂 mode；`sendWithFile(text)` 首条注入前缀）
  - `quickPromptsOf(contentKind) → { id, labelKey, promptKey }[]`
  - 首条注入前缀常量（见 Step 3，i18n `fileWindow.chat.injectPrefix`）

- [ ] **Step 1: 写失败测试**

`tests/ai/file-window/quick-prompts.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { quickPromptsOf } from "../../../src-react/domains/ai/file-window/lib/quick-prompts";

describe("快捷指令矩阵（spec §6.5）", () => {
  it("md 四条 / text 四条 / url 无", () => {
    expect(quickPromptsOf("md").map((p) => p.id)).toEqual([
      "summarize",
      "proofread",
      "polish",
      "outline",
    ]);
    expect(quickPromptsOf("text").map((p) => p.id)).toEqual([
      "summarize",
      "proofread",
      "extract",
      "translate",
    ]);
    expect(quickPromptsOf("url")).toEqual([]);
    expect(quickPromptsOf("image").map((p) => p.id)).toEqual([
      "describe",
      "ocr",
      "analyze",
      "qa",
    ]);
    expect(quickPromptsOf("html").map((p) => p.id)).toEqual(["summarize", "improve"]);
    expect(quickPromptsOf("pdf").map((p) => p.id)).toEqual([
      "summarize",
      "extract",
      "outline",
      "qa",
    ]);
  });

  it("labelKey/promptKey 均落在 fileWindow.prompt.<kind>.*", () => {
    for (const p of quickPromptsOf("md")) {
      expect(p.labelKey).toMatch(/^chat:fileWindow\.prompt\.md\./);
      expect(p.promptKey).toMatch(/^chat:fileWindow\.prompt\.md\./);
    }
  });
});
```

`tests/ai/file-window/use-file-session.test.ts`：

```ts
/**
 * 惰建会话：首条消息 session:create（title=文件名）+ 首条注入前缀；
 * 第二条不重复注入。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("../../../src-react/lib/ipc", () => ({ invoke: invokeMock }));
vi.mock("../../../src-react/domains/ai/chat/hooks/use-chat-send", () => ({
  useChatSend: () => ({
    sending: false,
    send: vi.fn(),
    stop: vi.fn(),
    regenerate: vi.fn(),
    editResend: vi.fn(),
  }),
}));

import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";
import { useFileSession } from "../../../src-react/domains/ai/file-window/hooks/use-file-session";

beforeEach(() => {
  useFileWindowStore.getState().reset();
  invokeMock.mockReset();
});

it("首条消息建会话并注入文件前缀；次条原样", async () => {
  invokeMock.mockResolvedValue({ id: 99, workspaceId: 7 });
  const { tabId } = useFileWindowStore
    .getState()
    .openTab({ kind: "workspace", workspaceId: 7, path: "docs/a.md" });
  const { result } = renderHook(() => useFileSession(tabId));
  await act(() => result.current.sendWithFile("总结一下"));
  await waitFor(() =>
    expect(useFileWindowStore.getState().tabs[0].sessionId).toBe(99),
  );
  const createCall = invokeMock.mock.calls.find(
    (c) => c[0] === "session:create",
  );
  expect(createCall?.[1]).toMatchObject({ workspaceId: 7, title: "a.md" });
  const sendCall = invokeMock.mock.calls.find((c) => c[0] === "chat:send");
  expect(sendCall?.[1].content).toContain("docs/a.md");
  expect(sendCall?.[1].content).toContain("总结一下");
  expect(sendCall?.[1].sessionId).toBe(99);
  await act(() => result.current.sendWithFile("再补充"));
  const sendCalls = invokeMock.mock.calls.filter((c) => c[0] === "chat:send");
  expect(sendCalls[1][1].content).toBe("再补充");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/file-window/quick-prompts.test.ts tests/ai/file-window/use-file-session.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`quick-prompts.ts`：

```ts
/**
 * 快捷指令矩阵（WorkBuddy office.prompt.* 文案对照移植，spec §6.5）：
 * 点击仅插入输入框不自动发送。label/prompt 均走 i18n。
 */
import type { FileWindowContentKind } from "../store/file-window.store";

export interface QuickPrompt {
  id: string;
  labelKey: string;
  promptKey: string;
}

const WORD_LIKE = {
  summarize: { id: "summarize", labelKey: "md.summarize.label", promptKey: "md.summarize.text" },
  proofread: { id: "proofread", labelKey: "md.proofread.label", promptKey: "md.proofread.text" },
  polish: { id: "polish", labelKey: "md.polish.label", promptKey: "md.polish.text" },
  outline: { id: "outline", labelKey: "md.outline.label", promptKey: "md.outline.text" },
};

const MATRIX: Partial<Record<FileWindowContentKind, QuickPrompt[]>> = {
  md: [WORD_LIKE.summarize, WORD_LIKE.proofread, WORD_LIKE.polish, WORD_LIKE.outline],
  text: [
    { id: "summarize", labelKey: "text.summarize.label", promptKey: "text.summarize.text" },
    { id: "proofread", labelKey: "text.proofread.label", promptKey: "text.proofread.text" },
    { id: "extract", labelKey: "text.extract.label", promptKey: "text.extract.text" },
    { id: "translate", labelKey: "text.translate.label", promptKey: "text.translate.text" },
  ],
  image: [
    { id: "describe", labelKey: "image.describe.label", promptKey: "image.describe.text" },
    { id: "ocr", labelKey: "image.ocr.label", promptKey: "image.ocr.text" },
    { id: "analyze", labelKey: "image.analyze.label", promptKey: "image.analyze.text" },
    { id: "qa", labelKey: "image.qa.label", promptKey: "image.qa.text" },
  ],
  html: [
    { id: "summarize", labelKey: "html.summarize.label", promptKey: "html.summarize.text" },
    { id: "improve", labelKey: "html.improve.label", promptKey: "html.improve.text" },
  ],
  pdf: [
    { id: "summarize", labelKey: "pdf.summarize.label", promptKey: "pdf.summarize.text" },
    { id: "extract", labelKey: "pdf.extract.label", promptKey: "pdf.extract.text" },
    { id: "outline", labelKey: "pdf.outline.label", promptKey: "pdf.outline.text" },
    { id: "qa", labelKey: "pdf.qa.label", promptKey: "pdf.qa.text" },
  ],
};

export function quickPromptsOf(kind: FileWindowContentKind): QuickPrompt[] {
  return (MATRIX[kind] ?? []).map((p) => ({
    ...p,
    labelKey: `chat:fileWindow.prompt.${p.labelKey}`,
    promptKey: `chat:fileWindow.prompt.${p.promptKey}`,
  }));
}
```

`use-file-session.ts`：

```ts
/**
 * 文件会话（每 tab 惰建，spec §6.2）：首条消息 ensureSession
 * （session:create + title=文件名）→ 注入前缀 → chat:send。
 * 复用 useChatSend 的流式管道（chat.store 在本窗口独立实例）。
 */
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@/lib/ipc";
import { useChatSend } from "@/domains/ai/chat/hooks/use-chat-send";
import { useFileWindowStore } from "../store/file-window.store";

export function useFileSession(tabId: string) {
  const { t } = useTranslation(["chat"]);
  const tab = useFileWindowStore((s) => s.tabs.find((x) => x.id === tabId));

  // session:create 缺省 mode 即 agent（session.repo 落库 null → 读侧默认
  // "agent"，无需显式 setMode）——工具直改链路（spec §6.4）天然生效
  const ensureSession = useCallback(async (): Promise<{ id: number; created: boolean }> => {
    const current = useFileWindowStore.getState().tabs.find((x) => x.id === tabId);
    if (current?.sessionId) return { id: current.sessionId, created: false };
    const resource = current?.resource;
    if (resource?.kind !== "workspace") throw new Error("NOT_WORKSPACE_TAB");
    const created = (await invoke("session:create", {
      workspaceId: resource.workspaceId,
      title: resource.path.split("/").pop() ?? "文件",
    })) as { id: number };
    useFileWindowStore.getState().patchTab(tabId, { sessionId: created.id });
    return { id: created.id, created: true };
  }, [tabId]);

  // 发送管道挂上 ensureSession 后的 sessionId（useChatSend 以 id 建流订阅）
  const liveId = tab?.sessionId ?? -1;
  const { sending, send, stop } = useChatSend(liveId);

  const sendWithFile = useCallback(
    async (text: string) => {
      const { id, created } = await ensureSession();
      const resource = useFileWindowStore
        .getState()
        .tabs.find((x) => x.id === tabId)?.resource;
      // 仅新建会话的首条注入前缀（引用式：agent 用 read_file 按需读，
      // spec §6.3）；既有会话靠历史
      const injected = created
        ? `${t("chat:fileWindow.chat.injectPrefix", {
            path: resource?.kind === "workspace" ? resource.path : "",
          })}\n\n${text}`
        : text;
      await send(injected);
    },
    [ensureSession, send, t, tabId],
  );

  // 图片 tab（workspace）：首条走多模态 images 附件（absPath =
  // workspace.directoryPath + path；directoryPath 经 workspace:list 取）
  const sendWithImage = useCallback(
    async (text: string) => {
      const { id, created } = await ensureSession();
      const tabNow = useFileWindowStore.getState().tabs.find((x) => x.id === tabId);
      if (!tabNow || tabNow.resource.kind !== "workspace") return;
      const wsList = (await invoke("workspace:list")) as {
        id: number;
        directoryPath: string | null;
      }[];
      const dir = wsList.find((w) => w.id === tabNow.resource.workspaceId)?.directoryPath;
      if (!dir) return;
      const images = [{ absPath: `${dir}/${tabNow.resource.path}` }];
      const injected = created
        ? `${t("chat:fileWindow.chat.injectPrefix", { path: tabNow.resource.path })}\n\n${text}`
        : text;
      await send(injected, undefined, undefined, images);
    },
    [ensureSession, send, t, tabId],
  );

  // 重新注入（spec §6.3）：文件被外部/AI 修改后追问时贴最新路径提示重读
  const reinject = useCallback(async () => {
    const resource = useFileWindowStore
      .getState()
      .tabs.find((x) => x.id === tabId)?.resource;
    if (!tab?.sessionId || resource?.kind !== "workspace") return;
    await send(
      t("chat:fileWindow.chat.reinjectFile", { path: resource.path }),
    );
  }, [send, t, tab?.sessionId, tabId]);

  return {
    sessionId: liveId,
    ensureSession,
    sendWithFile,
    sendWithImage,
    reinject,
    sending,
    stop,
  };
}
```

（`send` 签名 `(content, modelId?, overrides?, images?)` 与 useChatSend 一致；图片 tab 的 FileChatPanel 分发用 `sendWithImage`。两个 use-file-session 测试路径：首条建会话+注入、次条原文——与该实现一致。）`FileChatPanel` 接入：快捷指令 chips（`quickPromptsOf(tab.contentKind)` 点击 setInput(prompt 文本) 聚焦不发送）+ `useFileSession` + `sessionId > 0 && <MessageList sessionId={sessionId} workspaceId={tab.resource.kind === "workspace" ? tab.resource.workspaceId : null} />`（MessageList 挂在 QueryClientProvider 内——FileWindowView 根部包一层 QueryClientProvider，检查 App 根是否已有，没有则在 view 内自建 client）+ 轻输入框（textarea + 发送按钮 + Enter 发送 / Shift+Enter 换行）。

i18n 追加 `fileWindow.chat.injectPrefix`：zh `【当前文件】{{path}}\n请先用 read_file 工具读取该文件，再处理我的请求。` / en `【Current file】{{path}}\nPlease read it with the read_file tool first, then handle my request.`；`fileWindow.prompt.*` 全矩阵（zh 照 spec §6.5 文案；en 用 WorkBuddy en locale 等义翻译）共 22 条 label + 22 条 text。

- [ ] **Step 4: 跑测试至绿 + typecheck**

Run: `npx vitest run tests/ai/file-window/quick-prompts.test.ts tests/ai/file-window/use-file-session.test.ts && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/file-window tests/ai/file-window/quick-prompts.test.ts \
  tests/ai/file-window/use-file-session.test.ts \
  src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json
git commit -m "feat(file-window): 会话惰建 + 首条文件注入 + 快捷指令矩阵"
```

---

### Task 12: fileChanged 联动（窗口重载/脏冲突 + 主窗缓存失效）

**Files:**
- Create: `src-react/domains/ai/file-window/hooks/use-file-changed.ts`
- Modify: `src-react/domains/ai/chat/components/artifacts/FilePreview.tsx`（订阅失效）
- Test: `tests/ai/file-window/use-file-changed.test.ts`

**Interfaces:**
- Consumes: 事件 `workspace:fileChanged { workspaceId, path }`
- Produces: `useFileChanged()`——同路径 tab：不脏 invalidate `["fw-file"]` 重载；脏 → store 标记 `externalChanged`（FileTabHeader 弹 §8 冲突条复用：文案 conflict.*，选择 overwrite=丢弃我的修改并重载磁盘 / reload 命名在本场景语义相反——统一按钮「重载磁盘版本」「保留我的修改」，重载走 invalidate+清 dirty）；主窗 FilePreview 订阅同事件 invalidate `["artifact-file"]`

- [ ] **Step 1: 写失败测试**

`tests/ai/file-window/use-file-changed.test.ts`：

```ts
/**
 * fileChanged：非脏 tab invalidate 重载；脏 tab 置 externalChanged。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";

const listeners = new Map<string, (p: unknown) => void>();
vi.stubGlobal("ipcRenderer", {
  on: (ch: string, cb: (e: unknown, p: unknown) => void) => {
    listeners.set(ch, cb as (p: unknown) => void);
    return () => listeners.delete(ch);
  },
});

import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";
import { useFileChanged } from "../../../src-react/domains/ai/file-window/hooks/use-file-changed";

beforeEach(() => {
  useFileWindowStore.getState().reset();
  listeners.clear();
});

it("非脏同路径 tab → invalidate fw-file", async () => {
  const client = new QueryClient();
  const spy = vi.spyOn(client, "invalidateQueries");
  const { tabId } = useFileWindowStore
    .getState()
    .openTab({ kind: "workspace", workspaceId: 7, path: "a.md" });
  renderHook(() => useFileChanged(client));
  listeners.get("workspace:fileChanged")?.({ workspaceId: 7, path: "a.md" });
  await waitFor(() => expect(spy).toHaveBeenCalled());
  expect(useFileWindowStore.getState().tabs[0].dirty).toBe(false);
});

it("脏 tab → externalChanged 标记", async () => {
  const client = new QueryClient();
  const { tabId } = useFileWindowStore
    .getState()
    .openTab({ kind: "workspace", workspaceId: 7, path: "a.md" });
  useFileWindowStore.getState().patchTab(tabId, { dirty: true });
  renderHook(() => useFileChanged(client));
  listeners.get("workspace:fileChanged")?.({ workspaceId: 7, path: "a.md" });
  await waitFor(() =>
    expect(
      (useFileWindowStore.getState().tabs[0] as { externalChanged?: boolean })
        .externalChanged,
    ).toBe(true),
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/file-window/use-file-changed.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`FileWindowTab` 加可选 `externalChanged?: boolean`（store 接口同步）。`use-file-changed.ts`：

```ts
/**
 * workspace:fileChanged 消费：同路径非脏 tab 静默重载（invalidate）；
 * 脏 tab 置 externalChanged 由 header 冲突条接手（spec §5.2）。
 */
import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { useFileWindowStore } from "../store/file-window.store";

export function useFileChanged(queryClient: QueryClient): void {
  useEffect(() => {
    const off = window.ipcRenderer?.on(
      "workspace:fileChanged",
      (_e, payload: { workspaceId: number; path: string }) => {
        const hit = useFileWindowStore
          .getState()
          .tabs.find(
            (t) =>
              t.resource.kind === "workspace" &&
              t.resource.workspaceId === payload.workspaceId &&
              t.resource.path === payload.path,
          );
        if (!hit) return;
        if (hit.dirty) {
          useFileWindowStore
            .getState()
            .patchTab(hit.id, { externalChanged: true });
        } else {
          void queryClient.invalidateQueries({
            queryKey: ["fw-file", payload.workspaceId, payload.path],
          });
        }
      },
    );
    return () => off?.();
  }, [queryClient]);
}
```

`FileTabHeader` 冲突条复用：`conflict = conflict || tab.externalChanged`；「重载磁盘版本」= invalidate + patchTab 清 dirty/externalChanged；「保留我的修改」= 仅清 externalChanged（保存时 §8 mtime 基线再兜底）。`FilePreview.tsx` 加订阅（同款 on + invalidate `["artifact-file", workspaceId, file.path]`，useEffect 清理退订）。`FileWindowView` 挂 `useFileChanged(queryClient)`。

- [ ] **Step 4: 跑测试至绿 + typecheck**

Run: `npx vitest run tests/ai/file-window/use-file-changed.test.ts tests/ai/chat/file-preview.test.tsx && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/file-window tests/ai/file-window/use-file-changed.test.ts \
  src-react/domains/ai/chat/components/artifacts/FilePreview.tsx
git commit -m "feat(file-window): fileChanged 联动——静默重载/脏冲突 + 主窗缓存失效"
```

---

### Task 13: 会话级路径授权清单（library AI 直改的地基）

**Files:**
- Create: `electron/domains/ai/file-window/granted-paths.ts`
- Create: `electron/domains/ai/file-window/granted-paths-ipc.ts`
- Modify: `electron/domains/security/file-gate.ts`（`makeFileDecider` extraBuiltin 判定后查授权清单）
- Modify: `electron/domains/ai/agent/file-tools.ts`（`resolveSafePath` 加白名单参数；`FileToolContext` 加 `grantedPaths?: string[]`）
- Modify: `electron/domains/ai/chat/chat.service.ts`（ctx 组装传 grantedPaths）
- Test: `tests/ai/file-window/granted-paths.test.ts`

**Interfaces:**
- Consumes: option 表（持久化 key `fileWindow.grantedPaths`，JSON：`Record<sessionId, string[]>`）
- Produces:
  - `grantFilePath(sessionId, absPath)` / `revokeSession(sessionId)` / `grantedPathsOf(sessionId): string[]`（内存缓存 + option 落盘，懒加载）
  - `fileWindow:grantFilePath { sessionId, absPath }` handler（Task 14 渲染层调）
  - `resolveSafePath(workspacePath, relative, fullAccess, extraAllowed?)`——extraAllowed 命中的绝对路径放行（.realpath 归一比对）
  - file-gate：命中授权 → 返回 `"default"`（读写不因数据根 builtin 拦截；write 审批仍由 write_file kind:"write" 走）

- [ ] **Step 1: 写失败测试**

`tests/ai/file-window/granted-paths.test.ts`：

```ts
/**
 * 授权清单：注册/读取/会话回收/持久化往返；file-gate 命中放行；
 * resolveSafePath 白名单放行数据根路径。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const optionStore = new Map<string, string>();
vi.mock("../../../electron/commons/prisma-client", () => ({
  default: {
    option: {
      findFirst: vi.fn(async ({ where }: { where: { type: string } }) =>
        optionStore.has(where.type)
          ? { value: optionStore.get(where.type) }
          : null,
      ),
      upsert: vi.fn(async (p: { where: { type: string }; update: { value: string } }) => {
        optionStore.set(p.where.type, p.update.value);
        return {};
      }),
    },
    $disconnect: vi.fn(),
  },
}));

import {
  grantFilePath,
  grantedPathsOf,
  revokeSession,
} from "../../../electron/domains/ai/file-window/granted-paths";
import { resolveSafePath } from "../../../electron/domains/ai/agent/file-tools";

beforeEach(() => {
  optionStore.clear();
});

describe("授权清单", () => {
  it("注册后可查，会话回收清空", async () => {
    await grantFilePath(5, "/root/library/1.md");
    expect(await grantedPathsOf(5)).toContain("/root/library/1.md");
    await revokeSession(5);
    expect(await grantedPathsOf(5)).toEqual([]);
  });

  it("持久化往返（新实例可读）", async () => {
    await grantFilePath(5, "/root/library/1.md");
    const saved = optionStore.get("fileWindow.grantedPaths");
    expect(saved).toContain("/root/library/1.md");
  });
});

describe("resolveSafePath 白名单", () => {
  it("授权路径放行（workspace 外）", () => {
    const out = resolveSafePath(
      "/ws",
      "/root/library/1.md",
      false,
      ["/root/library/1.md"],
    );
    expect(out).toBe("/root/library/1.md");
  });

  it("未授权仍拒", () => {
    expect(() =>
      resolveSafePath("/ws", "/root/library/2.md", false, ["/root/library/1.md"]),
    ).toThrow("PATH_OUTSIDE_WORKSPACE");
  });
});
```

（`/ws` 需真实存在——resolveSafePath 内 realpathSync 会炸；测试用 `mkdtempSync` 建临时 workspace 目录替换字符串常量，实现测试时调整。）file-gate 判定测试并入本文件：构造 `makeFileDecider(() => ({ sandboxEnabled: true, fileBlocklist: [], fileAllowlist: [] }), ["/root"], grantedOf)` 后断言授权路径返回 `"default"`——签名加第 4 参 `grantedOf?: (absPath: string) => boolean`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/file-window/granted-paths.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`granted-paths.ts`：

```ts
/**
 * 会话级文件授权清单（spec §6.4）：文件窗口 library tab 发起 AI 对话时
 * 注册条目 storagePath；read_file 放行、write_file 审批仍走。
 * 内存缓存 + option 表（key fileWindow.grantedPaths）持久化；会话删除
 * 或条目删除时由注册方懒清理（read 校验存在性成本高，采取：revoke 时机
 * = 窗口关 tab / 会话删除钩子尽力而为，spec 允许）。
 */
import prisma from "../../commons/prisma-client";
import Log from "../../commons/Log";

const OPTION_KEY = "fileWindow.grantedPaths";
type Store = Record<string, string[]>;
let cache: Store | null = null;

async function load(): Promise<Store> {
  if (cache) return cache;
  const row = await prisma.option
    .findFirst({ where: { type: OPTION_KEY } })
    .catch(() => null);
  try {
    cache = row?.value ? (JSON.parse(row.value) as Store) : {};
  } catch {
    cache = {};
  }
  return cache!;
}

async function persist(next: Store): Promise<void> {
  cache = next;
  await prisma.option
    .upsert({
      where: { type: OPTION_KEY },
      create: { type: OPTION_KEY, value: JSON.stringify(next) },
      update: { value: JSON.stringify(next) },
    })
    .catch((e) => Log.error("授权清单持久化失败", e));
}

export async function grantFilePath(
  sessionId: number,
  absPath: string,
): Promise<null> {
  const store = await load();
  const key = String(sessionId);
  const list = store[key] ?? [];
  if (!list.includes(absPath)) list.push(absPath);
  await persist({ ...store, [key]: list });
  return null;
}

export async function grantedPathsOf(sessionId: number): Promise<string[]> {
  const store = await load();
  return store[String(sessionId)] ?? [];
}

export async function revokeSession(sessionId: number): Promise<null> {
  const store = await load();
  const next = { ...store };
  delete next[String(sessionId)];
  await persist(next);
  return null;
}
```

（option 表 upsert 的唯一键形态以 `option.repo.ts` 现有用法为准——若 type 非唯一键改 findFirst+create/update 两步。）`granted-paths-ipc.ts`：`handleUser("fileWindow:grantFilePath", (_e, _u, p) => grantFilePath(p.sessionId, p.absPath))`，main/Application 接线一行。`file-gate.ts`：

```ts
export function makeFileDecider(
  getConfigValue: () => SecurityConfig,
  extraBuiltin: string[],
  grantedOf?: (absPath: string) => boolean,
): (absPath: string, workspacePath: string) => FileAccessDecision {
  return (absPath, workspacePath) => {
    try {
      if (grantedOf?.(absPath)) return "default"; // 会话授权清单（spec §6.4）
      // ……原逻辑不动
```

Application 装配处（`installFileGate(makeFileDecider(...))`）第 4 传参同步 `grantedOf` 需同步判定——但 decider 是同步闭包而 grantedPathsOf 异步：改为模块级同步缓存（granted-paths 维护 `Set<string>` 全量扁平集 `grantedSetSync()` 供 gate 查询，grant/revoke 时同步更新集合 + 异步落盘）。`resolveSafePath` 第 4 参与 ctx 链同 Step 1 描述；`file-tools.ts` ctx 装配点（`ctx.fullAccess` 使用处同改）把 `ctx.grantedPaths` 传入。

- [ ] **Step 4: 跑测试至绿 + typecheck**

Run: `npx vitest run tests/ai/file-window/granted-paths.test.ts && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/file-window/granted-paths.ts \
  electron/domains/ai/file-window/granted-paths-ipc.ts \
  electron/domains/security/file-gate.ts electron/domains/ai/agent/file-tools.ts \
  electron/domains/ai/chat/chat.service.ts electron/Application.ts \
  tests/ai/file-window/granted-paths.test.ts
git commit -m "feat(file-window): 会话级路径授权清单——file-gate/resolveSafePath 双层放行"
```

---

### Task 14: library tab（渲染/编辑/保存 + 入口 + 授权注册）

**Files:**
- Modify: `src-react/domains/ai/file-window/components/FileTabContent.tsx`（library 分支实装）
- Create: `src-react/domains/ai/file-window/components/LibraryTabBody.tsx`
- Modify: `src-react/domains/ai/library/components/LibraryPreviewContent.tsx`（工具行加「在新窗口打开」）
- Modify: `src-react/domains/ai/file-window/hooks/use-file-session.ts`（library 会话：默认 workspace + 全文注入 + grantFilePath 注册）
- Test: `tests/ai/file-window/library-tab.test.tsx`

**Interfaces:**
- Consumes: `LibraryApi.list/tree`（条目获取——按 itemId 精确取：`LibraryApi.tree()` 平铺里 find id）、`file:readExternalFile`（storagePath 读）、`library:writeFileContent`、Task 13 `grantFilePath`
- Produces: `LibraryTabBody { tabId }`（md→LibraryMarkdownEditor / csv→LibraryCsvEditor / 只读类同 workspace 分支；保存走 `LibraryApi.writeFileContent` + updatedAt 基线冲突沿用 §8 冲突条）；AI 会话注入前缀变体 `fileWindow.chat.injectPrefixLibrary`

- [ ] **Step 1: 写失败测试**

`tests/ai/file-window/library-tab.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * library tab：条目读取渲染 md 编辑器；编辑→保存 writeFileContent；
 * AI 发首条消息前注册 grantFilePath。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../../../src-react/domains/ai/library/components/LibraryMarkdownEditor", () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="md" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src-react/lib/ipc", () => ({ invoke: invokeMock }));

import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";
import LibraryTabBody from "../../../src-react/domains/ai/file-window/components/LibraryTabBody";

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  useFileWindowStore.getState().reset();
});

const ITEM = {
  id: 3,
  name: "note.md",
  kind: "file",
  fileType: "text/markdown",
  storagePath: "/root/library/3.md",
  updatedAt: "2026-10-14T00:00:00.000Z",
};

it("渲染 md 编辑器并保存走 writeFileContent", async () => {
  invokeMock.mockImplementation((ch: string) => {
    if (ch === "library:tree")
      return [ITEM];
    if (ch === "file:readExternalFile")
      return { kind: "text", content: "# 库文档" };
    if (ch === "library:writeFileContent") return { ...ITEM, updatedAt: "2026-10-14T01:00:00.000Z" };
    return null;
  });
  const { tabId } = useFileWindowStore.getState().openTab({
    kind: "library",
    itemId: 3,
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <LibraryTabBody tabId={tabId} onSave={() => {}} />
    </QueryClientProvider>,
  );
  const ta = await screen.findByRole("textbox", { name: "md" });
  fireEvent.change(ta, { target: { value: "# 改" } });
  await waitFor(() => {
    expect(invokeMock).toHaveBeenCalledWith("library:writeFileContent", 3, "# 改");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/file-window/library-tab.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

`LibraryTabBody.tsx`（结构对照 LibraryPreviewContent 精简——无自动保存，手动语义）：

```tsx
/**
 * library tab 内容体：条目（tree 平铺 find id）→ storagePath 经
 * file:readExternalFile 读 → md/csv 编辑（复用资料库编辑器）/只读分支。
 * 保存 library:writeFileContent（updatedAt 基线冲突：服务端 updatedAt
 * 早于加载基线即拒绝——实现按返回值比对，冲突条复用 §8）。
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { invoke } from "@/lib/ipc";
import LibraryApi from "@/domains/ai/library/api/library.api";
import LibraryCsvEditor from "@/domains/ai/library/components/LibraryCsvEditor";
import LibraryMarkdownEditor from "@/domains/ai/library/components/LibraryMarkdownEditor";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import { libraryContentKindOf } from "../lib/content-kind";
import { useFileWindowStore } from "../store/file-window.store";

export default function LibraryTabBody({
  tabId,
  onSave,
}: {
  tabId: string;
  onSave: (draft: string) => void;
}) {
  const tab = useFileWindowStore((s) => s.tabs.find((t) => t.id === tabId));
  const itemId = tab?.resource.kind === "library" ? tab.resource.itemId : null;
  const itemQuery = useQuery({
    queryKey: ["fw-library-item", itemId],
    queryFn: async () =>
      ((await LibraryApi.tree()) as { id: number }[]).find((x) => x.id === itemId) ?? null,
    enabled: itemId !== null,
    retry: false,
  });
  const item = itemQuery.data as
    | (typeof itemQuery.data & { storagePath: string | null; fileType: string | null; name: string })
    | null;
  useEffect(() => {
    if (item) {
      useFileWindowStore.getState().patchTab(tabId, {
        contentKind: libraryContentKindOf(item.fileType),
        title: item.name,
      });
    }
  }, [item, tabId]);

  const readQuery = useQuery({
    queryKey: ["fw-library-content", item?.storagePath],
    queryFn: () =>
      invoke<{ kind: string; content?: string; dataUrl?: string; absPath?: string }>(
        "file:readExternalFile",
        item!.storagePath,
      ),
    enabled: !!item?.storagePath,
    retry: false,
  });
  useEffect(() => {
    if (readQuery.error) toast.error(mapIpcError(readQuery.error));
  }, [readQuery.error]);

  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [item?.storagePath]); // 切 tab 重置草稿
  const kind = item ? libraryContentKindOf(item.fileType) : "text";
  if (itemQuery.isPending) return <p className="p-3 text-xs text-muted-foreground">…</p>;
  if (!item?.storagePath)
    return <p className="p-3 text-xs text-muted-foreground">fileWindow.itemMissing</p>;

  if (kind === "image" && readQuery.data?.dataUrl)
    return (
      <div className="flex h-full items-center justify-center">
        <img src={readQuery.data.dataUrl} alt={item.name} className="max-h-full max-w-full object-contain" />
      </div>
    );
  if (kind === "md" || kind === "csv" || kind === "text") {
    const value = draft ?? readQuery.data?.content ?? "";
    return (
      <div className="h-full min-h-0 overflow-auto p-3">
        {kind === "md" ? (
          <LibraryMarkdownEditor value={value} onChange={setDraft} loading={readQuery.isPending} />
        ) : kind === "csv" ? (
          <LibraryCsvEditor value={value} onChange={setDraft} />
        ) : (
          <textarea
            value={value}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="h-full min-h-[60vh] w-full resize-none rounded-md border border-border/50 bg-transparent p-3 font-mono text-xs leading-relaxed outline-none focus:border-primary/30"
          />
        )}
      </div>
    );
  }
  // webview 类（html/pdf/音视频）：storagePath file:// 直开
  return (
    <webview
      src={`file://${item.storagePath}`}
      partition="artifact-preview"
      className="h-full min-h-0 w-full rounded-md border border-border/50"
    />
  );
}
```

（`LibraryCsvEditor` 实际 props 以其文件签名为准——计划假设 `{ value, onChange }`，实现时对齐。）`FileTabContent` library 分支换 `<LibraryTabBody tabId onSave={...} />`（保存流：`invoke("library:writeFileContent", itemId, draft)` 成功清 dirty；library tab 的保存不走 useSaveTab——header 按钮分发按 resource.kind）。`use-file-session.ts` 扩展：resource.kind==="library" 时 ensureSession 挂**默认 workspace**（`SessionApi.create({ title: item.name })` 不传 workspaceId——主进程落默认空间，以 session.repo 实际行为为准）+ 首条注入改 `injectPrefixLibrary`（含文件全文，截断 100k 字符 + i18n 截断提示后缀 `fileWindow.chat.truncated`）+ 发送前 `invoke("fileWindow:grantFilePath", { sessionId, absPath: item.storagePath })`。`LibraryPreviewContent.tsx` 工具行（saveState 指示同一行）加「在新窗口打开」按钮（icon 同 FilePreview：`SquareArrowOutUpRight`；onClick `invoke("fileWindow:open", { resources: [{ kind: "library", itemId: item.id }] })` 成功后 toast 成功文案——资料库详情非 tab 无移动语义）。

- [ ] **Step 4: 跑测试至绿 + typecheck**

Run: `npx vitest run tests/ai/file-window/library-tab.test.tsx && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/file-window tests/ai/file-window/library-tab.test.tsx \
  src-react/domains/ai/library/components/LibraryPreviewContent.tsx \
  src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json
git commit -m "feat(file-window): library tab——渲染/编辑/保存 + 资料库入口 + AI 授权注册"
```

---

### Task 15: 「+」菜单（新建/打开/网址/最近）+ tab 菜单（移动语义/关闭其他/右侧/复制路径）

**Files:**
- Create: `src-react/domains/ai/file-window/components/NewTabMenu.tsx`
- Create: `src-react/domains/ai/file-window/components/TabContextMenu.tsx`
- Create: `src-react/domains/ai/file-window/lib/recent-files.ts`
- Modify: `src-react/domains/ai/file-window/components/FileWindowTabBar.tsx`（挂菜单）
- Modify: `electron/domains/ai/file-window/file-window.service.ts`（`fileWindow:pickFile` handler：dialog 限定 workspace 目录）
- Test: `tests/ai/file-window/new-tab-menu.test.tsx`、`tests/ai/file-window/tab-context-menu.test.tsx`

**Interfaces:**
- Consumes: Task 7 `workspace:writeFile`（新建文件空内容）；`fileWindow:pickFile { workspaceId } → string[]`（相对路径）；Task 1 `fileWindow:open`（移动语义）
- Produces: `NewTabMenu`（DropdownMenu：新建 Markdown/文本、打开文件、打开网址（内嵌输入）、最近打开≤10）；`TabContextMenu`（在新窗口打开=移动、关闭、关闭其他、关闭右侧、复制路径/URL）；`pushRecent(resource)` / `recentOf()`（localStorage `tianshu-file-window-recent`，去重键 dedupeKeyOf）

- [ ] **Step 1: 写失败测试**

`tests/ai/file-window/new-tab-menu.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * + 菜单：新建 md → workspace:writeFile(未命名) + 开 tab；最近打开去重。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src-react/lib/ipc", () => ({ invoke: invokeMock }));

import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";
import NewTabMenu from "../../../src-react/domains/ai/file-window/components/NewTabMenu";
import { pushRecent, recentOf } from "../../../src-react/domains/ai/file-window/lib/recent-files";

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  useFileWindowStore.getState().reset();
  localStorage.clear();
});

it("新建 Markdown：唯一名写入 workspace 并开 tab", async () => {
  invokeMock.mockImplementation((ch: string) => {
    if (ch === "workspace:writeFile") return { absPath: "/ws/未命名-1.md", mtime: 1 };
    if (ch === "workspace:list") return [{ id: 7, directoryPath: "/ws" }];
    return null;
  });
  const { tabId } = useFileWindowStore
    .getState()
    .openTab({ kind: "workspace", workspaceId: 7, path: "seed.md" });
  render(<NewTabMenu />);
  fireEvent.click(screen.getByRole("button", { name: "chat:fileWindow.tab.new" }));
  fireEvent.click(await screen.findByText("chat:fileWindow.file.newMarkdown"));
  await waitFor(() => {
    const call = invokeMock.mock.calls.find((c) => c[0] === "workspace:writeFile");
    expect(call?.[1].path).toMatch(/^未命名-\d+\.md$/);
    expect(call?.[1].content).toBe("");
  });
  await waitFor(() =>
    expect(useFileWindowStore.getState().tabs.length).toBe(2),
  );
});

it("最近打开：pushRecent 去重置顶", () => {
  pushRecent({ kind: "url", url: "https://t.cn" });
  pushRecent({ kind: "url", url: "https://t.cn" });
  pushRecent({ kind: "workspace", workspaceId: 7, path: "a.md" });
  expect(recentOf()[0]).toEqual({ kind: "workspace", workspaceId: 7, path: "a.md" });
  expect(recentOf()).toHaveLength(2);
});
```

`tests/ai/file-window/tab-context-menu.test.tsx` 核心断言：点「在新窗口打开」→ `invoke("fileWindow:open", { resources: [带 sessionId 的 resource] })` 后 store 移除该 tab（移动语义）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/file-window/new-tab-menu.test.tsx tests/ai/file-window/tab-context-menu.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

`recent-files.ts`：

```ts
import type { FileWindowResource } from "../model/resource";
import { dedupeKeyOf } from "../store/file-window.store";

const KEY = "tianshu-file-window-recent";
const LIMIT = 10;

export function recentOf(): FileWindowResource[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as FileWindowResource[];
  } catch {
    return [];
  }
}

export function pushRecent(resource: FileWindowResource): void {
  const key = dedupeKeyOf(resource);
  const next = [
    resource,
    ...recentOf().filter((r) => dedupeKeyOf(r) !== key),
  ].slice(0, LIMIT);
  localStorage.setItem(KEY, JSON.stringify(next));
}
```

（store openTab 内顺带 pushRecent——由 FileTabContent/View 层调，避免 store 依赖 localStorage 语义混杂。）`NewTabMenu.tsx`：shadcn DropdownMenu（弹层 z-[75] 口径），菜单项新建 Markdown / 新建文本（唯一名探测：现有 tabs 里 `未命名-\d+` 取最大 n+1；写空文件后 openTab + patchTab baselineMtime）、打开文件（`invoke("fileWindow:pickFile", { workspaceId })` 返回相对路径数组 → openTab 逐个；workspaceId 取首个 workspace tab，无则提示先开工作空间文件——i18n `fileWindow.file.needWorkspace`）、打开网址（子表单 input + 回车 openTab url）、最近打开（recentOf 渲染，点击 openTab）。`file-window.service.ts` 加 handler：

```ts
handleUser(FILE_WINDOW_IPC.pickFile, async (_e, _userId, p: { workspaceId: number }) => {
  const ws = await prisma.workspace.findUnique({
    where: { id: p.workspaceId },
    select: { directoryPath: true },
  });
  if (!ws?.directoryPath) return [];
  const r = await dialog.showOpenDialog(null as never, {
    defaultPath: ws.directoryPath,
    properties: ["openFile", "multiSelections"],
  });
  return r.filePaths
    .filter((f) => f === ws.directoryPath || f.startsWith(ws.directoryPath + path.sep))
    .map((f) => path.relative(ws.directoryPath!, f));
});
```

（import prisma/dialog；showOpenDialog 首参窗口可省——Electron 允许 `dialog.showOpenDialog(options)` 单参形态，用单参。）`TabContextMenu.tsx`：tab 右键（FileWindowTabBar 的 DetailTabBar 加 `onContextMenu` 透传——DetailTabBar 泛化时一并加可选 prop）弹菜单：在新窗口打开（busy=moving → closeTab 本地 → `FileWindowApi.open([{ ...resource, sessionId }])`）、关闭、关闭其他、关闭右侧（逐个走关闭握手语义——一期简化为直接 closeTab（脏 tab 弹 §9 确认），实现按 DetailPanel closeOthers 无先例时一期直接关并注释）、复制路径（`navigator.clipboard.writeText`，workspace=path、library=名称、url=url）。

- [ ] **Step 4: 跑测试至绿 + typecheck**

Run: `npx vitest run tests/ai/file-window/new-tab-menu.test.tsx tests/ai/file-window/tab-context-menu.test.tsx && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/file-window electron/domains/ai/file-window/file-window.service.ts \
  tests/ai/file-window/new-tab-menu.test.tsx tests/ai/file-window/tab-context-menu.test.tsx \
  src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json
git commit -m "feat(file-window): +菜单（新建/打开/网址/最近）与 tab 菜单（移动语义等）"
```

---

### Task 16: i18n 全量核对 + 全量回归收尾

**Files:**
- Modify: `src-react/i18n/locales/zh-CN/chat.json`、`en-US/chat.json`（缺漏补齐）
- Modify: 本计划涉及全部文件（按回归结果修）

**Interfaces:**
- Consumes: 前 15 个任务全部
- Produces: 全绿基线

- [ ] **Step 1: i18n 盘点**

对照 spec §8 清单 grep 两侧 chat.json 的 `fileWindow` 键集差异（node 脚本 diff zh/en 键路径），缺者补（zh 文案以 spec/任务内为准，en 等义翻译）。键集必须 zh === en。

- [ ] **Step 2: 全量回归**

Run: `npm run test && npm run lint && npm run typecheck`
Expected: 全部 PASS；任何失败回到对应任务修复（禁改测试期望迁就实现）

- [ ] **Step 3: 手动冒烟（dev 实测一次全链路）**

`npm run dev` 起应用，验证：主窗文件 tab「在新窗口打开」→ 独立窗开 tab → 编辑保存 → ⌘S → AI 快捷指令注入对话 → write_file 审批直改 → 编辑器重载 → 关闭未保存确认 → + 菜单新建/网址/最近 → 移到新窗口 → 资料库条目外开 + AI 授权直改。（GUI 驱动可参照 memory 的 nohup dev + playwright-core 临时驱动法。）

- [ ] **Step 4: Commit**

```bash
git add -u src-react/domains/ai/file-window src-react/i18n electron/domains/ai/file-window tests/ai/file-window
git commit -m "test(file-window): i18n 核对 + 全量回归收尾"
```
