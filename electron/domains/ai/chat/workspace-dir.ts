/**
 * 工作空间目录列举（DetailPanel 工作空间 tab 文件树）：resolveSafePath
 * 沙箱语义（越界拒绝，与 file:readWorkspaceFile 同、非产物预览的
 * fullAccess 语义）；纯 Node 实现（禁止 import electron），照
 * workspace-files.ts 可测先例。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveSafePath } from "../agent/file-tools";

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

/** 单目录上限（防超大目录卡 UI） */
export const LIST_DIR_LIMIT = 2000;

export async function listWorkspaceDir(
  rootDir: string,
  relPath: string,
): Promise<DirEntry[]> {
  const absDir = resolveSafePath(rootDir, relPath, false);
  const dirents = await fs.readdir(absDir, { withFileTypes: true });
  const visible = dirents
    .filter((d) => !d.name.startsWith("."))
    .slice(0, LIST_DIR_LIMIT);
  const stats = await Promise.all(
    visible.map((d) => fs.stat(path.join(absDir, d.name)).catch(() => null)),
  );
  return visible
    .map((d, i) => ({
      name: d.name,
      // symlink 指向目录时 stat 为目录，与展开行为一致
      isDir: stats[i]?.isDirectory() ?? d.isDirectory(),
      size: stats[i]?.size ?? 0,
      mtime: stats[i]?.mtimeMs ?? 0,
    }))
    .sort((a, b) =>
      a.isDir === b.isDir
        ? a.name.localeCompare(b.name, "zh-CN", { numeric: true })
        : a.isDir
          ? -1
          : 1,
    );
}
