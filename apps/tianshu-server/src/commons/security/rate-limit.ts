/**
 * 轻量 IP 退避限流（安全审查 2026-11-02 尾批 F2）：
 * 内存滑动窗计数——不引外部依赖（Redis 等），单进程部署语义足够；
 * 进程重启清零（可接受——攻击者重启窗口收益远小于持续爆破）。
 *
 * 覆盖面：/auth/login 密码爆破、backup/claim 邀请码爆破、token 401
 * 重试。固定窗口（非滑动窗）——实现最简且对爆破场景足够。
 */

interface WindowState {
  count: number;
  resetAt: number;
}

const windows = new Map<string, WindowState>();
/** 简单清理：超过 10k 键时清过期（防内存膨胀） */
function sweepIfNeeded(): void {
  if (windows.size < 10_000) return;
  const now = Date.now();
  for (const [key, w] of windows) {
    if (w.resetAt <= now) windows.delete(key);
  }
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** 剩余重试次数（allowed=true 时有意义） */
  remaining: number;
  /** 窗口重置时间戳 ms（allowed=false 时调用方可回 Retry-After） */
  resetAt: number;
}

/**
 * 消费一次配额：windowMs 内超过 max 次 → 拒绝。
 * key 由调用方组装（如 `login:1.2.3.4`）。
 */
export function consumeRateLimit(
  key: string,
  max: number,
  windowMs: number,
): RateLimitVerdict {
  sweepIfNeeded();
  const now = Date.now();
  const w = windows.get(key);
  if (w === undefined || w.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: max - 1, resetAt: now + windowMs };
  }
  if (w.count >= max) {
    return { allowed: false, remaining: 0, resetAt: w.resetAt };
  }
  w.count += 1;
  return { allowed: true, remaining: max - w.count, resetAt: w.resetAt };
}

/** 测试隔离 */
export function resetRateLimitsForTest(): void {
  windows.clear();
}
