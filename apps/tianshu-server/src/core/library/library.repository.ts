/**
 * 资料库仓储·检索面最小摘取（PL-2，spec §2.2）：自 mirror
 * electron/domains/ai/library/library.repo.ts 摘 search/按 id 读两面。
 * - **写面零摘**：addFiles/importFolder/addLink/rename/move/delete/
 *   toggleFavorite/markViewed 等 mirror 写面一律不摘——library 写侧
 *   （上传/导入/管理端点）属后续「library 同步/上传」批（spec §1 非
 *   目标）；本仓仅落 libraryItem 表 + 读面，drift manifest 入册见 PL-T3；
 * - search：跨层文件名检索语义逐字（仅 kind=file + name contains，keyword
 *   trim 后截 100 防超长 LIKE）；返回 DB 行本体——不含 mirror 的 location
 *   面包屑/storagePath 投影（electron 依赖，server 无树形消费面）；
 * - getById：mirror mustGet 同语义（不存在与他人所有同报错，不泄露存在性）；
 * - findFilesByNames：library_search 命中块回联条目的精确名批量读（mirror
 *   无对应——工具检索面配套新增，仅 file）。
 */
/** 资料库条目 DB 行（libraryItem 表全字段投影） */
export interface LibraryItemRow {
  id: number;
  parentId: number | null;
  name: string;
  kind: string;
  fileType: string | null;
  mimeType: string | null;
  size: number | null;
  originalPath: string | null;
  url: string | null;
  favorite: boolean;
  lastViewedAt: Date | null;
  userId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * prisma libraryItem delegate 结构子集（真实客户端/测试 stub 均可注入——
 * OptionPrismaLike 先例，personalization.ts）
 */
export interface LibraryPrismaLike {
  libraryItem: {
    findMany(args: {
      where: {
        kind?: string;
        name?: { contains?: string; in?: string[] };
        userId?: number;
      };
    }): Promise<LibraryItemRow[]>;
    findFirst(args: {
      where: { id?: number; userId?: number };
    }): Promise<LibraryItemRow | null>;
  };
}

export class LibraryRepository {
  constructor(private readonly prismaClient: LibraryPrismaLike) {}

  /** 跨层文件名搜索（mirror search 逐字：仅 file；contains = SQLite LIKE，
   *  ASCII 大小写不敏感；keyword 截 100 防超长 LIKE；空白返空） */
  async search(keyword: string, userId: number): Promise<LibraryItemRow[]> {
    const trimmed = keyword.trim().slice(0, 100);
    if (!trimmed) {
      return [];
    }
    return this.prismaClient.libraryItem.findMany({
      where: {
        kind: 'file',
        name: { contains: trimmed },
        userId,
      },
    });
  }

  /** 取行并校验归属当前用户（mirror mustGet 逐字：不存在与他人所有同报错，
   *  不泄露存在性） */
  async getById(id: number, userId: number): Promise<LibraryItemRow> {
    const row = await this.prismaClient.libraryItem.findFirst({
      where: { id, userId },
    });
    if (!row) {
      throw new Error('条目不存在');
    }
    return row;
  }

  /** 精确名匹配的 file 行批量读（library_search 命中块回联条目；
   *  folder/link 与他用户行排除；空名单直返不发查询） */
  async findFilesByNames(
    names: readonly string[],
    userId: number,
  ): Promise<LibraryItemRow[]> {
    if (names.length === 0) {
      return [];
    }
    return this.prismaClient.libraryItem.findMany({
      where: {
        kind: 'file',
        name: { in: [...names] },
        userId,
      },
    });
  }
}
