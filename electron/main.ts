import { app, Tray, Menu, BrowserWindow, dialog } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ConsoleLogProxy from "./commons/console-log-proxy.js";
import Log from "./commons/Log.js";
import Application from "./Application.js";
import WindowService from "./commons/window.service.js";
import { Constants } from "./Constants.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, "..");

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, "public")
  : RENDERER_DIST;

let win: BrowserWindow | null;
new ConsoleLogProxy();
const isDevelopment = process.env.NODE_ENV === "development";

// 全局捕获未处理异常与 Promise rejection，避免 Electron 弹出原生错误对话框（仅记日志）
process.on("uncaughtException", (error) => {
  Log.error(
    "Uncaught exception:",
    error?.stack || error?.message || String(error),
  );
});
process.on("unhandledRejection", (reason) => {
  Log.error(
    "Unhandled rejection:",
    reason instanceof Error ? reason.stack || reason.message : String(reason),
  );
});

//禁用硬件加速
app.disableHardwareAcceleration();
if (!isDevelopment) {
  //只打开一个窗口
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    app.quit();
  } else {
    app.on("second-instance", () => {
      if (win) {
        win.show();
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
  }
}

import { initUpdater } from "./init-updater.js";
function createWindow() {
  win = new BrowserWindow({
    title: "天枢",
    width: 910,
    height: 700,
    icon: process.env.VITE_PUBLIC
      ? path.join(process.env.VITE_PUBLIC, "pc_logo.png")
      : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
    },
    // macOS 用 hidden（红绿灯浮层），布局上单独留一行给红绿灯；
    // Windows 生产用 hidden + overlay（自绘窗口按钮），开发用 default。
    titleBarStyle:
      process.platform !== "darwin" && process.env.NODE_ENV === "development"
        ? "default"
        : "hidden",
    titleBarOverlay:
      process.platform === "darwin"
        ? undefined
        : {
            color: "#ffffff", // 白色背景
            symbolColor: "#000000", // 黑色图标
            height: 36, // 控制按钮高度，与前端 TopBar h-9 (36px) 保持一致
          },
  });

  //生产环境隐藏菜单栏
  if (process.env.NODE_ENV !== "development") {
    win.setMenuBarVisibility(false);
  }

  // Test active push message to Renderer-process.
  win.webContents.on("did-finish-load", () => {
    win?.webContents.send("main-process-message", new Date().toLocaleString());
  });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(RENDERER_DIST, "index.html"));
  }

  // 关闭窗口最小化到托盘
  // closeForMinize(win);

  //自动更新检查
  win.on("ready-to-show", () => {
    win?.show();
    if (!isDevelopment) {
      setTimeout(() => {
        if (win) initUpdater(win);
      }, 5000);
    }
  });
}

// 最小化到托盘（暂未启用；如需启用，在 createWindow 内调用 closeForMinize(win)）
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function closeForMinize(app: BrowserWindow) {
  // 监听关闭事件，阻止默认的退出行为，改为最小化窗口
  app.on("close", (event) => {
    event.preventDefault(); // 阻止窗口关闭
    app?.minimize(); // 最小化窗口
    app?.setSkipTaskbar(true);
  });

  const tray = new Tray(path.join(__dirname, "../public/pc_logo.png"));
  const contextMenu = Menu.buildFromTemplate([
    { label: "打开主界面", click: () => app?.show() }, // 恢复窗口
    {
      label: "退出",
      click: () => {
        app?.destroy();
      },
    },
  ]);
  tray.setToolTip("天枢");
  tray.setContextMenu(contextMenu);
  tray.on("click", () => {
    // 我们这里模拟桌面程序点击通知区图标实现打开关闭应用的功能
    // 以点击前的可见性为准（与源实现一致：隐藏时 setSkipTaskbar(true)，显示时 setSkipTaskbar(false)）
    const wasVisible = app?.isVisible();
    if (wasVisible) {
      app?.hide();
      app?.setSkipTaskbar(true);
    } else {
      app?.show();
      app?.setSkipTaskbar(false);
    }
  });
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
    win = null;
  }
});

app.on("activate", () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.whenReady().then(async () => {
  // 在应用启动时设置便携模式（重新安装后data目录会被删掉，因此注释）
  // const isDevelopment = process.env.NODE_ENV === "development";
  // if (process.platform == "win32" && !isDevelopment) {
  //   app.setPath(
  //     "userData",
  //     path.join(path.dirname(app.getPath("exe")), "data")
  //   );
  // }

  try {
    await new Application(Constants.DATABASE_VERSION).execute();
    createWindow();
    // 窗口服务：全屏切换 IPC + 唤起/隐藏主窗口全局快捷键（⇧⌥W）
    new WindowService(() => win);
  } catch (e) {
    console.error("Application execute failed:", e);
    dialog.showErrorBox(
      "天枢启动失败",
      e instanceof Error ? e.stack || e.message : String(e),
    );
    app.quit();
  }
});
