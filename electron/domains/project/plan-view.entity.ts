/**
 * 计划视图数据接口（前后端共享，子系统 A spec §数据模型）
 * 视图 = 展示类型 + 筛选/排序/分组配置；不复制数据，共享项目 planItem
 */

/** 视图类型枚举：table 表格 / kanban 看板 / list 列表 / gantt 甘特 / calendar 日历（list/gantt/calendar 为 C 阶段预留，本期 UI 仅 table/kanban 可选） */
export const PLAN_VIEW_TYPES = [
  "table",
  "kanban",
  "list",
  "gantt",
  "calendar",
] as const;
export type PlanViewType = (typeof PLAN_VIEW_TYPES)[number];

/** 看板分组依据：status 状态 / priority 优先级 / assignee 处理人 */
export const PLAN_GROUP_BYS = ["status", "priority", "assignee"] as const;
export type PlanGroupBy = (typeof PLAN_GROUP_BYS)[number];

/** 视图类型本地化名 key（默认视图 name 为空串时 UI 兜底显示） */
export const PLAN_VIEW_NAME_KEYS: Record<PlanViewType, string> = {
  table: "project:planView.typeTable",
  kanban: "project:planView.typeKanban",
  list: "project:planView.typeList",
  gantt: "project:planView.typeGantt",
  calendar: "project:planView.typeCalendar",
};

/** 错误码：最后一个视图不可删（项目至少保留一个视图） */
export const PLAN_VIEW_LAST_ONE = "PLAN_VIEW_LAST_ONE";

/** 视图记录（DateTime 已转 ISO 字符串） */
export interface PlanViewRecord {
  id: number;
  projectId: number;
  /** 空串 = 播种默认视图（UI 显示本地化类型名） */
  name: string;
  type: PlanViewType;
  groupBy: PlanGroupBy | null;
  filterJson: string;
  sortJson: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** 创建参数：type 必填；name 缺省空串（默认视图语义）；重名自动 (n) 后缀 */
export interface PlanViewCreateParams {
  projectId: number;
  name?: string;
  type: PlanViewType;
  groupBy?: PlanGroupBy | null;
  filterJson?: string;
  sortJson?: string;
}

/** 局部更新参数：仅传入字段写入（未传键不覆盖） */
export interface PlanViewUpdateParams {
  id: number;
  name?: string;
  type?: PlanViewType;
  groupBy?: PlanGroupBy | null;
  filterJson?: string;
  sortJson?: string;
}
