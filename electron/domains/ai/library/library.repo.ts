/**
 * 资料库仓储（spec §3/§4）：DB 为真相源 + ID 寻址存储
 * {userData}/library/{itemId}/{原文件名}。元数据六通道（list 含面包屑 /
 * search 跨层 / createFolder / rename / move 循环防护 / delete 级联删
 * 记录后清盘）；rename/move 的 file 分支均磁盘双写（storagePath 派生自
 * name，纯 DB 改名会使路径断裂）；folder 无磁盘实体，仍纯 DB。
 */
import { ipcMain, app, shell } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import type { PrismaClient } from "../../../generated/prisma/client";
import type {
  LibraryItem,
  AddFilesResult,
} from "../../../../src-react/domains/ai/library/api/library.api";
import {
  buildBreadcrumbChain,
  collectSubtreeIds,
  isDescendantOrSelf,
  sanitizeLibraryName,
  uniqueDbName,
  compareLibraryItems,
  classifyFileType,
  mimeOf,
  storageDirOf,
  type ItemRow,
} from "./library.utils";

/** 资料库存储根（天枢管理目录，用户不直接操作） */
const LIBRARY_ROOT_NAME = "library";

/** toClientItem 行输入：DB 行（libraryItemModel）与面包屑投影
 * （buildBreadcrumbChain 返回 ItemRow 接口，无隐式索引签名）的
 * 公共结构——日期/文件字段可缺省，读取处 as 断言兜底 */
