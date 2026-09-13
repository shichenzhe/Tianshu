/**
 * 计划事项 API
 * IPC 通道由主进程 PlanItemRepository 提供（electron/domains/project/plan-item.repo.ts）；
 * 单表双视图：list（计划 Tab）/ listMine（任务 Tab）；
 * query key 工厂供 React Query 查询与失效缓存（后续任务消费）
 */

import { invoke } from "@/lib/ipc";
import type {
  PlanFieldDef,
  PlanItemCreateParams,
  PlanItemMoveParams,
  PlanItemRecord,
  PlanItemUpdateParams,
} from "../../../../electron/domains/project/plan-item.entity";

/** 项目全部事项（计划 Tab）query key */
export const PLAN_ITEMS_KEY = (projectId: number) =>
  ["planItems", projectId] as const;

/** 个人事项聚合（任务 Tab）query key */
export const PLAN_ITEMS_MINE_KEY = (userId: number) =>
  ["planItemsMine", userId] as const;

/** 项目自定义字段定义 query key */
export const PLAN_FIELDS_KEY = (projectId: number) =>
  ["planFields", projectId] as const;

export default abstract class PlanItemApi {
  /** 项目全部事项（计划 Tab 数据源，projectId null 的本地任务不可见） */
  static async list(projectId: number): Promise<PlanItemRecord[]> {
    return invoke<PlanItemRecord[]>("planItem:list", projectId);
  }

  /** 个人聚合（任务 Tab 数据源）：指派给我 OR 我创建 */
  static async listMine(userId: number): Promise<PlanItemRecord[]> {
    return invoke<PlanItemRecord[]>("planItem:listMine", userId);
  }

  /** 创建事项（title trim 与枚举校验在后端） */
  static async create(params: PlanItemCreateParams): Promise<PlanItemRecord> {
    return invoke<PlanItemRecord>("planItem:create", params);
  }

  /** 局部更新（仅传入键写入，未传字段不覆盖） */
  static async update(params: PlanItemUpdateParams): Promise<void> {
    return invoke<void>("planItem:update", params);
  }

  /** 删除事项 */
  static async remove(id: number): Promise<void> {
    return invoke<void>("planItem:delete", id);
  }

  /** 看板拖拽落点持久化（目标状态列 + 列内新序） */
  static async move(params: PlanItemMoveParams): Promise<void> {
    return invoke<void>("planItem:move", params);
  }

  /** 项目自定义字段定义 */
  static async listFields(projectId: number): Promise<PlanFieldDef[]> {
    return invoke<PlanFieldDef[]>("planItem:fields:list", projectId);
  }

  /** 全量保存自定义字段定义（消失字段名同步清理行内值） */
  static async saveFields(
    projectId: number,
    fields: PlanFieldDef[],
  ): Promise<void> {
    return invoke<void>("planItem:fields:save", projectId, fields);
  }
}
