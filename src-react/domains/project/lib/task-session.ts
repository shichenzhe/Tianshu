/**
 * 任务「推进」入口（一期会话统一 D6）：任务 → 专属会话直达。
 * - 复用：["sessions","all"] 缓存按 planItemId 找既有会话直接跳（批 2 起
 *   listAll 已含项目会话，命中即跳零 IPC 往返）。缓存命中分支只可能命中
 *   未归档会话（listAll 已滤 archivedAt）——归档命中仅出现在 create 的
 *   复用返回（后端查重不看归档，D1 语义保留），由下方撤销分支兜底
 * - 新建：SessionApi.create（projectId+planItemId+title，不传 workspaceId
 *   ——后端解析项目资产空间）→（D9 二期：返回归档会话先撤销归档）→
 *   失效 ["sessions"] 再跳；并发双击由后端 planItemId 查重复用兜底
 *   （批 1 D1），前端不设防抖
 * - 本地任务（projectId null）无项目资产空间，不提供推进入口（调用方
 *   不渲染入口 + 此处防御性直接返回）
 * 失败 toast（mapIpcError）不跳转（create/撤销归档任一失败均兜底）；
 * openTaskSession 不抛出（错误已消化）
 */
import type { QueryClient } from "@tanstack/react-query";
import type { NavigateFunction } from "react-router-dom";
import { toast } from "sonner";

import SessionApi, { type SessionRecord } from "@/domains/ai/api/session.api";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import type { PlanItemRecord } from "../../../../electron/domains/project/plan-item.entity";

/** 会话列表缓存 key（SessionTreePanel/ChatView 同源） */
const SESSIONS_ALL_KEY = ["sessions", "all"] as const;

export async function openTaskSession(
  queryClient: QueryClient,
  navigate: NavigateFunction,
  planItem: Pick<PlanItemRecord, "id" | "projectId" | "title">,
): Promise<void> {
  // 本地任务防御：无项目归属即无资产空间与会话域归属，不推进
  if (planItem.projectId == null) {
    return;
  }
  // 复用优先：缓存命中直接跳（创建语义后端也会查重复用，此处省一次 IPC）
  const sessions =
    queryClient.getQueryData<SessionRecord[]>(SESSIONS_ALL_KEY) ?? [];
  const existing = sessions.find((s) => s.planItemId === planItem.id);
  if (existing) {
    navigate(`/module/ai?session=${existing.id}`);
    return;
  }
  try {
    const created = await SessionApi.create({
      projectId: planItem.projectId,
      planItemId: planItem.id,
      title: planItem.title,
    });
    // D9：后端查重复用不看归档——返回归档会话时先撤销，否则 listAll
    // （过滤 archivedAt）看不到它、ChatView 跳转落点成空
    if (created.archivedAt != null) {
      await SessionApi.archive(created.id, false);
    }
    await queryClient.invalidateQueries({ queryKey: ["sessions"] });
    navigate(`/module/ai?session=${created.id}`);
  } catch (e) {
    toast.error(mapIpcError(e));
  }
}
