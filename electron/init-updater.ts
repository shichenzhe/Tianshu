import { autoUpdater } from "electron-updater";
import { ipcMain, BrowserWindow } from "electron";
import Log from "./commons/Log";
import { Constants } from "./Constants";

let mainWindow: BrowserWindow | null = null;

export const initUpdater = (win: BrowserWindow) => {
  // 未配置更新源时静默禁用自动更新
  if (!Constants.UPGRADE_URL || Constants.UPGRADE_URL.startsWith("{{")) {
    Log.info("未配置更新服务器地址，跳过自动更新初始化");
    return;
  }

  mainWindow = win;

  Log.info("初始化更新。。。");

  // 自定义服务器地址
  autoUpdater.setFeedURL({
    provider: "generic",
    url: Constants.UPGRADE_URL,
  });

  autoUpdater.logger = Log;

  autoUpdater.autoDownload = true;

  // 开启本地dev调试
  autoUpdater.forceDevUpdateConfig = true;

  // 检查更新（捕获异常，避免 electron-updater 的 Promise reject 时触发 Electron 原生错误对话框）
  const checkForUpdates = () => {
    autoUpdater.checkForUpdates().catch((error) => {
      Log.error("检查更新失败：", error?.message || String(error));
    });
  };

  checkForUpdates();

  ipcMain.on("check-for-updates", () => {
    checkForUpdates();
  });

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
