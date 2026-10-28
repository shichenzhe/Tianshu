/**
 * 资料库面服务（library 批，spec 2026-10-26 §1.1）：十八端点业务面——
 * 元数据面直转 LibraryDiskRepository（mirror library.repo golden 移植），
 * 内容面收口四类守卫（与 mirror server-face library-tap 逐点对齐）：
 * read 512KiB+NUL（@tianshu/core readTextFileGuarded 共享纯函数消费）、
 * readImage 白名单 png/jpg/jpeg/webp/gif/svg+xml + ≤10MB、writeContent
 * ≤512KiB + LIBRARY_WRITE_FAILED、归属校验（LIBRARY_NOT_FOUND 不泄露
 * 存在性）。DTO 显式字段挑选——storagePath/originalPath 本机绝对路径
 * 绝不透出（spec §1.4，钉测试守护）；磁盘路径由服务端校验归属后自行
 * 解析。归属用户 = COMPANION_USER_ID（无头端伴生用户，workspace/
 * assistant 模块同口径）。
 */
import { Injectable } from '@nestjs/common';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readTextFileGuarded } from '@tianshu/core';
import type {
  LibraryItemDto,
  LibraryReadImageResult,
  LibraryReadResult,
} from '@tianshu/protocol';
import { BusinessException } from 'src/commons/exception/bussiness-exception';
import { COMPANION_USER_ID } from 'src/commons/config/tianshu-config.entity';
import {
  LibraryDiskRepository,
  type LibraryItem,
} from 'src/core/library/library-disk.repository';

/** readImage 图片上限（对齐 mirror library-tap/workspace-files
 *  IMAGE_READ_LIMIT 与 face image 端点 10MB 口径；文本仍 512KiB） */
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** 上传上限（对齐 skills installUpload 口径：解码后原始 ≤3MB，relay 单帧
 *  4MiB 余量；spec §1.1） */
const UPLOAD_MAX_BYTES = 3 * 1024 * 1024;

/** base64 形状校验：标准字母表 + padding 对齐（解码前拒——Node
 *  Buffer.from 对坏串 lenient 吞错，无法事后判定） */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** readImage 扩展名 → mime 白名单（mirror library-tap 同口径——含 svg
 *  文本型图像；bmp/ico 明确不扩，RN Image 跨平台支持差，移动端前置拦截） */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

/** DTO 转制：显式字段挑选——storagePath/originalPath 为本机绝对路径，
 *  刻意剔除（spec §1.4 ruling：不作远程读取凭证） */
