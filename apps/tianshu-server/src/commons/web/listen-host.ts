/**
 * HTTP 监听地址解析与启动安全告警（终审必修 3）。
 * main.ts 启动期调用；判定函数独立成模块以便单测（main.ts 顶层即 bootstrap
 * 不可导入）。告警口径与 main.ts 的 JWT 占位符告警同款（[安全告警] 前缀）。
 */

/** HTTP 监听地址缺省值（沿用历史行为：绑定所有网卡） */
export const DEFAULT_LISTEN_HOSTNAME = '0.0.0.0';

/**
 * 解析监听地址：config app.hostname（可空白视为未设置），缺省 0.0.0.0
 * （spec §4 的 --hostname CLI 留二期，config 口径先行）
 */
export function resolveListenHostname(configHostname?: string): string {
  const trimmed = configHostname?.trim();
  return trimmed ? trimmed : DEFAULT_LISTEN_HOSTNAME;
}

/** 通配地址：监听所有网卡（IPv4/IPv6 any），公网/局域网可达 */
export function isWildcardAddress(hostname: string): boolean {
  return hostname === '0.0.0.0' || hostname === '::';
}

/** loopback 地址：仅本机可达（本地开发无 token 静默放行的前提） */
export function isLoopbackAddress(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname.startsWith('127.')
  );
}

/**
 * 监听安全告警（warn 回调注入以便测试）：
 * - 通配绑定（0.0.0.0/::）：公网暴露提示（有 token 也提示，绑定面本身值得知晓）
 * - TIANSHU_TOKEN 未设置且绑定非 loopback：全部接口（chat/file/web 工具面）
 *   无鉴权暴露；loopback 无 token 维持静默放行（本地开发语义）
 */
export function emitListenSecurityWarnings(
  hostname: string,
  token: string | undefined,
  warn: (message: string) => void,
): void {
  if (isWildcardAddress(hostname)) {
    warn(
      '[安全告警] HTTP 服务绑定 0.0.0.0/::（监听所有网卡），局域网/公网可达：' +
        '请确认防火墙与 TIANSHU_TOKEN 已设置，或将 config.yml app.hostname 指定为内网/回环地址',
    );
  }
  if (!token && !isLoopbackAddress(hostname)) {
    warn(
      '[安全告警] TIANSHU_TOKEN 未设置且绑定地址非 loopback：' +
        '所有接口（含 chat/file/web 工具面）处于无鉴权暴露状态，请设置 TIANSHU_TOKEN',
    );
  }
}
