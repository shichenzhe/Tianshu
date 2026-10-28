/**
 * 文件独立窗口服务（WorkBuddy office window 对齐）：
 * - fileWindow:open 开新窗（或向 targetWindowId 投递 resources 复用）；
 *   deliver 投递 = did-finish-load 首投 + close-ready 重投兜底（首投可早于
 *   渲染层订阅即丢；deliver 幂等——openTab 去重/快照权威恢复不重放；
 *   did-finish-load 复位 rendererReady，reload 后重投机制恢复生效）
 * - 注册表 Map<windowId, 窗口+握手状态>；窗口关闭自动清除（快照关窗即弃）
 * - close bridge：close 拦截 → close-request 询问渲染层 → confirm/cancel；
 *   渲染层未 ready 3s 强关；close-request 后 15s 超时视为取消（双定时器
 *   同 WorkBuddy）。窗口 destroyed / renderer crashed 直放行（T28）
 * - 快照：setSessionState/getSessionState（内存 Map，关窗即弃）
 * - 预热池（spec §12 项 7）：ready 后 prewarm 预建隐藏窗（池容量 1）；
 *   open 优先取用（转正：show + 显式投递），open 后统一延迟补建下一只；
 *   池窗建窗传空 resources——首投/close-ready 重投对空集跳过，首个 deliver
 *   留给取用时显式投递（渲染层收到即 bootstrap，链路与冷启动同构）；取用
 *   校验池窗健康（未登录期建池被 FileWindowView 守卫跳 #/login 丢
 *   windowId；crashed 同失效），失效即销毁走冷启；before-quit/搁浅（主窗
 *   已关仅剩池窗，占住全窗口计数）destroy 回收
 * - pickFile：+ 菜单「打开文件」系统选择框（限定 workspace 目录，相对路径回传）
 * - focusMain：AI 面板「打开主页」唤起主窗（show+focus，最小化先 restore；
 *   主窗引用经构造 getter 注入——main.ts 模块级 win 重建后仍取最新，
 *   WindowService 同款先例）
 */
import { app, BrowserWindow, dialog } from "electron";
import path from "node:path";
import prisma from "../../../commons/prisma-client";
import { handleUser } from "../../../commons/ipc-user";
import { shouldAllowNavigation } from "../../security/renderer-guard";
import type { FileWindowResource } from "../../../../src-react/domains/ai/file-window/model/resource";

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
  focusMain: "fileWindow:focusMain",
  /** T22 跨窗导航：文件窗 ChatPane 设置类入口 → 聚焦主窗并令其跳路由 */
  openRoute: "fileWindow:openRoute",
  /** openRoute → 主窗渲染层全局监听跳转（事件通道，白名单见 ipc-channels） */
  navigate: "fileWindow:navigate",
} as const;

export interface FileWindowServiceDeps {
  devServerUrl: string;
  rendererIndex: string;
  preloadPath: string;
  /** 主窗口引用 getter（main.ts 模块级 win；缺失/已销毁时静默） */
  getMainWindow: () => BrowserWindow | null;
}

interface OpenParams {
  resources: FileWindowResource[];
  /** 传入即复用该窗口（tab 菜单「移到新窗口」恒不传 → 新开） */
  targetWindowId?: string;
}

interface SessionStateParams {
  windowId: string;
  snapshot: unknown;
}

interface WindowIdParams {
  windowId: string;
}

interface PickFileParams {
  workspaceId: number;
}

/** T22 跨窗导航：目标应用内路由（"/" 起始；渲染层 router.navigate 直达） */
interface OpenRouteParams {
  hash: string;
}

/** close bridge 每窗握手状态 */
interface RendererState {
  rendererReady: boolean;
  allowClose: boolean;
  timers: NodeJS.Timeout[];
}

