/**
 * 标准侧边栏任务列表的排序、时间筛选与项目分组派生（纯函数，ISO 串字典序即时间序）
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

/** 会话树分组所需归属字段（一期会话统一 D4：项目/任务会话进侧边栏项目组） */
export interface SessionGroupFields {
  projectId?: number | null;
  planItemId?: number | null;
}

/** 项目分组：projectId 非空的会话按项目聚合（组名由调用方从项目表解析） */
export interface ProjectSessionGroup<T> {
  projectId: number;
  sessions: T[];
}

/**
 * 项目分组派生（D4）：projectId 非空的会话按项目聚合；组间先按
 * projectOrder（侧边栏项目列表序）取有会话的项目，已删项目（不在列表）
 * 按首现序兜底在后；组内任务会话（planItemId 非空）排主会话前，
 * 子集内保持传入序（调用方先经 sortSessions）
 */
export function projectSessionGroups<T extends SessionGroupFields>(
  sessions: T[],
  projectOrder: number[] = [],
): ProjectSessionGroup<T>[] {
  const byProject = new Map<number, T[]>();
  for (const session of sessions) {
    if (session.projectId == null) {
      continue;
    }
    const list = byProject.get(session.projectId);
    if (list) {
      list.push(session);
    } else {
      byProject.set(session.projectId, [session]);
    }
  }
  const orphanIds = [...byProject.keys()].filter(
    (id) => !projectOrder.includes(id),
  );
  return [...projectOrder, ...orphanIds]
    .filter((id) => byProject.has(id))
    .map((projectId) => ({
      projectId,
      sessions: withTaskSessionsFirst(byProject.get(projectId)!),
    }));
}

/** 组内排序：任务会话在前（事项「推进」的落点会话），主会话殿后 */
function withTaskSessionsFirst<T extends SessionGroupFields>(
  sessions: T[],
): T[] {
  return [
    ...sessions.filter((s) => s.planItemId != null),
    ...sessions.filter((s) => s.planItemId == null),
  ];
}
