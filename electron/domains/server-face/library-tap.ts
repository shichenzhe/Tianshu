// A5 资料库批（spec 2026-10-26 §2.2）：桌面被控面 library 十六端点桥——
// 复用 LibraryRepository 单实例（Application 注入，严禁 face 侧二次构造
// ——构造函数注册全部 IPC handler）；DTO 显式剔除 storagePath/originalPath
// （本机绝对路径不作远程读取凭证）；read/readImage 服务端解析
// {libraryDir()}/{id}/{name} 磁盘路径，512KB/NUL/mime/10MB 守卫对齐
// files-tap 口径（files/read 同款 readTextFileGuarded 共享纯函数）。
import fs from "node:fs/promises";
import path from "node:path";

import { readTextFileGuarded } from "@tianshu/core";
import type {
  LibraryErrorCode,
  LibraryItemDto,
  LibraryReadImageResult,
  LibraryUploadFilePayload,
} from "@tianshu/protocol";
import { libraryDir } from "../../commons/paths";
import type LibraryRepository from "../ai/library/library.repo";
import type { LibraryItem } from "../../../src-react/domains/ai/library/api/library.api";
import { sanitizeLibraryName } from "../ai/library/library.utils";
import type { ServerFaceLibrary } from "./deps";

/** readImage 图片上限（对齐 workspace-files IMAGE_READ_LIMIT 与 face image
 *  端点 10MB 口径；文本仍 512KB） */
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** uploadFile 原始二进制上限（对齐 skills installUpload 3MB 口径——
 *  relay 单帧 4MiB 余量；base64 解码后字节计） */
const UPLOAD_MAX_BYTES = 3 * 1024 * 1024;

/** readImage 扩展名 → mime 白名单（readImageWithinRoot 同口径；A5 尾扩 svg——
 *  文本型图像，base64 后移动端 WebView data URL 可渲染；bmp/ico 明确不扩，
 *  RN Image 跨平台支持差，移动端前置拦截，spec 2026-10-26 §1.1 裁定） */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

