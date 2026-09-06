/**
 * 工作空间文件读取（产物面板预览）：纯 Node 实现（禁止 import electron），
 * vitest 可直接测试。路径 resolve 取 fullAccess 语义——绝对路径直接用，
 * 相对以 workspacePath 为基，不做越界拒绝（读操作，路径源自会话内
 * write_file 记录；full access 模式可写工作空间外绝对路径，须放行）。
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface WorkspaceFileContent {
  kind: "text" | "image";
  content?: string;
  dataUrl?: string;
  size: number;
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const READ_LIMIT = 512 * 1024;

export function resolveFilePath(
  workspacePath: string,
  relPath: string,
): string {
  return path.isAbsolute(relPath)
    ? path.resolve(relPath)
    : path.resolve(workspacePath, relPath);
}

export async function readWorkspaceFile(
  absPath: string,
): Promise<WorkspaceFileContent> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(absPath);
  } catch {
    throw new Error("文件不存在");
  }
  if (!stat.isFile()) throw new Error("目标是目录，无法预览");
  if (stat.size > READ_LIMIT) throw new Error("文件超过 512KB 预览上限");
  const buf = await fs.readFile(absPath);
  if (buf.includes(0)) {
    throw new Error("该格式暂不支持预览，请另存查看");
  }
  const ext = path.extname(absPath).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (mime) {
    return {
      kind: "image",
      dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
      size: stat.size,
    };
  }
  return { kind: "text", content: buf.toString("utf8"), size: stat.size };
}
