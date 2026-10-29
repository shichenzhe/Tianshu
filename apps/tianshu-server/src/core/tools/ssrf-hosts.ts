/**
 * SSRF 封锁清单（自 mirror electron/domains/security/ssrf-hosts.ts 逐字移植）：
 * agent fetch 消费；云 metadata 端点对齐 WorkBuddy。
 */
const HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.azure.com',
]);

export const SSRF_HOSTS: ReadonlySet<string> = HOSTS;

export function isSsrfHost(hostname: string): boolean {
  return HOSTS.has(hostname.toLowerCase());
}
