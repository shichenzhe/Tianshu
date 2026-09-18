/**
 * 资料库仓储（spec §3/§4）：DB 为真相源 + ID 寻址存储
 * {userData}/library/{itemId}/{原文件名}。元数据六通道（list 含面包屑 /
 * search 跨层 / createFolder / rename / move 循环防护 / delete 级联删
 * 记录后清盘）；移动与重命名只改 DB 不动磁盘。文件三通道（addFiles
 * 拷贝入库 + revealItem 定位）见 Task 4。
 */
import { ipcMain, app } from "electron";
import path from "node:path";
import prisma from "../../../commons/prisma-client";
import type { PrismaClient } from "../../../generated/prisma/client";
import type { LibraryItem } from "../../../../src-react/domains/ai/library/api/library.api";
import {
  buildBreadcrumbChain,
  collectSubtreeIds,
  isDescendantOrSelf,
  sanitizeLibraryName,
  uniqueDbName,
  compareLibraryItems,
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

  /** 重命名：清洗 + 同层（排除自身）重名序号；纯 DB 不动磁盘 */
  async rename(id: number, name: string): Promise<LibraryItem> {
    const row = await this.mustGet(id);
    const finalName = uniqueDbName(
      await this.siblingNames(row.parentId ?? null, id),
      sanitizeLibraryName(name),
    );
    const updated = await this.prismaClient.libraryItem.update({
      where: { id },
      data: { name: finalName },
    });
    return toClientItem(updated, this.libraryRoot);
  }

  /** 移动：目标须为文件夹且不在被移项自身子树内（循环防护）；纯 DB */
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

  /** Task 4 实现：逐项清理 {libraryRoot}/{id} 目录（失败仅日志，孤儿目录无害） */
  private async cleanupDisk(_ids: number[]): Promise<void> {
    void _ids; // 占位参数，Task 4 消费
  }
}
