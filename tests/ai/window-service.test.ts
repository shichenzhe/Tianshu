/**
 * 窗口服务单测（Task 15）：
 * - 构造注册：全屏切换 IPC 通道、⇧⌥W globalShortcut、will-quit 注销钩子
 * - 全屏 IPC：按发送者窗口翻转 isFullScreen（false→true / true→false）
 * - 快捷键切换：可见→hide+出任务栏；隐藏→show+回任务栏+focus
 * - 容错：主窗口缺失/已销毁静默；快捷键被占用（注册失败）仅记日志
 * electron 走 mock（ipcMain/globalShortcut/BrowserWindow.fromWebContents/app.on）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { on: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
  globalShortcut: {
    register: vi.fn(() => true),
    unregister: vi.fn(),
  },
  ipcMain: { handle: vi.fn() },
}));

vi.mock("../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import Log from "../../electron/commons/Log";
import WindowService from "../../electron/commons/window.service";
import {
  IPC_EVENT_ALLOWLIST,
  IPC_INVOKE_ALLOWLIST,
} from "../../electron/commons/ipc-channels";

/** 取指定通道的已注册 IPC handler */
function ipcHandlerOf(channel: string) {
  const call = vi
    .mocked(ipcMain.handle)
    .mock.calls.find(([registered]) => registered === channel);
  if (!call) {
    throw new Error(`通道未注册: ${channel}`);
  }
  return call[1];
}

/** 取 ⇧⌥W 已注册的快捷键回调 */
function shortcutCallbackOf(): () => void {
  const call = vi
    .mocked(globalShortcut.register)
    .mock.calls.find(([accelerator]) => accelerator === "Shift+Alt+W");
  if (!call) {
    throw new Error("快捷键未注册: Shift+Alt+W");
  }
  return call[1];
}

/** 取 will-quit 已注册的监听器 */
function willQuitListenerOf(): () => void {
  const call = vi
    .mocked(app.on)
    .mock.calls.find(([event]) => event === "will-quit");
  if (!call) {
    throw new Error("will-quit 未挂监听");
  }
  return call[1];
}

/** 全屏窗口桩（isFullScreen 可变，setFullScreen 记录翻转目标） */
function fullScreenWindow(fullScreen: boolean) {
  return {
    isFullScreen: vi.fn(() => fullScreen),
    setFullScreen: vi.fn((next: boolean) => {
      fullScreen = next;
    }),
  };
}

/** 自绘标题栏控制桩：原生事件可手动触发，最大化状态随操作变化 */
function controlWindow(initialMaximized = false) {
  let maximized = initialMaximized;
  const listeners = new Map<string, () => void>();
  return {
    minimize: vi.fn(),
    maximize: vi.fn(() => {
      maximized = true;
    }),
    unmaximize: vi.fn(() => {
      maximized = false;
    }),
    isMaximized: vi.fn(() => maximized),
    close: vi.fn(),
    on: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
    }),
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: vi.fn(),
      isDestroyed: vi.fn(() => false),
    },
    emit(event: string) {
      listeners.get(event)?.();
    },
  };
}

/** 主窗口可见性桩 */
function mainWindow(visible: boolean) {
  return {
    isVisible: vi.fn(() => visible),
    hide: vi.fn(() => {
      visible = false;
    }),
    show: vi.fn(() => {
      visible = true;
    }),
    focus: vi.fn(),
    setSkipTaskbar: vi.fn(),
    isDestroyed: vi.fn(() => false),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(globalShortcut.register).mockImplementation(() => true);
});

describe("注册与注销", () => {
  it("构造即注册全屏 IPC、⇧⌥W 快捷键并挂 will-quit 注销", () => {
    new WindowService(() => null);
    expect(ipcMain.handle).toHaveBeenCalledWith(
      "window:toggleFullScreen",
      expect.any(Function),
    );
    expect(globalShortcut.register).toHaveBeenCalledWith(
      "Shift+Alt+W",
      expect.any(Function),
    );
    expect(app.on).toHaveBeenCalledWith("will-quit", expect.any(Function));

    willQuitListenerOf()();
    expect(globalShortcut.unregister).toHaveBeenCalledWith("Shift+Alt+W");
  });

  it("快捷键被占用（注册失败）仅记日志不抛错", () => {
    vi.mocked(globalShortcut.register).mockImplementationOnce(() => false);
    new WindowService(() => null);
    expect(Log.error).toHaveBeenCalledTimes(1);
  });
});

