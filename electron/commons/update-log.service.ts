/**
 * 更新日志服务
 * 提供从指定文件读取更新日志的功能
 */
import { ipcMain } from "electron";
import fs from "fs";

export interface UpdateLogConfig {
  logFilePath?: string;
}

export default class UpdateLogService {
  private config: UpdateLogConfig;

  constructor(config: UpdateLogConfig = {}) {
    this.config = {
      logFilePath: config.logFilePath,
    };
    this.registerHandlers();
  }

  /**
   * 注册IPC处理程序
   */
  private registerHandlers() {
    ipcMain.handle("update-log:getContent", async () => {
      return this.getUpdateLogContent();
    });

    ipcMain.handle("update-log:getConfig", async () => {
      return {
        logFilePath: this.config.logFilePath,
      };
    });
  }

  /**
   * 获取更新日志内容
   * @returns 更新日志内容
   */
  private async getUpdateLogContent(): Promise<string> {
    if (!this.config.logFilePath || !fs.existsSync(this.config.logFilePath)) {
      throw new Error("更新日志文件不存在");
    }

    const content = fs.readFileSync(this.config.logFilePath, "utf-8");
    if (!content.trim()) {
      throw new Error("更新日志文件内容为空");
    }

    return content;
  }

  /**
   * 更新配置
   * @param newConfig 新的配置
   */
  public updateConfig(newConfig: Partial<UpdateLogConfig>) {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * 设置更新日志文件路径
   * @param filePath 文件路径
   */
  public setLogFilePath(filePath: string) {
    this.config.logFilePath = filePath;
  }
}
