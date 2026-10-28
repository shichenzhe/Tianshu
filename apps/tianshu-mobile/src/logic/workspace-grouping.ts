/**
 * 会话按 workspace 分组（MB-T2，对齐桌面 HD-A2 侧栏分组语义）：组随
 * workspace id 升序、组内保持入参序（分页续载自然追加）、未匹配任何
 * 空间的会话进兜底组沉底（列表窗口期防御——workspace 行晚于会话行到
 * 达时不丢）。纯函数，空组不产出。
 */

/** 分组产物（SectionList sections 直用） */
export interface SessionGroup<T> {
  key: string;
  title: string;
  data: T[];
}

export function groupSessionsByWorkspace<T extends { id: number; workspaceId?: number | null }>(
  rows: T[],
  workspaces: Array<{ id: number; name: string }>,
  fallbackTitle: string,
): SessionGroup<T>[] {
  const groups: SessionGroup<T>[] = [];
  const byWorkspace = new Map<number, T[]>();
  const fallback: T[] = [];
  for (const row of rows) {
    if (row.workspaceId != null && workspaces.some((w) => w.id === row.workspaceId)) {
      const bucket = byWorkspace.get(row.workspaceId);
      if (bucket) {
        bucket.push(row);
      } else {
        byWorkspace.set(row.workspaceId, [row]);
      }
    } else {
      fallback.push(row);
    }
  }
  const ordered = [...workspaces].sort((a, b) => a.id - b.id);
  for (const workspace of ordered) {
    const data = byWorkspace.get(workspace.id);
    if (data && data.length > 0) {
      groups.push({ key: `ws-${workspace.id}`, title: workspace.name, data });
    }
  }
  if (fallback.length > 0) {
    groups.push({ key: "ws-ungrouped", title: fallbackTitle, data: fallback });
  }
  return groups;
}
