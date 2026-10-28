/**
 * 侧栏任务树展开态持久化（localStorage，对齐 WorkBuddy expanded-state）：
 * 空间区开关、空间/项目组折叠、组收缩可见条数。组 key 用 w:/p: 前缀
 * 隔离空间与项目 id 撞号；折叠与可见条数「回到默认即删记录」——存储
 * 瘦身，默认值调整天然向后兼容。visibleCountOf 的活跃保底（选中项
 * 超界自动扩档）为渲染期派生不落盘，落盘只发生在用户动作
 * （showMoreGroup/collapseGroup）。
 */
import { useCallback, useState } from "react";

import {
  SIDEBAR_GROUP_VISIBLE_DEFAULT,
  nextVisibleCount,
  resolveVisibleCount,
  visibleCountCovering,
} from "@/domains/ai/chat/lib/session-list";

export const SIDEBAR_EXPAND_STORAGE_KEY = "tianshu-sidebar-expand";

export interface SidebarExpandState {
  spacesOpen: boolean;
  spaceCollapsed: Record<string, boolean>;
  projectCollapsed: Record<string, boolean>;
  groupVisibleCount: Record<string, number>;
}

const DEFAULT_STATE: SidebarExpandState = {
  spacesOpen: true,
  spaceCollapsed: {},
  projectCollapsed: {},
  groupVisibleCount: {},
};

export const spaceGroupKey = (workspaceId: number) => `w:${workspaceId}`;
export const projectGroupKey = (projectId: number) => `p:${projectId}`;

/** 布尔组表过滤：仅收 boolean 值（损坏数据防御） */
function sanitizeBoolMap(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "boolean") {
        out[key] = value;
      }
    }
  }
  return out;
}

/** 可见条数表过滤：仅收有限数字且高于默认的记录（≤ 默认无存储意义） */
function sanitizeCountMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        resolveVisibleCount(value) > SIDEBAR_GROUP_VISIBLE_DEFAULT
      ) {
        out[key] = resolveVisibleCount(value);
      }
    }
  }
  return out;
}

function readState(): SidebarExpandState {
  try {
    const raw = localStorage.getItem(SIDEBAR_EXPAND_STORAGE_KEY);
    if (!raw) {
      return {
        ...DEFAULT_STATE,
        spaceCollapsed: {},
        projectCollapsed: {},
        groupVisibleCount: {},
      };
    }
    const parsed = JSON.parse(raw) as Partial<SidebarExpandState>;
    return {
      spacesOpen:
        typeof parsed.spacesOpen === "boolean"
          ? parsed.spacesOpen
          : DEFAULT_STATE.spacesOpen,
      spaceCollapsed: sanitizeBoolMap(parsed.spaceCollapsed),
      projectCollapsed: sanitizeBoolMap(parsed.projectCollapsed),
      groupVisibleCount: sanitizeCountMap(parsed.groupVisibleCount),
    };
  } catch {
    return {
      ...DEFAULT_STATE,
      spaceCollapsed: {},
      projectCollapsed: {},
      groupVisibleCount: {},
    };
  }
}

function writeState(state: SidebarExpandState) {
  try {
    localStorage.setItem(SIDEBAR_EXPAND_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 写入失败（隐私模式/满额）不阻断 UI，仅本次会话失忆
  }
}

/**
 * 侧栏展开态 hook（SessionTreePanel 消费）：读默认惰性一次，
 * 用户动作更新即落盘。activeIndex 传选中会话在组内 index
 * （不在组内传 -1）
 */
export function useSidebarExpand() {
  const [state, setState] = useState<SidebarExpandState>(readState);

  const update = useCallback(
    (patch: (prev: SidebarExpandState) => SidebarExpandState) => {
      setState((prev) => {
        const next = patch(prev);
        writeState(next);
        return next;
      });
    },
    [],
  );

  /** 折叠组表切换：展开（回默认）即删记录 */
  const toggleBoolMapKey = useCallback(
    (map: "spaceCollapsed" | "projectCollapsed", key: string) => {
      update((prev) => {
        const records = { ...prev[map] };
        if (records[key]) {
          delete records[key];
        } else {
          records[key] = true;
        }
        return { ...prev, [map]: records };
      });
    },
    [update],
  );

  const toggleSpaces = useCallback(() => {
    update((prev) => ({ ...prev, spacesOpen: !prev.spacesOpen }));
  }, [update]);

  const toggleSpaceGroup = useCallback(
    (workspaceId: number) =>
      toggleBoolMapKey("spaceCollapsed", spaceGroupKey(workspaceId)),
    [toggleBoolMapKey],
  );

  const toggleProjectGroup = useCallback(
    (projectId: number) =>
      toggleBoolMapKey("projectCollapsed", projectGroupKey(projectId)),
    [toggleBoolMapKey],
  );

  /** 「展开更多」：current 为当前渲染可见值（保底派生态继续步进），≤ 默认不落盘 */
  const showMoreGroup = useCallback(
    (key: string, current: number, total: number) => {
      const next = nextVisibleCount(current, total);
      update((prev) => {
        const counts = { ...prev.groupVisibleCount };
        if (next > SIDEBAR_GROUP_VISIBLE_DEFAULT) {
          counts[key] = next;
        } else {
          delete counts[key];
        }
        return { ...prev, groupVisibleCount: counts };
      });
    },
    [update],
  );

  /** 「收起」：删记录回默认 */
  const collapseGroup = useCallback(
    (key: string) => {
      update((prev) => {
        const counts = { ...prev.groupVisibleCount };
        delete counts[key];
        return { ...prev, groupVisibleCount: counts };
      });
    },
    [update],
  );

  const isSpaceCollapsed = useCallback(
    (workspaceId: number) =>
      state.spaceCollapsed[spaceGroupKey(workspaceId)] ?? false,
    [state.spaceCollapsed],
  );

  const isProjectCollapsed = useCallback(
    (projectId: number) =>
      state.projectCollapsed[projectGroupKey(projectId)] ?? false,
    [state.projectCollapsed],
  );

  /** 组可见条数：纯读存储（收起动作不被渲染派生推翻） */
  const visibleCountOf = useCallback(
    (key: string) => resolveVisibleCount(state.groupVisibleCount[key]),
    [state.groupVisibleCount],
  );

  /** 活跃保底（事件驱动落盘，对齐 WorkBuddy）：选中项超界时扩档落盘；
   *  界内/不在组内 no-op（返回原引用不触发重渲染）。落盘后用户显式
   *  「收起」可覆盖（collapseGroup 删记录生效，选中行接受被藏） */
  const syncActiveVisible = useCallback(
    (key: string, activeIndex: number) => {
      update((prev) => {
        const stored = prev.groupVisibleCount[key];
        const next = visibleCountCovering(activeIndex, stored);
        if (stored !== undefined && next <= stored) {
          return prev;
        }
        return {
          ...prev,
          groupVisibleCount: { ...prev.groupVisibleCount, [key]: next },
        };
      });
    },
    [update],
  );

  return {
    spacesOpen: state.spacesOpen,
    isSpaceCollapsed,
    isProjectCollapsed,
    visibleCountOf,
    syncActiveVisible,
    toggleSpaces,
    toggleSpaceGroup,
    toggleProjectGroup,
    showMoreGroup,
    collapseGroup,
  };
}
