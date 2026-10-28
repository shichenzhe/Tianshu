// 主进程单测：mock electron（BrowserWindow 记录构造参数与事件注册）。
// mock 基类与 handleUserMock 经 vi.hoisted 提供——vi.mock 工厂随被测模块
// import 先于模块体执行，直接引用类/常量会踩 TDZ（vitest 官方手法）
import { beforeEach, describe, expect, it, vi } from "vitest";

const { winInstances, MockWin } = vi.hoisted(() => {
  const winInstances: MockWin[] = [];
  /** mock 窗口监听器签名（close 需 preventDefault；will-navigate 带第二参 url） */
  type MockListener = (
    event?: { preventDefault(): void },
    ...args: unknown[]
  ) => void;
  class MockWin {
    id = winInstances.length + 1;
    handlers: Record<string, (details: { url: string }) => unknown> = {};
    listeners: Record<string, MockListener> = {};
    sent: Array<{ channel: string; payload: unknown }> = [];
    destroyed = false;
    closed = false;
    /** 当前 URL（loadURL/loadFile 写入；T20 池窗健康检查 getURL 断言用，
     *  模拟登录守卫跳转直接改写本字段） */
    url = "";
    /** renderer 是否 crashed（isCrashed 断言用，测试直接置位） */
    crashed = false;
    /** 最近一次 close() 是否被监听器 preventDefault（真实 Electron 语义：拦下不关） */
    closePrevented = false;
    webContents = {
      id: this.id,
      on: (ev: string, fn: MockListener) => (this.listeners[ev] = fn),
      send: (channel: string, payload: unknown) =>
        this.sent.push({ channel, payload }),
      setWindowOpenHandler: (fn: (details: { url: string }) => unknown) =>
        (this.handlers.open = fn),
      getURL: () => this.url,
      isCrashed: () => this.crashed,
    };
    on(ev: string, fn: MockListener) {
      this.listeners[ev] = fn;
      return this;
    }
    once(ev: string, fn: MockListener) {
      this.listeners[ev] = fn;
      return this;
    }
    loadURL = vi.fn((u: string) => {
      this.url = u;
    });
    loadFile = vi.fn((p: string, o?: { hash?: string }) => {
      this.url = `${p}#${o?.hash ?? ""}`;
    });
    // show/focus/restore/isMinimized：focusMain（T18「打开主页」）断言用
    show = vi.fn();
    focus = vi.fn();
    restore = vi.fn();
    isMinimized = vi.fn(() => false);
    close() {
      let prevented = false;
      this.listeners.close?.({
        preventDefault: () => {
          prevented = true;
        },
      });
      this.closePrevented = prevented;
      if (!prevented) this.closed = true;
    }
    destroy() {
      this.destroyed = true;
    }
    isDestroyed() {
      return this.destroyed;
    }
    setMenuBarVisibility() {}
  }
  return { winInstances, MockWin };
});

vi.mock("electron", () => ({
  // getPath/getAppPath/isPackaged：renderer-guard → network-gate → Log 顶层
  // 经 ensureTianshuData 读取（agent-loop.test.ts 同款 app mock）
  app: {
    on: vi.fn(),
    getPath: vi.fn(() => `/tmp/tianshu-fw-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-fw-test-app-${process.pid}`),
    isPackaged: false,
  },
  BrowserWindow: class extends MockWin {
    constructor(opts: unknown) {
      super();
      // @ts-expect-error 构造参数挂在实例供断言
      (this as unknown as { opts: unknown }).opts = opts;
      winInstances.push(this);
    }
  },
  dialog: { showOpenDialog: vi.fn() },
  // openExternal：handleWindowOpen 放行域经系统浏览器外开（mock 返回已决议）
  shell: {
    openExternal: vi.fn(() => Promise.resolve()),
    showItemInFolder: vi.fn(),
  },
}));

vi.mock("../../../electron/commons/prisma-client", () => ({
  default: {
    workspace: { findFirst: vi.fn() },
  },
}));

