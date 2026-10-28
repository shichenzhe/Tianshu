/**
 * 项目会话上下文（一期会话统一批 4）：ChatView 面包屑与任务概览共用的
 * 项目名/任务事项数据。项目名走 ["projects", ownerId] 轻量列表缓存（与
 * SessionTreePanel 同 key，GlobalSidebar 常驻预热）；任务事项
 * 走 PLAN_ITEMS_KEY(projectId)（计划 Tab/弹窗同缓存），缓存无数据时
 * enabled 拉取——未就绪由消费段兜底（面包屑先渲染项目名段、概览不渲染）
 */
import { useQuery } from "@tanstack/react-query";

import ProjectApi from "@/domains/project/api/project.api";
import PlanItemApi, {
  PLAN_ITEMS_KEY,
} from "@/domains/project/api/plan-item.api";
import { useUserStore } from "@/domains/user/store/user.store";
import type { PlanItemRecord } from "../../../../../electron/domains/project/plan-item.entity";
import type { SessionRecord } from "../../api/session.api";

interface ProjectSessionData {
  /** 会话归属项目 id；null = 普通会话 */
  projectId: number | null;
  /** 项目名（列表缓存未就绪/项目已删为 null——消费段自行兜底） */
  projectName: string | null;
  /** 任务会话关联事项（事项缓存未就绪或非任务会话为 null） */
  planItem: PlanItemRecord | null;
}

export function useProjectSessionData(
  session: Pick<SessionRecord, "projectId" | "planItemId"> | null,
): ProjectSessionData {
  const userId = useUserStore((state) => state.user.id);
  const projectId = session?.projectId ?? null;
  const planItemId = session?.planItemId ?? null;
  // 项目名用轻量列表（getDetail 较重且含资产空间自愈副作用，面包屑不必触发）
  const projectsQuery = useQuery({
    queryKey: ["projects", userId],
    queryFn: () => ProjectApi.list(),
    enabled: projectId != null,
  });
  // 仅任务会话拉取计划事项；主会话/普通会话不查
  const planItemsQuery = useQuery({
    queryKey: PLAN_ITEMS_KEY(projectId ?? 0),
    queryFn: () => PlanItemApi.list(projectId ?? 0),
    enabled: projectId != null && planItemId != null,
  });
  return {
    projectId,
    projectName:
      projectsQuery.data?.find((p) => p.id === projectId)?.name ?? null,
    planItem:
      planItemId == null
        ? null
        : (planItemsQuery.data?.find((item) => item.id === planItemId) ?? null),
  };
}
