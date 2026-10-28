import { app, BrowserWindow } from "electron";
import path from "path";
import VersionRepository from "./infrastructure/version/version.repo";
import {
  dropAllTables,
  readSnapshotHash,
  recordSnapshotHash,
  shouldResetDatabase,
} from "./infrastructure/version/snapshot-guard";
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
import LibraryRepository from "./domains/ai/library/library.repo";
import SettingsService from "./domains/app-settings/settings.service";
import AutomationRepository from "./domains/ai/automation/automation.repo";
import MonitorRepository from "./domains/ai/monitor/monitor.repo";
import GraphRepository from "./domains/ai/orchestration/graph.repo";
import ProjectRepository from "./domains/project/project.repo";
import AssetRepository from "./domains/project/asset.repo";
import PlanItemRepository from "./domains/project/plan-item.repo";
import PlanViewRepository from "./domains/project/plan-view.repo";
import AutomationScheduler from "./domains/ai/automation/automation-scheduler";
import { setEventBusDisabledTools } from "./domains/ai/automation/automation-event-bus";
import { graphTestInflight } from "./domains/ai/orchestration/graph-inflight";
import MemoryScheduler from "./domains/ai/personalization/memory-scheduler";
import MemoryService from "./domains/ai/personalization/memory.service";
import AuditLogService from "./domains/security/audit/audit-log.service";
import SecurityService from "./domains/security/security.service";
import {
  installCommandGate,
  installCommandWatchlist,
  makeCommandDecider,
} from "./domains/security/command-gate";
import { installFileGate, makeFileDecider } from "./domains/security/file-gate";
import { tianshuRoot, fileHistoryDir } from "./commons/paths";
import { FileHistoryService } from "./domains/security/file-history";
import FileWriteIpc from "./domains/ai/file-window/file-write-ipc";
import { isPathGrantedSync } from "./domains/ai/file-window/granted-paths";
import { registerGrantedPathsIpc } from "./domains/ai/file-window/granted-paths-ipc";
import SqlFileExecutor from "./commons/sql-file-executor";
import { fileURLToPath } from "node:url";
import Log from "./commons/Log";
import AppInfoService from "./commons/app-info.service";
import UpdateLogService from "./commons/update-log.service";
import { setAppOption } from "./domains/app-settings/option-store";
import prisma, {
  cleanupGraphRunSessions,
  ensureArtifactTable,
  ensureEventStatMaintenance,
  ensureGraphRunNodeTable,
  ensureMonitorTables,
} from "./commons/prisma-client";
import { Constants } from "./Constants";
import { setPolicyHook } from "./domains/app-settings/proxy-dispatcher";
import { buildExemptDomains } from "./domains/security/domain-policy";
import { installNetworkGate } from "./domains/security/network-gate";
import {
  installSessionGuard,
  installLibraryPreviewSessionGuard,
} from "./domains/security/renderer-guard";
import { registerTerminalIpc } from "./domains/ai/terminal/terminal-ipc";
import {
  installBrowserSessionGuard,
  registerBrowserGuestPopupForwarding,
  registerBrowserIpc,
} from "./domains/ai/browser/browser-session";
import { registerBrowserActionsIpc } from "./domains/ai/browser/browser-actions-ipc";
import { installGuestRegistry } from "./domains/ai/browser/guest-registry-ipc";
import { LocalConnectProxy } from "./domains/security/local-proxy";
import {
  attachServerFace,
  shutdownServerFace,
} from "./domains/server-face/ipc";
import { registerServerIpc, shutdownServerConsole } from "./domains/server/ipc";
import { createMemoryFace } from "./domains/server-face/memory-tap";
import { loadPersonalization } from "./domains/ai/personalization/personalization.repo";
import { serverConnections } from "./domains/server/connections";
import { registerBackupIpc, type BackupIpcDeps } from "./domains/backup/ipc";
import { createBackupFace } from "./domains/server-face/backup-tap";
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
  // A7 项目域四仓储实例留存（registerServices 组装，注入被控面
  // attachServerFace——构造函数注册全部 IPC handler，face 侧严禁二次构造；
  // AssetRepository 依赖同一 projectRepo 定位资产根）
  private projectRepo: ProjectRepository | null = null;
  private assetRepo: AssetRepository | null = null;
  private planItemRepo: PlanItemRepository | null = null;
  private planViewRepo: PlanViewRepository | null = null;
  constructor(databaseVerson: number) {
    this.databaseVerson = databaseVerson;
  }

  /**
   * 执行应用程序
   */
  async execute() {
    await this.initDatabase();
    // 埋点表索引补建与保留期裁剪（M12）+ 产物表建表（H7a）+ 监控事件表
    // 建表 + 图运行节点详情表建表与存量图运行会话清理（去会话化
    // 2026-10-28）：均失败仅记日志不阻塞启动；
    // ensureEventStatMaintenance 会对新表 deleteMany，须待 ensureMonitorTables
    // 建表成功后再跑（串行，避免微任务交错下 no such table）
    void ensureArtifactTable().catch((e) =>
      console.error("产物表建表失败:", e),
    );
    void ensureMonitorTables()
      .then(() => ensureEventStatMaintenance())
      .catch((e) => console.error("埋点/监控事件表维护失败:", e));
    void ensureGraphRunNodeTable()
      .then(() => cleanupGraphRunSessions())
      .catch((e) => console.error("图运行节点表/存量会话清理失败:", e));
    await this.registerServices();
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
      // 图试运行在途中止（悬挂 run 由下次启动 recoverInterruptedRuns 兜底）
      for (const abort of graphTestInflight.values()) {
        abort.abort();
      }
      // webhook server：中止在途运行并关 listener（模块已加载则微任务内完成）
      void import("./domains/ai/orchestration/webhook-server").then((m) =>
        m.stopWebhookServer(),
      );
      // 被控面：停 HTTP 服务面与 relay 客户端（SSE/WS 连接随 listener 关闭）
      void shutdownServerFace();
      // 控制端：拆连接注册表 transport + 停本地无头端子进程（T16）
      void shutdownServerConsole();
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
      let currentVersion = await VersionRepository.getCurrent();
      Log.info(
        `当前数据库版本: ${currentVersion}, 目标版本: ${this.databaseVerson}`,
      );

      if (currentVersion === 0) {
        await VersionRepository.initTable();
      }

      // 快照守卫（snapshot-guard）：版本倒挂或同版本指纹不符（发布前
      // 改 v1 快照不加版）→ drop 全部业务表重放 v1 全量重建（开发期数据可弃）
      const snapshotPath = path.join(
        __dirname,
        "script",
        "v1",
        "upgrade-table.sql",
      );
      const snapshotHash = await readSnapshotHash(snapshotPath);
      if (
        await shouldResetDatabase(
          prisma.option,
          currentVersion,
          this.databaseVerson,
          snapshotHash,
        )
      ) {
        Log.warn(
          "数据库结构与 v1 全量快照不一致（版本倒挂或快照已修改），重置开发库重建",
        );
        await dropAllTables({
          query: (sql) => prisma.$queryRawUnsafe(sql),
          execute: (sql) => prisma.$executeRawUnsafe(sql),
        });
        await VersionRepository.initTable();
        currentVersion = 0;
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
        await recordSnapshotHash(prisma.option, snapshotHash);
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
    // 技能管理：list 自愈对账（扫描→对账→落库）+启停/批量/卸载 IPC；
    // 禁用名单供 chat 组装过滤（P-A §4.2），须先于 ChatService 实例化传入；
    // 已安装技能名清单另供专家工具 skillNames 过滤（专家 2.0 Task 3），
    // 故先于 AssistantRepository 构造
    const skillRepo = new SkillRepository(prisma);
    // 专家工具 create/update_expert 构造时静态注册进聚合 registry，
    // 注入 skillRepo 已安装清单（构造器可选 deps 最小侵入注入）
    const assistantRepo = new AssistantRepository({
      listInstalledNames: () => skillRepo.listInstalledNames(),
    });
    const sessionRepo = new SessionRepository();
    // 资料库（DB v11）：拷贝入库 + ID 寻址存储；实例留存注入被控面
    // （A5——构造函数注册全部 IPC handler，face 侧严禁二次构造）
    const libraryRepo = new LibraryRepository(prisma);
    // 监控统计：token/工具事件聚合查询 IPC + 被控面只读路由
    const monitorRepo = new MonitorRepository();
    // 项目模块：repo 供 chat 组装项目会话上下文（项目指令+挂载专家），
    // 须先于 ChatService 实例化传入（单实例，避免 IPC 重复注册）
    this.projectRepo = new ProjectRepository();
    // 资产仓储（二期 T3）：复用 projectRepo.ensureAssetWorkspace 定位资产根，
    // 注册 projectAsset:list/createFolder/rename/delete IPC（upload 等 T4 补）
    this.assetRepo = new AssetRepository(this.projectRepo);
    // 计划事项仓储（三期 T2）：计划/任务双视图聚合 + 枚举校验 + 拖拽落点 IPC
    // （fields 两通道 Task 3 注册）
    this.planItemRepo = new PlanItemRepository();
    this.planViewRepo = new PlanViewRepository();
    // 安全中心（SP1）：审计链服务先行（SecurityService 写审计依赖），
    // 均注入 prisma 单例；init 恢复审计链尾，失败仅日志不阻塞启动
    const auditLogService = new AuditLogService();
    await auditLogService.init().catch((e) => Log.error("审计链恢复失败", e));
    // provider 豁免域 30s TTL 缓存（SP5 网络安全门消费）——声明须先于
    // SecurityService：init 尾部即触 onConfigChange，晚声明会 TDZ ReferenceError
    const providerDomains: string[] = [];
    let providerDomainsAt = 0;
    const readProviderDomains = async (): Promise<string[]> => {
      if (Date.now() - providerDomainsAt < 30_000) return providerDomains;
      try {
        const rows = await prisma.provider.findMany({
          select: { baseUrl: true },
        });
        providerDomains.length = 0;
        providerDomains.push(...rows.map((r) => r.baseUrl));
        providerDomainsAt = Date.now();
      } catch (e) {
        Log.error("provider 豁免域读取失败，豁免面退化为 loopback+升级域", e);
      }
      return providerDomains;
    };
    // 网络安全门（SP5）：单例安装——policyProvider 保持同步（undici dispatch
    // 同步路径）：TTL 内用豁免域缓存，过期由异步刷新。声明先于 SecurityService
    // 与代理生命周期函数：init 尾部即触 onConfigChange，晚声明会 TDZ ReferenceError
    const networkGate = installNetworkGate({
      policyProvider: () => {
        const config = securityService.getConfigValue();
        if (!config.sandboxEnabled) return null;
        return {
          exemptDomains: buildExemptDomains(
            providerDomains,
            Constants.UPGRADE_URL,
          ),
          domainAllow: config.domainAllow,
          domainDeny: config.domainDeny,
          blockAllNetwork: config.blockAllNetwork,
          maliciousDomainProtection: config.maliciousDomainProtection,
        };
      },
      audit: (event) => auditLogService.append(event),
    });
    // 本地 CONNECT 代理（SP5）：按配置需要启停（spec §5 生命周期）——
    // 声明须先于 SecurityService（TDZ 同上）；securityService/networkGate
    // 均为闭包引用，onConfigChange 触发时两者已就绪
    const localProxy = new LocalConnectProxy(() => networkGate);
    const syncProxyLifecycle = async (): Promise<void> => {
      const config = securityService.getConfigValue();
      const needed =
        config.sandboxEnabled &&
        (config.domainAllow.length > 0 ||
          config.domainDeny.length > 0 ||
          config.blockAllNetwork ||
          config.maliciousDomainProtection);
      const running = localProxy.port !== undefined;
      if (needed && !running) {
        try {
          const port = await localProxy.start();
          networkGate.setProxyUrl(`http://127.0.0.1:${port}`);
        } catch (e) {
          Log.error("本地网络代理启动失败，子进程网络维持现状", e);
        }
      } else if (!needed && running) {
        networkGate.setProxyUrl(undefined);
        await localProxy.stop();
      }
    };
    const securityService = new SecurityService({
      audit: (event) => auditLogService.append(event),
      onConfigChange: () => {
        void readProviderDomains();
        void syncProxyLifecycle();
      },
    });
    await securityService.init().catch((e) => Log.error("安全配置加载失败", e));
    // 命令安全判定门（SP2）：install 后 chat/automation 两处装配共享
    installCommandGate(
      makeCommandDecider(() => securityService.getConfigValue()),
    );
    installCommandWatchlist(() =>
      securityService.getConfigValue().sandboxEnabled
        ? securityService.getConfigValue().programBlacklist
        : [],
    );
    // 文件安全判定门（SP3）：extraBuiltin = userData 自我保护（spec §4.1）；
    // 数据库等用户数据已迁 ~/.tianshu（见 commons/paths.ts），一并纳入保护
    installFileGate(
      makeFileDecider(
        () => securityService.getConfigValue(),
        [app.getPath("userData"), tianshuRoot()],
        // 会话授权清单（文件窗口 spec §6.4）：同步闭包查内存缓存——
        // grant/revoke IPC 原地更新，判定实时生效
        isPathGrantedSync,
      ),
    );
    // 授权清单 IPC（fileWindow:grantFilePath，通道白名单 T1 已登记）
    registerGrantedPathsIpc();
    // undici 全局策略槽（SP5）：主进程 fetch 层判定接线（门已在上方安装）
    setPolicyHook({
      judgeHost: (host) => networkGate.judgeHost(host),
      onBlocked: (host, rule) => networkGate.blockedAudit(host, rule, "fetch"),
    });
    installSessionGuard(); // SP5：渲染层 webRequest 判定
    // 资料库预览 webview 为独立 partition，webRequest 门不随 defaultSession
    // 生效——对 library-preview session 单独注册 http(s) 全拒
    installLibraryPreviewSessionGuard();
    // 终端域（DetailPanel 终端 tab）
    registerTerminalIpc();
    // 内置浏览器 partition：NetworkGate 请求门 + 嵌入头剥离 + 清数据 IPC
    installBrowserSessionGuard();
    registerBrowserIpc();
    // 浏览器工具栏动作（WorkBuddy `...` 菜单）：设备模拟/截图剪贴板/外开
    registerBrowserActionsIpc();
    // guest 站内开窗（target=_blank）拦截转新 tab
    registerBrowserGuestPopupForwarding();
    // browser_use 工具组地基：guest 注册表 + 会话绑定通道
    installGuestRegistry();
    // TTL 异步刷新（首启动即拉一次）+ 代理生命周期初对齐（配置变更时经
    // onConfigChange 重触发）；退出时停本地代理释放端口
    void readProviderDomains();
    await syncProxyLifecycle().catch((e) =>
      Log.error("网络代理生命周期初始化失败", e),
    );
    app.on("quit", () => void localProxy.stop());
    // SP4 数据安全：备份服务 + ChatService 数据安全装配（闭包实时读配置）
    const fileHistory = new FileHistoryService(
      fileHistoryDir(),
      () => securityService.getConfigValue().fileBackupMaxSizeMB * 1024 * 1024,
    );
    // SP1 事件源接入：命令拦截/审批决议经 ChatService 第 4 参汇入审计链；
    // SP4 数据安全：第 5 参注入备份/删除保护/批量阈值（闭包实时读配置）
    const chatService = new ChatService(
      sessionRepo,
      skillRepo,
      this.projectRepo!,
      (event) => auditLogService.append(event),
      {
        backupFile: (absPath, sessionId) => {
          if (!securityService.getConfigValue().fileBackupEnabled) {
            return Promise.resolve({ ok: false, reason: "disabled" });
          }
          return fileHistory.backupFile(absPath, sessionId);
        },
        deleteProtection: () =>
          securityService.getConfigValue().deleteProtection,
        bulkDeleteThreshold: () =>
          securityService.getConfigValue().bulkDeleteThreshold,
      },
      // SP6 工具禁用（裁定 2）：闭包实时读配置——注入层过滤，禁用=对模型
      // 不存在（collectToolDefinitions 组装尾统一收口）
      () => securityService.getConfigValue().disabledTools,
    );
    // A4 批装配顺序修正：MCP manager+repo 必须先于 attachServerFace 创建
    // 并保留实例注入被控面（此前 repo 在 attachServerFace 之后才 new 且未
    // 保留，被控面 mcps 桥只能裸 updateMany——进程/工具注册态不切换、行
    // 不存在也返回成功）。manager 负责连接生命周期与工具注册；repo 负责
    // CRUD IPC 并联动 manager（create/update/delete/setEnabled/reconnect）
    // ——repo 构造函数注册全部 IPC handler，被控面复用本实例零二次构造
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
    const mcpRepo = new McpRepository(prisma, mcpManager);
    // 自动化/编排 repo 前移构造（CRUD 批：被控面 automation 五段 + graph
    // 只读需实例引用；构造副作用仅 IPC 注册与工具登记，顺序无依赖——
    // 原两处 new 在 attachServerFace 后，移此行为不变）
    const automationRepo = new AutomationRepository(
      // SP6 裁定 2：runNow 手动触发同样受注入层工具禁用约束
      () => securityService.getConfigValue().disabledTools,
    );
    const graphRepo = new GraphRepository(
      () => securityService.getConfigValue().disabledTools,
    );
    // 备份域共享 deps（IPC 与被控面 backup-tap 同源——备份面批）：连接
    // 信息走 server 域连接注册表（仅 direct 开放；backupToken 申领所得
    // 备份身份，T6 透传链）；申领写回经注册表 saveConnection 归一重存
    // （只 patch backupToken，其余字段原样；transport 拆除下次使用自愈）
    const backupDeps: BackupIpcDeps = {
      getConnection: (connId) =>
        serverConnections.list().then(
          (shape) =>
            shape.connections.find((c) => c.id === connId) as
              | {
                  mode: string;
                  baseUrl?: string;
                  token?: string;
                  backupToken?: string;
                }
              | undefined,
        ),
      saveConnection: async (connId, patch) => {
        const { connections } = await serverConnections.list();
        const conn = connections.find((c) => c.id === connId);
        if (!conn) throw new Error(`连接不存在：${connId}`);
        await serverConnections.saveConnection({
          ...conn,
          backupToken: patch.backupToken,
        });
      },
      windows: () => BrowserWindow.getAllWindows(),
    };
    // 被控面（server-face spec §6）：注入既有单例（sessionRepo/chatService
    // ——send 签名零改动，被控面经 chat.send(params, userId, undefined) 无头
    // 调用；approve/provider/image 三端点复用 providerRepo/modelRepo 与
    // readImageWithinRoot 数据根读取），登记 serverFace:status/setEnabled IPC
    // 并按 option 恢复服务面与 relay 客户端（默认关，零开销）
    attachServerFace({
      sessions: sessionRepo,
      chatService,
      providerRepo,
      modelRepo,
      assistantRepo,
      monitorRepo,
      // A8 工作空间写面桥（workspace/create|update|delete 复用本实例——
      // delete 硬级联语义 repo 内聚）
      workspaceRepo: sessionRepo,
      // A4 MCP 面桥（mcp/query|setEnabled 复用本实例——联动进程生命周期）
      mcpRepo,
      // A5 资料库面桥（library 十六端点复用本实例）
      libraryRepo,
      // AR 批本地产物面桥（artifact 三端点复用本实例——list/toggle/read
      // 均为 SessionRepository 既有方法，tap 内 wire 转换）
      artifactRepo: sessionRepo,
      // A7 项目域四面桥（project/planItem/planView/projectAsset 23 端点
      // 复用本实例；planView/asset 可见性守卫复用 projectRepo）
      projectRepo: this.projectRepo ?? undefined,
      planItemRepo: this.planItemRepo ?? undefined,
      planViewRepo: this.planViewRepo ?? undefined,
      projectAssetRepo: this.assetRepo ?? undefined,
      // CU 批模式切换桥（名字适配在 attachServerFace 内收口）
      setSessionMode: (id, mode, userId) =>
        sessionRepo.setSessionMode(id, mode, userId),
      // AL 批归档桥 + LA 批置顶桥
      archiveSession: (id, archived, userId) =>
        sessionRepo.archiveSession(id, archived, userId),
      pinSession: (id, pinned, userId) =>
        sessionRepo.pinSession(id, pinned, userId),
      // PM 批专家绑定桥
      setSessionAssistant: (id, assistantId, userId) =>
        sessionRepo.setSessionAssistant(id, assistantId, userId),
      // HD 批会话模型桥
      setSessionModel: (id, modelId, userId) =>
        sessionRepo.setSessionModel(id, modelId, userId),
      // AL 批技能面桥（list 清单 / readSkill 全文）
      skillRepo,
      // 移动端 CRUD 批：automation 五端点 + graph/query 只读选图面
      // （automation-tap 桥两 repo；变更事件经 automation-change-bus）
      automationRepo,
      graphRepo,
      // 记忆进化批：memory 五端点（option 读写 + MemoryService AI 操作；
      // memoryService 已在上方 238 行构造留档实例）
      memory: this.memoryService
        ? createMemoryFace({
            loadConfig: loadPersonalization,
            save: (name, value) => setAppOption(prisma.option, name, value),
            memoryService: this.memoryService,
          })
        : undefined,
      // 备份面批：backup 三端点（遥控桌面备份客户端；connId 自动取连接
      // 注册表首个 direct）
      backup: createBackupFace({
        backupDeps,
        resolveConnection: () =>
          serverConnections
            .list()
            .then(
              (shape) =>
                shape.connections.find((c) => c.mode === "direct")?.id ?? null,
            ),
      }),
    });
    // 控制端（T16）：连接注册表 + server:* IPC 面（连接 CRUD/测试、本地
    // 无头端启停、session 遥控透传与 server:chunk:*/server:event:* 事件桥）
    registerServerIpc();
    // 备份域（spec 2026-10-27 §4）：四 invoke 通道 + progress 事件
    // （backupDeps 已前移共享——被控面 backup-tap 同源）
    registerBackupIpc(backupDeps);
    // 文件窗口保存写回（spec 2026-10-14 §5.2）：workspace:writeFile
    // handler + fileChanged 全窗广播；备份复用上方 fileHistory
    // （sessionId=0 表手动保存，非会话来源）
    new FileWriteIpc({
      fileHistory,
      fileBackupEnabled: () =>
        securityService.getConfigValue().fileBackupEnabled,
    });
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
    // MCP 启动连接：fire-and-forget，失败不影响应用启动（manager/repo 的
    // 创建在上方 attachServerFace 之前——A4 批装配顺序修正，须保持「代理
    // 重放先于启动连接」的时序）
    void mcpManager
      .startupConnectAll()
      .catch((e) => Log.error("MCP 启动连接失败", e));
    // 基础设施
    new Log();
    new AppInfoService();
    new UpdateLogService({
      logFilePath: path.join(path.join(__dirname, "docs"), "update-log.md"),
    });
    // 自动化模块：repo/图 repo 已前移构造（CRUD 批被控面装配）；
    // 调度器随应用生命周期启停
    // 入站 webhook：启动时恢复注册（有注册项才起本地 server，无则零开销）；
    // 工具禁用闭包先于 ensure 注入（SP6 裁定 2：外部触发同一过滤口径）
    void import("./domains/ai/orchestration/webhook-server")
      .then((m) => {
        m.setWebhookDisabledTools(
          () => securityService.getConfigValue().disabledTools,
        );
        return m.ensureWebhookServer();
      })
      .catch((e) => {
        // 端口占用等启动失败不阻断应用：webhook 状态查询时再按需重试
        // （getWebhookRegistration 会 ensure），此处只记日志

        console.error("webhook server 启动失败（应用继续）", e);
      });
    // 事件总线（SP6 裁定 2）：事件触发的运行与调度/手动触发同一注入层
    // 工具禁用——闭包实时读配置，先于 scheduler.start（appStarted 即发事件）
    setEventBusDisabledTools(
      () => securityService.getConfigValue().disabledTools,
    );
    // 调度器启动（原在 execute 注册完成后首行，等价前移至接线尾——securityService
    // 为本方法局部闭包，跨方法不可达）：SP6 裁定 2，注入工具禁用闭包实时读配置
    this.scheduler.start(() => securityService.getConfigValue().disabledTools);
  }
}
