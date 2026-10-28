/** 指数退避：1s × 2^attempt，封顶 30s（mirror transports 同款语义） */
export function nextBackoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}
