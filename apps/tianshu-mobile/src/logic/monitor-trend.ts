interface TrendTokenPoint {
  inputTokens: number;
  outputTokens: number;
}

/** 趋势双柱高度：整个窗口共用一个 token 峰值，零值/小值以 2px 保持可见。 */
export function trendBarHeights(
  trend: TrendTokenPoint[],
  maxHeight: number,
): Array<{ input: number; output: number }> {
  const peak = Math.max(
    0,
    ...trend.flatMap((point) => [point.inputTokens, point.outputTokens]),
  );
  const scale = peak > 0 ? maxHeight / peak : 0;
  return trend.map((point) => ({
    input: Math.max(2, point.inputTokens * scale),
    output: Math.max(2, point.outputTokens * scale),
  }));
}
