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

/** 批③（2026-11-01）：项目组产物（聊天主页组态——对齐桌面侧栏 D4「有会话
 *  的项目聚合、渲染在空间组之后」语义） */
export interface ProjectSessionGroup<T> {
  id: number;
  name: string;
  items: T[];
}

/** 项目会话剥离：projectId 非空且项目可见的行剥为项目组（组序=projects
 *  入参序、空组不产出——无会话项目不显示，同桌面）；其余行留 rest 走
 *  workspace 分组/兜底。projectId 非空但项目不可见的行不剥离（项目列表
 *  窗口期防御——行不丢，组名就绪后自然纠正，同 workspace 兜底思路） */
export function splitProjectSessions<T extends { projectId?: number | null }>(
  rows: T[],
  projects: Array<{ id: number; name: string }>,
): { groups: ProjectSessionGroup<T>[]; rest: T[] } {
  const byProject = new Map<number, T[]>();
  const rest: T[] = [];
  const known = new Set(projects.map((p) => p.id));
  for (const row of rows) {
    if (row.projectId != null && known.has(row.projectId)) {
      const bucket = byProject.get(row.projectId);
      if (bucket) {
        bucket.push(row);
      } else {
        byProject.set(row.projectId, [row]);
      }
    } else {
      rest.push(row);
    }
  }
  const groups: ProjectSessionGroup<T>[] = [];
  for (const project of projects) {
    const items = byProject.get(project.id);
    if (items && items.length > 0) {
      groups.push({ id: project.id, name: project.name, items });
    }
  }
  return { groups, rest };
}
