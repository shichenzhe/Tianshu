// readImage 错误码映射（A5 尾富媒体批）：LIBRARY_TOO_LARGE（10MB 上限）
// 与 LIBRARY_BINARY 分别出独立文案，与笼统「图片加载失败」区分；其余码
// 及无码网络错回落 imageFailed。store 抛错时把业务码挂 error.code 上。

/** 从抛错对象取业务码（store readImage/readText 抛错附带 code 字段） */
export function libraryErrorCodeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code !== "" ? code : null;
}

/** 图片预览失败文案 key（library i18n ns） */
export function imageFailureKey(code: string | null): string {
  if (code === "LIBRARY_TOO_LARGE") return "errorTooLarge";
  if (code === "LIBRARY_BINARY") return "errorBinary";
  return "imageFailed";
}

/** 内容写失败文案 key（资料库编辑批）：LIBRARY_TOO_LARGE（512KiB 写守卫）
 *  独立文案，LIBRARY_WRITE_FAILED 与其余无码回落通用保存失败——保存动作
 *  语义单一，未知错无需再细分 */
export function writeFailureKey(code: string | null): string {
  if (code === "LIBRARY_TOO_LARGE") return "errorWriteTooLarge";
  return "errorWriteFailed";
}
