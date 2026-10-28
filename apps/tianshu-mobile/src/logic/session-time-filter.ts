/**
 * 会话时间筛选阈值计算（A11 批）——与桌面
 * src-react/domains/ai/chat/lib/session-list.ts（filterSessionsByTime）
 * 同口径：滚动窗非自然周月（today=本机今日 00:00；week/month 自当日
 * 00:00 回溯 7/30 天），阈值含边界（服务端按 活动时间 >= 阈值 过滤）。
 * 改算法必须双改（两端 UI 结果须一致）。
 */

/** 时间筛选维度（对齐桌面 FilterPopover：all/today/week/month） */
export type SessionTimeFilter = "all" | "today" | "week" | "month";

/** 一天的毫秒数（滚动窗步进） */
const DAY_MS = 86400000;

/**
 * 计算 session/query 的 activityAfter 阈值（ISO 串）。
 * all → null（不出键）；其余按桌面同口径算本机滚动窗起点：
 * 当日 00:00（new Date(y, m, d) 本地时区构造）回溯 days 天。
 * 时区陷阱：阈值必须由客户端按本机时区算好上送，服务端时区不可信。
 */
export function computeActivityAfter(
  range: SessionTimeFilter,
  now: Date = new Date(),
): string | null {
  if (range === "all") {
    return null;
  }
  const days = range === "today" ? 0 : range === "week" ? 7 : 30;
  const startOfDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  return new Date(startOfDay - days * DAY_MS).toISOString();
}
