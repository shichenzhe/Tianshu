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
  kind: "folder" | "file";
  fileType: string | null;
  mimeType: string | null;
  size: number | null;
  originalPath: string | null;
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
  search: (keyword: string) =>
    invoke<LibraryItem[]>("library:search", keyword),
  addFiles: (paths: string[], folderId?: number) =>
    invoke<AddFilesResult>("library:addFiles", paths, folderId ?? null),
  createFolder: (name: string, parentId?: number) =>
    invoke<LibraryItem>("library:createFolder", name, parentId ?? null),
  rename: (id: number, name: string) =>
    invoke<LibraryItem>("library:rename", id, name),
  move: (ids: number[], targetParentId?: number) =>
    invoke<null>("library:move", ids, targetParentId ?? null),
  delete: (ids: number[]) => invoke<null>("library:delete", ids),
  revealItem: (id: number) => invoke<null>("library:revealItem", id),
};

export default LibraryApi;
