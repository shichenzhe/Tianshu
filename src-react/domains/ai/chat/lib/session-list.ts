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

/** 当日 00:00（本地时区）时间戳（筛选阈值基准） */
function startOfDay(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** 时间筛选：活动时间（lastMessageAt ?? updatedAt）不早于阈值（含边界） */
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
  return sessions.filter(
    (session) =>
      new Date(session.lastMessageAt ?? session.updatedAt).getTime() >=
      threshold,
  );
}
