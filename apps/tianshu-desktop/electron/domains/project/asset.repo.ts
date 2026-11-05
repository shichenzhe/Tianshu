/**
 * 资产仓储：项目资产空间内文件/文件夹的列表/新建文件夹/重命名/删除（二期 spec §4），
 * 以及上传（copyFile 逐文件）/用量统计（递归 du）/系统预览与定位（Task 4）。
 * 所有相对路径经 safeJoin 沙箱校验（resolve 后必须仍落在资产根内），
 * 名称经 sanitizeName 清洗 + uniqueName 重名序号；list 对缺失目录自愈重建。
 * fs 沿用 project.repo 的 node:fs/promises 默认导入 + node:fs existsSync 探测。
 */
import { dialog, ipcMain, shell } from "electron";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Dirent, Stats } from "node:fs";
import prisma from "../../commons/prisma-client";
import Log from "../../commons/Log";
import { PROJECT_NOT_FOUND } from "./project.entity";
import type ProjectRepository from "./project.repo";
import type { SecurityEventSink } from "../../../src-react/domains/security/model/types";
import {
  ASSET_QUOTA_BYTES,
  type AssetEntry,
  type AssetStorage,
  type AssetUploadResult,
} from "./asset.entity";

/** 名称非法字符：Windows 保留符号 + 控制字符（\p{Cc} 覆盖 C0/C1/DEL） */
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|\p{Cc}]/gu;

/**
 * 名称清洗：剥离非法字符与首尾空白/点号；清洗后为空抛错。
 * 模块级纯函数（单测覆盖），Task 4 上传复用
 */
export function sanitizeName(name: string): string {
  const cleaned = name
    .replace(ILLEGAL_NAME_CHARS, "")
    .replace(/^[\s.]+/, "")
    .replace(/[\s.]+$/, "");
  if (!cleaned) {
    throw new Error("名称无效");
  }
  return cleaned;
}

/**
 * 路径沙箱：relPath resolve 后必须等于根或位于根之下，否则拒绝
 * （../ 穿越、绝对路径注入、空字节注入均拦截；"" 与 "/" 归一到根）
 */
export function safeJoin(root: string, relPath: string): string {
  if (relPath.includes("\0")) {
    throw new Error("非法路径");
  }
  const base = path.resolve(root);
  const resolved = path.resolve(base, relPath === "/" ? "" : relPath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("非法路径");
  }
  return resolved;
}

/**
 * 重名探测：名称被占用则追加 " (2)"、" (3)"…（扩展名保留，a.txt → a (2).txt）。
 * 顺序探测不回填空洞；Task 4 上传复用
 */
export function uniqueName(dir: string, name: string): string {
  if (!existsSync(path.join(dir, name))) {
    return name;
  }
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let index = 2; ; index++) {
    const candidate = `${stem} (${index})${ext}`;
    if (!existsSync(path.join(dir, candidate))) {
      return candidate;
    }
  }
}

/** 文件扩展名：小写无点；无扩展名（含点开头隐藏文件）返回 null */
function extOf(name: string): string | null {
  const ext = path.extname(name).slice(1).toLowerCase();
  return ext.length > 0 ? ext : null;
}

