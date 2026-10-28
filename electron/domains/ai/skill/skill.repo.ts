/**
 * skillRecord 仓储:skill:list 自愈对账(扫描→比对→落库→返回)+
 * 启停/批量/卸载。卸载仅允许 userData/skills 内路径(防越界)且拒绝
 * 系统内置技能(重启自愈重装,UI 系统组本就无卸载入口)。
 * 安装三通道(P-C Task 3):市场下载安装 / 本地导入(zip 或目录,
 * dryRun 走预检)/ 系统文件选择器,编排委托 SkillInstaller。
 * 另含内置技能启动自愈安装(P-D Task 1,ensureBuiltinSkills)与
 * 技能埋点采集/聚合查询(P-E,skill:stats)。
 */
import { ipcMain, app, dialog } from "electron";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prisma from "../../../commons/prisma-client";
import { skillsDir } from "../../../commons/paths";
import type { PrismaClient } from "../../../generated/prisma/client";
import { loadSkills } from "../agent/skill-loader";
import {
  isInsideDir,
  syncSkillRecords,
  type SkillRecordRow,
} from "./skill-sync";
import { SkillInstaller } from "./skill-installer";
import {
  aggregateGroupedSkillStats,
  recordSkillEvent,
  type SkillStatItem,
} from "./skill-stats";
import { registerTools } from "../agent/tool-registry";
import { makeCreateSkillTool } from "../agent/create-skill";
import { ensureBuiltinSkills as ensureBuiltinSkillsImpl } from "./builtin-skills";
import { SkillHubClient, type SkillHubListParams } from "./skillhub-client";
import { mapHubDetail, mapHubSkill } from "./skillhub-mapping";
import type {
  SkillHubCategory,
  SkillHubPage,
  SkillHubSkill,
} from "./skillhub-client";
import type {
  BatchUninstallResult,
  PickImportResult,
  SkillRecord,
} from "../../../../src-react/domains/ai/skills/api/skill.api";
import type {
  InstallResult,
  InspectResult,
} from "../../../../src-react/domains/ai/skills/api/skillhub-types";

