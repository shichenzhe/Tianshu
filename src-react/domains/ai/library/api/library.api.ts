/**
 * 资料库 IPC 封装与数据契约（类型被后端 library.repo.ts 反向 import，
 * skill.api.ts 先例）。storagePath 为文件专用绝对路径，发送侧注入
 * （file:readExternalFile）直接消费；folder 恒为 null。
 */
import { invoke } from "@/lib/ipc";

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

const LibraryApi = {
  list: (parentId?: number) =>
    invoke<{ items: LibraryItem[]; breadcrumbs: LibraryItem[] }>(
      "library:list",
      parentId ?? null,
    ),
  search: (keyword: string) => invoke<LibraryItem[]>("library:search", keyword),
  addFiles: (paths: string[], folderId?: number) =>
    invoke<AddFilesResult>("library:addFiles", paths, folderId ?? null),
  createFolder: (name: string, parentId?: number) =>
    invoke<LibraryItem>("library:createFolder", name, parentId ?? null),
  createFile: (name: string, folderId?: number) =>
    invoke<LibraryItem>("library:createFile", name, folderId ?? null),
  importFolder: (dirPath: string, parentId?: number) =>
    invoke<AddFilesResult>("library:importFolder", dirPath, parentId ?? null),
  addLink: (url: string, title: string | null, folderId?: number) =>
    invoke<LibraryItem>("library:addLink", url, title, folderId ?? null),
  openLink: (id: number) => invoke<null>("library:openLink", id),
  rename: (id: number, name: string) =>
    invoke<LibraryItem>("library:rename", id, name),
  move: (ids: number[], targetParentId?: number) =>
    invoke<null>("library:move", ids, targetParentId ?? null),
  delete: (ids: number[]) => invoke<null>("library:delete", ids),
  revealItem: (id: number) => invoke<null>("library:revealItem", id),
  subtreeCount: (id: number) => invoke<number>("library:subtreeCount", id),
  /** 全量条目平铺（folder+file+link；树形栏数据源，前端组嵌套树） */
  tree: () => invoke<LibraryItem[]>("library:tree"),
  writeFileContent: (id: number, content: string) =>
    invoke<LibraryItem>("library:writeFileContent", id, content),
  toggleFavorite: (id: number) =>
    invoke<LibraryItem>("library:toggleFavorite", id),
  markViewed: (id: number) => invoke<LibraryItem>("library:markViewed", id),
  listRecent: () => invoke<LibraryItem[]>("library:listRecent"),
  listFavorites: () => invoke<LibraryItem[]>("library:listFavorites"),
};

export default LibraryApi;