/** 稳定基准序：文件夹在前、同类按名升序（UI 可再重排） */
function compareEntries(a: AssetEntry, b: AssetEntry): number {
  if (a.type !== b.type) {
    return a.type === "folder" ? -1 : 1;
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** 提取 fs 错误码（ENOENT/EACCES 等分支判定） */
function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/**
 * 相对路径归一（批8 P3）：分隔符统一 "/"、剥首尾斜杠——附件 assetPath 与
 * 删除/改名目标的同口径匹配基准（模块级纯函数，单测覆盖）
 */
export function normalizeAssetRelPath(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

/** fs 异常转中文错误（附 cause，沿用 project.repo 先例） */
function wrapFsError(error: unknown, message: string): Error {
  const cause = error instanceof Error ? error.message : String(error);
  return new Error(`${message}：${cause}`, { cause: error });
}

export default class AssetRepository {
  private readonly projectRepo: ProjectRepository;

  // 项目资产审计出口（批8 P2）：Application 注入 auditLogService.append；
  // 缺席（测试/未接线）时静默空转，行为与接入前一致
  private auditSink: SecurityEventSink | null = null;

  constructor(projectRepo: ProjectRepository) {
    this.projectRepo = projectRepo;
    this.registerHandlers();
  }

  /** 安装审计出口（Application 装配接 auditLogService；传 null 卸载） */
  installAuditSink(sink: SecurityEventSink | null): void {
    this.auditSink = sink;
  }

  /**
   * 注册IPC处理程序：基础四通道（Task 3）+ 上传/用量/预览五通道（Task 4）
   */
  private registerHandlers() {
    this.registerCrudHandlers();
    this.registerTransferHandlers();
  }

  /** 基础通道：list/createFolder/rename/delete */
  private registerCrudHandlers() {
    ipcMain.handle(
      "projectAsset:list",
      (_, projectId: number, folderPath?: string) =>
        this.list(projectId, folderPath),
    );
    ipcMain.handle(
      "projectAsset:createFolder",
      (_, projectId: number, parentPath: string, name: string) =>
        this.createFolder(projectId, parentPath, name),
    );
    ipcMain.handle(
      "projectAsset:rename",
      (_, projectId: number, oldPath: string, newName: string) =>
        this.rename(projectId, oldPath, newName),
    );
    ipcMain.handle(
      "projectAsset:delete",
      (_, projectId: number, targetPath: string) =>
        this.delete(projectId, targetPath),
    );
  }

  /** 传输通道：upload/storage/openFile/revealFile/pickFiles */
  private registerTransferHandlers() {
    ipcMain.handle(
      "projectAsset:upload",
      (_, projectId: number, folderPath: string, absPaths: string[]) =>
        this.upload(projectId, folderPath, absPaths),
    );
    ipcMain.handle("projectAsset:storage", (_, projectId: number) =>
      this.storage(projectId),
    );
    ipcMain.handle(
      "projectAsset:openFile",
      (_, projectId: number, targetPath: string) =>
        this.openFile(projectId, targetPath),
    );
    ipcMain.handle(
      "projectAsset:revealFile",
      (_, projectId: number, targetPath: string) =>
        this.revealFile(projectId, targetPath),
    );
    ipcMain.handle("projectAsset:pickFiles", () => this.pickFiles());
  }

  /**
   * 解析资产根：project 行缺失抛 PROJECT_NOT_FOUND；
   * 经 ensureAssetWorkspace 自愈（幂等）取 workspace 目录
   */
  async resolveAssetRoot(projectId: number): Promise<{
    root: string;
    workspaceId: number;
  }> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new Error(PROJECT_NOT_FOUND);
    }
    const workspace = await this.projectRepo.ensureAssetWorkspace(project);
    if (!workspace.directoryPath) {
      throw new Error(`资产空间目录记录缺失（workspaceId=${workspace.id}）`);
    }
    return { root: workspace.directoryPath, workspaceId: workspace.id };
  }

  /**
   * 目录列表：readdir+stat 映射条目（文件夹大小懒统计一层）；
   * 目录缺失 → mkdir recursive 自愈返回空（spec §4）
   */
  async list(projectId: number, folderPath = ""): Promise<AssetEntry[]> {
    const { root } = await this.resolveAssetRoot(projectId);
    const dir = safeJoin(root, folderPath);
    const dirents = await this.readDirWithSelfHeal(dir);
    const entries = await Promise.all(
      dirents.map((dirent) => this.toEntry(dir, dirent)),
    );
    return entries.sort(compareEntries);
  }

  /**
   * 新建文件夹：清洗 + 重名序号 + mkdir；返回最终目录名
   */
  async createFolder(
    projectId: number,
    parentPath: string,
    name: string,
  ): Promise<string> {
    const parent = safeJoin(
      (await this.resolveAssetRoot(projectId)).root,
      parentPath,
    );
    const finalName = uniqueName(parent, sanitizeName(name));
    try {
      await fs.mkdir(path.join(parent, finalName), { recursive: true });
    } catch (error) {
      throw wrapFsError(error, `创建文件夹失败（${finalName}）`);
    }
    return finalName;
  }

  /**
   * 重命名：清洗 + 重名序号 + rename（同目录内改）；返回最终名。
   * 改名后反查改绑附件关联 assetPath（批8 P3，含文件夹前缀迁移）
   */
  async rename(
    projectId: number,
    oldPath: string,
    newName: string,
  ): Promise<string> {
    const root = (await this.resolveAssetRoot(projectId)).root;
    const old = safeJoin(root, oldPath);
    this.assertNotRoot(root, old, "重命名");
    const dir = path.dirname(old);
    const finalName = uniqueName(dir, sanitizeName(newName));
    try {
      await fs.rename(old, path.join(dir, finalName));
    } catch (error) {
      throw wrapFsError(error, `重命名失败（${oldPath} → ${finalName}）`);
    }
    // 附件改绑：新相对路径 = 原父目录 + 最终名（uniqueName 序号生效）
    const oldRel = normalizeAssetRelPath(oldPath);
    const parentRel = oldRel.includes("/")
      ? oldRel.slice(0, oldRel.lastIndexOf("/"))
      : "";
    const newRel = parentRel ? `${parentRel}/${finalName}` : finalName;
    await this.rebindAttachmentsOf(projectId, oldRel, newRel);
    return finalName;
  }

  /**
   * 删除：文件 unlink / 文件夹 rm recursive；目标已不存在幂等 no-op。
   * 删除后反查级联解绑附件关联（批8 P3，防死链残留）+ 审计留痕（批8 P2）
   */
  async delete(projectId: number, targetPath: string): Promise<void> {
    const root = (await this.resolveAssetRoot(projectId)).root;
    const target = safeJoin(root, targetPath);
    this.assertNotRoot(root, target, "删除");
    const stat = await this.statOrNull(target);
    if (!stat) {
      return;
    }
    if (stat.isFile()) {
      await this.unlinkFile(target);
    } else {
      await this.rmFolder(target);
    }
    // 附件死链治理（批8 P3）：指向已删目标的关联级联解绑（文件精确/文件夹前缀）
    await this.unbindAttachmentsOf(projectId, targetPath);
    // 审计（批8 P2）：资产删除不可逆且可能连带解绑附件关联
    this.auditSink?.({
      eventType: "projectAsset.deleted",
      decision: "approved",
      detail: { projectId, path: targetPath.slice(0, 200) },
    });
  }

  /**
   * 批量上传：目标目录自愈后逐文件 basename → 清洗 → 重名序号 → copyFile。
   * 单文件失败（源缺失/不可读/名称无效）收集进 failed 不中断循环（spec §4）；
   * 逐文件串行保证同批次同名能拿到不同序号；仅沙箱/项目级错误抛出。
   * 软配额仅 UI 提示，此处不做大小与总量拦截
   */
  async upload(
    projectId: number,
    folderPath: string,
    absPaths: string[],
  ): Promise<AssetUploadResult> {
    const destDir = safeJoin(
      (await this.resolveAssetRoot(projectId)).root,
      folderPath,
    );
    await this.ensureDir(destDir);
    const result: AssetUploadResult = { uploaded: [], failed: [] };
    for (const absPath of absPaths) {
      const baseName = path.basename(absPath);
      try {
        const destName = uniqueName(destDir, sanitizeName(baseName));
        await fs.copyFile(absPath, path.join(destDir, destName));
        result.uploaded.push(destName);
      } catch {
        result.failed.push(baseName);
      }
    }
    return result;
  }

  /**
   * 单文件缓冲写入（被控面上传批）：目标目录自愈 + basename 清洗 + 重名
   * 序号 + writeFile；返回落盘名（清洗/去重与 upload 同口径）
   */
  async uploadBuffer(
    projectId: number,
    folderPath: string,
    fileName: string,
    data: Buffer,
  ): Promise<string> {
    const destDir = safeJoin(
      (await this.resolveAssetRoot(projectId)).root,
      folderPath,
    );
    await this.ensureDir(destDir);
    const destName = uniqueName(destDir, sanitizeName(fileName));
    await fs.writeFile(path.join(destDir, destName), data);
    return destName;
  }

  /**
   * 资产空间用量：根目录递归 du + 恒定软配额（5GiB）
   */
  async storage(projectId: number): Promise<AssetStorage> {
    const { root } = await this.resolveAssetRoot(projectId);
    return {
      usedBytes: await this.walkDirSize(root),
      quotaBytes: ASSET_QUOTA_BYTES,
    };
  }

  /**
   * 系统默认程序预览（仅文件）：stat 校验 + openPath；
   * openPath 失败 resolve 错误串 → 转 reject 让渲染层 toast
   */
  async openFile(projectId: number, targetPath: string): Promise<void> {
    const target = safeJoin(
      (await this.resolveAssetRoot(projectId)).root,
      targetPath,
    );
    const stat = await this.statOrNull(target);
    if (!stat) {
      throw new Error("文件不存在");
    }
    if (!stat.isFile()) {
      throw new Error("仅支持预览文件");
    }
    const openError = await shell.openPath(target);
    if (openError) {
      throw new Error(openError);
    }
  }

  /** Finder/资源管理器定位（文件与文件夹均可；无返回值不判错） */
  async revealFile(projectId: number, targetPath: string): Promise<void> {
    const target = safeJoin(
      (await this.resolveAssetRoot(projectId)).root,
      targetPath,
    );
    shell.showItemInFolder(target);
  }

  /**
   * 系统文件多选（上传按钮入口）：取消/未选返回 null（渲染层静默处理）。
   * 不做目录预选——所选文件落到 UI 当前浏览文件夹（由 upload 的 folderPath 决定），
   * 通道多传的 folderPath 参数被忽略
   */
  async pickFiles(): Promise<string[] | null> {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
    });
    return result.canceled || result.filePaths.length === 0
      ? null
      : result.filePaths;
  }

  /** 读目录；缺失（ENOENT）自愈递归重建返回空，其他错误转中文 */
  private async readDirWithSelfHeal(dir: string): Promise<Dirent[]> {
    try {
      return await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (errnoCode(error) === "ENOENT") {
        try {
          await fs.mkdir(dir, { recursive: true });
        } catch (mkdirError) {
          throw wrapFsError(mkdirError, `自愈重建资产目录失败（${dir}）`);
        }
        return [];
      }
      throw wrapFsError(error, `读取资产目录失败（${dir}）`);
    }
  }

  /** 单条目录项 → AssetEntry：文件取 stat 大小/时间；文件夹大小懒统计 */
  private async toEntry(dir: string, dirent: Dirent): Promise<AssetEntry> {
    const fullPath = path.join(dir, dirent.name);
    const stat = await fs.stat(fullPath);
    const updatedAt = stat.mtime.toISOString();
    if (!dirent.isDirectory()) {
      return {
        name: dirent.name,
        type: "file",
        size: stat.size,
        updatedAt,
        ext: extOf(dirent.name),
      };
    }
    return {
      name: dirent.name,
      type: "folder",
      size: await this.folderSize(fullPath),
      updatedAt,
      ext: null,
    };
  }

  /**
   * 递归 du（storage 专用，区别于 list 的 folderSize 一层懒统计）：
   * 常规文件计大小、子目录递归、其余（符号链接/FIFO 等）跳过——
   * withFileTypes 为 lstat 口径不跟随链接，天然防符号环死循环。
   * 目录缺失/不可读按 0：用量面板不因缺失报错（自愈或零口径）
   */
  private async walkDirSize(dir: string): Promise<number> {
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let bytes = 0;
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        bytes += await this.walkDirSize(full);
      } else if (dirent.isFile()) {
        bytes += await this.sizeOrZero(full);
      }
    }
    return bytes;
  }

  /** 单文件大小：stat 失败（遍历竞态被删/无权限）按 0 计不连坐 */
  private async sizeOrZero(file: string): Promise<number> {
    try {
      return (await fs.stat(file)).size;
    } catch {
      return 0;
    }
  }

  /** 目标目录自愈（recursive 幂等；失败转中文——目录级错误属项目级，抛出） */
  private async ensureDir(dir: string): Promise<void> {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      throw wrapFsError(error, `创建上传目录失败（${dir}）`);
    }
  }

  /**
   * 文件夹懒统计：仅累计一层直接子文件字节（嵌套目录不递归，spec §4 口径）；
   * 探测失败记日志返回 0（列表主流程不因单个子目录竞态中断）
   */
  private async folderSize(dir: string): Promise<number> {
    try {
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      const stats = await Promise.all(
        dirents
          .filter((dirent) => dirent.isFile())
          .map((dirent) => fs.stat(path.join(dir, dirent.name))),
      );
      return stats.reduce((sum, stat) => sum + stat.size, 0);
    } catch (error) {
      Log.warn(`文件夹大小懒统计失败（${dir}）`, error);
      return 0;
    }
  }

  /** stat；目标缺失（ENOENT）返回 null（删除幂等口径），其他错误转中文 */
  private async statOrNull(target: string): Promise<Stats | null> {
    try {
      return await fs.stat(target);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") {
        return null;
      }
      throw wrapFsError(error, `访问资产失败（${target}）`);
    }
  }

  private async unlinkFile(target: string): Promise<void> {
    try {
      await fs.unlink(target);
    } catch (error) {
      throw wrapFsError(error, `删除文件失败（${target}）`);
    }
  }

  private async rmFolder(target: string): Promise<void> {
    try {
      await fs.rm(target, { recursive: true, force: true });
    } catch (error) {
      throw wrapFsError(error, `删除文件夹失败（${target}）`);
    }
  }

  /** 目标即资产根时拒绝（防整空间误删/改名逃出 workspace 记录） */
  private assertNotRoot(root: string, target: string, action: string): void {
    if (target === path.resolve(root)) {
      throw new Error(`${action}不支持资产空间根目录`);
    }
  }

  /** 本项目全部事项的附件关联行（按事项 id 集圈定——assetPath 无项目列，
   *  防跨项目同名路径误伤，批8 P3） */
  private async projectAttachmentRows(
    projectId: number,
  ): Promise<Array<{ id: number; assetPath: string }>> {
    const items = await prisma.planItem.findMany({
      where: { projectId },
      select: { id: true },
    });
    if (items.length === 0) {
      return [];
    }
    return prisma.planItemAttachment.findMany({
      where: { planItemId: { in: items.map((item) => item.id) } },
      select: { id: true, assetPath: true },
    });
  }

  /** 删除反查解绑（批8 P3）：目标（文件精确/文件夹前缀）命中的本项目附件
   *  关联行级联删除，防死链残留（assetPath 无存在性校验，打开即失败）。
   *  失败仅记日志——文件已删，解绑是卫生动作不阻断删除主流程 */
  private async unbindAttachmentsOf(
    projectId: number,
    targetPath: string,
  ): Promise<void> {
    try {
      const prefix = normalizeAssetRelPath(targetPath);
      if (!prefix) {
        return;
      }
      const rows = await this.projectAttachmentRows(projectId);
      const deadIds = rows
        .filter((row) => {
          const rel = normalizeAssetRelPath(row.assetPath);
          return rel === prefix || rel.startsWith(`${prefix}/`);
        })
        .map((row) => row.id);
      if (deadIds.length > 0) {
        await prisma.planItemAttachment.deleteMany({
          where: { id: { in: deadIds } },
        });
      }
    } catch (error) {
      Log.warn(`删除资产后解绑附件关联失败（projectId=${projectId}）`, error);
    }
  }

  /** 改名反查改绑（批8 P3）：命中前缀的关联行 assetPath 同步迁移（文件
   *  精确替换/文件夹前缀平移）；失败仅记日志——关联仍指旧路径，读取侧
   *  valid=false 失效态兜底显示 */
  private async rebindAttachmentsOf(
    projectId: number,
    oldRel: string,
    newRel: string,
  ): Promise<void> {
    try {
      if (!oldRel || !newRel) {
        return;
      }
      const rows = await this.projectAttachmentRows(projectId);
      for (const row of rows) {
        const rel = normalizeAssetRelPath(row.assetPath);
        if (rel !== oldRel && !rel.startsWith(`${oldRel}/`)) {
          continue;
        }
        const next =
          rel === oldRel ? newRel : `${newRel}${rel.slice(oldRel.length)}`;
        await prisma.planItemAttachment.update({
          where: { id: row.id },
          data: { assetPath: next },
        });
      }
    } catch (error) {
      Log.warn(`资产改名后改绑附件关联失败（projectId=${projectId}）`, error);
    }
  }
}
