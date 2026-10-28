/**
 * 工作空间文件读/写（产物面板预览 + 文件窗口保存写回）：纯 Node 实现
 * （禁止 import electron），vitest 可直接测试。路径 resolve 取 fullAccess
 * 语义——绝对路径直接用，相对以 workspacePath 为基，不做越界拒绝
 * （读操作，路径源自会话内 write_file 记录；full access 模式可写工作
 * 空间外绝对路径，须放行；写回同语义——文件窗 tab 路径亦源自产物记录）。
 * 图片按扩展名先行识别（真实 PNG/JPEG 等普遍含 NUL 字节），
 * NUL 检查仅用于文本候选文件。
 *
 * 双通道差异：本模块服务 workspace:readFile（产物面板预览），fullAccess
 * 语义（绝对路径直接用）；既有 file:readWorkspaceFile（chat.service.ts，
 * AI 工具读取）走 resolveSafePath 沙箱校验，两通道有意不同；后续可将
 * 读取上限/NUL 判定整合进 file-tools.ts。
 *
 * 例外：readImageWithinRoot（server-face image 端点）经 appDataHome 解析
 * 数据根，传递引入 electron app——仅调用期解引用，模块加载无副作用
 * （未触达该函数的直测不受影响）。
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { appDataHome } from "../../../commons/paths";
import type { MessageBlock } from "./blocks";

export interface WorkspaceFileContent {
  kind: "text" | "image" | "webview";
  content?: string;
  dataUrl?: string;
  /** webview 类（html/pdf/音视频）：绝对路径（前端拼编码 file:// URL） */
  absPath?: string;
  size: number;
  /** 磁盘 mtime（ms）：文件窗保存的基线冲突检测（spec §5.2） */
  mtime: number;
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/**
 * webview 类扩展名（与资料库预览口径一致）：不读内容（音频/视频/PDF
 * 普遍超 512KB 上限，且无需进渲染进程），stat 校验存在后交 webview
 * 以 file:// 自行加载
 */
const WEBVIEW_EXTS = new Set([
  ".html",
  ".htm",
  ".pdf",
  ".mp3",
  ".wav",
  ".ogg",
  ".m4a",
  ".flac",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
]);

const READ_LIMIT = 512 * 1024;

/** 图片读取上限：10MB（对齐粘贴落盘 pasted-image-store 上限；文本仍 512KB） */
export const IMAGE_READ_LIMIT = 10 * 1024 * 1024;

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
  stat: { size: number; mtimeMs: number },
): WorkspaceFileContent | null {
  const mime = imageMimeOf(absPath);
  if (!mime) return null;
  return {
    kind: "image",
    dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
    size: stat.size,
    mtime: stat.mtimeMs,
  };
}

/** 扩展名 → 图片 mime（未收录返回 undefined；三个图片分支共用） */
function imageMimeOf(absPath: string): string | undefined {
  return IMAGE_MIME[path.extname(absPath).toLowerCase()];
}

/** 文本候选：含 NUL 字节视为不支持的二进制格式 */
function toTextContent(
  buf: Buffer,
  stat: { size: number; mtimeMs: number },
): WorkspaceFileContent {
  if (buf.includes(0)) {
    throw new Error("该格式暂不支持预览，请另存查看");
  }
  return {
    kind: "text",
    content: buf.toString("utf8"),
    size: stat.size,
    mtime: stat.mtimeMs,
  };
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

/**
 * imagePath（相对 rootDir，数据根）→ dataUrl：消息图片块回喂/展示的
 * 读取通道。越出 rootDir（防 ../ 穿越）、超 10MB、未收录格式、读失败
 * 一律返回 null（调用方降级占位，不抛错）
 */
export async function readImageAsDataUrl(
  rootDir: string,
  imagePath: string,
): Promise<string | null> {
  const root = path.resolve(rootDir);
  const abs = path.resolve(root, imagePath);
  if (!abs.startsWith(root + path.sep)) {
    return null;
  }
  const mime = imageMimeOf(abs);
  if (!mime) {
    return null;
  }
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile() || stat.size > IMAGE_READ_LIMIT) {
      return null;
    }
    const buf = await fs.readFile(abs);
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** server-face image 端点扩展名 → mime 白名单（较 IMAGE_MIME 少 svg——
 * 远程面不回传可含脚本的矢量图，其余一律拒绝） */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** 防穿越图片读取（server-face image 端点）：resolve 后必须落在数据根
 * 分组内 + 扩展名 mime 白名单；≤10MB；不可读返回 null（4040 由调用方包装） */
export async function readImageWithinRoot(
  imagePath: string,
): Promise<{ mime: string; dataBase64: string } | null> {
  const root = appDataHome();
  const abs = path.resolve(root, imagePath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return null;
  }
  const ext = path.extname(abs).toLowerCase();
  const mime = IMAGE_MIME_BY_EXT[ext];
  if (!mime) {
    return null;
  }
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile() || stat.size > IMAGE_READ_LIMIT) {
      return null;
    }
    const buf = await fs.readFile(abs);
    return { mime, dataBase64: buf.toString("base64") };
  } catch {
    return null;
  }
}

/**
 * 用户消息图片附件（绝对路径）→ 消息块：subDirs 白名单（数据根下
 * attachments/library——防渲染层传任意路径让模型读任意本地文件）内且
 * 可读（≤10MB、收录格式）→ ImageBlock（imagePath 相对 rootDir，数据根
 * 迁移后仍有效）；其余一律降级占位 text 块（发送不因单图失败而中断）
 */
