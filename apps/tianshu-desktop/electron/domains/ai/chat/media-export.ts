/**
 * dataUrl 图片另存为（纯 Node 实现，禁止 import electron——vitest 可直测，
 * 先例 pasted-image-store.ts）：mime 白名单 + base64 回验 + 10MB 上限；
 * 默认文件名只保留 basename 并强制 mime 扩展（不信任渲染层文件名，防
 * 路径注入与名实不符），用户在保存对话框自选的路径尊重原值、仅在无
 * 扩展时补齐。调用方负责 showSaveDialog（本模块不碰 electron API）。
 */
import fs from "node:fs/promises";
import path from "node:path";

export const IMAGE_SAVE_LIMIT_BYTES = 10 * 1024 * 1024;

/** mime 白名单 → 扩展（svg 不放行：聊天图片/截图/mermaid 导出均位图，
 * 收紧矢量脚本面） */
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export interface ParsedImageDataUrl {
  mime: string;
  buffer: Buffer;
  /** 白名单扩展（png/jpg/webp/gif） */
  ext: string;
}

/**
 * 校验并解码 dataUrl。错误标记（渲染层映射 toast）：
 * - IMAGE_DATAURL_INVALID：格式非法 / 非法 base64 / 空字节
 * - IMAGE_DATAURL_MIME_REJECTED：mime 不在白名单
 * - IMAGE_DATAURL_TOO_LARGE：解码后超 10MB
 */
export function parseImageDataUrl(dataUrl: string): ParsedImageDataUrl {
  const match = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    throw new Error("IMAGE_DATAURL_INVALID");
  }
  const [, mime, base64] = match;
  const ext = MIME_EXT[mime];
  if (!ext) {
    throw new Error(`IMAGE_DATAURL_MIME_REJECTED: ${mime}`);
  }
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length === 0 || buffer.toString("base64") !== base64) {
    throw new Error("IMAGE_DATAURL_INVALID");
  }
  if (buffer.length > IMAGE_SAVE_LIMIT_BYTES) {
    throw new Error(
      `IMAGE_DATAURL_TOO_LARGE: ${buffer.length} > ${IMAGE_SAVE_LIMIT_BYTES}`,
    );
  }
  return { mime, buffer, ext };
}

/** 默认文件名清洗：只保留 basename，剔除跨平台非法字符，一律改写为
 * mime 扩展（防目录注入） */
export function sanitizeSaveName(defaultName: string, ext: string): string {
  const raw = path
    .basename((defaultName ?? "").trim())
    // eslint-disable-next-line no-control-regex -- \x00 有意：文件名清 NUL（工具写盘 NUL 泄漏防线）
    .replace(/[\\/:*?"<>|\x00]/g, "");
  const stem = raw.replace(/\.[^.]*$/, "");
  return `${stem || "image"}.${ext}`;
}

/** 写盘：target 无扩展时按 mime 补齐；目录不存在自动创建；返回最终路径 */
export async function saveImageDataUrl(
  dataUrl: string,
  target: string,
): Promise<string> {
  const { buffer, ext } = parseImageDataUrl(dataUrl);
  const finalPath = path.extname(target) ? target : `${target}.${ext}`;
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, buffer);
  return finalPath;
}
