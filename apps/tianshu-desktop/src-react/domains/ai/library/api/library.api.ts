/**
 * 资料库 IPC 封装与数据契约（类型被后端 library.repo.ts 反向 import，
 * skill.api.ts 先例）。storagePath 为文件专用绝对路径，发送侧注入
 * （file:readExternalFile）直接消费；folder 恒为 null。
 *
 * 主机路由化（automation/library 批 2026-11-10）：结构 CRUD + 收藏/打点
 * + 内容读写（writeContent/read/readImage）远程态经 remote-catalog 适配
 * 器走无头端 library 端点——远程行 storagePath/originalPath 恒 null
 * （server wire 刻意剔除，spec §1.4），预览与附件读内容走 readContent/
 * readImageDataUrl（按 id，本地链维持 readExternalFile 直读）。addFiles/
 * importFolder 远程态走主进程组合通道跨端上传（挂账收口）；深水功能门控
 * （本地磁盘语义，远程态显式拒绝防静默错位）：revealItem（Finder 定位
 * 远端服务器路径无意义）；openLink 由 LibraryView 调用点远程态改走
 * browser:openExternal（行内已有 url，无需回库）。
 */
import { invoke } from "@/lib/ipc";
import { routeInvoke, remoteConnId } from "@/domains/ai/data-source/host-route";
import {
  remoteLibraryAddFiles,
  remoteLibraryAddLink,
  remoteLibraryCreateFile,
  remoteLibraryCreateFolder,
  remoteLibraryDelete,
  remoteLibraryImportFolder,
  remoteLibraryList,
  remoteLibraryListFavorites,
  remoteLibraryListRecent,
  remoteLibraryMarkViewed,
  remoteLibraryMove,
  remoteLibraryRename,
  remoteLibrarySearch,
  remoteLibrarySubtreeCount,
  remoteLibraryToggleFavorite,
  remoteLibraryTree,
  remoteLibraryWriteContent,
} from "@/domains/ai/data-source/remote-catalog";

export interface LibraryItem {
  id: number;
  parentId: number | null;
  name: string;
  kind: "folder" | "file" | "link";
  fileType: string | null;
  mimeType: string | null;
  size: number | null;
  originalPath: string | null;
  /** 链接条目（kind=link）的目标地址；文件/文件夹恒 null */
  url: string | null;
  favorite: boolean;
  lastViewedAt: string | null;
  /** 祖代文件夹名（根→父）；根层为 []；单条出口（create/rename 等）恒 [] */
  location: string[];
  storagePath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AddFilesResult {
  added: LibraryItem[];
  failed: Array<{ path: string; reason: string }>;
}

/** 远程态深水功能门控（统一文案出口——i18n 由 toast 层消费 Error message；
 *  orchestration.api.ts rejectOnRemote 同款先例） */
function rejectOnRemote(feature: string): void {
  if (remoteConnId() != null) {
    throw new Error(`远程主机暂不支持${feature}（本功能仅本机可用）`);
  }
}

const LibraryApi = {
  list: (parentId?: number) =>
    routeInvoke(
      { ch: "library:list", args: [parentId ?? null] },
      (connId) => remoteLibraryList(parentId, connId),
    ),
  search: (keyword: string) =>
    routeInvoke({ ch: "library:search", args: [keyword] }, (connId) =>
      remoteLibrarySearch(keyword, connId),
    ),
  /** 本地磁盘路径批量入库（扫描+拷贝数据根）；远程态经主进程组合通道
   *  上传远端（授权门+3MB+uploadFile 逐个，挂账收口 2026-11-10） */
  addFiles: async (paths: string[], folderId?: number) => {
    return routeInvoke<AddFilesResult>(
      { ch: "library:addFiles", args: [paths, folderId ?? null] },
      (connId) => remoteLibraryAddFiles(paths, folderId, connId),
    );
  },
  createFolder: (name: string, parentId?: number) =>
    routeInvoke(
      { ch: "library:createFolder", args: [name, parentId ?? null] },
      (connId) => remoteLibraryCreateFolder(name, parentId, connId),
    ),
  createFile: (name: string, folderId?: number) =>
    routeInvoke(
      { ch: "library:createFile", args: [name, folderId ?? null] },
      (connId) => remoteLibraryCreateFile(name, folderId, connId),
    ),
  /** 本地目录递归导入；远程态走主进程组合通道（递归建层+逐文件上传，
   *  同构本地 importFolder 语义，挂账收口 2026-11-11） */
  importFolder: async (dirPath: string, parentId?: number) => {
    return routeInvoke<AddFilesResult>(
      { ch: "library:importFolder", args: [dirPath, parentId ?? null] },
      (connId) => remoteLibraryImportFolder(dirPath, parentId, connId),
    );
  },
  addLink: (url: string, title: string | null, folderId?: number) =>
    routeInvoke(
      { ch: "library:addLink", args: [url, title, folderId ?? null] },
      (connId) => remoteLibraryAddLink(url, title, folderId, connId),
    ),
  openLink: (id: number) => invoke<null>("library:openLink", id),
  rename: (id: number, name: string) =>
    routeInvoke({ ch: "library:rename", args: [id, name] }, (connId) =>
      remoteLibraryRename(id, name, connId),
    ),
  move: (ids: number[], targetParentId?: number) =>
    routeInvoke(
      { ch: "library:move", args: [ids, targetParentId ?? null] },
      (connId) => remoteLibraryMove(ids, targetParentId, connId),
    ),
  delete: (ids: number[]) =>
    routeInvoke({ ch: "library:delete", args: [ids] }, (connId) =>
      remoteLibraryDelete(ids, connId),
    ),
  /** Finder 定位（本地 shell.showItemInFolder）——远程态门控：条目在
   *  远端服务器磁盘，控制端 Finder 无从定位 */
  revealItem: async (id: number) => {
    rejectOnRemote("在访达中显示");
    return invoke<null>("library:revealItem", id);
  },
  subtreeCount: (id: number) =>
    routeInvoke({ ch: "library:subtreeCount", args: [id] }, (connId) =>
      remoteLibrarySubtreeCount(id, connId),
    ),
  /** 全量条目平铺（folder+file+link；树形栏数据源，前端组嵌套树） */
  tree: () =>
    routeInvoke({ ch: "library:tree", args: [] }, (connId) =>
      remoteLibraryTree(connId),
    ),
  writeFileContent: (id: number, content: string) =>
    routeInvoke(
      { ch: "library:writeFileContent", args: [id, content] },
      (connId) => remoteLibraryWriteContent(id, content, connId),
    ),
  toggleFavorite: (id: number) =>
    routeInvoke({ ch: "library:toggleFavorite", args: [id] }, (connId) =>
      remoteLibraryToggleFavorite(id, connId),
    ),
  markViewed: (id: number) =>
    routeInvoke({ ch: "library:markViewed", args: [id] }, (connId) =>
      remoteLibraryMarkViewed(id, connId),
    ),
  listRecent: () =>
    routeInvoke({ ch: "library:listRecent", args: [] }, (connId) =>
      remoteLibraryListRecent(connId),
    ),
  listFavorites: () =>
    routeInvoke({ ch: "library:listFavorites", args: [] }, (connId) =>
      remoteLibraryListFavorites(connId),
    ),
};

export default LibraryApi;