// 与 Application.ts 同款 __dirname 推导:主进程产物全部内联进
// dist-electron/main.js(无嵌套 chunk),故本模块 __dirname 即 main.js 所在目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class SkillRepository {
  private readonly hub = new SkillHubClient();
  private readonly installer: SkillInstaller;

  constructor(private readonly prismaClient: PrismaClient = prisma) {
    // prisma 传 skillRecord 仓储子集(SkillRecordPrismaLike 结构接口);
    // statRecord 传 skillStat delegate(P-E 埋点,写入失败由 recorder 吞)
    this.installer = new SkillInstaller({
      skillsRoot: this.skillsRoot(),
      prisma: this.prismaClient.skillRecord,
      statRecord: this.prismaClient.skillStat,
      // 市场请求全走 SkillHubClient(spec §2.2):X-API-Key 鉴权 +
      // 退避重试 + 下载量计入团队 Key 归因
      download: (slug) => this.hub.downloadZip(slug),
      getVersion: (slug) =>
        this.hub
          .getDetail(slug)
          .then((d) => d.latestVersion?.version ?? d.skill?.version ?? ""),
    });
    // create_skill 工具静态注册进 P1 聚合点（chat.service 从 registry 透传），
    // deps 在此装配（skillsRoot/prisma 仓储子集），chat.service 零侵入
    registerTools([
      makeCreateSkillTool({
        skillsRoot: this.skillsRoot(),
        prisma: this.prismaClient.skillRecord,
        statRecord: this.prismaClient.skillStat,
      }),
    ]);
    this.registerHandlers();
  }

  private registerHandlers() {
    ipcMain.handle("skill:list", () => this.list());
    ipcMain.handle(
      "skill:setEnabled",
      (_e, p: { name: string; enabled: boolean }) =>
        this.setEnabled(p.name, p.enabled),
    );
    ipcMain.handle(
      "skill:setScenarios",
      (_e, p: { name: string; scenarios: string[] }): Promise<null> =>
        this.setScenarios(p.name, p.scenarios),
    );
    ipcMain.handle(
      "skill:batchSetEnabled",
      (_e, p: { names: string[]; enabled: boolean }) =>
        this.batchSetEnabled(p.names, p.enabled),
    );
    ipcMain.handle("skill:uninstall", (_e, p: { name: string }) =>
      this.uninstall(p.name),
    );
    ipcMain.handle("skill:batchUninstall", (_e, p: { names: string[] }) =>
      this.batchUninstall(p.names),
    );
    ipcMain.handle(
      "skill:import",
      async (
        _e,
        p: {
          path: string;
          overwrite?: boolean;
          dryRun?: boolean;
          scenarios?: string[];
        },
      ): Promise<InstallResult | InspectResult> => {
        if (p.dryRun) {
          return this.installer.inspectFromPath(p.path);
        }
        const result = await this.installer.importFromPath(
          p.path,
          p.overwrite ?? false,
        );
        // 导入弹窗当场打标透传：仅显式传参时落库（空数组=清标），
        // 未传不动——保护重装/旧调用方下已有用户打标（spec Deviation 7）
        if (result.status === "installed" && p.scenarios !== undefined) {
          await this.setScenarios(result.record.name, p.scenarios);
        }
        return result;
      },
    );
    ipcMain.handle("skill:pickImport", () => this.pickImport());
    ipcMain.handle("skill:stats", () => this.stats());
    ipcMain.handle("skill:readSkill", (_e, p: { name: string }) =>
      this.readSkill(p.name),
    );
    ipcMain.handle("skillhub:list", (_e, p: SkillHubListParams) =>
      this.hub.listSkills(p ?? {}),
    );
    ipcMain.handle("skillhub:top", () => this.hub.listTop());
    ipcMain.handle("skillhub:categories", () => this.hub.listCategories());
    ipcMain.handle(
      "skillhub:install",
      (_e, p: { slug: string; overwrite?: boolean }): Promise<InstallResult> =>
        this.installer.downloadAndInstall(p.slug, p.overwrite ?? false),
    );
  }

  private skillsRoot(): string {
    return skillsDir();
  }

  /**
   * 启动自愈安装内置技能(skill-creator):缺失时从应用资源复制并落库
   * (source builtin),存在即跳过(幂等)。资源定位沿用 Application.ts 的
   * __dirname 先例(与 script/docs 同构,asar 内读取 Electron 已 patch):
   * prod 取 main.js 同级的 builtin-skills(syncElectronAssets 复制),
   * dev 直读源码 resources
   */
  async ensureBuiltinSkills(): Promise<void> {
    const builtinRoot = app.isPackaged
      ? path.join(__dirname, "builtin-skills")
      : path.join(app.getAppPath(), "electron", "resources", "builtin-skills");
    await ensureBuiltinSkillsImpl({
      builtinRoot,
      skillsRoot: this.skillsRoot(),
      prisma: this.prismaClient.skillRecord,
    });
  }

  /** 扫描→对账→落库→返回全量记录(name 升序) */
  async list(): Promise<SkillRecord[]> {
    const root = this.skillsRoot();
    const scanned = loadSkills([{ dir: root, source: "user" }]);
    const rows: SkillRecordRow[] =
      await this.prismaClient.skillRecord.findMany();
    const plan = syncSkillRecords(scanned, rows);
    if (plan.toDeleteIds.length > 0) {
      await this.prismaClient.skillRecord.deleteMany({
        where: { id: { in: plan.toDeleteIds } },
      });
    }
    for (const item of plan.toInsert) {
      await this.prismaClient.skillRecord.create({ data: item });
    }
    for (const item of plan.toUpdate) {
      await this.prismaClient.skillRecord.update({
        where: { id: item.id },
        data: { dir: item.dir, description: item.description },
      });
    }
    const fresh = await this.prismaClient.skillRecord.findMany({
      orderBy: { name: "asc" },
    });
    return fresh.map((row) => ({
      ...row,
      installedAt: row.installedAt.toISOString(),
      scenarios: row.scenarios ? (JSON.parse(row.scenarios) as string[]) : null,
    }));
  }

  async setEnabled(name: string, enabled: boolean): Promise<null> {
    await this.prismaClient.skillRecord.updateMany({
      where: { name },
      data: { enabled },
    });
    // P-E 埋点:fire-and-forget,失败由 recorder 吞
    void recordSkillEvent(
      this.prismaClient.skillStat,
      name,
      enabled ? "enable" : "disable",
    );
    return null;
  }

  /** 场景打标:JSON 序列化落库;scenario 值不在白名单时过滤防脏数据；
   *  被控面（A3 批）同用——技能不存在抛 SKILL_NOT_FOUND 稳定码（此前
   *  prisma P2025 裸抛） */
  async setScenarios(name: string, scenarios: string[]): Promise<null> {
    const valid = ["daily", "coding", "design"];
    const filtered = [...new Set(scenarios.filter((s) => valid.includes(s)))];
    const existing = await this.prismaClient.skillRecord.findUnique({
      where: { name },
    });
    if (!existing) {
      throw new Error("SKILL_NOT_FOUND");
    }
    await this.prismaClient.skillRecord.update({
      where: { name },
      data: { scenarios: JSON.stringify(filtered) },
    });
    return null;
  }

  async batchSetEnabled(names: string[], enabled: boolean): Promise<null> {
    if (names.length > 0) {
      await this.prismaClient.skillRecord.updateMany({
        where: { name: { in: names } },
        data: { enabled },
      });
    }
    // P-E 埋点:批量操作逐选中技能记一条 batch_*(每技能活跃度与
    // 批量使用率一表两得);fire-and-forget
    for (const name of names) {
      void recordSkillEvent(
        this.prismaClient.skillStat,
        name,
        enabled ? "batch_enable" : "batch_disable",
      );
    }
    return null;
  }

  /** chat.service 消费:禁用技能名集合(组装时过滤) */
  async getDisabledNames(): Promise<Set<string>> {
    const rows = await this.prismaClient.skillRecord.findMany({
      where: { enabled: false },
      select: { name: true },
    });
    return new Set(rows.map((r) => r.name));
  }

  /**
   * 已安装技能名清单（专家 2.0 Task 3）：create/update_expert 工具的
   * skillNames 过滤依据。轻量查表而非走 list() 全量对账——skillRecord 由
   * list 对账/三通道安装/卸载/create_skill upsert 共同维护，真源一致，
   * 免每次工具调用全盘扫描磁盘
   */
  async listInstalledNames(): Promise<string[]> {
    const rows = await this.prismaClient.skillRecord.findMany({
      select: { name: true },
      orderBy: { name: "asc" },
    });
    return rows.map((r) => r.name);
  }

  /**
   * 工具分组场景门控消费（spec §20 项 B）：name/source/enabled 三列全表
   * 轻量清单——workflow-creator 开门判定（非内置且启用）单查询完成
   * （替代 getDisabledNames + listInstalledNames 各查一次的合并取列）
   */
  async listGateStatus(): Promise<
    Array<{ name: string; source: string; enabled: boolean }>
  > {
    return this.prismaClient.skillRecord.findMany({
      select: { name: true, source: true, enabled: true },
    });
  }

  /** 卸载 = 删目录 + 删记录;路径越界拒绝;目录删除失败时记录保留(可重试) */
  async uninstall(name: string): Promise<null> {
    await this.uninstallCore(name);
    // P-E 埋点:单个卸载记 uninstall(批量走 batchUninstall 记 batch_*)
    void recordSkillEvent(this.prismaClient.skillStat, name, "uninstall");
    return null;
  }

  /** 卸载主流程(埋点除外):uninstall/batchUninstall 共用,避免批量双记 */
  private async uninstallCore(name: string): Promise<void> {
    const row = await this.prismaClient.skillRecord.findUnique({
      where: { name },
    });
    if (!row) {
      return;
    }
    // 系统内置技能不可卸载(重启自愈重装语义,UI 系统组无卸载入口,此处兜底)
    if (row.source === "builtin") {
      throw new Error("系统内置技能不支持卸载");
    }
    if (!isInsideDir(row.dir, this.skillsRoot())) {
      throw new Error(`技能目录不在管理范围内: ${row.dir}`);
    }
    rmSync(row.dir, { recursive: true, force: true });
    await this.prismaClient.skillRecord.delete({ where: { id: row.id } });
  }

  async batchUninstall(names: string[]): Promise<BatchUninstallResult> {
    const result: BatchUninstallResult = { succeeded: [], failed: [] };
    for (const name of names) {
      try {
        await this.uninstallCore(name);
        result.succeeded.push(name);
        // P-E 埋点:批量逐成功技能记 batch_uninstall(不是 uninstall,防双计)
        void recordSkillEvent(
          this.prismaClient.skillStat,
          name,
          "batch_uninstall",
        );
      } catch (e) {
        result.failed.push({
          name,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return result;
  }

  /** 埋点聚合查询(P-E):SQL groupBy 聚合下推（M12，免全表行读回；事件表
   *  有 90 天保留期裁剪，行数有界） */
  async stats(): Promise<{ items: SkillStatItem[] }> {
    const groups = await this.prismaClient.skillStat.groupBy({
      by: ["name", "event"],
      _count: { _all: true },
      _max: { createdAt: true },
    });
    return {
      items: aggregateGroupedSkillStats(
        groups.map((group) => ({
          name: group.name,
          event: group.event,
          count: group._count._all,
          lastActiveAt: group._max.createdAt ?? new Date(0),
        })),
      ),
    };
  }

  /** @ 引用读取:按名读 user 级 SKILL.md 正文(≤256KB 截断,同 read_skill 工具语义) */
  async readSkill(name: string): Promise<{ content: string }> {
    const skill = loadSkills([{ dir: this.skillsRoot(), source: "user" }]).find(
      (s) => s.name === name,
    );
    if (!skill) {
      throw new Error(`技能不存在: ${name}`);
    }
    const buf = readFileSync(skill.bodyPath);
    const body =
      buf.byteLength > 256 * 1024
        ? `${buf.subarray(0, 256 * 1024).toString("utf8")}\n…(已截断)`
        : buf.toString("utf8");
    return { content: body };
  }

  /** 被控面（A3 批）SkillHub 市场四端点桥——复用本实例持有的 hub/installer
   *  （严禁 face 侧二次构造；远端不可用错误由 tap 层收 SKILLHUB_UNAVAILABLE） */
  listHubSkills(params: SkillHubListParams): Promise<SkillHubPage> {
    return this.hub.listSkills(params).then((page) => ({
      total: page.total,
      skills: page.skills.map(mapHubSkill),
    }));
  }

  listHubTop(): Promise<SkillHubSkill[]> {
    return this.hub.listTop().then((skills) => skills.map(mapHubSkill));
  }

  listHubCategories(): Promise<SkillHubCategory[]> {
    return this.hub.listCategories();
  }

  /** 宿主侧下载 zip 落盘安装（手机零流量）；slug 不存在等远端错误由
   *  tap 层收 SKILLHUB_UNAVAILABLE */
  installFromHub(slug: string, overwrite = false): Promise<InstallResult> {
    return this.installer.downloadAndInstall(slug, overwrite);
  }

  /** 被控面（detail 批）hub 详情透传——camel 映射 + security 归一经
   *  skillhub-mapping；远端错误由 tap 层收 SKILLHUB_UNAVAILABLE */
  async getHubSkillDetail(
    slug: string,
  ): Promise<import("@tianshu/protocol").SkillHubDetailDto> {
    return mapHubDetail(await this.hub.getDetail(slug));
  }

  /** 被控面（A3 尾）zip buffer 直装——复用本实例持有的 installer
   *  （严禁 face 侧二次构造）；source=local 与桌面 zip 导入同语义
   *  （冲突返回 {status:"conflict"}，overwrite 由调用方定） */
  installFromUpload(buf: Buffer, overwrite = false): Promise<InstallResult> {
    return this.installer.installFromBuffer(buf, "local", undefined, overwrite);
  }

  /** 系统文件选择器(zip 文件或技能目录);取消/未选返回 canceled:true */
  private async pickImport(): Promise<PickImportResult> {
    const res = await dialog.showOpenDialog({
      properties: ["openFile", "openDirectory"],
      filters: [{ name: "Skill 包", extensions: ["zip"] }],
    });
    if (res.canceled || res.filePaths.length === 0) {
      return { canceled: true };
    }
    return { canceled: false, path: res.filePaths[0] };
  }
}
