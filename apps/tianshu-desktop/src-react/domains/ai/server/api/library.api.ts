/**
 * 资料库遥控 API（library 路由化批 2026-11-10）：无头端 library/* 十七
 * 端点 IPC 封装（uploadFile 未接——控制端「添加文件/导入文件夹」为本地
 * 磁盘扫描深水功能，远程态由 library.api.ts 门控，跨端上传挂账）。
 * 消费契约（与 graph.api.ts 同款）：通道返回 {status, body} 全信封，
 * 判错查 body.success；wire 类型为 tianshu-server toLibraryItemDto 出参
 * 的 type-only 同构副本——storagePath/originalPath 为本机绝对路径，
 * 服务端刻意剔除（spec §1.4 ruling：不作远程读取凭证），远程读内容
 * 一律走 read/readImage 按 id 取。
 */
import { requestRemote } from "./server.api";

/** 资料库条目行（LibraryItem 同构副本；storagePath/originalPath 远程态
 * 恒缺席——适配层兜 null，内容读走 read/readImage） */
export interface RemoteLibraryItem {
  id: number;
  parentId: number | null;
  name: string;
  kind: "folder" | "file" | "link";
  fileType: string | null;
  mimeType: string | null;
  size: number | null;
  url: string | null;
  favorite: boolean;
  lastViewedAt: string | null;
  location: string[];
  createdAt: string;
  updatedAt: string;
}

/** library/read 出参（512KiB/NUL 守卫在服务端） */
export interface RemoteLibraryRead {
  kind: "text";
  content: string;
}

/** library/readImage 出参（mime 白名单成员 + base64） */
export interface RemoteLibraryReadImage {
  mime: string;
  dataBase64: string;
}

export default class RemoteLibraryApi {
  static async list(
    parentId: number | null,
    connId: string,
  ): Promise<{ items: RemoteLibraryItem[]; breadcrumbs: RemoteLibraryItem[] }> {
    return requestRemote("server:libraryList", { parentId }, connId);
  }

  static async tree(connId: string): Promise<RemoteLibraryItem[]> {
    return requestRemote("server:libraryTree", {}, connId);
  }

  static async search(
    keyword: string,
    connId: string,
  ): Promise<RemoteLibraryItem[]> {
    return requestRemote("server:librarySearch", { keyword }, connId);
  }

  static async listRecent(connId: string): Promise<RemoteLibraryItem[]> {
    return requestRemote("server:libraryListRecent", {}, connId);
  }

  static async listFavorites(connId: string): Promise<RemoteLibraryItem[]> {
    return requestRemote("server:libraryListFavorites", {}, connId);
  }

  static async createFolder(
    name: string,
    parentId: number | null,
    connId: string,
  ): Promise<RemoteLibraryItem> {
    return requestRemote(
      "server:libraryCreateFolder",
      { name, parentId },
      connId,
    );
  }

  static async createFile(
    name: string,
    parentId: number | null,
    connId: string,
  ): Promise<RemoteLibraryItem> {
    return requestRemote(
      "server:libraryCreateFile",
      { name, parentId },
      connId,
    );
  }

  static async addLink(
    url: string,
    title: string | null,
    parentId: number | null,
    connId: string,
  ): Promise<RemoteLibraryItem> {
    return requestRemote(
      "server:libraryAddLink",
      { url, title, parentId },
      connId,
    );
  }

  static async rename(
    id: number,
    name: string,
    connId: string,
  ): Promise<RemoteLibraryItem> {
    return requestRemote("server:libraryRename", { id, name }, connId);
  }

  static async move(
    ids: number[],
    targetParentId: number | null,
    connId: string,
  ): Promise<null> {
    return requestRemote("server:libraryMove", { ids, targetParentId }, connId);
  }

  static async delete(ids: number[], connId: string): Promise<null> {
    return requestRemote("server:libraryDelete", { ids }, connId);
  }

  static async subtreeCount(id: number, connId: string): Promise<number> {
    return requestRemote("server:librarySubtreeCount", { id }, connId);
  }

  static async toggleFavorite(
    id: number,
    connId: string,
  ): Promise<RemoteLibraryItem> {
    return requestRemote("server:libraryToggleFavorite", { id }, connId);
  }

  static async markViewed(
    id: number,
    connId: string,
  ): Promise<RemoteLibraryItem> {
    return requestRemote("server:libraryMarkViewed", { id }, connId);
  }

  static async read(id: number, connId: string): Promise<RemoteLibraryRead> {
    return requestRemote("server:libraryRead", { id }, connId);
  }

  static async readImage(
    id: number,
    connId: string,
  ): Promise<RemoteLibraryReadImage> {
    return requestRemote("server:libraryReadImage", { id }, connId);
  }

  static async writeContent(
    id: number,
    content: string,
    connId: string,
  ): Promise<RemoteLibraryItem> {
    return requestRemote("server:libraryWriteContent", { id, content }, connId);
  }
}
