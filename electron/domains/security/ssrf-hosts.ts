/**
 * SSRF 封锁清单（云 metadata 端点，对齐 WorkBuddy）：内置浏览器请求门
 * （browser-session）与 agent fetch 共用；提取公共模块防两处清单漂移。
 */
const HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.azure.com",
]);

export const SSRF_HOSTS: ReadonlySet<string> = HOSTS;

export function isSsrfHost(hostname: string): boolean {
  return HOSTS.has(hostname.toLowerCase());
}
