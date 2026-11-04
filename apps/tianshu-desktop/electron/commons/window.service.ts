/**
 * 窗口服务：全屏快捷键、Windows 自绘标题栏控制及主窗唤起/隐藏
 */
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  type WebContents,
} from "electron";

import Log from "./Log";

/** 唤起/隐藏主窗口快捷键（showHideWindow 命令的系统级固定绑定） */
export const SHOW_HIDE_WINDOW_ACCELERATOR = "Shift+Alt+W";

const TOGGLE_FULL_SCREEN_CHANNEL = "window:toggleFullScreen";
const STATE_CHANGED_CHANNEL = "window:stateChanged";

export interface WindowControlState {
  maximized: boolean;
}

export default class WindowService {
  private readonly stateTrackedWindows = new WeakSet<BrowserWindow>();

  /** 主窗口引用以 getter 注入（main.ts 的 win 为模块级变量，重建后仍取到最新） */
  constructor(private getMainWindow: () => BrowserWindow | null) {
    this.registerIpcHandlers();
    this.registerGlobalShortcut();
    app.on("will-quit", () => this.unregisterGlobalShortcut());
  }

  /** 全屏切换与自绘窗口按钮 IPC：均以发送者窗口为目标 */
  private registerIpcHandlers(): void {
    ipcMain.handle(TOGGLE_FULL_SCREEN_CHANNEL, (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      win?.setFullScreen(!win.isFullScreen());
    });
    ipcMain.handle("window:getState", (event) =>
      this.getWindowState(event.sender),
    );
    ipcMain.handle("window:minimize", (event) => {
      BrowserWindow.fromWebContents(event.sender)?.minimize();
    });
    ipcMain.handle("window:toggleMaximize", (event) =>
      this.toggleMaximize(event.sender),
    );
    ipcMain.handle("window:close", (event) => {
      BrowserWindow.fromWebContents(event.sender)?.close();
    });
  }

  /** 查询时绑定原生状态事件；重复挂载/查询不重复监听 */
  private getWindowState(sender: WebContents): WindowControlState {
    const win = BrowserWindow.fromWebContents(sender);
    if (!win) return { maximized: false };
    this.trackWindowState(win);
    return this.stateOf(win);
  }

  private toggleMaximize(sender: WebContents): WindowControlState {
    const win = BrowserWindow.fromWebContents(sender);
    if (!win) return { maximized: false };
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return this.stateOf(win);
  }

  private stateOf(win: BrowserWindow): WindowControlState {
    return { maximized: win.isMaximized() };
  }

  /** 双击拖拽区等原生路径也经事件同步按钮图标 */
  private trackWindowState(win: BrowserWindow): void {
    if (this.stateTrackedWindows.has(win)) return;
    this.stateTrackedWindows.add(win);
    const sendState = () => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      win.webContents.send(STATE_CHANGED_CHANNEL, this.stateOf(win));
    };
    win.on("maximize", sendState);
    win.on("unmaximize", sendState);
  }

  /** 注册唤起/隐藏快捷键；被其他应用占用（注册失败）时仅记日志 */
  private registerGlobalShortcut(): void {
    const registered = globalShortcut.register(
      SHOW_HIDE_WINDOW_ACCELERATOR,
      () => this.toggleMainWindow(),
    );
    if (!registered) {
      Log.error(
        `全局快捷键注册失败（可能被占用）: ${SHOW_HIDE_WINDOW_ACCELERATOR}`,
      );
    }
  }

  /** will-quit 注销：全局热键随进程退出必须释放 */
  private unregisterGlobalShortcut(): void {
    globalShortcut.unregister(SHOW_HIDE_WINDOW_ACCELERATOR);
  }

  /** 切换主窗口可见性（与托盘点击同口径：隐藏时移出任务栏） */
  private toggleMainWindow(): void {
    const win = this.getMainWindow();
    if (!win || win.isDestroyed()) {
      return;
    }
    if (win.isVisible()) {
      win.hide();
      win.setSkipTaskbar(true);
      return;
    }
    win.show();
    win.setSkipTaskbar(false);
    win.focus();
  }
}
