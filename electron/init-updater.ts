import { autoUpdater } from "electron-updater";
import { ipcMain, BrowserWindow, app } from "electron";
import Log from "./commons/Log";
import { Constants } from "./Constants";

let mainWindow: BrowserWindow | null = null;

const isUpdaterDisabled = () =>
  !Constants.UPGRADE_URL || Constants.UPGRADE_URL.startsWith("{{");

export const initUpdater = (win: BrowserWindow) => {
  mainWindow = win;

  // 检查更新（捕获异常，避免 electron-updater 的 Promise reject 时触发 Electron 原生错误对话框）
  // 禁用态（未配置更新源）下直接回发 update-not-available，
  // 保证渲染端"检查更新"菜单始终有响应
  const checkForUpdates = () => {
    if (isUpdaterDisabled()) {
      mainWindow?.webContents.send("update-not-available");
      return;
    }
    autoUpdater.checkForUpdates().catch((error) => {
      Log.error("检查更新失败：", error?.message || String(error));
    });
  };

  ipcMain.on("check-for-updates", () => {
    checkForUpdates();
  });

  // 未配置更新源时静默禁用自动更新
  if (isUpdaterDisabled()) {
    Log.info("未配置更新服务器地址，跳过自动更新初始化");
    return;
  }

  Log.info("初始化更新。。。");

  // 自定义服务器地址
  autoUpdater.setFeedURL({
    provider: "generic",
    url: Constants.UPGRADE_URL,
  });

  autoUpdater.logger = Log;

  autoUpdater.autoDownload = true;

  // 仅开发环境开启本地 dev 更新调试；生产包强制读取打包元数据，
  // 避免加载应用目录旁的 dev-app-update.yml（可被篡改指向任意更新源）
  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true;
  }

  checkForUpdates();

  autoUpdater.on("update-not-available", () => {
    Log.info("无新版本");
    mainWindow?.webContents.send("update-not-available");
  });

  autoUpdater.on("update-available", () => {
    Log.info("检测到新版本");
    mainWindow?.webContents.send("update-available");
  });

  autoUpdater.on("error", (error) => {
    Log.error("更新错误：", JSON.stringify(error));
    mainWindow?.webContents.send("update-error", error.message);
  });

  // 下载进度
  autoUpdater.on("download-progress", (progress) => {
    Log.info(`下载安装包进度: ${progress.percent}%`);
  });

  autoUpdater.on("update-downloaded", () => {
    Log.info("下载完成，是否立即安装更新？");
    mainWindow?.webContents.send("update-downloaded");
  });
};

export const install = () => {
  autoUpdater.quitAndInstall();
};

ipcMain.on("install-update", () => {
  install();
});