interface FileWindowEntry {
  win: BrowserWindow;
  state: RendererState;
  /** 开窗 resources（ready 重投用，见 sendDeliver 注释） */
  initialResources: FileWindowResource[];
  /** 预热池窗（spec §12 项 7）：隐藏待取用，open 转正 */
  prewarmed: boolean;
}

/** 渲染层未 ready 时收到 close 的强关时限（防 renderer 卡死） */
const NOT_READY_FORCE_MS = 3_000;
/** close-request 发出后等待 renderer confirm/cancel 的超时（超时视为取消） */
const CLOSE_TIMEOUT_MS = 15_000;
/** 池窗补建延迟：错开取用窗 show/首屏渲染的资源争抢（池容量 1） */
const PREWARM_REBUILD_MS = 2_000;

export default class FileWindowService {
  private windows = new Map<string, FileWindowEntry>();
  private snapshots = new Map<string, unknown>();
  /** before-quit 置位：停补建（quit 中建窗会拖住/扰动退出流程） */
  private quitting = false;
  private rebuildTimer: NodeJS.Timeout | null = null;

  constructor(private deps: FileWindowServiceDeps) {
    this.registerIpc();
    // 退出回收池窗：隐藏池窗无用户态，destroy 绕过关闭握手——quit 不被
    // 15s 协商超时/未 ready 3s 强关拖住；置 quitting 使补建排程作废
    app.on("before-quit", () => {
      this.quitting = true;
      this.discardPrewarmed();
    });
  }

  private registerIpc(): void {
    handleUser(FILE_WINDOW_IPC.open, (_e, _userId, p: OpenParams) =>
      this.open(p),
    );
    handleUser(
      FILE_WINDOW_IPC.setSessionState,
      (_e, _userId, p: SessionStateParams) => {
        this.snapshots.set(p.windowId, p.snapshot);
        return null;
      },
    );
    handleUser(
      FILE_WINDOW_IPC.getSessionState,
      (_e, _userId, p: WindowIdParams) =>
        this.snapshots.get(p.windowId) ?? null,
    );
    handleUser(FILE_WINDOW_IPC.closeReady, (_e, _userId, p: WindowIdParams) =>
      this.markReady(p.windowId),
    );
    handleUser(FILE_WINDOW_IPC.confirmClose, (_e, _userId, p: WindowIdParams) =>
      this.confirmClose(p.windowId),
    );
    handleUser(FILE_WINDOW_IPC.cancelClose, (_e, _userId, p: WindowIdParams) =>
      this.cancelClose(p.windowId),
    );
    handleUser(FILE_WINDOW_IPC.pickFile, (_e, userId, p: PickFileParams) =>
      this.pickFile(userId, p),
    );
    handleUser(FILE_WINDOW_IPC.focusMain, () => this.focusMain());
    handleUser(FILE_WINDOW_IPC.openRoute, (_e, _userId, p: OpenRouteParams) =>
      this.openRoute(p),
    );
  }

  /** 「打开主页」：唤起主窗（最小化先 restore；缺失/已销毁静默） */
  private focusMain(): null {
    const win = this.deps.getMainWindow();
    if (!win || win.isDestroyed()) return null;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return null;
  }

  /** 跨窗导航（T22）：唤起主窗 + 发 navigate 事件（主窗渲染层全局监听
   *  经 router 跳 hash）；hash 须以 "/" 起始（应用内路由白名单口径——
   *  防向主窗注入任意事件载荷），否则拒收 */
  private openRoute(p: OpenRouteParams): null {
    if (typeof p.hash !== "string" || !p.hash.startsWith("/")) {
      throw new Error("INVALID_ROUTE");
    }
    const win = this.deps.getMainWindow();
    if (!win || win.isDestroyed()) return null;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send(FILE_WINDOW_IPC.navigate, { hash: p.hash });
    return null;
  }

