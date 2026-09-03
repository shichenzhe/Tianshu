import { app } from "electron";
import path from "path";
import VersionRepository from "./infrastructure/version/version.repo";
import UserRepository from "./domains/user/user.repo";
import OptionRepository from "./domains/option/option.repo";
import { ProviderRepository } from "./domains/ai/provider/provider.repo";
import { ModelRepository } from "./domains/ai/provider/model.repo";
import { AssistantRepository } from "./domains/ai/chat/assistant.repo";
import { SessionRepository } from "./domains/ai/chat/session.repo";
import ChatService from "./domains/ai/chat/chat.service";
import SqlFileExecutor from "./commons/sql-file-executor";
import { fileURLToPath } from "node:url";
import Log from "./commons/Log";
import AppInfoService from "./commons/app-info.service";
import UpdateLogService from "./commons/update-log.service";
import prisma from "./commons/prisma-client";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default class Application {
  private databaseVerson: number;
  constructor(databaseVerson: number) {
    this.databaseVerson = databaseVerson;
  }

  /**
   * 执行应用程序
   */
  async execute() {
    await this.initDatabase();
    this.registerServices();
    console.info("register dbservice success");
  }

  /**
   * 初始化数据库：按版本号逐个执行 script/vN 升级脚本
   */
  private async initDatabase(): Promise<void> {
    app.on("quit", () => {
      prisma.$disconnect();
      console.info("database closed");
    });
    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") {
        prisma.$disconnect();
        console.info("database closed on window-all-closed");
      }
    });

    try {
      const currentVersion = await VersionRepository.getCurrent();
      Log.info(
        `当前数据库版本: ${currentVersion}, 目标版本: ${this.databaseVerson}`,
      );

      if (currentVersion === 0) {
        await VersionRepository.initTable();
      }

      if (currentVersion < this.databaseVerson) {
        const sqlFileExecutor = new SqlFileExecutor();
        for (let i = currentVersion + 1; i <= this.databaseVerson; i++) {
          const sqlPath = path.join(path.join(__dirname, "script"), "v" + i);
          Log.info(`执行升级脚本: ${sqlPath}`);

          await sqlFileExecutor.executeFile(
            path.join(sqlPath, "upgrade-table.sql"),
          );
          try {
            await sqlFileExecutor.executeFile(
              path.join(sqlPath, "upgrade-data.sql"),
            );
          } catch (e) {
            Log.error("upgrade data error", e);
          }
          Log.info(`upgrade database to v${i}`);
        }

        await VersionRepository.update(currentVersion, this.databaseVerson);
      }

      Log.info("init database success");
    } catch (e) {
      Log.error("init database failed", e);
      prisma.$disconnect();
      throw e;
    }
  }

  /**
   * 注册服务（新增业务域时在此接线，参考 docs/guide.md）
   */
  private registerServices(): void {
    new UserRepository();
    new OptionRepository();
    // 可选 AI 模块：不需要时删除本块与 electron/domains/ai
    const providerRepo = new ProviderRepository();
    new ModelRepository(providerRepo);
    new AssistantRepository();
    const sessionRepo = new SessionRepository();
    new ChatService(sessionRepo);
    // 基础设施
    new Log();
    new AppInfoService();
    new UpdateLogService({
      logFilePath: path.join(path.join(__dirname, "docs"), "update-log.md"),
    });
  }
}
