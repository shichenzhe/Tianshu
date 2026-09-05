/**
 * 标准侧边栏任务列表的排序与时间筛选（纯函数，ISO 串字典序即时间序）
 */

/** 时间筛选维度（顶栏筛选 Popover） */
export type TimeFilter = "all" | "today" | "week" | "month";

export interface SessionTimeFields {
  pinnedAt?: string;
  lastMessageAt?: string;
  updatedAt: string;
}

/** 任务排序：置顶（pinnedAt 倒序）在前；其余有消息的按 lastMessageAt 倒序，从未有消息的沉底 */
export function sortSessions<T extends SessionTimeFields>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => {
    const pinnedDiff = (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? "");
    if (pinnedDiff !== 0) {
      return pinnedDiff;
    }
    if (!a.lastMessageAt || !b.lastMessageAt) {
      if (a.lastMessageAt) return -1;
      if (b.lastMessageAt) return 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    }
    return b.lastMessageAt.localeCompare(a.lastMessageAt);
  });
}

/** 当日 00:00（UTC）时间戳（筛选阈值基准，跨时区结果稳定） */
function startOfDay(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** 时间筛选：today 含当日 00:00 整；week/month 不含第 N 天前 00:00 整的边界 */
export function filterSessionsByTime<T extends SessionTimeFields>(
  sessions: T[],
  filter: TimeFilter,
  now = new Date(),
): T[] {
  if (filter === "all") {
    return sessions;
  }
  const days = filter === "today" ? 0 : filter === "week" ? 7 : 30;
  const threshold = startOfDay(now) - days * 86400000;
  return sessions.filter((session) => {
    const time = new Date(session.lastMessageAt ?? session.updatedAt).getTime();
    return filter === "today" ? time >= threshold : time > threshold;
  });
}