  private async open(p: OpenParams): Promise<{ windowId: string }> {
    if (p.targetWindowId) {
      const entry = this.entryOf(p.targetWindowId);
      // 池窗不可被定向复用（渲染层无从知晓池 id，防御性跳过走池/冷启）
      if (entry && !entry.prewarmed) {
        this.sendDeliver(p.targetWindowId, p.resources);
        entry.win.focus();
        return { windowId: p.targetWindowId };
      }
    }
    const pooled = this.takeHealthyPrewarmed();
    const windowId = pooled ?? `file-window:${crypto.randomUUID()}`;
    if (pooled) this.adoptPrewarmed(pooled, p.resources);
    else this.createWindow(windowId, p.resources);
    // 池不变式（取用/冷启同规，含顺带销毁的失效池——未登录期建池被守卫
    // 跳转的场景）：任意 open 后 2s 池容量恢复 1
    this.schedulePoolRebuild();
    return { windowId };
  }

  /** 取一只健康池窗：路由须仍在本窗 windowId（#/file-window?windowId=…）
   *  且 renderer 未 crash——未登录期建池会被 FileWindowView 登录守卫跳
   *  #/login，windowId 随 hash 改写丢失（store 也停留空 token）；隐藏
   *  闲置 renderer 可能 OOM crashed（取用即死白窗且无恢复路径）。失效
   *  一律销毁后返回 null 走冷启（补建的下一只自然恢复健康） */
  private takeHealthyPrewarmed(): string | null {
    for (const [id, entry] of [...this.windows]) {
      if (!entry.prewarmed) continue;
      const wc = entry.win.webContents;
      const ok =
        !entry.win.isDestroyed() &&
        !wc.isCrashed() &&
        wc.getURL().includes(`#/file-window?windowId=${id}`);
      if (ok) return id;
      this.windows.delete(id);
      if (!entry.win.isDestroyed()) entry.win.destroy();
    }
    return null;
  }

  /** 窗口预热（spec §12 项 7）：预建隐藏窗（同款参数+守卫，show:false）。
   *  建窗传空 resources——首投/close-ready 重投对空集跳过（deliver 恒带
   *  真 resources），首个投递留给 open 取用时显式 sendDeliver，渲染层收
   *  到即 bootstrap（getSessionState 无快照→直接开 tab，链路同冷启动）。
   *  搁浅/退出守卫：主窗已销毁且无在用文件窗时不建无主池窗（启动 2s
   *  定时器晚于「启动即关主窗」到达的场景——无主隐藏窗会占住 activate
   *  全窗口计数），清排程与存量后返回 null。幂等（池容量 1）：失效池窗
   *  （登录守卫跳转/crashed，见 takeHealthyPrewarmed）先销毁再补新；
   *  返回池窗 id（测试用） */
  prewarm(): string | null {
    if (this.quitting || this.stranded()) {
      this.discardPrewarmed();
      return null;
    }
    const pooled = this.takeHealthyPrewarmed();
    if (pooled) return pooled;
    const windowId = `file-window:${crypto.randomUUID()}`;
    this.createWindow(windowId, [], { prewarmed: true });
    return windowId;
  }

  /** 池窗转正：投递真 resources + 显示（补建排程由 open 统一安排） */
  private adoptPrewarmed(
    windowId: string,
    resources: FileWindowResource[],
  ): void {
    const entry = this.entryOf(windowId);
    if (!entry) return;
    entry.prewarmed = false;
    // 重投基准同步为真 resources：取用时渲染层可能仍未订阅（显式投递即
    // 丢），close-ready 兜底重投必须带真资源而非建窗时的空集
    entry.initialResources = resources;
    this.sendDeliver(windowId, resources);
    entry.win.show();
  }

