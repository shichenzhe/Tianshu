/**
 * 顶层 message + cause 链拼接（SP5 移交，spec §6.1）：undici 策略拒绝的
 * 文案在 error.cause.message（顶层只见 "fetch failed"），解包后调用方
 * 回喂/上抛才能让策略文案对模型与用户可见（SP5 裁定 5 闭环）
 */
export function errorMessageWithCause(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.message];
  let cause: unknown = err.cause;
  const seen = new Set<unknown>([err]);
  while (cause instanceof Error && !seen.has(cause)) {
    parts.push(cause.message);
    seen.add(cause);
    cause = cause.cause;
  }
  return parts.join("：");
}
