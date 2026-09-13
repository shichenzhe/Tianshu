// src-react/domains/project/model/use-plan-views.ts
/**
 * 计划视图状态 hook（子系统 A spec §前端）：视图列表 React Query（首次
 * 懒播种在后端）+ 激活视图（?viewId= 路由参数，兼容旧 ?view=）+ draft
 * 未保存调整态（切换视图/刷新即丢弃）+ 保存两动作（saveAsNew 命名新建 /
 * saveOverwrite 覆盖回写）+ 视图增删改名与类型切换（立即保存）。
 * 变更走乐观更新 setQueryData、失败 invalidate 回滚 + toast（PlanPane 惯例）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import PlanViewApi, { PLAN_VIEWS_KEY } from "../api/plan-view.api";
import type {
  PlanGroupBy,
  PlanViewRecord,
  PlanViewType,
} from "../../../../electron/domains/project/plan-view.entity";
import type { FilterCondition, SortRule } from "./plan-view-engine";
import { parseViewConfig } from "./plan-view-engine";

export interface PlanViewDraft {
  conditions: FilterCondition[];
  sortRules: SortRule[];
  groupBy: PlanGroupBy | null;
}

/** 初始激活视图：viewId 参数直取 → 旧 ?view= 按 type 映射 → 回退首个 */
export function resolveInitialViewId(
  views: PlanViewRecord[],
  viewIdParam: string | null,
  legacyViewParam: string | null,
): number | null {
  const byId = Number(viewIdParam);
  if (viewIdParam && views.some((v) => v.id === byId)) {
    return byId;
  }
  if (legacyViewParam) {
    const matched = views.find((v) => v.type === legacyViewParam);
    if (matched) {
      return matched.id;
    }
  }
  return views[0]?.id ?? null;
}

/** 视图记录 → draft 初值（容错解析） */
function toDraft(view: PlanViewRecord): PlanViewDraft {
  const { conditions, sortRules } = parseViewConfig(
    view.filterJson,
    view.sortJson,
  );
  return { conditions, sortRules, groupBy: view.groupBy };
}

/** draft 与视图持久化配置是否一致（不一致 = 已修改） */
function isSameDraft(a: PlanViewDraft, b: PlanViewDraft): boolean {
  return (
    JSON.stringify([a.conditions, a.sortRules, a.groupBy]) ===
    JSON.stringify([b.conditions, b.sortRules, b.groupBy])
  );
}

