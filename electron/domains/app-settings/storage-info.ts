/**
 * 存储信息纯函数：目录递归大小（注入 fs 接口可测）与 statfs 字节换算。
 */
import type { Dirent } from "node:fs";
import path from "node:path";

/** 计算目录大小所需的最小 fs 接口（node:fs/promises 结构满足，测试可注入 stub） */
export interface DirSizeFs {
  readdir(dir: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  stat(target: string): Promise<{ size: number }>;
}

/**
 * 目录递归大小（字节）：目录不存在/不可读返回 0；
 * 符号链接既不跟随也不计大小（防死循环，链接自身按 Dirent 非文件非目录跳过）
 */
export async function computeDirSize(
  fsLike: DirSizeFs,
  root: string,
): Promise<number> {
  const total = { bytes: 0 };
  await walkDir(fsLike, root, total);
  return total.bytes;
}

/** 逐条目累计：常规文件计大小，子目录递归，其余（符号链接/FIFO 等）跳过 */
async function walkDir(
  fsLike: DirSizeFs,
  dir: string,
  total: { bytes: number },
): Promise<void> {
  for (const entry of await readEntries(fsLike, dir)) {
    if (entry.isFile()) {
      total.bytes += (await fsLike.stat(path.join(dir, entry.name))).size;
    } else if (entry.isDirectory()) {
      await walkDir(fsLike, path.join(dir, entry.name), total);
    }
  }
}

/** 目录读取失败（不存在/无权限）按空处理：信息面板不因目录缺失而报错 */
async function readEntries(fsLike: DirSizeFs, dir: string): Promise<Dirent[]> {
  try {
    return await fsLike.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** statfs 字节换算：总量 = blocks×bsize，可用 = bavail×bsize（普通用户可用口径） */
export function diskBytesFromStatfs(stats: {
  bsize: number;
  blocks: number;
  bavail: number;
}): { diskTotal: number; diskFree: number } {
  return {
    diskTotal: stats.blocks * stats.bsize,
    diskFree: stats.bavail * stats.bsize,
  };
}