  /** 补建下一只池窗：延迟错峰（新窗显示/首屏优先）；prewarm 自身幂等 */
  private schedulePoolRebuild(): void {
    clearTimeout(this.rebuildTimer ?? undefined);
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      if (!this.quitting) this.prewarm();
    }, PREWARM_REBUILD_MS);
  }

  /** 池窗回收（before-quit/搁浅）：无用户态，destroy 绕过关闭握手 */
  private discardPrewarmed(): void {
    clearTimeout(this.rebuildTimer ?? undefined);
    this.rebuildTimer = null;
    for (const [id, entry] of [...this.windows]) {
      if (!entry.prewarmed) continue;
      this.windows.delete(id);
      if (!entry.win.isDestroyed()) entry.win.destroy();
    }
  }

  /** 搁浅判定：主窗已销毁/缺失且注册表无在用文件窗（只剩或只剩池窗）——
   *  此时建/留隐藏池窗即无主窗口：win/linux 卡 window-all-closed，darwin
   *  卡 main.ts activate 的 getAllWindows().length === 0 判定（点 dock
   *  永不重建主窗，app 表现为死掉） */
  private stranded(): boolean {
    const main = this.deps.getMainWindow();
    const live = [...this.windows.values()].some(
      (e) => !e.prewarmed && !e.win.isDestroyed(),
    );
    return (!main || main.isDestroyed()) && !live;
  }

  /** 搁浅回收：清池（判定见 stranded；触发点 main.ts 主窗 closed +
   *  本服务窗口 closed；prewarm 入口另有同判定守卫兜底启动定时器晚到） */
  prunePrewarmedIfStranded(): void {
    if (this.stranded()) this.discardPrewarmed();
  }

  /** deliver 投递（复用/首开同语义）。幂等：渲染层 openTab 去重、快照
   *  恢复时初始 resources 不重放（裁决在渲染层 store 的 restored 标志，
   *  主进程不感知）——重复投递无副作用 */
  private sendDeliver(windowId: string, resources: FileWindowResource[]): void {
    const entry = this.entryOf(windowId);
    if (!entry || entry.win.isDestroyed()) return;
    entry.win.webContents.send(FILE_WINDOW_IPC.deliver, { resources });
  }

  private createWindow(
    windowId: string,
    resources: FileWindowResource[],
    opts?: { prewarmed?: boolean },
  ): void {
    const win = new BrowserWindow({
      // 文件窗标题区分主窗（spec §13 项 1；渲染层挂载后经 document.title
      // 再落一次——页面 <title>天枢</title> 会覆盖建窗 title）
      title: "天枢 文件浏览器",
      width: 1440,
      height: 852,
      minWidth: 640,
      minHeight: 480,
      // 预热池窗（spec §12 项 7）：隐藏预加载，open 取用时才 show
      ...(opts?.prewarmed ? { show: false } : {}),
      icon: process.env.VITE_PUBLIC
        ? path.join(process.env.VITE_PUBLIC, "pc_logo.png")
        : undefined,
      webPreferences: {
        preload: this.deps.preloadPath,
        webviewTag: true,
      },
      // 窗口框样式照抄主窗 createWindow（titleBarStyle/红绿灯/overlay）
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
      void import("../../security/renderer-guard").then(
        ({ handleWindowOpen }) => handleWindowOpen(url),
      );
      return { action: "deny" };
    });
    // 顶层导航白名单（同主窗）：file:// 与 dev server 放行，其余 http(s) 一律拒
    win.webContents.on("will-navigate", (event, url) => {
      if (!shouldAllowNavigation(url, this.deps.devServerUrl || undefined)) {
        event.preventDefault();
      }
    });
    const entry: FileWindowEntry = {
      win,
      state: { rendererReady: false, allowClose: false, timers: [] },
      initialResources: resources,
      prewarmed: opts?.prewarmed ?? false,
    };
    this.windows.set(windowId, entry);
    // 首投（did-finish-load）：渲染层订阅（bootstrapWindow）可能在事件
    // 之后才就位——早到即丢，close-ready 时 sendDeliver 重投兜底。
    // reload 再触发本事件时复位 rendererReady——新渲染进程须重新
    // close-ready 才收到重投，握手机制对 reload 后的窗口恢复生效。
    // 空集（预热窗）跳过：deliver 恒带真 resources，首投留给取用时投递
    win.webContents.on("did-finish-load", () => {
      entry.state.rendererReady = false;
      if (resources.length > 0) this.sendDeliver(windowId, resources);
    });
    win.on("close", (event) => {
      if (entry.state.allowClose || win.isDestroyed()) return;
      // crashed renderer（T28 spec §16 项 4）：无人应答 close-request，协商
      // 只会白等——清挂起定时器直接放行关闭（不 preventDefault；窗口销毁
      // 已在上方短路，此处 webContents 存活）
      if (win.webContents.isCrashed()) {
        entry.state.timers.forEach(clearTimeout);
        entry.state.timers = [];
        entry.state.allowClose = true;
        return;
      }
      event.preventDefault();
      if (!entry.state.rendererReady) {
        entry.state.timers.push(
          setTimeout(() => {
            entry.state.allowClose = true;
            win.close();
          }, NOT_READY_FORCE_MS),
        );
        return;
      }
      entry.state.timers.push(
        setTimeout(() => this.cancelClose(windowId), CLOSE_TIMEOUT_MS),
      );
      win.webContents.send(FILE_WINDOW_IPC.closeRequest);
    });
    win.on("closed", () => {
      entry.state.timers.forEach(clearTimeout);
      this.snapshots.delete(windowId);
      this.windows.delete(windowId);
      // 搁浅检查（全平台）：主窗已关且无在用文件窗（仅剩隐藏池窗）时清池
      this.prunePrewarmedIfStranded();
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

  /** 打开文件菜单（+ 菜单）：workspace 绑定目录范围多选，返回相对路径
      数组（"/" 分隔，dedupe key 口径）；归属校验口径同 workspace:writeFile
      （findFirst 带 userId），越界（系统对话框绕过/链接逃逸）与未绑定
      目录一律丢弃/空数组 */
  private async pickFile(userId: number, p: PickFileParams): Promise<string[]> {
    const ws = await prisma.workspace.findFirst({
      where: { id: p.workspaceId, userId },
      select: { directoryPath: true },
    });
    const dir = ws?.directoryPath?.trim();
    if (!dir) return [];
    // 单参形态（无父窗口锚定）：文件窗独立渲染进程发起，锚主窗反而错位
    const r = await dialog.showOpenDialog({
      defaultPath: dir,
      properties: ["openFile", "multiSelections"],
    });
    return r.filePaths
      .filter((f) => f === dir || f.startsWith(dir + path.sep))
      .map((f) => path.relative(dir, f).split(path.sep).join("/"));
  }

  private markReady(windowId: string): null {
    const entry = this.entryOf(windowId);
    if (!entry) return null;
    if (!entry.state.rendererReady) {
      entry.state.rendererReady = true;
      // 握手复位：清挂起定时器——未 ready 期间 arm 的 NOT_READY 强关定时
      // 器不得再触发（渲染层已就位，交正常 close-request 协商）；reload
      // 前旧渲染进程的 close-request 15s 超时一并作废（新进程无该请求
      // 上下文，重新 close 会重发）
      entry.state.timers.forEach(clearTimeout);
      entry.state.timers = [];
      // ready 重投：did-finish-load 首投可能早于渲染层订阅即丢（冒烟实测
      // dev 下必现）；此时订阅已就位，重投保证开窗 resources 不丢——
      // deliver 幂等（sendDeliver 注释），先到先消费后到去重。空集
      // （未取用的预热窗）不投：restored 留给取用时的真投递
      if (entry.initialResources.length > 0)
        this.sendDeliver(windowId, entry.initialResources);
    }
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

  /** 注册表查询：窗口已销毁视为不存在 */
  private entryOf(windowId: string): FileWindowEntry | null {
    const entry = this.windows.get(windowId);
    if (!entry || entry.win.isDestroyed()) return null;
    return entry;
  }
}