describe("全屏切换 IPC", () => {
  it("按发送者窗口翻转：非全屏→进入全屏", () => {
    new WindowService(() => null);
    const win = fullScreenWindow(false);
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(win as never);
    ipcHandlerOf("window:toggleFullScreen")({ sender: {} });
    expect(win.setFullScreen).toHaveBeenCalledWith(true);
  });

  it("全屏→退出全屏", () => {
    new WindowService(() => null);
    const win = fullScreenWindow(true);
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(win as never);
    ipcHandlerOf("window:toggleFullScreen")({ sender: {} });
    expect(win.setFullScreen).toHaveBeenCalledWith(false);
  });

  it("发送者无对应窗口时静默", () => {
    new WindowService(() => null);
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null);
    expect(() =>
      ipcHandlerOf("window:toggleFullScreen")({ sender: {} }),
    ).not.toThrow();
  });
});

describe("自绘标题栏窗口 IPC", () => {
  it("注册控制通道并开放最大化状态事件", () => {
    new WindowService(() => null);
    for (const channel of [
      "window:getState",
      "window:minimize",
      "window:toggleMaximize",
      "window:close",
    ]) {
      expect(IPC_INVOKE_ALLOWLIST).toContain(channel);
      expect(ipcMain.handle).toHaveBeenCalledWith(
        channel,
        expect.any(Function),
      );
    }
    expect(IPC_EVENT_ALLOWLIST).toContain("window:stateChanged");
  });

  it("getState 返回发送者窗口状态且只绑定一次原生事件", () => {
    new WindowService(() => null);
    const win = controlWindow(true);
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(win as never);
    const event = { sender: {} };
    expect(ipcHandlerOf("window:getState")(event)).toEqual({
      maximized: true,
    });
    expect(ipcHandlerOf("window:getState")(event)).toEqual({
      maximized: true,
    });
    expect(win.on).toHaveBeenCalledTimes(2);

    win.unmaximize();
    win.emit("unmaximize");
    expect(win.webContents.send).toHaveBeenCalledWith("window:stateChanged", {
      maximized: false,
    });
    win.maximize();
    win.emit("maximize");
    expect(win.webContents.send).toHaveBeenLastCalledWith(
      "window:stateChanged",
      { maximized: true },
    );
  });

  it("minimize 与 close 仅操作发送者窗口", () => {
    new WindowService(() => null);
    const win = controlWindow();
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(win as never);
    const event = { sender: {} };
    ipcHandlerOf("window:minimize")(event);
    ipcHandlerOf("window:close")(event);
    expect(win.minimize).toHaveBeenCalledTimes(1);
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it("toggleMaximize 切换并返回最新状态", () => {
    new WindowService(() => null);
    const win = controlWindow();
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(win as never);
    const handler = ipcHandlerOf("window:toggleMaximize");
    expect(handler({ sender: {} })).toEqual({ maximized: true });
    expect(win.maximize).toHaveBeenCalledTimes(1);
    expect(handler({ sender: {} })).toEqual({ maximized: false });
    expect(win.unmaximize).toHaveBeenCalledTimes(1);
  });

  it("发送者无对应窗口时所有控制通道安全返回", () => {
    new WindowService(() => null);
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null);
    for (const channel of [
      "window:getState",
      "window:minimize",
      "window:toggleMaximize",
      "window:close",
    ]) {
      expect(() => ipcHandlerOf(channel)({ sender: {} })).not.toThrow();
    }
  });
});

describe("唤起/隐藏主窗口快捷键", () => {
  it("可见→隐藏并移出任务栏", () => {
    const win = mainWindow(true);
    new WindowService(() => win as never);
    shortcutCallbackOf()();
    expect(win.hide).toHaveBeenCalledTimes(1);
    expect(win.setSkipTaskbar).toHaveBeenCalledWith(true);
    expect(win.show).not.toHaveBeenCalled();
  });

  it("隐藏→显示、回任务栏并聚焦", () => {
    const win = mainWindow(false);
    new WindowService(() => win as never);
    shortcutCallbackOf()();
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.setSkipTaskbar).toHaveBeenCalledWith(false);
    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(win.hide).not.toHaveBeenCalled();
  });

  it("主窗口缺失/已销毁时静默", () => {
    new WindowService(() => null);
    expect(() => shortcutCallbackOf()()).not.toThrow();

    const destroyed = { ...mainWindow(true), isDestroyed: vi.fn(() => true) };
    new WindowService(() => destroyed as never);
    expect(() => shortcutCallbackOf()()).not.toThrow();
    expect(destroyed.hide).not.toHaveBeenCalled();
  });
});
