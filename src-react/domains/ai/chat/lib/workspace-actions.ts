/**
 * 工作空间目录绑定/解绑动作（SessionTreePanel 空间菜单与路径 chip 共用）：
 * 成功绑定后失效工作空间缓存；用户取消（后端返回 null）时静默返回
 */
import type { QueryClient } from "@tanstack/react-query";

import WorkspaceApi, { type WorkspaceRecord } from "../../api/workspace.api";

export const WORKSPACES_KEY = ["workspaces"] as const;

/** 弹系统目录选择框绑定工作空间目录；用户取消返回 null，不失效缓存 */
export async function bindWorkspaceDirectory(
  queryClient: QueryClient,
  workspaceId: number,
): Promise<WorkspaceRecord | null> {
  const updated = await WorkspaceApi.bindDirectory(workspaceId);
  if (updated) {
    await queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY });
  }
  return updated;
}

/** 解绑工作空间目录（历史消息保留）并失效工作空间缓存 */
export async function unbindWorkspaceDirectory(
  queryClient: QueryClient,
  workspaceId: number,
): Promise<WorkspaceRecord | null> {
  const updated = await WorkspaceApi.unbindDirectory(workspaceId);
  await queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY });
  return updated;
}
