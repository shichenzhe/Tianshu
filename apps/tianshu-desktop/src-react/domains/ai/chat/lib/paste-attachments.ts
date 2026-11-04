// src-react/domains/ai/chat/lib/paste-attachments.ts
/**
 * 粘贴附件分流纯函数（WorkBuddy 剪贴板工程经验移植，spec 2026-10-10）：
 * - Finder 复制的文件经 preload filePath.getPathForFile 解出磁盘路径（授权
 *   随解自动登记），复用资料库 pill 同链路（readExternalFile 读取注入）
 * - 截图等无路径图片 blob 钉字节转 base64 交主进程落盘 attachments/
 * - macOS 截图坑：剪贴板会出现 size-0 图片 File（getAsFile 拿不到字节），
 *   须走主进程 clipboard.readImage 兜底
 * - 有文件才 preventDefault，纯文本粘贴零干扰
 */
export const PASTED_IMAGE_LIMIT_BYTES = 10 * 1024 * 1024;

/** 粘贴附件 pill 项（与资料库 pill 同构：name 展示 / path 读取注入） */
export interface PastedFileEntry {
  name: string;
  path: string;
  /** FA-T3 远程图片链：blob 字节 base64 暂存（远程主机不落控制端盘，
   *  发送时经 files/uploadImage 上传；本地链缺省走 path 落盘链） */
  base64?: string;
}

/** DataTransfer.items 只收 kind=file 项（文本项忽略；getAsFile 空项跳过） */
export function collectPasteFiles(items: DataTransferItemList): File[] {
  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") {
      continue;
    }
    const file = item.getAsFile();
    if (file) {
      files.push(file);
    }
  }
  return files;
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

/** 解码后超 10MB 拒绝（与 HTTP 节点 binary 上限同口径） */
export function isOverLimit(byteSize: number): boolean {
  return byteSize > PASTED_IMAGE_LIMIT_BYTES;
}

/** 粘贴分流：有路径 → pathEntries；无路径图片 → imageBlobs；size-0 图片
 *  → needsClipboardFallback（主进程 clipboard.readImage 兜底）。
 *  resolvePath 接 preload 桥——File 必须原样传递（JS 构造的 File 经
 *  webUtils.getPathForFile 解出空串，先克隆会丢路径） */
export function categorizePastedFiles(
  files: File[],
  resolvePath: (file: File) => string,
): {
  pathEntries: PastedFileEntry[];
  imageBlobs: File[];
  needsClipboardFallback: boolean;
} {
  const pathEntries: PastedFileEntry[] = [];
  const imageBlobs: File[] = [];
  let needsClipboardFallback = false;
  for (const file of files) {
    const path = resolvePath(file);
    if (path !== "") {
      pathEntries.push({ name: file.name, path });
      continue;
    }
    if (!isImageFile(file)) {
      continue; // 无路径非图片（内部合成 blob）无通道，忽略
    }
    if (file.size === 0) {
      needsClipboardFallback = true; // macOS size-0 坑
      continue;
    }
    imageBlobs.push(file);
  }
  return { pathEntries, imageBlobs, needsClipboardFallback };
}

/** blob → 无前缀 base64（IPC 直传主进程落盘；钉住字节防事件返回后失效） */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  let binary = "";
  for (const byte of new Uint8Array(buffer)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
