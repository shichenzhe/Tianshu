/**
 * skillRecord 仓储:skill:list 自愈对账(扫描→比对→落库→返回)+
 * 启停/批量/卸载。卸载仅允许 userData/skills 内路径(防越界)。
 * 安装三通道(P-C Task 3):市场下载安装 / 本地导入(zip 或目录,
 * dryRun 走预检)/ 系统文件选择器,编排委托 SkillInstaller。
 */
import { ipcMain, app, dialog } from "electron";
import { rmSync } from "node:fs";
import path from "node:path";
import prisma from "../../../commons/prisma-client";
import type { PrismaClient } from "../../../generated/prisma/client";
import { loadSkills } from "../agent/skill-loader";
import {
  isInsideDir,
  syncSkillRecords,
  type SkillRecordRow,
} from "./skill-sync";
import { SkillInstaller } from "./skill-installer";
import { SkillHubClient, type SkillHubListParams } from "./skillhub-client";
import type {
  BatchUninstallResult,
  PickImportResult,
  SkillRecord,
} from "../../../../src-react/domains/ai/skills/api/skill.api";
import type {
  InstallResult,
  InspectResult,
} from "../../../../src-react/domains/ai/skills/api/skillhub-types";

export class SkillRepository {
  private readonly hub = new SkillHubClient();
  private readonly installer: SkillInstaller;

  constructor(private readonly prismaClient: PrismaClient = prisma) {
    // prisma 传 skillRecord 仓储子集(SkillRecordPrismaLike 结构接口)
    this.installer = new SkillInstaller({
      skillsRoot: this.skillsRoot(),
      prisma: this.prismaClient.skillRecord,
      // 市场请求全走 SkillHubClient(spec §2.2):X-API-Key 鉴权 +
      // 退避重试 + 下载量计入团队 Key 归因
      download: (slug) => this.hub.downloadZip(slug),
      getVersion: (slug) =>
        this.hub.getDetail(slug).then((d) => d.latestVersion.version),
    });
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
      (
        _e,
        p: { path: string; overwrite?: boolean; dryRun?: boolean },
      ): Promise<InstallResult | InspectResult> =>
        p.dryRun
          ? this.installer.inspectFromPath(p.path)
          : this.installer.importFromPath(p.path, p.overwrite ?? false),
    );
    ipcMain.handle("skill:pickImport", () => this.pickImport());
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
    return path.join(app.getPath("userData"), "skills");
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
    }));
  }

  async setEnabled(name: string, enabled: boolean): Promise<null> {
    await this.prismaClient.skillRecord.updateMany({
      where: { name },
      data: { enabled },
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

  /** 卸载 = 删目录 + 删记录;路径越界拒绝;目录删除失败时记录保留(可重试) */
  async uninstall(name: string): Promise<null> {
    const row = await this.prismaClient.skillRecord.findUnique({
      where: { name },
    });
    if (!row) {
      return null;
    }
    if (!isInsideDir(row.dir, this.skillsRoot())) {
      throw new Error(`技能目录不在管理范围内: ${row.dir}`);
    }
    rmSync(row.dir, { recursive: true, force: true });
    await this.prismaClient.skillRecord.delete({ where: { id: row.id } });
    return null;
  }

  async batchUninstall(names: string[]): Promise<BatchUninstallResult> {
    const result: BatchUninstallResult = { succeeded: [], failed: [] };
    for (const name of names) {
      try {
        await this.uninstall(name);
        result.succeeded.push(name);
      } catch (e) {
        result.failed.push({
          name,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return result;
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
