// 资料库预览分流（A5 尾富媒体批）：行点击 → 预览载体纯路由。按扩展名
// 前置分流（大小写不敏感）——svg 走 readImage + WebView data URL；bmp/ico
// 前置拦「请在桌面端预览」不发请求；png/jpg/jpeg/webp/gif 走既有 RN Image；
// html/htm 并入 FilePreviewModal 既有 WebView 分支（文本类口径）；csv 路由
// 到纯客户端表格预览。folder/link 由调用方先行截走，此处防御性归 desktop。

import type { LibraryItemDto } from "@tianshu/protocol";

/** RN Image 直渲染五型（与服务端 readImage 白名单同口径） */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

/** 文本类 fileType（对齐桌面 previewModeOf 口径）：FilePreviewModal */
export const TEXT_FILE_TYPES = new Set(["markdown", "text", "code"]);

export type LibraryPreviewRoute =
  | { kind: "text" } // FilePreviewModal（markdown/text/code/html）
  | { kind: "csv" } // CSV 只读表格预览（纯客户端解析 library/read）
  | { kind: "image" } // RN Image 五型
  | { kind: "svg" } // readImage → WebView data URL
  | { kind: "desktop" }; // bmp/ico 及其它：请在桌面端预览

/** 小写扩展名（无扩展名/点文件返回 ""） */
export function extensionOf(name: string): string {
  const trimmed = name.trim();
  const dot = trimmed.lastIndexOf(".");
  if (dot <= 0) return "";
  return trimmed.slice(dot + 1).toLowerCase();
}

/** 预览载体路由：kind/fileType/name → 五种载体之一（纯函数，可测） */
export function previewRouteOf(
  item: Pick<LibraryItemDto, "kind" | "fileType" | "name">,
): LibraryPreviewRoute {
  if (item.kind !== "file") return { kind: "desktop" };
  const ext = extensionOf(item.name);
  if (item.fileType === "image") {
    if (ext === "svg") return { kind: "svg" };
    if (IMAGE_EXTENSIONS.has(ext)) return { kind: "image" };
    // bmp/ico 及未知图片型：RN 跨平台支持差，前置拦截不发 readImage
    return { kind: "desktop" };
  }
  if (ext === "csv") return { kind: "csv" };
  if (ext === "html" || ext === "htm") return { kind: "text" };
  if (item.fileType && TEXT_FILE_TYPES.has(item.fileType)) {
    return { kind: "text" };
  }
  return { kind: "desktop" };
}
