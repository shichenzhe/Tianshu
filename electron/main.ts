import { app, Tray, Menu, BrowserWindow, dialog } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
// 数据根装配见 commons/tianshu-data.ts：由 prisma-client/Log 等顺序敏感
// 消费者各自先调（打包器模块顺序不可依赖，详见该文件头注释）
import ConsoleLogProxy from "./commons/console-log-proxy.js";
import Log from "./commons/Log.js";
import Application from "./Application.js";
import WindowService from "./commons/window.service.js";
import FileWindowService from "./domains/ai/file-window/file-window.service.js";
import { Constants } from "./Constants.js";
import { fixPathForGuiProcess } from "./commons/path-env.js";

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
// 打包态 GUI 启动（launchd）不加载 shell 配置，PATH 缺 Homebrew/nvm 等目录，
// run_command/代码节点执行外部命令会全数 ENOENT——须在任何子进程调用前补齐
if (app.isPackaged) {
  fixPathForGuiProcess();
}

process.env.APP_ROOT = path.join(__dirname, "..");

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, "public")
  : RENDERER_DIST;

let win: BrowserWindow | null;
let fileWindowService: FileWindowService | undefined;
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

//禁用硬件加速（2026-10-09 排查确认与 webview 卡死无关，保持禁用）
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
import {
  handleWindowOpen,
  shouldAllowNavigation,
} from "./domains/security/renderer-guard.js";
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
      // 资料库预览 <webview>（html/pdf/音视频走内置 Chromium 渲染，spec 裁定 6）
      webviewTag: true,
    },
    // macOS 用 hidden（红绿灯浮层），布局上单独留一行给红绿灯；
    // Windows 生产用 hidden + overlay（自绘窗口按钮），开发用 default。
    titleBarStyle:
      process.platform !== "darwin" && process.env.NODE_ENV === "development"
        ? "default"
        : "hidden",
    // macOS 红绿灯垂直对齐 TopBar(h-11=44px) 内容行：钮径约 12px，
    // y=16 使钮中心落在 22px——与 TopBar 左段按钮组（h-7 居中）同水平
    // 线；x 取系统默认左缘。Windows 不适用（overlay 自绘）不传
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 13, y: 16 } }
      : {}),
    titleBarOverlay:
      process.platform === "darwin"
        ? undefined
        : {
            color: "#ffffff", // 白色背景
            symbolColor: "#000000", // 黑色图标
            height: 44, // 控制按钮高度，与前端 TopBar h-11 (44px) 保持一致
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

  // 外开动作已在 handleWindowOpen 内完成（放行域经 shell.openExternal），此处恒拒 Electron 内开窗
  win.webContents.setWindowOpenHandler(({ url }) => {
    handleWindowOpen(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!shouldAllowNavigation(url, VITE_DEV_SERVER_URL)) {
      event.preventDefault();
    }
  });

  // 池窗搁浅回收（T20）：主窗关闭后若仅剩隐藏预热窗（Windows/Linux 卡
  // window-all-closed 不退出；macOS 卡下方 activate 的全窗口计数，点
  // dock 永不重建主窗），交文件窗服务清池
  win.on("closed", () => fileWindowService?.prunePrewarmedIfStranded());

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
    // 文件独立窗口服务：主窗/资料库预览「在新窗口打开」开独立 BrowserWindow
    // （多 tab 编辑 + AI 面板，spec 2026-10-14 file-window）
    fileWindowService = new FileWindowService({
      devServerUrl: VITE_DEV_SERVER_URL ?? "",
      rendererIndex: path.join(RENDERER_DIST, "index.html"),
      preloadPath: path.join(__dirname, "preload.mjs"),
      // 主窗引用 getter 注入（模块级 win 重建后仍取最新，WindowService
      // 同款）：文件窗 AI 面板「打开主页」唤起主窗
      getMainWindow: () => win,
    });
    // 文件窗预热（T20，spec §12 项 7）：延迟 2s 错开主窗启动（Prisma 迁移
    // /首屏渲染）的资源争抢；池容量 1，open 取用即免冷启、取用后自动补建
    setTimeout(() => fileWindowService?.prewarm(), 2_000);
  } catch (e) {
    console.error("Application execute failed:", e);
    dialog.showErrorBox(
      "天枢启动失败",
      e instanceof Error ? e.stack || e.message : String(e),
    );
    app.quit();
  }
});
