/**
 * 文件扩展名 → Lucide 图标（产物面板列表/预览共用）
 */
import {
  File,
  FileCode,
  FileImage,
  FileText,
  type LucideIcon,
} from "lucide-react";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const CODE_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".css",
  ".scss",
  ".html",
  ".sh",
  ".yml",
  ".yaml",
  ".toml",
  ".sql",
]);
const DOC_EXT = new Set([".md", ".markdown", ".txt", ".log", ".csv"]);

export function fileIconFor(name: string): LucideIcon {
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot).toLowerCase();
  if (IMAGE_EXT.has(ext)) return FileImage;
  if (CODE_EXT.has(ext)) return FileCode;
  if (DOC_EXT.has(ext)) return FileText;
  return File;
}
