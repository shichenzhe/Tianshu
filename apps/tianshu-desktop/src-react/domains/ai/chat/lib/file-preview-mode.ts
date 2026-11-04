/**
 * 产物面板按类型预览的模式判定（对齐资料库 previewModeOf 口径）：
 * md/markdown 走 Markdown 渲染；图片扩展名与后端 dataUrl 通道一致
 * （png/jpg/jpeg/gif/webp/svg）；html/pdf/音视频走 <webview file://>
 *（readFile 返回 kind:"webview" + 绝对路径）；其余按文本尝试（后端
 * NUL/超限检查兜底报错）。路径取扩展名小写，无扩展名归文本
 */
export type FilePreviewMode = "md" | "text" | "image" | "webview";

const MD_EXTS = new Set(["md", "markdown"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const WEBVIEW_EXTS = new Set([
  "html",
  "htm",
  "pdf",
  "mp3",
  "wav",
  "ogg",
  "m4a",
  "flac",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
]);

export function previewModeOfPath(filePath: string): FilePreviewMode {
  const ext = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase();
  if (WEBVIEW_EXTS.has(ext)) return "webview";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (MD_EXTS.has(ext)) return "md";
  return "text";
}
