/**
 * 窗口服务（快捷键配套的主进程能力）：
 * - window:toggleFullScreen IPC：按事件发送者窗口翻转全屏（渲染层 ⌘⌃F 分发）
 * - 唤起/隐藏主窗口全局快捷键 ⇧⌥W（Shift+Alt+W）：可见→隐藏并出任务栏，
 *   隐藏→显示、回任务栏并聚焦；app will-quit 时注销，避免占用系统热键
 */
import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";

import Log from "./Log";

/** 唤起/隐藏主窗口快捷键（showHideWindow 命令的系统级固定绑定） */
export const SHOW_HIDE_WINDOW_ACCELERATOR = "Shift+Alt+W";

const TOGGLE_FULL_SCREEN_CHANNEL = "window:toggleFullScreen";

export default class WindowService {
  /** 主窗口引用以 getter 注入（main.ts 的 win 为模块级变量，重建后仍取到最新） */
  constructor(private getMainWindow: () => BrowserWindow | null) {
    this.registerIpcHandlers();
    this.registerGlobalShortcut();
    app.on("will-quit", () => this.unregisterGlobalShortcut());
  }

  /** 全屏切换 IPC：以发送者窗口为目标（多窗口下各翻各的） */
  private registerIpcHandlers(): void {
    ipcMain.handle(TOGGLE_FULL_SCREEN_CHANNEL, (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      win?.setFullScreen(!win.isFullScreen());
    });
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
