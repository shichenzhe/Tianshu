/**
 * relay 凭据续期判断（relay 多租户 spec §5.4）：纯函数零依赖，四端共享
 * 单源（tianshu-server relay-client / 桌面 server-face / 移动端
 * relay-transport / 桌面控制端 transport）——各端凭据缓存侧以同一阈值
 * 决定何时向 relay 换发 access token，避免四端各自实现漂移。
 */

/**
 * 剩余寿命 < 半个 maxAge 即应续期（spec §5.4：剩 <50% 触发）。
 * 严格小于：恰剩 50% 不续；已过期（剩余 ≤ 0）必续。
 */
export function shouldRenew(
  expiresAtMs: number,
  maxAgeSec: number,
  nowMs: number,
): boolean {
  return expiresAtMs - nowMs < maxAgeSec * 500;
}