type LibraryRowInput = {
  id: number;
  parentId: number | null;
  name: string;
  kind: string;
  fileType?: string | null;
  mimeType?: string | null;
  size?: number | null;
  originalPath?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

/** DB 行 → 前端契约（file 附 storagePath 绝对路径；folder 恒 null） */
function toClientItem(row: LibraryRowInput, libraryRoot: string): LibraryItem {
  const isFile = row.kind === "file";
  return {
    id: row.id,
    parentId: (row.parentId as number | null) ?? null,
    name: row.name as string,
    kind: row.kind as "folder" | "file",
    fileType: (row.fileType as string | null) ?? null,
    mimeType: (row.mimeType as string | null) ?? null,
    size: (row.size as number | null) ?? null,
    originalPath: (row.originalPath as string | null) ?? null,
    storagePath: isFile
      ? path.join(libraryRoot, String(row.id), row.name as string)
      : null,
    createdAt: (row.createdAt as Date).toISOString(),
    updatedAt: (row.updatedAt as Date).toISOString(),
  };
}

export default class LibraryRepository {
  constructor(private readonly prismaClient: PrismaClient = prisma) {
    this.registerHandlers();
  }

  private get libraryRoot(): string {
    return path.join(app.getPath("userData"), LIBRARY_ROOT_NAME);
  }

  private registerHandlers(): void {
    ipcMain.handle("library:list", (_e, parentId: number | null) =>
      this.list(parentId),
    );
    ipcMain.handle("library:search", (_e, keyword: string) =>
      this.search(keyword),
    );
    ipcMain.handle(
      "library:createFolder",
      (_e, name: string, parentId: number | null) =>
        this.createFolder(name, parentId),
    );
    ipcMain.handle("library:rename", (_e, id: number, name: string) =>
      this.rename(id, name),
    );
    ipcMain.handle(
      "library:move",
      (_e, ids: number[], targetParentId: number | null) =>
        this.move(ids, targetParentId),
    );
    ipcMain.handle("library:delete", (_e, ids: number[]) => this.delete(ids));
    ipcMain.handle(
      "library:addFiles",
      (_e, paths: string[], folderId: number | null) =>
        this.addFiles(paths, folderId),
    );
    ipcMain.handle("library:revealItem", (_e, id: number) =>
      this.revealItem(id),
    );
  }

  /** 单层列表（folder 置前基准序）+ 祖先链面包屑一次返回 */
  async list(parentId: number | null): Promise<{
    items: LibraryItem[];
    breadcrumbs: LibraryItem[];
  }> {
    const rows = await this.prismaClient.libraryItem.findMany({
      where: { parentId },
    });
    const items = rows
      .map((row) => toClientItem(row, this.libraryRoot))
      .sort(compareLibraryItems);
    let breadcrumbs: LibraryItem[] = [];
    if (parentId !== null) {
      const all = await this.prismaClient.libraryItem.findMany();
      // 透传完整行（仅收紧 kind 类型）：链上对象原样流回 toClientItem，
      // 缺 createdAt 等字段会在 ISO 转换处崩
      breadcrumbs = buildBreadcrumbChain(
        all.map((row) => ({ ...row, kind: row.kind as "folder" | "file" })),
        parentId,
      ).map((row) => toClientItem(row, this.libraryRoot));
    }
    return { items, breadcrumbs };
  }

  /** 跨层文件名搜索（仅 file；contains = SQLite LIKE，ASCII 大小写不敏感） */
  async search(keyword: string): Promise<LibraryItem[]> {
    if (!keyword.trim()) {
      return [];
    }
    const rows = await this.prismaClient.libraryItem.findMany({
      where: { kind: "file", name: { contains: keyword.trim() } },
    });
    return rows.map((row) => toClientItem(row, this.libraryRoot));
  }

  /** 新建文件夹：清洗 + 同层重名序号 */
  async createFolder(
    name: string,
    parentId: number | null,
  ): Promise<LibraryItem> {
    const finalName = uniqueDbName(
      await this.siblingNames(parentId),
      sanitizeLibraryName(name),
    );
    const row = await this.prismaClient.libraryItem.create({
      data: { parentId, name: finalName, kind: "folder" },
    });
    return toClientItem(row, this.libraryRoot);
  }

  /**
   * 批量拷贝入库：逐文件 校验源存在 → 同层重名序号 → INSERT 得 id →
   * mkdir {libraryRoot}/{id} → copyFile → 回填 size。任一步失败回滚该条
   * （删记录 + 清目录）记入 failed，不阻断批次（spec §4）。
   */
  async addFiles(
    paths: string[],
    folderId: number | null,
  ): Promise<AddFilesResult> {
    const result: AddFilesResult = { added: [], failed: [] };
    const siblingNames = await this.siblingNames(folderId);
    for (const absPath of paths) {
      const baseName = path.basename(absPath);
      try {
        if (!existsSync(absPath)) {
          throw new Error("源文件不存在");
        }
        const name = uniqueDbName(siblingNames, sanitizeLibraryName(baseName));
        const row = await this.prismaClient.libraryItem.create({
          data: {
            parentId: folderId,
            name,
            kind: "file",
            fileType: classifyFileType(name),
            mimeType: mimeOf(name),
            originalPath: absPath,
          },
        });
        const dir = storageDirOf(this.libraryRoot, row.id);
        try {
          await fs.mkdir(dir, { recursive: true });
          await fs.copyFile(absPath, path.join(dir, name));
          const stat = await fs.stat(path.join(dir, name));
          await this.prismaClient.libraryItem.update({
            where: { id: row.id },
            data: { size: stat.size },
          });
        } catch (error) {
          // 入库中途失败：回滚记录与目录（吞错——清理失败仅日志）
          await this.prismaClient.libraryItem
            .deleteMany({ where: { id: { in: [row.id] } } })
            .catch(() => {});
          await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        siblingNames.add(name);
        result.added.push(
          toClientItem(
            { ...row, size: (await this.mustGet(row.id)).size ?? null },
            this.libraryRoot,
          ),
        );
      } catch (error) {
        result.failed.push({
          path: baseName,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  /** Finder/资源管理器定位（file 定位文件本体、folder 定位其目录） */
  async revealItem(id: number): Promise<null> {
    const row = await this.mustGet(id);
    shell.showItemInFolder(
      row.kind === "file"
        ? path.join(this.libraryRoot, String(row.id), row.name)
        : storageDirOf(this.libraryRoot, id),
    );
    return null;
  }

  /**
   * rename 升级（Task 3 review 裁决）：file 的重命名先同步磁盘文件名再
   * update DB（storagePath 派生自当前 name，纯 DB rename 会使其断裂）；
   * 磁盘失败抛错、DB 不动。folder 无磁盘实体，仍走纯 DB。
   */
  async rename(id: number, name: string): Promise<LibraryItem> {
    const row = await this.mustGet(id);
    const finalName = uniqueDbName(
      await this.siblingNames(row.parentId ?? null, id),
      sanitizeLibraryName(name),
    );
    if (row.kind === "file" && finalName !== row.name) {
      await fs.rename(
        path.join(this.libraryRoot, String(id), row.name),
        path.join(this.libraryRoot, String(id), finalName),
      );
    }
    const updated = await this.prismaClient.libraryItem.update({
      where: { id },
      data: { name: finalName },
    });
    return toClientItem(updated, this.libraryRoot);
  }

  /** 移动：目标须为文件夹且不在被移项自身子树内（循环防护）；file 撞名
   *  改序号时磁盘双写（同 rename 模式——磁盘成功才动 DB），其余纯 DB */
  async move(ids: number[], targetParentId: number | null): Promise<null> {
    const all = await this.prismaClient.libraryItem.findMany();
    const rows: ItemRow[] = all.map((row) => ({
      id: row.id,
      parentId: row.parentId ?? null,
      name: row.name,
      kind: row.kind as "folder" | "file",
    }));
    if (targetParentId !== null) {
      const target = rows.find((row) => row.id === targetParentId);
      if (!target || target.kind !== "folder") {
        throw new Error("目标必须是文件夹");
      }
      // 目标是被移项自身或其后代 → 移入即成环，拒绝
      for (const id of ids) {
        if (isDescendantOrSelf(rows, id, targetParentId)) {
          throw new Error("不能移动到自身或其子文件夹内");
        }
      }
    }
    // 目标层现有名集合（动态维护——同批逐个移入互不撞名）
    const existingNames = new Set(
      rows
        .filter((row) => row.parentId === targetParentId)
        .map((row) => row.name),
    );
    for (const id of ids) {
      const current = rows.find((row) => row.id === id);
      if (!current) {
        continue;
      }
      // 自身已在目标层（排序原位）：旧名不构成冲突
      if (current.parentId === targetParentId) {
        existingNames.delete(current.name);
      }
      const finalName = uniqueDbName(existingNames, current.name);
      existingNames.add(finalName);
      // 撞名（finalName !== current.name）时 file 须先同步磁盘文件名再动
      // DB——storagePath 派生自 name，纯 DB 改名会使路径指向不存在文件且
      // rename() 后续按错名 fs.rename ENOENT 无法自愈；folder 纯 DB
      if (current.kind === "file" && finalName !== current.name) {
        await fs.rename(
          path.join(this.libraryRoot, String(id), current.name),
          path.join(this.libraryRoot, String(id), finalName),
        );
      }
      await this.prismaClient.libraryItem.update({
        where: { id },
        data: { parentId: targetParentId, name: finalName },
      });
    }
    return null;
  }

  /** 级联删除子树记录（磁盘清理见 Task 4 cleanupDisk） */
  async delete(ids: number[]): Promise<null> {
    const all = await this.prismaClient.libraryItem.findMany();
    const rows: ItemRow[] = all.map((row) => ({
      id: row.id,
      parentId: row.parentId ?? null,
      name: row.name,
      kind: row.kind as "folder" | "file",
    }));
    const subtreeIds = collectSubtreeIds(rows, ids);
    await this.prismaClient.libraryItem.deleteMany({
      where: { id: { in: subtreeIds } },
    });
    await this.cleanupDisk(subtreeIds);
    return null;
  }

  /** 同层名集合（rename 时排除自身） */
  private async siblingNames(
    parentId: number | null,
    excludeId?: number,
  ): Promise<Set<string>> {
    const rows = await this.prismaClient.libraryItem.findMany({
      where: { parentId },
    });
    return new Set(
      rows.filter((row) => row.id !== excludeId).map((row) => row.name),
    );
  }

  private async mustGet(id: number) {
    const row = await this.prismaClient.libraryItem.findUnique({
      where: { id },
    });
    if (!row) {
      throw new Error("条目不存在");
    }
    return row;
  }

  /** 删除后清盘：先删记录后删盘（中断仅剩孤儿目录，无害——spec 裁定 8）；失败记日志放行 */
  private async cleanupDisk(ids: number[]): Promise<void> {
    for (const id of ids) {
      try {
        await fs.rm(storageDirOf(this.libraryRoot, id), {
          recursive: true,
          force: true,
        });
      } catch (error) {
        Log.warn(`资料库磁盘清理失败（id=${id}）`, error);
      }
    }
  }
}
