/**
 * 工作空间文件读取（产物面板预览）：纯 Node 实现（禁止 import electron），
 * vitest 可直接测试。路径 resolve 取 fullAccess 语义——绝对路径直接用，
 * 相对以 workspacePath 为基，不做越界拒绝（读操作，路径源自会话内
 * write_file 记录；full access 模式可写工作空间外绝对路径，须放行）。
 * 图片按扩展名先行识别（真实 PNG/JPEG 等普遍含 NUL 字节），
 * NUL 检查仅用于文本候选文件。
 *
 * 双通道差异：本模块服务 workspace:readFile（产物面板预览），fullAccess
 * 语义（绝对路径直接用）；既有 file:readWorkspaceFile（chat.service.ts，
 * AI 工具读取）走 resolveSafePath 沙箱校验，两通道有意不同；后续可将
 * 读取上限/NUL 判定整合进 file-tools.ts。
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

/** 图片按扩展名识别 → base64 dataURL；扩展名未收录返回 null（先于 NUL 检查） */
function toImageContent(
  absPath: string,
  buf: Buffer,
  size: number,
): WorkspaceFileContent | null {
  const mime = IMAGE_MIME[path.extname(absPath).toLowerCase()];
  if (!mime) return null;
  return {
    kind: "image",
    dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
    size,
  };
}

/** 文本候选：含 NUL 字节视为不支持的二进制格式 */
function toTextContent(buf: Buffer, size: number): WorkspaceFileContent {
  if (buf.includes(0)) {
    throw new Error("该格式暂不支持预览，请另存查看");
  }
  return { kind: "text", content: buf.toString("utf8"), size };
}

/** stat/read 失败本地化：ENOENT → 文件不存在；其余（EACCES/EPERM 等）→ 无权读取 */
function localizedReadError(e: unknown): Error {
  if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
    return new Error("文件不存在");
  }
  return new Error("无权读取该文件，请检查文件权限");
}

/** readFile 错误同样本地化（覆盖 stat 通过后的 ENOENT 竞态 / EACCES） */
async function readFileLocalized(absPath: string): Promise<Buffer> {
  try {
    return await fs.readFile(absPath);
  } catch (e) {
    throw localizedReadError(e);
  }
}

export async function readWorkspaceFile(
  absPath: string,
): Promise<WorkspaceFileContent> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(absPath);
  } catch (e) {
    throw localizedReadError(e);
  }
  if (!stat.isFile()) throw new Error("目标是目录，无法预览");
  if (stat.size > READ_LIMIT) throw new Error("文件超过 512KB 预览上限");
  const buf = await readFileLocalized(absPath);
  const image = toImageContent(absPath, buf, stat.size);
  if (image) return image;
  return toTextContent(buf, stat.size);
}
