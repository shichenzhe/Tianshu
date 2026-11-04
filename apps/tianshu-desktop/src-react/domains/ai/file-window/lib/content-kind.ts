/**
 * resource → 内容类型（spec §5.1 路由表：渲染/可编辑/saveStatus 徽标依据；
 * 扩展名分组口径复用 chat 域 previewModeOfPath——图片集 png/jpg/jpeg/
 * gif/webp/svg（终审 I3：删 bmp/ico 对齐，未收录格式回落 text 可编辑），
 * 音视频集合对齐含 m4a/avi）。
 * library 开 tab 时拿不到条目 fileType，一律先落 text（可编辑基线占位）——
 * Task 14 载入条目元数据后经 libraryContentKindOf patchTab 细化，
 * 不发明中间态类型污染 FileWindowContentKind 联合。
 */
import type { FileWindowResource } from "../model/resource";
import type {
  FileWindowContentKind,
  FileWindowSaveStatus,
} from "../store/file-window.store";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
const PDF_EXT = /\.pdf$/i;
const HTML_EXT = /\.(html?|htm)$/i;
const AV_EXT = /\.(mp3|wav|ogg|flac|m4a|mp4|webm|mov|avi|mkv)$/i;
const MD_EXT = /\.(md|markdown)$/i;
const CSV_EXT = /\.csv$/i;

export function contentKindOfResource(
  resource: FileWindowResource,
): FileWindowContentKind {
  // library 占位 text：见文件头注释（Task 14 由 libraryContentKindOf 细化）
  if (resource.kind === "library") return "text";
  const p = resource.path;
  if (MD_EXT.test(p)) return "md";
  if (CSV_EXT.test(p)) return "csv";
  if (IMAGE_EXT.test(p)) return "image";
  if (PDF_EXT.test(p)) return "pdf";
  if (HTML_EXT.test(p)) return "html";
  if (AV_EXT.test(p)) return "audiovideo";
  return "text";
}

/** library 条目按 fileType/mimeType 细化（Task 14 消费；口径同上） */
export function libraryContentKindOf(
  fileType: string | null,
): FileWindowContentKind {
  const ft = (fileType ?? "").toLowerCase();
  if (ft.includes("markdown") || /\.md$/.test(ft)) return "md";
  if (ft.includes("csv")) return "csv";
  if (ft.startsWith("image/")) return "image";
  if (ft === "pdf" || ft.includes("pdf")) return "pdf";
  if (ft.startsWith("text/html")) return "html";
  if (ft.startsWith("audio/") || ft.startsWith("video/")) return "audiovideo";
  return "text";
}

/** 可编辑三类（spec §5.1）：仅它们显示 saveStatus 徽标 */
const EDITABLE_KINDS: readonly FileWindowContentKind[] = ["md", "text", "csv"];

/** 新建/恢复统一按可编辑性定初始 saveStatus：可编辑类 dirty?unsaved:saved，
    只读类恒 hidden（运行态 saving 由保存流 patchTab，不经此函数） */
export function saveStatusOfKind(
  kind: FileWindowContentKind,
  dirty: boolean,
): FileWindowSaveStatus {
  if (!EDITABLE_KINDS.includes(kind)) return "hidden";
  return dirty ? "unsaved" : "saved";
}
