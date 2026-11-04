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
 * 目录递归大小（字节）：目录不存在/不可读返回 0；遍历中单文件 stat 失败
 * （删除竞态/无权限）按 0 跳过不连坐；符号链接既不跟随也不计大小
 * （防死循环，链接自身按 Dirent 非文件非目录跳过）
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
      total.bytes += await fileSizeOrZero(fsLike, path.join(dir, entry.name));
    } else if (entry.isDirectory()) {
      await walkDir(fsLike, path.join(dir, entry.name), total);
    }
  }
}

/** 单文件大小：stat 失败（遍历竞态中被删/无权限）按 0 计，不连坐整个统计 */
async function fileSizeOrZero(
  fsLike: DirSizeFs,
  file: string,
): Promise<number> {
  try {
    return (await fsLike.stat(file)).size;
  } catch {
    return 0;
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
