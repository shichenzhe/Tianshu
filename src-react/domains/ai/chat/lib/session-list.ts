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

/** 归档字段（splitArchived 数据源） */
export interface SessionArchiveFields {
  archivedAt?: string;
}

/**
 * 归档拆分：archivedAt 非空的会话单独成组（侧边栏「已归档」分组，
 * 点进可查看只读），正常列表不含归档——后端 listAll 自归档可查看起
 * 返回全量，拆分收敛在前端
 */
export function splitArchived<T extends SessionArchiveFields>(
  sessions: T[],
): { active: T[]; archived: T[] } {
  const active: T[] = [];
  const archived: T[] = [];
  for (const session of sessions) {
    (session.archivedAt ? archived : active).push(session);
  }
  return { active, archived };
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

/** 组收缩默认可见条数（对齐 WorkBuddy：组内默认 5 条） */
export const SIDEBAR_GROUP_VISIBLE_DEFAULT = 5;

/** 「展开更多」单次步进条数 */
export const SIDEBAR_GROUP_VISIBLE_STEP = 20;

/** 存储可见条数解析：未存/非法回落默认，不低于默认，小数向下取整 */
export function resolveVisibleCount(
  stored: number | undefined,
  fallback = SIDEBAR_GROUP_VISIBLE_DEFAULT,
): number {
  return typeof stored !== "number" || !Number.isFinite(stored)
    ? fallback
    : Math.max(fallback, Math.floor(stored));
}

/** 「展开更多」：当前可见 + 步进，封顶组内总数；总数非正回落默认 */
export function nextVisibleCount(
  current: number,
  total: number,
  fallback = SIDEBAR_GROUP_VISIBLE_DEFAULT,
): number {
  if (total <= 0) {
    return fallback;
  }
  return Math.min(
    resolveVisibleCount(current, fallback) + SIDEBAR_GROUP_VISIBLE_STEP,
    total,
  );
}

/** 剩余未显示条数（「展开更多 (N)」的 N），下限 0 */
export function remainingVisible(
  current: number,
  total: number,
  fallback = SIDEBAR_GROUP_VISIBLE_DEFAULT,
): number {
  return Math.max(0, total - resolveVisibleCount(current, fallback));
}

/** 「收起」可用：总数超默认且已展开超默认（默认态不显示收起） */
export function canCollapseVisible(
  current: number,
  total: number,
  fallback = SIDEBAR_GROUP_VISIBLE_DEFAULT,
): boolean {
  return total > fallback && resolveVisibleCount(current, fallback) > fallback;
}

/** 未读角标封顶显示值（与移动端视觉语言一致：≥100 显 99+） */
export const UNREAD_BADGE_CAP = 100;

/** 未读角标投影（P1 尾）：≤0 不显（null）；≥100 显 "99+"；其余显原数。
 *  纯展示派生——角标文本入组件前收口于此，渲染层零分支重复 */
export function unreadBadgeText(count: number | undefined): string | null {
  if (count === undefined || count <= 0) {
    return null;
  }
  return count >= UNREAD_BADGE_CAP ? "99+" : String(count);
}

/**
 * 活跃会话保底（对齐 WorkBuddy visibleCountCovering）：选中项 index
 * 在当前可见范围内维持原值；超界时扩到覆盖它的最小档位（默认起按
 * 步进向上取整）——当前选中会话绝不因收缩被藏掉。index 为 -1
 * （选中不在本组）时天然落入「范围内」分支，维持原值
 */
export function visibleCountCovering(
  index: number,
  stored: number | undefined,
  fallback = SIDEBAR_GROUP_VISIBLE_DEFAULT,
  step = SIDEBAR_GROUP_VISIBLE_STEP,
): number {
  const visible = resolveVisibleCount(stored, fallback);
  if (index < visible) {
    return visible;
  }
  return fallback + Math.ceil((index + 1 - fallback) / step) * step;
}