/** library 面业务错（code 稳定——routes 侧转 bizError 信封，控制端判码） */
export class FaceLibraryError extends Error {
  readonly code: LibraryErrorCode;
  constructor(code: LibraryErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** 桥接的仓储方法子集（LibraryRepository 满足；get 为 A5 新增公共方法） */
type LibraryRepoSubset = Pick<
  LibraryRepository,
  | "get"
  | "list"
  | "tree"
  | "search"
  | "listRecent"
  | "listFavorites"
  | "createFolder"
  | "createFile"
  | "addLink"
  | "rename"
  | "move"
  | "delete"
  | "subtreeCount"
  | "toggleFavorite"
  | "markViewed"
  | "writeFileContent"
  | "uploadFileBuffer"
>;

/** DTO 转制：显式字段挑选——storagePath/originalPath 为本机绝对路径，
 *  刻意剔除（spec §1.2 Ruling：不作远程读取凭证） */
function toDto(item: LibraryItem): LibraryItemDto {
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

/** 行校验：不存在 LIBRARY_NOT_FOUND（存在性不泄露，同 repo mustGet 口径）；
 *  非文件 LIBRARY_NOT_FILE（folder 无磁盘实体 / link 无内容语义） */
async function mustFile(
  repo: LibraryRepoSubset,
  userId: number,
  id: number,
): Promise<LibraryItem> {
  const item = await repo.get(id, userId);
  if (!item) {
    throw new FaceLibraryError("LIBRARY_NOT_FOUND", "资料库条目不存在");
  }
  if (item.kind !== "file") {
    throw new FaceLibraryError("LIBRARY_NOT_FILE", "仅文件条目支持读取内容");
  }
  return item;
}

/** 磁盘实体路径：{libraryDir}/{id}/{name}（repo storageDirOf 同款布局） */
function diskPathOf(item: LibraryItem): string {
  return path.join(libraryDir(), String(item.id), item.name);
}

/** 严格 base64 解码（skills installUpload 的 Node 宽松解码会吞非法字符——
 *  上传批前置拒「坏 base64」：字符集/对齐/填充位全校验；空串 = 空文件
 *  合法（createFile 同款 size-0 语义），返回空 buffer */
function decodeBase64Strict(value: string): Buffer | null {
  if (value === "") {
    return Buffer.alloc(0);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    return null;
  }
  return Buffer.from(value, "base64");
}

/** readImage：mime 白名单（非图片 LIBRARY_BINARY）+ ≤10MB（LIBRARY_TOO_LARGE）
 *  → {mime, dataBase64}；stat/读盘失败 LIBRARY_READ_FAILED */
async function readImageOf(
  repo: LibraryRepoSubset,
  userId: number,
  id: number,
): Promise<LibraryReadImageResult> {
  const item = await mustFile(repo, userId, id);
  const mime = IMAGE_MIME_BY_EXT[path.extname(item.name).toLowerCase()];
  if (!mime) {
    throw new FaceLibraryError("LIBRARY_BINARY", "不是受支持的图片格式");
  }
  const abs = diskPathOf(item);
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile() || stat.size > IMAGE_MAX_BYTES) {
      throw new FaceLibraryError("LIBRARY_TOO_LARGE", "图片超过 10MB 上限");
    }
    const buf = await fs.readFile(abs);
    return { mime, dataBase64: buf.toString("base64") };
  } catch (error) {
    if (error instanceof FaceLibraryError) throw error;
    throw new FaceLibraryError("LIBRARY_READ_FAILED", "读取失败");
  }
}

export function createLibraryFace(repo: LibraryRepoSubset): ServerFaceLibrary {
  return {
    list: async (userId, parentId) => {
      const result = await repo.list(parentId, userId);
      return {
        items: result.items.map(toDto),
        breadcrumbs: result.breadcrumbs.map(toDto),
      };
    },
    tree: async (userId) => (await repo.tree(userId)).map(toDto),
    search: async (userId, keyword) =>
      (await repo.search(keyword, userId)).map(toDto),
    listRecent: async (userId) => (await repo.listRecent(userId)).map(toDto),
    listFavorites: async (userId) =>
      (await repo.listFavorites(userId)).map(toDto),
    createFolder: async (userId, name, parentId) =>
      toDto(await repo.createFolder(name, parentId, userId)),
    createFile: async (userId, name, parentId) =>
      toDto(await repo.createFile(name, parentId, userId)),
    addLink: async (userId, url, title, parentId) =>
      toDto(await repo.addLink(url, title, parentId, userId)),
    rename: async (userId, id, name) =>
      toDto(await repo.rename(id, name, userId)),
    move: (userId, ids, targetParentId) =>
      repo.move(ids, targetParentId, userId),
    delete: (userId, ids) => repo.delete(ids, userId),
    subtreeCount: (userId, id) => repo.subtreeCount(id, userId),
    toggleFavorite: async (userId, id) =>
      toDto(await repo.toggleFavorite(id, userId)),
    markViewed: async (userId, id) => toDto(await repo.markViewed(id, userId)),
    read: async (userId, id) => {
      const item = await mustFile(repo, userId, id);
      const guarded = await readTextFileGuarded(diskPathOf(item));
      if (guarded.ok) return { kind: "text", content: guarded.content };
      if (guarded.reason === "too-large") {
        throw new FaceLibraryError("LIBRARY_TOO_LARGE", "超过 512KB 上限");
      }
      if (guarded.reason === "binary") {
        throw new FaceLibraryError("LIBRARY_BINARY", "二进制文件不支持预览");
      }
      throw new FaceLibraryError("LIBRARY_READ_FAILED", "读取失败");
    },
    readImage: (userId, id) => readImageOf(repo, userId, id),
    writeContent: async (userId, id, content) => {
      await mustFile(repo, userId, id);
      // 写守卫：≤512KiB 对齐 read 口径（readTextFileGuarded 同款上限，
      // 超限读不回来——覆写即永久失联，故前置拦截）
      if (Buffer.byteLength(content, "utf8") > 512 * 1024) {
        throw new FaceLibraryError("LIBRARY_TOO_LARGE", "超过 512KB 上限");
      }
      try {
        // 写盘走 repo.writeFileContent 单写路径（桌面编辑器同款：utf8
        // 覆写 + size/updatedAt 刷新一条链）；并发编辑冲突 v1 不做乐观锁，
        // 最后写赢（spec 2026-10-26 §3 风险留档）
        return toDto(await repo.writeFileContent(id, content, userId));
      } catch (error) {
        if (error instanceof FaceLibraryError) throw error;
        throw new FaceLibraryError("LIBRARY_WRITE_FAILED", "写入失败");
      }
    },
    // 资料库上传批（spec 2026-10-26 §1.2）：base64 解码（≤3MB 解码后字节计）
    // → 文件名清洗前置拒 → repo buffer 落盘（源记 "upload"，分类推断在
    // repo）；坏 base64/超 3MB/空名/非法文件名统一 LIBRARY_UPLOAD_INVALID；
    // parentId 归属拒沿用 LIBRARY_NOT_FOUND 口径
    uploadFile: async (userId, payload: LibraryUploadFilePayload) => {
      const buf = decodeBase64Strict(payload.base64);
      if (buf === null) {
        throw new FaceLibraryError("LIBRARY_UPLOAD_INVALID", "base64 不合法");
      }
      if (buf.length > UPLOAD_MAX_BYTES) {
        throw new FaceLibraryError(
          "LIBRARY_UPLOAD_INVALID",
          "文件超过 3MB 上限",
        );
      }
      let name: string;
      try {
        name = sanitizeLibraryName(payload.name);
      } catch {
        throw new FaceLibraryError("LIBRARY_UPLOAD_INVALID", "文件名非法");
      }
      try {
        return toDto(
          await repo.uploadFileBuffer(
            name,
            buf,
            payload.parentId ?? null,
            userId,
          ),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes("条目不存在") ||
          message.includes("上级必须是文件夹")
        ) {
          throw new FaceLibraryError("LIBRARY_NOT_FOUND", "资料库条目不存在");
        }
        // 写盘失败对齐无头端上传面口径（LIBRARY_WRITE_FAILED，不裸抛 5000）
        throw new FaceLibraryError(
          "LIBRARY_WRITE_FAILED",
          `上传写盘失败：${message}`,
        );
      }
    },
  };
}
