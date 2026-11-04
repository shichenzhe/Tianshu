/**
 * 应用信息服务
 * 提供获取应用名称、版本等信息的功能
 */
import { ipcMain, app } from "electron";
import { createRequire } from "module";
import path from "path";

const require = createRequire(import.meta.url);

export interface AppInfo {
  name: string;
  version: string;
  productName: string;
}

export default class AppInfoService {
  constructor() {
    this.registerHandlers();
  }

  /**
   * 注册IPC处理程序
   */
  private registerHandlers() {
    ipcMain.handle("app:getInfo", async () => {
      return this.getAppInfo();
    });

    ipcMain.handle("app:getVersion", async () => {
      return this.getAppVersion();
    });

    ipcMain.handle("app:getName", async () => {
      return this.getAppName();
    });
  }

  /**
   * 获取应用信息
   * @returns 应用信息
   */
  private getAppInfo(): AppInfo {
    // 获取package.json信息
    const packageJsonPath = path.join(app.getAppPath(), "package.json");
    const packageJson = require(packageJsonPath);

    return {
      name: packageJson.name,
      version: packageJson.version,
      productName: app.getName() || packageJson.name,
    };
  }

  /**
   * 获取应用版本
   * @returns 应用版本号
   */
  private getAppVersion(): string {
    const appInfo = this.getAppInfo();
    return appInfo.version;
  }

  /**
   * 获取应用名称
   * @returns 应用名称
   */
  private getAppName(): string {
    const appInfo = this.getAppInfo();
    return appInfo.name;
  }
}
