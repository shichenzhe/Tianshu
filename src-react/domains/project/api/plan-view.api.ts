/**
 * 计划视图 API
 * IPC 通道由主进程 PlanViewRepository 提供（electron/domains/project/plan-view.repo.ts）
 */
import { invoke } from "@/lib/ipc";
import type {
  PlanViewCreateParams,
  PlanViewRecord,
  PlanViewUpdateParams,
} from "../../../../electron/domains/project/plan-view.entity";

/** 项目视图列表 query key */
export const PLAN_VIEWS_KEY = (projectId: number) =>
  ["planViews", projectId] as const;

export default abstract class PlanViewApi {
  /** 项目全部视图（首次返回空时后端懒播种默认两条） */
  static async list(projectId: number): Promise<PlanViewRecord[]> {
    return invoke<PlanViewRecord[]>("planView:list", projectId);
  }

  /** 创建视图（重名后端自动加 (n) 后缀） */
  static async create(params: PlanViewCreateParams): Promise<PlanViewRecord> {
    return invoke<PlanViewRecord>("planView:create", params);
  }

  /** 局部更新（改名/改类型/覆盖保存配置） */
  static async update(params: PlanViewUpdateParams): Promise<void> {
    return invoke<void>("planView:update", params);
  }

  /** 删除视图（最后一个后端拒绝） */
  static async remove(id: number): Promise<void> {
    return invoke<void>("planView:delete", id);
  }

  /** Tab 顺序批量更新（本期通道就绪，UI 后置） */
  static async reorder(
    items: Array<{ id: number; sortOrder: number }>,
  ): Promise<void> {
    return invoke<void>("planView:reorder", items);
  }
}