export function toLibraryItemDto(item: LibraryItem): LibraryItemDto {
  return {
    id: item.id,
    parentId: item.parentId,
    name: item.name,
    kind: item.kind,
    fileType: item.fileType,
    mimeType: item.mimeType,
    size: item.size,
    url: item.url,
    favorite: item.favorite,
    lastViewedAt: item.lastViewedAt,
    location: item.location,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

@Injectable()
export class LibraryService {
  constructor(private readonly repo: LibraryDiskRepository) {}

  /** 行校验：不存在 LIBRARY_NOT_FOUND（存在性不泄露，同 repo mustGet
   *  口径）；非文件 LIBRARY_NOT_FILE（folder 无磁盘实体 / link 无内容
   *  语义）——mirror library-tap mustFile 同语义 */
  private async mustFile(id: number): Promise<LibraryItem> {
    const item = await this.repo.get(id, COMPANION_USER_ID);
    if (!item) {
      throw new BusinessException('资料库条目不存在', 'LIBRARY_NOT_FOUND');
    }
    if (item.kind !== 'file') {
      throw new BusinessException('仅文件条目支持读取内容', 'LIBRARY_NOT_FILE');
    }
    return item;
  }

  /** 磁盘实体路径：{libraryRoot}/{id}/{name}（repo storagePath 派生口径
   *  一致——file 条目恒非 null，断言兜底） */
  private diskPathOf(item: LibraryItem): string {
    if (!item.storagePath) {
      throw new BusinessException('读取失败', 'LIBRARY_READ_FAILED');
    }
    return item.storagePath;
  }

  async list(parentId: number | null): Promise<{
    items: LibraryItemDto[];
    breadcrumbs: LibraryItemDto[];
  }> {
    const result = await this.repo.list(parentId, COMPANION_USER_ID);
    return {
      items: result.items.map(toLibraryItemDto),
      breadcrumbs: result.breadcrumbs.map(toLibraryItemDto),
    };
  }

  async tree(): Promise<LibraryItemDto[]> {
    return (await this.repo.tree(COMPANION_USER_ID)).map(toLibraryItemDto);
  }

  async search(keyword: string): Promise<LibraryItemDto[]> {
    return (await this.repo.search(keyword, COMPANION_USER_ID)).map(
      toLibraryItemDto,
    );
  }

  async listRecent(): Promise<LibraryItemDto[]> {
    return (await this.repo.listRecent(COMPANION_USER_ID)).map(
      toLibraryItemDto,
    );
  }

  async listFavorites(): Promise<LibraryItemDto[]> {
    return (await this.repo.listFavorites(COMPANION_USER_ID)).map(
      toLibraryItemDto,
    );
  }

  async createFolder(
    name: string,
    parentId: number | null,
  ): Promise<LibraryItemDto> {
    return toLibraryItemDto(
      await this.repo.createFolder(name, parentId, COMPANION_USER_ID),
    );
  }

  async createFile(
    name: string,
    parentId: number | null,
  ): Promise<LibraryItemDto> {
    return toLibraryItemDto(
      await this.repo.createFile(name, parentId, COMPANION_USER_ID),
    );
  }

  async addLink(
    url: string,
    title: string | null,
    parentId: number | null,
  ): Promise<LibraryItemDto> {
    return toLibraryItemDto(
      await this.repo.addLink(url, title, parentId, COMPANION_USER_ID),
    );
  }

  async rename(id: number, name: string): Promise<LibraryItemDto> {
    return toLibraryItemDto(
      await this.repo.rename(id, name, COMPANION_USER_ID),
    );
  }

  async move(ids: number[], targetParentId: number | null): Promise<null> {
    return this.repo.move(ids, targetParentId, COMPANION_USER_ID);
  }

  async delete(ids: number[]): Promise<null> {
    return this.repo.delete(ids, COMPANION_USER_ID);
  }

  async subtreeCount(id: number): Promise<number> {
    return this.repo.subtreeCount(id, COMPANION_USER_ID);
  }

  async toggleFavorite(id: number): Promise<LibraryItemDto> {
    return toLibraryItemDto(
      await this.repo.toggleFavorite(id, COMPANION_USER_ID),
    );
  }

  async markViewed(id: number): Promise<LibraryItemDto> {
    return toLibraryItemDto(await this.repo.markViewed(id, COMPANION_USER_ID));
  }

  /** 文本读取：512KiB 上限 + NUL 二进制判定（共享纯函数），守卫拒绝转
   *  LIBRARY_* 稳定码——mirror library-tap read 同口径 */
  async read(id: number): Promise<LibraryReadResult> {
    const item = await this.mustFile(id);
    const guarded = await readTextFileGuarded(this.diskPathOf(item));
    if (guarded.ok) return { kind: 'text', content: guarded.content };
    if (guarded.reason === 'too-large') {
      throw new BusinessException('超过 512KB 上限', 'LIBRARY_TOO_LARGE');
    }
    if (guarded.reason === 'binary') {
      throw new BusinessException('二进制文件不支持预览', 'LIBRARY_BINARY');
    }
    throw new BusinessException('读取失败', 'LIBRARY_READ_FAILED');
  }

  /** 图片读取：mime 白名单（非图片 LIBRARY_BINARY）+ ≤10MB
   *  （LIBRARY_TOO_LARGE）→ {mime, dataBase64}；stat/读盘失败
   *  LIBRARY_READ_FAILED——mirror library-tap readImageOf 同口径 */
  async readImage(id: number): Promise<LibraryReadImageResult> {
    const item = await this.mustFile(id);
    const mime = IMAGE_MIME_BY_EXT[path.extname(item.name).toLowerCase()];
    if (!mime) {
      throw new BusinessException('不是受支持的图片格式', 'LIBRARY_BINARY');
    }
    const abs = this.diskPathOf(item);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile() || stat.size > IMAGE_MAX_BYTES) {
        throw new BusinessException('图片超过 10MB 上限', 'LIBRARY_TOO_LARGE');
      }
      const buf = await fs.readFile(abs);
      return { mime, dataBase64: buf.toString('base64') };
    } catch (error) {
      if (error instanceof BusinessException) throw error;
      throw new BusinessException('读取失败', 'LIBRARY_READ_FAILED');
    }
  }

  /** 内容覆写：≤512KiB 对齐 read 口径（超限读不回来——覆写即永久失联，
   *  故前置拦截）；写盘失败 LIBRARY_WRITE_FAILED；并发冲突 v1 无乐观锁，
   *  最后写赢（mirror library-tap writeContent 同口径） */
  async writeContent(id: number, content: string): Promise<LibraryItemDto> {
    await this.mustFile(id);
    if (Buffer.byteLength(content, 'utf8') > 512 * 1024) {
      throw new BusinessException('超过 512KB 上限', 'LIBRARY_TOO_LARGE');
    }
    try {
      return toLibraryItemDto(
        await this.repo.writeFileContent(id, content, COMPANION_USER_ID),
      );
    } catch (error) {
      if (error instanceof BusinessException) throw error;
      throw new BusinessException('写入失败', 'LIBRARY_WRITE_FAILED');
    }
  }

  /** 二进制上传入库（uploadFile 端点，spec §1.2）：parentId 归属前置校验
   *  （LIBRARY_NOT_FOUND 不泄露存在性）→ base64 形状校验 + 解码 ≤3MB 前置
   *  拒（LIBRARY_UPLOAD_INVALID）→ repo buffer 落盘（清洗/重名序号/分类
   *  推断在 repo 同 createFile 先例）；文件名清洗后为空（"名称无效"）与
   *  写盘失败分别映射 LIBRARY_UPLOAD_INVALID / LIBRARY_WRITE_FAILED */
  async uploadFile(input: {
    parentId?: number | null;
    name: string;
    base64: string;
  }): Promise<LibraryItemDto> {
    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      const parent = await this.repo.get(parentId, COMPANION_USER_ID);
      if (!parent || parent.kind !== 'folder') {
        throw new BusinessException('资料库条目不存在', 'LIBRARY_NOT_FOUND');
      }
    }
    const cleaned = input.base64.trim();
    if (
      cleaned.length === 0 ||
      cleaned.length % 4 !== 0 ||
      !BASE64_PATTERN.test(cleaned)
    ) {
      throw new BusinessException('base64 无效', 'LIBRARY_UPLOAD_INVALID');
    }
    const buffer = Buffer.from(cleaned, 'base64');
    if (buffer.length > UPLOAD_MAX_BYTES) {
      throw new BusinessException('文件超过 3MB 上限', 'LIBRARY_UPLOAD_INVALID');
    }
    try {
      return toLibraryItemDto(
        await this.repo.uploadFileBuffer(
          buffer,
          input.name,
          parentId,
          COMPANION_USER_ID,
        ),
      );
    } catch (error) {
      if (error instanceof BusinessException) throw error;
      if (error instanceof Error && error.message === '名称无效') {
        throw new BusinessException('文件名非法', 'LIBRARY_UPLOAD_INVALID');
      }
      throw new BusinessException('写入失败', 'LIBRARY_WRITE_FAILED');
    }
  }
}
