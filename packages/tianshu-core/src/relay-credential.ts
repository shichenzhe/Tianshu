/**
 * relay 凭据续期判断（relay 多租户 spec §5.4）：纯函数零依赖，续期阈值
 * 单源——各端凭据缓存侧以同一阈值决定何时向控制平面换发 access token，
 * 避免各端自行实现漂移。直接消费方（import 本包）：tianshu-server
 * relay-client、mirror 桌面被控面 server-face（renewable-credential）、
 * mirror 桌面控制端 server 域（relay-ak，主进程 alias 直引源码）。
 * 移动端**非直接消费**：@tianshu/core 的 langChain peer 不进 metro
 * bundle（e2e-crypto 同款裁定），双份移植在 apps/tianshu-mobile/
 * src/transport/relay-ak.ts，语义由其测试对本文件源码交叉锁定防漂移。
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