export function usePlanViews(projectId: number) {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const viewsQuery = useQuery({
    queryKey: PLAN_VIEWS_KEY(projectId),
    queryFn: () => PlanViewApi.list(projectId),
  });
  const views = useMemo(() => viewsQuery.data ?? [], [viewsQuery.data]);

  const initialId = resolveInitialViewId(
    views,
    searchParams.get("viewId"),
    searchParams.get("view"),
  );
  const [activeViewId, setActiveViewIdState] = useState<number | null>(null);

  // 初次解析或参数指向失效视图时对齐（参数优先，回退首个）
  useEffect(() => {
    if (initialId !== null && initialId !== activeViewId) {
      setActiveViewIdState(initialId);
    }
  }, [initialId, activeViewId]);

  const activeView = views.find((v) => v.id === activeViewId);

  // draft：激活视图变化时重置为该视图配置（未保存调整随之丢弃）
  const [draft, setDraftState] = useState<PlanViewDraft>({
    conditions: [],
    sortRules: [],
    groupBy: null,
  });
  useEffect(() => {
    if (activeView) {
      setDraftState(toDraft(activeView));
    }
  }, [activeView?.id]); // 仅按视图 id 重置 draft（本仓 ESLint 未注册 react-hooks 规则，eslint-disable-line 会报未知规则错误，故以注释说明；若启用 exhaustive-deps 需抑制该行）

  const isDirty = activeView ? !isSameDraft(draft, toDraft(activeView)) : false;

  /** 合并式写入 ?viewId=（清掉旧 ?view=，保留 ?tab= 等） */
  const setActiveViewId = useCallback(
    (id: number) => {
      setActiveViewIdState(id);
      setSearchParams(
        (prev) => {
          prev.set("viewId", String(id));
          prev.delete("view");
          return prev;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setDraft = useCallback(
    (updater: (prev: PlanViewDraft) => PlanViewDraft) => {
      setDraftState((prev) => updater(prev));
    },
    [],
  );

  const resetDraft = useCallback(() => {
    if (activeView) {
      setDraftState(toDraft(activeView));
    }
  }, [activeView]);

  /** draft → 序列化配置（保存动作共用） */
  const serializeDraft = (current: PlanViewDraft): string => {
    return JSON.stringify({ conditions: current.conditions });
  };

  /** 视图写通道统一容错：失败 invalidate 回滚 + toast；成功返回 true */
  const runViewMutation = useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      try {
        await action();
        return true;
      } catch (error) {
        await queryClient.invalidateQueries({
          queryKey: PLAN_VIEWS_KEY(projectId),
        });
        toast.error(mapIpcError(error));
        return false;
      } finally {
        await queryClient.invalidateQueries({
          queryKey: PLAN_VIEWS_KEY(projectId),
        });
      }
    },
    [projectId, queryClient],
  );

  /** 覆盖保存：draft 回写当前视图 */
  const saveOverwrite = useCallback(async () => {
    if (!activeView) {
      return;
    }
    await runViewMutation(() =>
      PlanViewApi.update({
        id: activeView.id,
        groupBy: draft.groupBy,
        filterJson: serializeDraft(draft),
        sortJson: JSON.stringify(draft.sortRules),
      }),
    );
  }, [activeView, draft, runViewMutation]);

  /** 保存为新视图：克隆当前视图类型与 draft 配置（重名后端自动后缀） */
  const saveAsNew = useCallback(
    async (name: string) => {
      const created = await PlanViewApi.create({
        projectId,
        name,
        type: activeView?.type ?? "table",
        groupBy: draft.groupBy,
        filterJson: serializeDraft(draft),
        sortJson: JSON.stringify(draft.sortRules),
      }).catch(async (error) => {
        toast.error(mapIpcError(error));
        return null;
      });
      if (!created) {
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: PLAN_VIEWS_KEY(projectId),
      });
      setActiveViewId(created.id);
    },
    [activeView, draft, projectId, queryClient, setActiveViewId],
  );

  /** 新建视图（+ 菜单）：type + 类型本地化名（非空名触发后端重名 (n) 后缀，
   *  同类型多视图 Tab 可区分）；创建成功即激活 */
  const addView = useCallback(
    async (type: PlanViewType, name?: string) => {
      const created = await PlanViewApi.create({
        projectId,
        type,
        name,
      }).catch(async (error) => {
        toast.error(mapIpcError(error));
        return null;
      });
      if (!created) {
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: PLAN_VIEWS_KEY(projectId),
      });
      setActiveViewId(created.id);
    },
    [projectId, queryClient, setActiveViewId],
  );

  /** 重命名 / 删除 / 类型切换（立即保存，不走 draft） */
  const renameView = useCallback(
    async (id: number, name: string) => {
      await runViewMutation(() => PlanViewApi.update({ id, name }));
    },
    [runViewMutation],
  );

  const removeView = useCallback(
    async (id: number) => {
      const ok = await runViewMutation(() => PlanViewApi.remove(id));
      if (ok) {
        const rest = views.filter((v) => v.id !== id);
        if (rest.length > 0 && activeViewId === id) {
          setActiveViewId(rest[0].id);
        }
      }
    },
    [runViewMutation, views, activeViewId, setActiveViewId],
  );

  const changeType = useCallback(
    async (type: PlanViewType) => {
      if (!activeView || activeView.type === type) {
        return;
      }
      await runViewMutation(() =>
        PlanViewApi.update({ id: activeView.id, type }),
      );
    },
    [activeView, runViewMutation],
  );

  return {
    views,
    isLoading: viewsQuery.isLoading,
    isError: viewsQuery.isError,
    activeView,
    activeViewId,
    setActiveViewId,
    draft,
    setDraft,
    isDirty,
    resetDraft,
    saveOverwrite,
    saveAsNew,
    addView,
    renameView,
    removeView,
    changeType,
  };
}
