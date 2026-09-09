/**
 * 会话动作（AiSidebar 与 AiLayout 快捷键分发共用）：
 * 新建任务并进入（落库 → 失效缓存 → URL 选中）、当前空间派生、
 * 任务列表内按序取相邻任务；均为纯数据操作，错误经 mapIpcError toast
 */
import type { QueryClient } from "@tanstack/react-query";
import type { NavigateFunction } from "react-router-dom";
import { toast } from "sonner";

import SessionApi, { type SessionRecord } from "../../api/session.api";
import type { WorkspaceRecord } from "../../api/workspace.api";
import { mapIpcError } from "./error-message";
import { sortSessions } from "./session-list";

/**
 * 新建任务并进入：与侧边栏「新建任务」按钮同链路；
 * workspaceId 为 null（无空间可用）时静默不动作，错误 toast 兜底
 */
export async function createSessionAndSelect(options: {
  queryClient: QueryClient;
  navigate: NavigateFunction;
  workspaceId: number | null;
}): Promise<void> {
  const { queryClient, navigate, workspaceId } = options;
  if (workspaceId === null) {
    return;
  }
  try {
    const created = await SessionApi.create({ workspaceId });
    await queryClient.invalidateQueries({ queryKey: ["sessions"] });
    navigate(`/module/ai?session=${created.id}`, { replace: true });
  } catch (e) {
    toast.error(mapIpcError(e));
  }
}

/** 当前空间：选中任务所属空间，无选中取第一个（spec §2.3） */
export function deriveCurrentWorkspaceId(
  sessions: SessionRecord[],
  workspaces: WorkspaceRecord[],
  selectedSessionId: number | null,
): number | null {
  const selected = sessions.find((session) => session.id === selectedSessionId);
  return selected?.workspaceId ?? workspaces[0]?.id ?? null;
}

/**
 * 相邻任务 id：按任务排序（置顶/活跃在前）定位当前位后移动 delta；
 * 到边界返回 null（不循环）；当前无选中时 delta 1 取首个、-1 取末个
 */
export function neighborSessionId(
  sessions: SessionRecord[],
  currentId: number | null,
  delta: 1 | -1,
): number | null {
  const ordered = sortSessions(sessions);
  if (ordered.length === 0) {
    return null;
  }
  const index = ordered.findIndex((session) => session.id === currentId);
  if (index === -1) {
    return (delta === 1 ? ordered[0] : ordered[ordered.length - 1]).id;
  }
  return ordered[index + delta]?.id ?? null;
}
