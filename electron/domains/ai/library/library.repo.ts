/**
 * 资料库仓储（spec §3/§4）：DB 为真相源 + ID 寻址存储
 * {userData}/library/{itemId}/{原文件名}。元数据六通道（list 含面包屑 /
 * search 跨层 / createFolder / rename / move 循环防护 / delete 级联删
 * 记录后清盘）；rename/move 的 file 分支均磁盘双写（storagePath 派生自
 * name，纯 DB 改名会使路径断裂）；folder 无磁盘实体，仍纯 DB。
 */
import { app, shell } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import { handleUser } from "../../../commons/ipc-user";
import type { PrismaClient } from "../../../generated/prisma/client";
import type {
  LibraryItem,
  AddFilesResult,
  LibraryFolderNode,
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
    handleUser("library:list", (_, userId, parentId: number | null) =>
      this.list(parentId, userId),
    );
    handleUser("library:search", (_, userId, keyword: string) =>
      this.search(keyword, userId),
    );
    handleUser(
      "library:createFolder",
      (_, userId, name: string, parentId: number | null) =>
        this.createFolder(name, parentId, userId),
    );
    handleUser("library:rename", (_, userId, id: number, name: string) =>
      this.rename(id, name, userId),
    );
    handleUser(
      "library:move",
      (_, userId, ids: number[], targetParentId: number | null) =>
        this.move(ids, targetParentId, userId),
    );
    handleUser("library:delete", (_, userId, ids: number[]) =>
      this.delete(ids, userId),
    );
    handleUser(
      "library:addFiles",
      (_, userId, paths: string[], folderId: number | null) =>
        this.addFiles(paths, folderId, userId),
    );
    handleUser("library:revealItem", (_, userId, id: number) =>
      this.revealItem(id, userId),
    );
    handleUser("library:subtreeCount", (_, userId, id: number) =>
      this.subtreeCount(id, userId),
    );
    handleUser("library:tree", (_, userId) => this.tree(userId));
  }

  /** 单层列表（folder 置前基准序）+ 祖先链面包屑一次返回 */
  async list(
    parentId: number | null,
    userId: number,
  ): Promise<{
    items: LibraryItem[];
    breadcrumbs: LibraryItem[];
  }> {
    const rows = await this.prismaClient.libraryItem.findMany({
      where: { parentId, userId },
    });
    const items = rows
      .map((row) => toClientItem(row, this.libraryRoot))
      .sort(compareLibraryItems);
    let breadcrumbs: LibraryItem[] = [];
    if (parentId !== null) {
      const all = await this.prismaClient.libraryItem.findMany({
        where: { userId },
      });
      // 透传完整行（仅收紧 kind 类型）：链上对象原样流回 toClientItem，
      // 缺 createdAt 等字段会在 ISO 转换处崩
      breadcrumbs = buildBreadcrumbChain(
        all.map((row) => ({ ...row, kind: row.kind as "folder" | "file" })),
        parentId,
      ).map((row) => toClientItem(row, this.libraryRoot));
    }
    return { items, breadcrumbs };
  }

  /** 跨层文件名搜索（仅 file；contains = SQLite LIKE，ASCII 大小写不敏感；
   *  keyword 截 100 防超长 LIKE） */
  async search(keyword: string, userId: number): Promise<LibraryItem[]> {
    const trimmed = keyword.trim().slice(0, 100);
    if (!trimmed) {
      return [];
    }
    const rows = await this.prismaClient.libraryItem.findMany({
      where: {
        kind: "file",
        name: { contains: trimmed },
        userId,
      },
    });
    return rows.map((row) => toClientItem(row, this.libraryRoot));
  }

  /** 全量文件夹平铺（树形栏数据源；个人库量级小一次拉全，元数据
   *  变更后由前端 invalidate 重拉） */
  async tree(userId: number): Promise<LibraryFolderNode[]> {
    const rows = await this.prismaClient.libraryItem.findMany({
      where: { kind: "folder", userId },
      select: { id: true, parentId: true, name: true },
    });
    return rows.map((row) => ({
      id: row.id,
      parentId: row.parentId ?? null,
      name: row.name,
    }));
  }

  /** 新建文件夹：清洗 + 同层重名序号 */
  async createFolder(
    name: string,
    parentId: number | null,
    userId: number,
  ): Promise<LibraryItem> {
    if (parentId !== null) {
      const parent = await this.mustGet(parentId, userId);
      if (parent.kind !== "folder") {
        throw new Error("上级必须是文件夹");
      }
    }
    const finalName = uniqueDbName(
      await this.siblingNames(parentId, userId),
      sanitizeLibraryName(name),
    );
    const row = await this.prismaClient.libraryItem.create({
      data: { parentId, name: finalName, kind: "folder", userId },
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
    userId: number,
  ): Promise<AddFilesResult> {
    const result: AddFilesResult = { added: [], failed: [] };
    // 目标层归属校验（根层免校验，下方写入均带 userId）
    if (folderId !== null) {
      await this.mustGet(folderId, userId);
    }
    const siblingNames = await this.siblingNames(folderId, userId);
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
            userId,
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
          // 成功路径一次收口（size 用本地 stat，免二次查询）
          siblingNames.add(name);
          result.added.push(
            toClientItem({ ...row, size: stat.size }, this.libraryRoot),
          );
        } catch (error) {
          // 入库中途失败：回滚记录与目录（吞错——清理失败仅日志）
          await this.prismaClient.libraryItem
            .deleteMany({ where: { id: { in: [row.id] } } })
            .catch(() => {});
          await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
      } catch (error) {
        result.failed.push({
          path: baseName,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  /** Finder/资源管理器定位（仅 file 有磁盘实体——folder 纯 DB 无目录，
   *  reveal 需求由前端对 folder 隐藏入口，此处防御性拒绝） */
  async revealItem(id: number, userId: number): Promise<null> {
    const row = await this.mustGet(id, userId);
    if (row.kind !== "file") {
      throw new Error("文件夹无实体文件可定位");
    }
    shell.showItemInFolder(
      path.join(this.libraryRoot, String(row.id), row.name),
    );
    return null;
  }

  /**
   * rename 升级（Task 3 review 裁决）：file 的重命名先同步磁盘文件名再
   * update DB（storagePath 派生自当前 name，纯 DB rename 会使其断裂）；
   * 磁盘失败抛错、DB 不动；DB 失败回滚磁盘名（防断裂，见 renameDiskThenDb）。
   * folder 无磁盘实体，仍走纯 DB。
   */
  async rename(id: number, name: string, userId: number): Promise<LibraryItem> {
    const row = await this.mustGet(id, userId);
    const finalName = uniqueDbName(
      await this.siblingNames(row.parentId ?? null, userId, id),
      sanitizeLibraryName(name),
    );
    if (row.kind === "file" && finalName !== row.name) {
      await this.renameDiskThenDb(id, row.name, finalName, () =>
        this.prismaClient.libraryItem.update({
          where: { id },
          data: { name: finalName },
        }),
      );
      return toClientItem(
        { ...row, name: finalName, updatedAt: new Date() },
        this.libraryRoot,
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
  async move(
    ids: number[],
    targetParentId: number | null,
    userId: number,
  ): Promise<null> {
    const rows = await this.allItemRows(userId);
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
        await this.renameDiskThenDb(id, current.name, finalName, () =>
          this.prismaClient.libraryItem.update({
            where: { id },
            data: { parentId: targetParentId, name: finalName },
          }),
        );
      } else {
        await this.prismaClient.libraryItem.update({
          where: { id },
          data: { parentId: targetParentId, name: finalName },
        });
      }
    }
    return null;
  }

  /** 级联删除子树记录（磁盘清理见 Task 4 cleanupDisk）；数据源按用户
   *  过滤，他人条目不在子树集合内即不可删 */
  async delete(ids: number[], userId: number): Promise<null> {
    const rows = await this.allItemRows(userId);
    const subtreeIds = collectSubtreeIds(rows, ids);
    await this.prismaClient.libraryItem.deleteMany({
      where: { id: { in: subtreeIds } },
    });
    await this.cleanupDisk(subtreeIds);
    return null;
  }

  /** 子树内容数（删除确认提示用；含全部后代，不含自身） */
  async subtreeCount(id: number, userId: number): Promise<number> {
    await this.mustGet(id, userId);
    const rows = await this.allItemRows(userId);
    return collectSubtreeIds(rows, [id]).length - 1;
  }

  /** 用户全量行投影（move/delete/subtreeCount 共用的循环防护数据源） */
  private async allItemRows(userId: number): Promise<ItemRow[]> {
    const rows = await this.prismaClient.libraryItem.findMany({
      where: { userId },
    });
    return rows.map((row) => ({
      id: row.id,
      parentId: row.parentId ?? null,
      name: row.name,
      kind: row.kind as "folder" | "file",
    }));
  }

  /** 磁盘文件改名（rename/move 撞名共用）；失败抛中文错误带原因，DB 不动 */
  private async renameDiskFile(
    id: number,
    oldName: string,
    newName: string,
  ): Promise<void> {
    try {
      await fs.rename(
        path.join(this.libraryRoot, String(id), oldName),
        path.join(this.libraryRoot, String(id), newName),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`磁盘文件同步失败（${oldName}）: ${reason}`, {
        cause: error,
      });
    }
  }

  /**
   * 磁盘改名 + DB 落库的断裂补偿：磁盘成功后 DB 失败时把文件名改回
   * 旧名——否则 storagePath 指向不存在文件且后续 rename 按旧名 ENOENT
   * 无法自愈；恢复失败仅日志（与现状同 worst case，不恶化）
   */
  private async renameDiskThenDb(
    id: number,
    oldName: string,
    newName: string,
    dbUpdate: () => Promise<unknown>,
  ): Promise<void> {
    await this.renameDiskFile(id, oldName, newName);
    try {
      await dbUpdate();
    } catch (error) {
      await fs
        .rename(
          path.join(this.libraryRoot, String(id), newName),
          path.join(this.libraryRoot, String(id), oldName),
        )
        .catch((rollbackError) =>
          Log.warn(`资料库磁盘名回滚失败（id=${id}）`, rollbackError),
        );
      throw error;
    }
  }

  /** 同层名集合（rename 时排除自身；同层同用户，根层跨用户需带 userId） */
  private async siblingNames(
    parentId: number | null,
    userId: number,
    excludeId?: number,
  ): Promise<Set<string>> {
    const rows = await this.prismaClient.libraryItem.findMany({
      where: { parentId, userId },
    });
    return new Set(
      rows.filter((row) => row.id !== excludeId).map((row) => row.name),
    );
  }

  /** 取行并校验归属当前用户（不存在与他人所有同报错，不泄露存在性） */
  private async mustGet(id: number, userId: number) {
    const row = await this.prismaClient.libraryItem.findFirst({
      where: { id, userId },
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
