import { autoUpdater } from "electron-updater";
import { ipcMain, BrowserWindow, app } from "electron";
import Log from "./commons/Log";

let mainWindow: BrowserWindow | null = null;

export const initUpdater = (win: BrowserWindow) => {
  mainWindow = win;

  // "检查更新"菜单始终有响应：dev 态不检查更新（无 dev-app-update.yml
  // 调测配置；打包态读打包时固化的 app-update.yml——publish 真源在
  // electron-builder.json5，github provider），直接回发"无新版本"
  const checkForUpdates = () => {
    if (!app.isPackaged) {
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

  if (!app.isPackaged) {
    Log.info("开发态跳过自动更新初始化");
    return;
  }

  Log.info("初始化更新。。。");
  autoUpdater.logger = Log;
  autoUpdater.autoDownload = true;

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
