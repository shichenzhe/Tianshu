/** 相邻消息时间分隔阈值（微信范式：间隔超 5 分钟插时间戳） */
export const TIME_GAP_MS = 5 * 60 * 1000;

/** 按时间正序的消息 key 集合计算时间分隔标记：首条有效消息必标；
 *  createdAt 缺失/非法（live 流式行）跳过并重置锚点——其后首条有效消息必标 */
export function timeSeparatorKeys(
  items: Array<{ key: string; createdAt?: string }>,
): Set<string> {
  const marks = new Set<string>();
  let prev: number | null = null;
  for (const item of items) {
    const t = Date.parse(item.createdAt ?? "");
    if (Number.isNaN(t)) {
      prev = null;
      continue;
    }
    if (prev === null || t - prev > TIME_GAP_MS) marks.add(item.key);
    prev = t;
  }
  return marks;
}