export async function imageAttachmentBlocks(
  rootDir: string,
  subDirs: string[],
  images: Array<{ absPath: string }>,
): Promise<MessageBlock[]> {
  const root = path.resolve(rootDir);
  const blocks: MessageBlock[] = [];
  for (const image of images) {
    const abs = path.resolve(image.absPath);
    const name = path.basename(abs);
    const allowed = subDirs.some(
      (dir) => abs === dir || abs.startsWith(dir + path.sep),
    );
    const mime = imageMimeOf(abs);
    let block: MessageBlock;
    if (allowed && mime) {
      const dataUrl = await readImageAsDataUrl(root, path.relative(root, abs));
      block = dataUrl
        ? {
            type: "image",
            imagePath: path.relative(root, abs),
            mime,
            name,
          }
        : { type: "text", text: `[图片 ${name} 无法读取]` };
    } else {
      block = { type: "text", text: `[图片 ${name} 无法读取]` };
    }
    blocks.push(block);
  }
  return blocks;
}

/**
 * 白名单外图片收编进 attachments 根（T11 文件窗 workspace 图片附件）：
 * 工作空间目录在数据根外，ImageBlock 的数据根相对路径 + 读回防越根校验
 * （readImageAsDataUrl）会把白名单外的它降级「无法读取」占位——复制进
 * attachments 后新路径天然命中 imageAttachmentBlocks 白名单，ImageBlock
 * 存正常相对路径，展示（file:readMessageImage）与模型回喂（loadImage）
 * 读回通道全兼容。超 10MB/未收录扩展/读失败返回 null（调用方保留原路径
 * → imageAttachmentBlocks 照旧降级占位，发送不中断）。命名同
 * pasted-image-store（时间戳+随机）防碰撞。
 */
export async function stageImageIntoAttachments(
  attachmentsRoot: string,
  absPath: string,
): Promise<string | null> {
  if (!imageMimeOf(absPath)) return null;
  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile() || stat.size > IMAGE_READ_LIMIT) return null;
    await fs.mkdir(attachmentsRoot, { recursive: true });
    const stamp = new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .slice(0, 14);
    const fileName = `ws-${stamp}-${randomBytes(4).toString("hex")}${path
      .extname(absPath)
      .toLowerCase()}`;
    const dest = path.join(attachmentsRoot, fileName);
    await fs.copyFile(absPath, dest);
    return dest;
  } catch {
    return null;
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
  // webview 类：不读内容、不受文本上限（前端 <webview file://> 自行加载）
  if (WEBVIEW_EXTS.has(path.extname(absPath).toLowerCase())) {
    return { kind: "webview", absPath, size: stat.size, mtime: stat.mtimeMs };
  }
  // 图片按扩展名先行放行 10MB 上限（多模态附件通道；文本候选仍 512KB）
  if (imageMimeOf(absPath)) {
    if (stat.size > IMAGE_READ_LIMIT) {
      throw new Error("图片超过 10MB 上限");
    }
    const buf = await readFileLocalized(absPath);
    const image = toImageContent(absPath, buf, stat);
    if (image) return image;
  }
  if (stat.size > READ_LIMIT) throw new Error("文件超过 512KB 预览上限");
  const buf = await readFileLocalized(absPath);
  return toTextContent(buf, stat);
}

/** 用户手动保存（文件窗口）：覆盖写 + mtime 基线冲突检测 + 可选备份 */
export interface WriteWorkspaceFileParams {
  relPath: string;
  content: string;
  /** 加载时磁盘 mtime（ms）；null = 新建/免检 */
  baselineMtime: number | null;
  /** 新建语义（+ 菜单等）：磁盘已有同名文件即拒绝（抛 FILE_EXISTS，
   *  渲染层换名重试）——唯一名探测仅扫本窗 tabs，漏掉磁盘既有文件时
   *  不得静默覆写 */
  expectNotExists?: boolean;
}

export interface WriteWorkspaceFileDeps {
  /** 覆盖前备份（fail-open：失败不阻断写盘） */
  backupFile?: (absPath: string) => Promise<unknown>;
}

/**
 * 文件窗口保存写回（spec 2026-10-14 §5.2）：自动建父目录、覆盖前可选
 * 备份；磁盘 mtime ≠ 基线（外部已改）抛 FILE_CONFLICT（渲染层弹
 * 覆盖/重载确认），返回新 mtime 供渲染层基线更新。新建语义
 * （expectNotExists）：磁盘已有同名文件先抛 FILE_EXISTS（渲染层换名）。
 */
export async function writeWorkspaceFile(
  workspacePath: string,
  params: WriteWorkspaceFileParams,
  deps: WriteWorkspaceFileDeps = {},
): Promise<{ absPath: string; mtime: number }> {
  const target = resolveFilePath(workspacePath, params.relPath);
  const prev = await fs.stat(target).catch(() => null);
  if (prev?.isFile() && params.expectNotExists) {
    throw new Error("FILE_EXISTS");
  }
  if (
    prev?.isFile() &&
    params.baselineMtime !== null &&
    prev.mtimeMs !== params.baselineMtime
  ) {
    throw new Error("FILE_CONFLICT");
  }
  if (prev?.isFile() && deps.backupFile) {
    await deps.backupFile(target).catch(() => undefined); // fail-open
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, params.content, "utf8");
  const mtime = (await fs.stat(target)).mtimeMs;
  return { absPath: target, mtime };
}
