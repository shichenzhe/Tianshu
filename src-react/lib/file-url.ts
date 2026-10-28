/**
 * file:// URL 构造（资料库预览与产物面板预览共用）：逐段
 * encodeURIComponent（空格/# 均安全；win32 反斜杠归一为 /，首段盘符
 * （C: 等）原样保留不编码——否则整段被编码成非法 file://C%3A%5C… URL）
 */
export function fileUrlOf(storagePath: string): string {
  return `file://${storagePath
    .split(/[\\/]/)
    .map((segment) =>
      /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment),
    )
    .join("/")}`;
}
