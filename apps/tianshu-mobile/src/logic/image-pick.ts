/**
 * 图片链（MB-T1，spec 2026-10-20 §2.1；融合批 2026-10-22 收敛单入口）：
 * uri → 压缩（超限自动降质/缩尺寸）→ base64 → 3MB 预检（relay 单帧
 * 余量——与桌面/被控端 uploadImage 上限同值）。上传与发送由
 * stream.store.startSend 消费（发送时上传，选图仅暂存——对齐桌面 FA
 * 口径：弃发不浪费上传）。入口统一为上传文件选择器的图片分流
 * （原独立选图器入口已并入 file-pick）。
 */
import * as ImageManipulator from "expo-image-manipulator";

import { blobToBase64, fetchBlob } from "./file-read";

export const IMAGE_LIMIT_BYTES = 3 * 1024 * 1024;

export class ImageTooLargeError extends Error {
  constructor() {
    super("图片超过 3MB 上限（远程主机链路）");
  }
}

/** base64 解码后字节估算（4/3 折算减 padding） */
export function decodedBytesOf(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export function assertWithinLimit(byteSize: number): void {
  if (byteSize > IMAGE_LIMIT_BYTES) throw new ImageTooLargeError();
}

/** 超限自动压缩（真机反馈：期望压缩而非报错）：先降质量再缩尺寸，两轮
 *  仍超限才抛错。压缩经 ImageManipulator 重编码（本地文件，不涉网络） */
async function compressToLimit(uri: string): Promise<string> {
  let current = uri;
  for (const step of [
    { compress: 0.5 },
    { compress: 0.3 },
    { compress: 0.3, maxWidth: 1600 },
    { compress: 0.2, maxWidth: 1200 },
  ]) {
    const out = await ImageManipulator.manipulateAsync(
      current,
      step.maxWidth ? [{ resize: { width: step.maxWidth } }] : [],
      { compress: step.compress, format: ImageManipulator.SaveFormat.JPEG },
    );
    current = out.uri;
    if ((await fetchBlob(current)).size <= IMAGE_LIMIT_BYTES) {
      return current;
    }
  }
  return current; // 尽力压缩后仍超限，由调用方判最终大小
}

/** uri → base64（超限自动压缩 + 3MB 预检 + 名字规整 .jpg）：
 *  选图器链与上传文件分流链共用（融合批 2026-10-22——document picker
 *  选中的图片文件走同款压缩/上限语义）；超限抛 ImageTooLargeError */
export async function imageUriAsBase64(
  uri: string,
  fallbackName: string,
): Promise<{ name: string; base64: string }> {
  // 读取原语为 RN 内建 fetch+blob（真机修复 2026-10-24，见 file-read.ts）
  let blob = await fetchBlob(uri);
  // 超限自动压缩（压缩后统一转 JPEG 名，避免原格式扩展名与内容不符）
  if (blob.size > IMAGE_LIMIT_BYTES) {
    const compressed = await compressToLimit(uri);
    blob = await fetchBlob(compressed);
  }
  assertWithinLimit(blob.size);
  const base64 = await blobToBase64(blob);
  const name = fallbackName.replace(/\.[^.]+$/, "") + ".jpg";
  return { name, base64 };
}
