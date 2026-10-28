/** 千分位缩写（1234 → 1.2k；<1000 原样）——UsageChip 消费（纯函数独立
 *  便于 node 环境单测：组件链 import react-native 的 Flow 语法在
 *  rolldown 新版下 node 测试环境解析失败） */
export function usageShort(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
