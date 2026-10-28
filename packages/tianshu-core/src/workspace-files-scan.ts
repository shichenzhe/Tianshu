/**
 * workspace 文件扫描 + 守卫读取（FA-T1，spec 2026-10-20 §2/§6 假设 2）：
 * mirror `file:listWorkspaceFiles` 与无头端/桌面 face `files/list|read`
 * 端点同口径消费的共享纯函数——逻辑逐字迁自 mirror chat.service（排除
 * node_modules/.git/dist 与点开头、2000 条上限、相对路径 / 分隔；读取
 * 512KB 上限 + NUL 二进制判定），收编 core 防双份漂移。
 * 纯 node:fs 零 electron 依赖；测试 tests/core/workspace-files-scan.test.ts。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join as joinPath } from "node:path";

const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist"]);
const DEFAULT_MAX_ENTRIES = 2000;

/** workspace 目录相对路径清单（根不存在/中途失败 → 已收集部分不抛） */
export async function listWorkspaceFiles(
  root: string,
  opts: { maxEntries?: number } = {},
): Promise<string[]> {
  const max = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const files: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    if (files.length >= max) {
      return;
    }
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= max) {
        return;
      }
      if (entry.name.startsWith(".")) {
        continue;
      }
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) {
          continue;
        }
        await walk(joinPath(dir, entry.name), rel);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  };
  try {
    await walk(root, "");
  } catch {
    return files;
  }
  return files;
}

const DEFAULT_MAX_BYTES = 512 * 1024;

/** 守卫读取：文本内容 or 结构化拒绝（too-large/binary/read-failed） */
export async function readTextFileGuarded(
  absPath: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<
  | { ok: true; content: string }
  | { ok: false; reason: "too-large" | "binary" | "read-failed" }
> {
  let buf: Buffer;
  try {
    const fileStat = await stat(absPath);
    if (fileStat.size > maxBytes) {
      return { ok: false, reason: "too-large" };
    }
    buf = await readFile(absPath);
  } catch {
    return { ok: false, reason: "read-failed" };
  }
  if (buf.length > maxBytes) {
    return { ok: false, reason: "too-large" };
  }
  if (buf.includes(0)) {
    return { ok: false, reason: "binary" };
  }
  return { ok: true, content: buf.toString("utf8") };
}
