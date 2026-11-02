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
 * - TIANSHU_TOKEN 未设置且绑定非 loopback：**拒绝启动**（安全批 S3 升级
 *   fail-closed——原仅告警，无 token 的放行面叠加对外绑定 = 全接口
 *   无鉴权暴露）；loopback 无 token 维持静默放行（本地开发语义）
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
  if (
    token !== undefined &&
    token.length > 0 &&
    token.length < 32 &&
    !isLoopbackAddress(hostname)
  ) {
    // 安全批 F2：非 loopback 部署的 token 最短 32 字符（16hex 随机）——
    // 短 token 在线爆破面；loopback 豁免（本地开发语义）
    throw new Error(
      `[安全拒绝启动] TIANSHU_TOKEN 长度不足（${token.length} < 32 字符）：非 loopback 部署须使用足够强度的 token（openssl rand -hex 32）`,
    );
  }
  if (!token && !isLoopbackAddress(hostname)) {
    // 安全批 S3：告警升级为拒绝启动——StaticTokenGuard/BackupGuard 在
    // 无 token 时的放行面叠加非 loopback 绑定 = 全接口无鉴权对外。
    // 本地开发请绑定 loopback 或显式设置 token
    throw new Error(
      `[安全拒绝启动] TIANSHU_TOKEN 未设置且绑定地址非 loopback（${hostname}）：` +
        '所有接口（含 chat/file/web 工具面与备份面）将以无鉴权状态对外暴露。' +
        '请设置 TIANSHU_TOKEN，或将 config.yml app.hostname 指定为 loopback/内网地址',
    );
  }
}