const handleUserMock = vi.hoisted(() => vi.fn());
vi.mock("../../../electron/commons/ipc-user", () => ({
  handleUser: (ch: string, fn: (...args: unknown[]) => unknown) =>
    handleUserMock(ch, fn),
}));

import path from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import prisma from "../../../electron/commons/prisma-client";
import FileWindowService, {
  FILE_WINDOW_IPC as FW_IPC,
} from "../../../electron/domains/ai/file-window/file-window.service";

type Handler = (event: unknown, userId: number, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
beforeEach(() => {
  winInstances.length = 0;
  handlers.clear();
  vi.mocked(app.on).mockClear();
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

function newService(getMainWindow: () => BrowserWindow | null = () => null) {
  return new FileWindowService({
    devServerUrl: "",
    rendererIndex: "/app/dist/index.html",
    preloadPath: "/app/preload.mjs",
    getMainWindow,
  });
}

/** dev server 形态服务（will-navigate 白名单放行分支用） */
function newDevService() {
  return new FileWindowService({
    devServerUrl: "http://localhost:5173",
    rendererIndex: "/app/dist/index.html",
    preloadPath: "/app/preload.mjs",
    getMainWindow: () => null,
  });
}

describe("FileWindowService", () => {
  it("open 创建带守卫的窗口并返回 windowId", async () => {
    newService();
    const { windowId } = (await invoke(FW_IPC.open, {
      resources: [RES],
    })) as { windowId: string };
    expect(windowId).toMatch(/^file-window:/);
    const win = winInstances[0];
    expect(winInstances).toHaveLength(1);
    const opts = (win as unknown as { opts: unknown }).opts;
    expect(opts).toBeTruthy();
    // 窗口标题区分主窗「天枢」（spec §13 项 1）
    expect((opts as { title: string }).title).toBe("天枢 文件浏览器");
    // 开窗守卫：window.open 恒拒内开（放行域转外开）
    expect(win.handlers.open({ url: "https://x" })).toEqual({ action: "deny" });
    // 页面加载完成后投递 deliver（mock 需手动触发 did-finish-load）
    win.listeners["did-finish-load"]?.();
    expect(win.sent.at(-1)?.channel).toBe(FW_IPC.deliver);
    expect(win.sent.at(-1)?.payload).toEqual({ resources: [RES] });
  });

  it("close-ready 重投 deliver：did-finish-load 首投早于渲染层订阅时不丢资源", async () => {
    newService();
    const { windowId } = (await invoke(FW_IPC.open, {
      resources: [RES],
    })) as { windowId: string };
    const win = winInstances[0];
    // 首投即丢场景：did-finish-load 时渲染层订阅未就位（事件无人消费）
    win.listeners["did-finish-load"]?.();
    expect(win.sent.filter((s) => s.channel === FW_IPC.deliver)).toHaveLength(
      1,
    );
    // 渲染层挂载发 close-ready：此时订阅已就位，重投兜底
    await invoke(FW_IPC.closeReady, { windowId });
    const delivers = win.sent.filter((s) => s.channel === FW_IPC.deliver);
    expect(delivers).toHaveLength(2);
    expect(delivers[1].payload).toEqual({ resources: [RES] });
    // 重复 close-ready（token 刷新等再发）不重投
    await invoke(FW_IPC.closeReady, { windowId });
    expect(win.sent.filter((s) => s.channel === FW_IPC.deliver)).toHaveLength(
      2,
    );
  });

  it("reload（再触 did-finish-load）复位 rendererReady：close-ready 重投仍可达", async () => {
    newService();
    const { windowId } = (await invoke(FW_IPC.open, {
      resources: [RES],
    })) as { windowId: string };
    const win = winInstances[0];
    win.listeners["did-finish-load"]?.(); // 首次加载首投
    await invoke(FW_IPC.closeReady, { windowId }); // 就位 → 重投 #2
    // reload：did-finish-load 再触发 → rendererReady 复位 + 按首投语义再投
    win.listeners["did-finish-load"]?.();
    // 新渲染进程就位（close-ready）→ markReady 重新生效 → 重投可达
    await invoke(FW_IPC.closeReady, { windowId });
    const delivers = win.sent.filter((s) => s.channel === FW_IPC.deliver);
    // #1 首投 + #2 就位重投 + #3 reload 首投 + #4 reload 后就位重投
    expect(delivers).toHaveLength(4);
    expect(delivers[3].payload).toEqual({ resources: [RES] });
  });

  it("未 ready 强关定时器：渲染层就位（close-ready）后作废，转正常协商", async () => {
    vi.useFakeTimers();
    try {
      newService();
      const { windowId } = (await invoke(FW_IPC.open, {
        resources: [RES],
      })) as { windowId: string };
      const win = winInstances[0];
      // 未 ready 收 close：arm 3s 强关定时器（不询问渲染层）
      win.close();
      expect(win.closePrevented).toBe(true);
      // 渲染层随后完成加载并就位
      win.listeners["did-finish-load"]?.();
      await invoke(FW_IPC.closeReady, { windowId });
      vi.advanceTimersByTime(3_000);
      // 挂起的 NOT_READY 强关定时器已随就位清除：窗口不误关
      expect(win.closed).toBe(false);
      // 再 close → rendererReady 路径：发 close-request 正常协商
      win.close();
      expect(win.sent.some((s) => s.channel === FW_IPC.closeRequest)).toBe(
        true,
      );
      expect(win.closed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("will-navigate 白名单：file:// 与 dev server 放行，其余 http(s) 拦截", async () => {
    newDevService();
    await invoke(FW_IPC.open, { resources: [RES] });
    const win = winInstances[0];
    expect(win.listeners["will-navigate"]).toBeTypeOf("function");
    let prevented = false;
    const navigate = (url: string) =>
      win.listeners["will-navigate"]?.(
        { preventDefault: () => (prevented = true) },
        url,
      );
    navigate("file:///app/dist/index.html");
    expect(prevented).toBe(false);
    navigate("http://localhost:5173/#/file-window?windowId=x");
    expect(prevented).toBe(false);
    navigate("https://evil.com");
    expect(prevented).toBe(true);
  });

  it("同 windowId 再 open → 不新建窗口，投递 deliver", async () => {
    newService();
    const first = (await invoke(FW_IPC.open, { resources: [RES] })) as {
      windowId: string;
    };
    await invoke(FW_IPC.open, {
      resources: [{ kind: "library", itemId: 5 }],
      targetWindowId: first.windowId,
    });
    expect(winInstances).toHaveLength(1);
    expect(winInstances[0].sent.at(-1)?.channel).toBe(FW_IPC.deliver);
  });

  it("close bridge：ready 后 close 发 close-request，confirmClose 放行", async () => {
    newService();
    const { windowId } = (await invoke(FW_IPC.open, {
      resources: [RES],
    })) as { windowId: string };
    const win = winInstances[0];
    // 渲染层就绪
    await invoke(FW_IPC.closeReady, { windowId });
    // 用户点关闭：主进程发 close-request（不发 renderer 不知情的 close）
    win.close();
    expect(win.sent.some((s) => s.channel === FW_IPC.closeRequest)).toBe(true);
    expect(win.closePrevented).toBe(true);
    expect(win.closed).toBe(false);
    // renderer 确认 → 放行（closed 标记）
    await invoke(FW_IPC.confirmClose, { windowId });
    expect(win.closed).toBe(true);
  });

  it("未 ready 收 close：3s 强关，不询问渲染层", async () => {
    vi.useFakeTimers();
    try {
      newService();
      await invoke(FW_IPC.open, { resources: [RES] });
      const win = winInstances[0];
      win.close();
      expect(win.sent.some((s) => s.channel === FW_IPC.closeRequest)).toBe(
        false,
      );
      expect(win.closePrevented).toBe(true);
      expect(win.closed).toBe(false);
      vi.advanceTimersByTime(3_000);
      expect(win.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("close-request 15s 无响应视为取消：复位后再 close 重新询问", async () => {
    vi.useFakeTimers();
    try {
      newService();
      const { windowId } = (await invoke(FW_IPC.open, {
        resources: [RES],
      })) as { windowId: string };
      const win = winInstances[0];
      await invoke(FW_IPC.closeReady, { windowId });
      win.close();
      expect(
        win.sent.filter((s) => s.channel === FW_IPC.closeRequest),
      ).toHaveLength(1);
      vi.advanceTimersByTime(15_000);
      // 超时视为取消：窗口未关
      expect(win.closed).toBe(false);
      // 复位后再次关闭：重新走询问
      win.close();
      expect(
        win.sent.filter((s) => s.channel === FW_IPC.closeRequest),
      ).toHaveLength(2);
      expect(win.closed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("crashed renderer 直接关（T28 spec §16 项 4）：ready 后 crash → 跳过协商无 close-request", async () => {
    newService();
    const { windowId } = (await invoke(FW_IPC.open, {
      resources: [RES],
    })) as { windowId: string };
    const win = winInstances[0];
    await invoke(FW_IPC.closeReady, { windowId });
    win.crashed = true;
    win.close();
    // crashed 进程无人应答：不发 close-request 直接放行关闭
    expect(win.sent.some((s) => s.channel === FW_IPC.closeRequest)).toBe(false);
    expect(win.closePrevented).toBe(false);
    expect(win.closed).toBe(true);
  });

  it("crashed renderer 未 ready 亦直接关：跳过 3s 强关定时器；挂起 close-request 定时器被清", async () => {
    vi.useFakeTimers();
    try {
      newService();
      const { windowId } = (await invoke(FW_IPC.open, {
        resources: [RES],
      })) as { windowId: string };
      const win = winInstances[0];
      await invoke(FW_IPC.closeReady, { windowId });
      // 协商在途（15s 定时器挂起）时 renderer crash → 下次 close 直接放行
      win.close();
      expect(win.closePrevented).toBe(true);
      win.crashed = true;
      win.close();
      expect(win.closed).toBe(true);
      // 挂起的 15s 超时回调不得再把状态当取消处理（窗口已关，无副作用）
      vi.advanceTimersByTime(20_000);
      expect(win.closed).toBe(true);
      // 未 ready + crashed：不再 arm 3s 强关定时器，直接关闭
      const second = (await invoke(FW_IPC.open, {
        resources: [RES],
      })) as { windowId: string };
      const win2 = winInstances[1];
      win2.crashed = true;
      win2.close();
      expect(second.windowId).toBeTruthy();
      expect(win2.closePrevented).toBe(false);
      expect(win2.closed).toBe(true);
      vi.advanceTimersByTime(5_000);
      expect(win2.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("快照存取按 windowId 隔离", async () => {
    newService();
    const { windowId } = (await invoke(FW_IPC.open, {
      resources: [RES],
    })) as { windowId: string };
    await invoke(FW_IPC.setSessionState, {
      windowId,
      snapshot: { tabs: [1] },
    });
    expect(await invoke(FW_IPC.getSessionState, { windowId })).toEqual({
      tabs: [1],
    });
    expect(
      await invoke(FW_IPC.getSessionState, { windowId: "nope" }),
    ).toBeNull();
  });

  it("closed 清理注册表与快照：旧 windowId 再 open 新建窗口", async () => {
    newService();
    const { windowId } = (await invoke(FW_IPC.open, {
      resources: [RES],
    })) as { windowId: string };
    const win = winInstances[0];
    await invoke(FW_IPC.setSessionState, {
      windowId,
      snapshot: { tabs: [1] },
    });
    // 窗口真正关闭（closed 事件）
    win.listeners.closed?.();
    // 旧 windowId 复用开窗 → 注册表已清 → 新建窗口
    const second = (await invoke(FW_IPC.open, {
      resources: [RES],
      targetWindowId: windowId,
    })) as { windowId: string };
    expect(winInstances).toHaveLength(2);
    expect(second.windowId).not.toBe(windowId);
    // 快照随窗清
    expect(await invoke(FW_IPC.getSessionState, { windowId })).toBeNull();
  });
});

describe("FileWindowService pickFile（+ 菜单打开文件，Task 15）", () => {
  const findFirst = prisma.workspace.findFirst as unknown as ReturnType<
    typeof vi.fn
  >;
  const showOpenDialog = dialog.showOpenDialog as unknown as ReturnType<
    typeof vi.fn
  >;

  beforeEach(() => {
    findFirst.mockReset();
    showOpenDialog.mockReset();
  });

  it(
    "归属校验 + 目录范围选择：回相对路径（" / " 分隔），越界路径丢弃",
    async () => {
      newService();
      findFirst.mockResolvedValue({ directoryPath: "/ws/root" });
      showOpenDialog.mockResolvedValue({
        filePaths: [
          path.join("/ws/root", "a.md"),
          path.join("/ws/root", "sub", "b.txt"),
          "/elsewhere/c.md",
        ],
      });
      const r = (await invoke(FW_IPC.pickFile, { workspaceId: 7 })) as string[];
      expect(findFirst).toHaveBeenCalledWith({
        where: { id: 7, userId: 1 },
        select: { directoryPath: true },
      });
      // 单参形态（无父窗锚定）；defaultPath 限定空间目录
      expect(showOpenDialog).toHaveBeenCalledWith({
        defaultPath: "/ws/root",
        properties: ["openFile", "multiSelections"],
      });
      expect(r).toEqual(["a.md", "sub/b.txt"]);
    },
  );

  it("空间不存在/未绑定目录：空数组，不弹选择框", async () => {
    newService();
    findFirst.mockResolvedValue({ directoryPath: null });
    expect(await invoke(FW_IPC.pickFile, { workspaceId: 7 })).toEqual([]);
    findFirst.mockResolvedValue(null);
    expect(await invoke(FW_IPC.pickFile, { workspaceId: 8 })).toEqual([]);
    expect(showOpenDialog).not.toHaveBeenCalled();
  });
});

describe("FileWindowService focusMain（文件窗「打开主页」，T18）", () => {
  /** mock 主窗注入（BrowserWindow 类型是真实声明，mock 实例需断言转换） */
  const asMain = (win: MockWin) => win as unknown as BrowserWindow;

  it("invoke fileWindow:focusMain → 主窗 show+focus", async () => {
    const main = new MockWin();
    newService(() => asMain(main));
    await invoke(FW_IPC.focusMain);
    expect(main.show).toHaveBeenCalled();
    expect(main.focus).toHaveBeenCalled();
    // 最小化检查先行（默认非最小化 → 不 restore）
    expect(main.isMinimized).toHaveBeenCalled();
    expect(main.restore).not.toHaveBeenCalled();
  });

  it("主窗最小化 → restore 后再 show+focus", async () => {
    const main = new MockWin();
    main.isMinimized.mockReturnValue(true);
    newService(() => asMain(main));
    await invoke(FW_IPC.focusMain);
    expect(main.restore).toHaveBeenCalled();
    expect(main.show).toHaveBeenCalled();
    expect(main.focus).toHaveBeenCalled();
  });

  it("主窗缺失/已销毁：静默返回 null 不抛", async () => {
    newService(() => null);
    await expect(invoke(FW_IPC.focusMain)).resolves.toBeNull();
    const dead = new MockWin();
    dead.destroy();
    newService(() => asMain(dead));
    await expect(invoke(FW_IPC.focusMain)).resolves.toBeNull();
  });
});

describe("FileWindowService prewarm（窗口预热，T20 spec §12 项 7）", () => {
  /** 构造时注册的 before-quit 处理器触发（退出回收池窗） */
  const fireBeforeQuit = () => {
    const call = vi
      .mocked(app.on)
      .mock.calls.find(([ev]) => ev === "before-quit");
    (call?.[1] as () => void)?.();
  };
  /** 预热套件默认带存活主窗——prewarm 搁浅守卫：主窗没了不建池 */
  const newPrewarmService = () => {
    const main = new MockWin();
    return newService(() => main as unknown as BrowserWindow);
  };
  const optsOf = (win: MockWin) =>
    (win as unknown as { opts: { show?: boolean } }).opts;

  it("prewarm 搁浅守卫：主窗已销毁且无在用文件窗 → 不建池（启动 2s 定时器晚到场景）", () => {
    const main = new MockWin();
    const svc = newService(() => main as unknown as BrowserWindow);
    main.destroy(); // 启动 2s 内即关主窗：池尚不存在，prune 无物可清
    expect(svc.prewarm()).toBeNull();
    expect(winInstances).toHaveLength(0);
  });

  it("prewarm 建隐藏窗：show:false、不调 show、did-finish-load 不首投", () => {
    const svc = newPrewarmService();
    const windowId = svc.prewarm();
    expect(windowId).toMatch(/^file-window:/);
    const win = winInstances[0];
    expect(winInstances).toHaveLength(1);
    expect(optsOf(win).show).toBe(false);
    expect(win.show).not.toHaveBeenCalled();
    // 同款路由加载（windowId 预生成随路由下发）
    expect(win.loadFile).toHaveBeenCalledWith(
      "/app/dist/index.html",
      expect.objectContaining({
        hash: `/file-window?windowId=${windowId}`,
      }),
    );
    // 加载完成不投递：deliver 恒带真 resources，首投留给 open 取用
    win.listeners["did-finish-load"]?.();
    expect(win.sent.filter((s) => s.channel === FW_IPC.deliver)).toHaveLength(
      0,
    );
  });

  it("prewarmed 窗 close-ready：不重投空 deliver（restored 留给首投）", async () => {
    const svc = newPrewarmService();
    const windowId = svc.prewarm() as string;
    const win = winInstances[0];
    win.listeners["did-finish-load"]?.();
    await invoke(FW_IPC.closeReady, { windowId });
    expect(win.sent.filter((s) => s.channel === FW_IPC.deliver)).toHaveLength(
      0,
    );
  });

  it("池容量 1：重复 prewarm 幂等不叠加", () => {
    const svc = newPrewarmService();
    const first = svc.prewarm();
    expect(svc.prewarm()).toBe(first);
    expect(winInstances).toHaveLength(1);
  });

  it("open 取用池窗：同 windowId、show、投递真 resources；异步补建下一只", async () => {
    vi.useFakeTimers();
    try {
      const svc = newPrewarmService();
      const pooled = svc.prewarm();
      const poolWin = winInstances[0];
      const { windowId } = (await invoke(FW_IPC.open, {
        resources: [RES],
      })) as { windowId: string };
      // 取用而非新建：同 id、显示、显式投递真 resources
      expect(windowId).toBe(pooled);
      expect(poolWin.show).toHaveBeenCalled();
      expect(poolWin.sent.filter((s) => s.channel === FW_IPC.deliver)).toEqual(
        expect.arrayContaining([
          { channel: FW_IPC.deliver, payload: { resources: [RES] } },
        ]),
      );
      // 延迟补建下一只池窗：仍是隐藏窗（错峰 2s）
      vi.advanceTimersByTime(2_000);
      expect(winInstances).toHaveLength(2);
      expect(optsOf(winInstances[1]).show).toBe(false);
      expect(winInstances[1].show).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("取用早于渲染层就位：显式投递即丢由 close-ready 重投真 resources 兜底", async () => {
    const svc = newPrewarmService();
    const pooled = svc.prewarm();
    // 立即取用（渲染层仍在加载，订阅未就位——显式投递会被丢）
    const { windowId } = (await invoke(FW_IPC.open, {
      resources: [RES],
    })) as { windowId: string };
    expect(windowId).toBe(pooled);
    const poolWin = winInstances[0];
    expect(
      poolWin.sent.filter((s) => s.channel === FW_IPC.deliver),
    ).toHaveLength(1);
    // 加载完成：闭包 resources 为建窗空集，不投空 deliver
    poolWin.listeners["did-finish-load"]?.();
    expect(
      poolWin.sent.filter((s) => s.channel === FW_IPC.deliver),
    ).toHaveLength(1);
    // 渲染层就位：close-ready 重投真 resources（initialResources 已随取用同步）
    await invoke(FW_IPC.closeReady, { windowId });
    const delivers = poolWin.sent.filter((s) => s.channel === FW_IPC.deliver);
    expect(delivers).toHaveLength(2);
    expect(delivers[1].payload).toEqual({ resources: [RES] });
  });

  it("池窗失效（未登录期建池被守卫跳 #/login 丢 windowId）→ open 销毁走冷启", async () => {
    const svc = newPrewarmService();
    const pooled = svc.prewarm();
    const poolWin = winInstances[0];
    // 模拟 FileWindowView 登录守卫改写 hash → #/login
    poolWin.url = "http://127.0.0.1:5176/#/login";
    const { windowId } = (await invoke(FW_IPC.open, {
      resources: [RES],
    })) as { windowId: string };
    // 失效池窗销毁，不取用；新窗冷启（首投带真 resources）
    expect(windowId).not.toBe(pooled);
    expect(poolWin.destroyed).toBe(true);
    expect(winInstances).toHaveLength(2);
    winInstances[1].listeners["did-finish-load"]?.();
    expect(winInstances[1].sent.at(-1)).toEqual({
      channel: FW_IPC.deliver,
      payload: { resources: [RES] },
    });
  });

  it("冷启路径同样补排池窗（失效池销毁后 2s 自愈，池不变式恢复）", async () => {
    vi.useFakeTimers();
    try {
      const svc = newPrewarmService();
      svc.prewarm();
      winInstances[0].url = "http://127.0.0.1:5176/#/login";
      await invoke(FW_IPC.open, { resources: [RES] }); // 冷启（销毁失效池）
      expect(winInstances).toHaveLength(2);
      vi.advanceTimersByTime(2_000);
      // 池恢复：第 3 只窗为隐藏预热窗
      expect(winInstances).toHaveLength(3);
      expect(optsOf(winInstances[2]).show).toBe(false);
      expect(winInstances[2].show).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("prewarm 自愈：失效池窗清理后重建（登录后补建的池健康）", () => {
    const svc = newPrewarmService();
    const first = svc.prewarm();
    winInstances[0].url = "http://127.0.0.1:5176/#/login";
    const second = svc.prewarm();
    expect(second).not.toBe(first);
    expect(winInstances[0].destroyed).toBe(true);
    expect(winInstances).toHaveLength(2);
    // 新池窗路由健康（loadFile 已写 #/file-window?windowId=<second>）
    expect(winInstances[1].url).toContain(`#/file-window?windowId=${second}`);
  });

  it("无池窗（未预热）open：现行冷启路径不变（首投带真 resources）", async () => {
    newService();
    const { windowId } = (await invoke(FW_IPC.open, {
      resources: [RES],
    })) as { windowId: string };
    expect(windowId).toMatch(/^file-window:/);
    const win = winInstances[0];
    expect(optsOf(win).show).toBeUndefined();
    win.listeners["did-finish-load"]?.();
    expect(win.sent.at(-1)).toEqual({
      channel: FW_IPC.deliver,
      payload: { resources: [RES] },
    });
  });

  it("before-quit：未取用池窗直接销毁（绕过关闭握手）", () => {
    const svc = newPrewarmService();
    svc.prewarm();
    const poolWin = winInstances[0];
    fireBeforeQuit();
    expect(poolWin.destroyed).toBe(true);
    expect(poolWin.closed).toBe(false);
  });

  it("before-quit：补建排程作废（取用后退出不再建池窗）", async () => {
    vi.useFakeTimers();
    try {
      const svc = newPrewarmService();
      svc.prewarm();
      // 取用 → 排程补建 → 退出
      await invoke(FW_IPC.open, { resources: [RES] });
      fireBeforeQuit();
      vi.advanceTimersByTime(2_000);
      expect(winInstances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("池窗 renderer 已 crashed → 视为失效：open 销毁走冷启", async () => {
    const svc = newPrewarmService();
    const pooled = svc.prewarm();
    // 模拟隐藏闲置 renderer OOM crashed（取用即死白窗）
    winInstances[0].crashed = true;
    const { windowId } = (await invoke(FW_IPC.open, {
      resources: [RES],
    })) as { windowId: string };
    expect(windowId).not.toBe(pooled);
    expect(winInstances[0].destroyed).toBe(true);
    expect(winInstances).toHaveLength(2);
  });

  it("prewarm 同校验 crashed：失效池窗清理后重建", () => {
    const svc = newPrewarmService();
    const first = svc.prewarm();
    winInstances[0].crashed = true;
    const second = svc.prewarm();
    expect(second).not.toBe(first);
    expect(winInstances[0].destroyed).toBe(true);
    expect(winInstances).toHaveLength(2);
  });

  it("搁浅回收：主窗已关且仅剩池窗 → 清池（darwin 亦然，activate 重建主窗路径可走通）", () => {
    const main = new MockWin();
    const svc = newService(() => main as unknown as BrowserWindow);
    svc.prewarm();
    main.destroy();
    svc.prunePrewarmedIfStranded();
    // 池清空后真实 Electron getAllWindows().length 归 0，main.ts activate
    // 得以重建主窗（修复前 darwin 提前 return，隐藏池窗占住计数点 dock 无响应）
    expect(winInstances[0].destroyed).toBe(true);
  });

  it("搁浅回收：主窗存活或仍有文件窗 → 保留池窗", async () => {
    const main = new MockWin();
    const svc = newService(() => main as unknown as BrowserWindow);
    // 先开文件窗（冷启，非池窗）再预热：注册表 = 文件窗 + 池窗
    await invoke(FW_IPC.open, { resources: [RES] });
    svc.prewarm();
    expect(winInstances).toHaveLength(2);
    // 主窗存活：不回收
    svc.prunePrewarmedIfStranded();
    expect(winInstances[1].destroyed).toBe(false);
    // 主窗已关但有未关文件窗：池窗仍保留
    main.destroy();
    svc.prunePrewarmedIfStranded();
    expect(winInstances[1].destroyed).toBe(false);
    expect(winInstances[0].destroyed).toBe(false);
  });
});

describe("FileWindowService openRoute（T22 跨窗导航，spec §13 项 3）", () => {
  const asMain = (win: MockWin) => win as unknown as BrowserWindow;

  it("invoke fileWindow:openRoute → 主窗聚焦 + 发 fileWindow:navigate 事件带 hash", async () => {
    const main = new MockWin();
    newService(() => asMain(main));
    await invoke(FW_IPC.openRoute, { hash: "/module/ai/providers" });
    expect(main.show).toHaveBeenCalled();
    expect(main.focus).toHaveBeenCalled();
    expect(main.sent.at(-1)).toEqual({
      channel: FW_IPC.navigate,
      payload: { hash: "/module/ai/providers" },
    });
  });

  it("主窗最小化 → restore 后再聚焦导航", async () => {
    const main = new MockWin();
    main.isMinimized.mockReturnValue(true);
    newService(() => asMain(main));
    await invoke(FW_IPC.openRoute, {
      hash: "/module/ai/experts?tab=connectors",
    });
    expect(main.restore).toHaveBeenCalled();
    expect(main.sent.at(-1)?.channel).toBe(FW_IPC.navigate);
  });

  it("非 / 起始 hash 拒绝（防御：不向主窗发任意事件载荷）", async () => {
    const main = new MockWin();
    newService(() => asMain(main));
    await expect(
      invoke(FW_IPC.openRoute, { hash: "javascript:alert(1)" }),
    ).rejects.toThrow("INVALID_ROUTE");
    expect(main.sent).toHaveLength(0);
  });

  it("主窗缺失/已销毁：静默返回 null 不抛（不向不存在的窗发事件）", async () => {
    newService(() => null);
    await expect(
      invoke(FW_IPC.openRoute, { hash: "/module/ai/providers" }),
    ).resolves.toBeNull();
    const dead = new MockWin();
    dead.destroy();
    newService(() => asMain(dead));
    await expect(
      invoke(FW_IPC.openRoute, { hash: "/module/ai/providers" }),
    ).resolves.toBeNull();
    expect(dead.sent).toHaveLength(0);
  });
});
