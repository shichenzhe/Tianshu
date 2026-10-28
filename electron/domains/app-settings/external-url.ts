/**
 * openExternal 白名单（纯函数，不依赖 electron 可直测）：
 * 仅放行系统通知授权设置页 scheme，防渲染层借通道任意跳转。
 */

/** 允许打开的地址前缀（macOS 系统偏好设置 / Windows 系统设置-通知；
 * Windows 前缀不带尾冒号，使 startsWith 同时放行 ms-settings:notifications
 * 与 ms-settings:notifications:sound 两种形式） */
const ALLOWED_URL_PREFIXES: readonly string[] = [
  "x-apple.systempreferences:com.apple.preference.notifications",
  "ms-settings:notifications",
];

/** 白名单前缀校验：非字符串/空串/任意 http(s)、文件协议等一律拒绝 */
export function isOpenExternalAllowed(url: unknown): boolean {
  if (typeof url !== "string" || url === "") {
    return false;
  }
  return ALLOWED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}
