/**
 * 资料库前端纯函数（单测覆盖）：列表排序（folder 恒置前）与类型筛选、
 * 预览分级判定（spec 裁定 6——html/pdf/audio/video 走 webview，md/
 * text/code/image 内联，其余 Finder）、file:// URL 逐段编码、容量格式化。
 */
import type { LibraryItem } from "../api/library.api";

export type SortField = "name" | "updatedAt";

/** 排序：文件夹恒置前，同类按字段升降序（名称本地化比较） */
export function sortItems(
  items: LibraryItem[],
  field: SortField,
  order: "asc" | "desc",
): LibraryItem[] {
  const factor = order === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "folder" ? -1 : 1;
    }
    if (field === "name") {
      return a.name.localeCompare(b.name) * factor;
    }
    return a.updatedAt.localeCompare(b.updatedAt) * factor;
  });
}

/** 类型筛选：命中 fileType 的文件 + 文件夹恒保留；"all" 原样返回 */
export function filterByType(
  items: LibraryItem[],
  fileType: string | "all",
): LibraryItem[] {
  if (fileType === "all") {
    return items;
  }
  return items.filter(
    (item) => item.kind === "folder" || item.fileType === fileType,
  );
}

export type PreviewMode =
  "inline-md" | "inline-image" | "inline-text" | "webview" | "finder";

/** 预览分级：md 看扩展名细类（classifyFileType 归 text），其余看 fileType */
export function previewModeOf(
  item: Pick<LibraryItem, "fileType" | "name">,
): PreviewMode {
  const ext = item.name.slice(item.name.lastIndexOf(".") + 1).toLowerCase();
  switch (item.fileType) {
    case "html":
    case "pdf":
    case "audio":
    case "video":
      return "webview";
    case "image":
      return "inline-image";
    case "text":
      return ext === "md" || ext === "markdown" ? "inline-md" : "inline-text";
    case "code":
      return "inline-text";
    default:
      return "finder";
  }
}

/** file:// URL：逐段 encodeURIComponent（空格/# 均安全） */
export function fileUrlOf(storagePath: string): string {
  return `file://${storagePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

/** 容量格式化：B/KB/MB/GB（一位小数，≥1 才带小数）；null → "—" */
export function formatSize(bytes: number | null): string {
  if (bytes === null) {
    return "—";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}
