/**
 * 资产仓储：项目资产空间内文件/文件夹的列表/新建文件夹/重命名/删除（二期 spec §4）。
 * 所有相对路径经 safeJoin 沙箱校验（resolve 后必须仍落在资产根内），
 * 名称经 sanitizeName 清洗 + uniqueName 重名序号；list 对缺失目录自愈重建。
 * fs 沿用 project.repo 的 node:fs/promises 默认导入 + node:fs existsSync 探测。
 */
import { ipcMain } from "electron";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Dirent, Stats } from "node:fs";
import prisma from "../../commons/prisma-client";
import Log from "../../commons/Log";
import { PROJECT_NOT_FOUND } from "./project.entity";
import type ProjectRepository from "./project.repo";
import type { AssetEntry } from "./asset.entity";

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

/** fs 异常转中文错误（附 cause，沿用 project.repo 先例） */
function wrapFsError(error: unknown, message: string): Error {
  const cause = error instanceof Error ? error.message : String(error);
  return new Error(`${message}：${cause}`, { cause: error });
}

export default class AssetRepository {
  private readonly projectRepo: ProjectRepository;

  constructor(projectRepo: ProjectRepository) {
    this.projectRepo = projectRepo;
    this.registerHandlers();
  }

  /**
   * 注册IPC处理程序（projectAsset:upload 等 4 通道由 Task 4 补齐）
   */
  private registerHandlers() {
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
   * 重命名：清洗 + 重名序号 + rename（同目录内改）；返回最终名
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
    return finalName;
  }

  /**
   * 删除：文件 unlink / 文件夹 rm recursive；目标已不存在幂等 no-op
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
      return;
    }
    await this.rmFolder(target);
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
}
