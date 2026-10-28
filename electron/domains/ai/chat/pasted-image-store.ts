/**
 * 粘贴截图落盘（纯 Node 实现，禁止 import electron——vitest 可直测，先例
 * workspace-files.ts）：base64 解码写入 attachments 根（调用方传
 * userData/attachments），文件名 paste-<时间戳>-<随机> 防碰撞，扩展白名单
 * 外归一 png（不信任渲染层文件名，防路径注入）。调用方落盘后经
 * external-file-gate 登记读授权。
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const PASTED_IMAGE_LIMIT_BYTES = 10 * 1024 * 1024;

/** 扩展白名单（剪贴板位图与常见粘贴格式） */
const EXT_WHITELIST = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

function normalizeExt(ext: string): string {
  const lowered = ext.toLowerCase();
  return EXT_WHITELIST.has(lowered) ? lowered : "png";
}

export interface SavePastedImageArgs {
  base64: string;
  ext: string;
  /** 落盘根目录（userData/attachments），不存在自动创建 */
  rootDir: string;
}

/**
 * base64 → 落盘 → 绝对路径。错误标记（渲染层映射 toast）：
 * - PASTED_IMAGE_TOO_LARGE：解码后超 10MB
 * - PASTED_IMAGE_INVALID_BASE64：非法 base64
 */
export async function savePastedImage({
  base64,
  ext,
  rootDir,
}: SavePastedImageArgs): Promise<string> {
  let buffer: Buffer;
  try {
    buffer = Buffer.from(base64, "base64");
  } catch {
    throw new Error("PASTED_IMAGE_INVALID_BASE64");
  }
  if (buffer.length === 0 || buffer.toString("base64") !== base64) {
    throw new Error("PASTED_IMAGE_INVALID_BASE64");
  }
  if (buffer.length > PASTED_IMAGE_LIMIT_BYTES) {
    throw new Error(
      `PASTED_IMAGE_TOO_LARGE: ${buffer.length} > ${PASTED_IMAGE_LIMIT_BYTES}`,
    );
  }
  await fs.mkdir(rootDir, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  const fileName = `paste-${stamp}-${randomBytes(4).toString("hex")}.${normalizeExt(ext)}`;
  const absPath = path.join(rootDir, fileName);
  await fs.writeFile(absPath, buffer);
  return absPath;
}
