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
import {
  McpManager,
  createDefaultClient,
  parseMcpRow,
} from "./domains/ai/agent/mcp-manager";
import { McpRepository } from "./domains/ai/mcp/mcp.repo";
import { SkillRepository } from "./domains/ai/skill/skill.repo";
import SettingsService from "./domains/app-settings/settings.service";
import AutomationRepository from "./domains/ai/automation/automation.repo";
import ProjectRepository from "./domains/project/project.repo";
import AssetRepository from "./domains/project/asset.repo";
import AutomationScheduler from "./domains/ai/automation/automation-scheduler";
import MemoryScheduler from "./domains/ai/personalization/memory-scheduler";
import MemoryService from "./domains/ai/personalization/memory.service";
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
  private scheduler = new AutomationScheduler();
  // 记忆定时器在 registerServices 组装（需注入已注册 IPC 的 provider/model
  // repo 实例，避免二次 new 触发 ipcMain 重复注册），启动/退出随应用生命周期
  private memoryScheduler: MemoryScheduler | null = null;
  // 记忆 IPC 服务（编辑指令应用 + 手动整理）：同样注入已建 repo 实例，
  // 与 scheduler 共享 memory-inflight 在途互斥
  private memoryService: MemoryService | null = null;
  constructor(databaseVerson: number) {
    this.databaseVerson = databaseVerson;
  }

  /**
   * 执行应用程序
   */
  async execute() {
    await this.initDatabase();
    await this.registerServices();
    this.scheduler.start();
    this.memoryScheduler?.start();
    console.info("register dbservice success");
  }

  /**
   * 初始化数据库：按版本号逐个执行 script/vN 升级脚本
   */
  private async initDatabase(): Promise<void> {
    app.on("quit", () => {
      this.scheduler.stop();
      this.memoryScheduler?.stop();
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
  private async registerServices(): Promise<void> {
    new UserRepository();
    new OptionRepository();
    // 可选 AI 模块：不需要时删除本块与 electron/domains/ai
    const providerRepo = new ProviderRepository();
    const modelRepo = new ModelRepository(providerRepo);
    // 记忆调度器：每晚窗口整理 + 启动补跑（spec §5.2），复用上方 repo 实例
    this.memoryScheduler = new MemoryScheduler({ providerRepo, modelRepo });
    // 记忆 IPC 服务（spec §4）：编辑指令应用 + 手动整理触发，复用 repo 实例
    this.memoryService = new MemoryService({ providerRepo, modelRepo });
    this.memoryService.registerIpc();
    new AssistantRepository();
    const sessionRepo = new SessionRepository();
    // 技能管理：list 自愈对账（扫描→对账→落库）+启停/批量/卸载 IPC；
    // 禁用名单供 chat 组装过滤（P-A §4.2），须先于 ChatService 实例化传入
    const skillRepo = new SkillRepository(prisma);
    // 项目模块：repo 供 chat 组装项目会话上下文（项目指令+挂载专家），
    // 须先于 ChatService 实例化传入（单实例，避免 IPC 重复注册）
    const projectRepo = new ProjectRepository();
    // 资产仓储（二期 T3）：复用 projectRepo.ensureAssetWorkspace 定位资产根，
    // 注册 projectAsset:list/createFolder/rename/delete IPC（upload 等 T4 补）
    new AssetRepository(projectRepo);
    new ChatService(sessionRepo, skillRepo, projectRepo);
    // 内置技能自愈安装：缺失时从应用资源复制（幂等，已存在跳过）；
    // fire-and-forget，失败仅日志不阻塞启动（P-D §2）
    void skillRepo
      .ensureBuiltinSkills()
      .catch((e) => Log.error("内置技能自愈安装失败", e));
    // 设置服务（通用设置面板）：IPC 注册 + 按持久化配置重放代理/防休眠。
    // 重放先于 MCP 启动连接并 await（失败仅日志不阻塞启动），消除并发首连
    // 走未恢复代理的启动竞态
    const settingsService = new SettingsService();
    await settingsService
      .restorePersistedSettings()
      .catch((e) => Log.error("设置启动恢复失败", e));
    // MCP 工具接入：manager 负责连接生命周期与工具注册；repo 负责 CRUD IPC 并联动
    // manager（create/update/delete/setEnabled/reconnect）。启动连接为 fire-and-forget，
    // 失败不影响应用启动（此处 wrapper 过滤 enabled 行，仅启动路径使用）
    const mcpManager = new McpManager({
      createClient: createDefaultClient,
      prisma: {
        mcpServer: {
          findMany: async () => {
            const rows = await prisma.mcpServer.findMany({
              where: { enabled: true },
            });
            return rows.map(parseMcpRow);
          },
        },
      },
    });
    new McpRepository(prisma, mcpManager);
    void mcpManager
      .startupConnectAll()
      .catch((e) => Log.error("MCP 启动连接失败", e));
    // 基础设施
    new Log();
    new AppInfoService();
    new UpdateLogService({
      logFilePath: path.join(path.join(__dirname, "docs"), "update-log.md"),
    });
    // 自动化模块:repo 注册 IPC;调度器随应用生命周期启停
    new AutomationRepository();
  }
}
