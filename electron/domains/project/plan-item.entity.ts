/**
 * 计划事项数据接口（前后端共享，项目模块三期 spec §3）
 * 单表双视图：一张 planItem 表支撑计划 Tab（项目全部事项）与
 * 任务 Tab（assigneeId=me OR createdById=me 个人聚合，projectId null 为本地任务）
 */

/**
 * 事项状态枚举：not_started 待开始 / in_progress 进行中 / paused 已暂停 / done 已完成
 * （表格三态与看板四态取并集，spec §2）
 */
export const PLAN_STATUSES = [
  "not_started",
  "in_progress",
  "paused",
  "done",
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/**
 * 事项优先级枚举：P0 最高 / P1 默认 / P2 最低
 */
export const PLAN_PRIORITIES = ["P0", "P1", "P2"] as const;
export type PlanPriority = (typeof PLAN_PRIORITIES)[number];

/**
 * 计划事项记录（DateTime 已转 ISO 字符串，tags/customFields 已解析 JSON 列）
 */
export interface PlanItemRecord {
  /**
   * 事项 id
   */
  id: number;

  /**
   * 所属项目 id；null = 本地任务（仅任务 Tab 可见）
   */
  projectId: number | null;

  /**
   * 标题
   */
  title: string;

  /**
   * 状态
   */
  status: PlanStatus;

  /**
   * 优先级
   */
  priority: PlanPriority;

  /**
   * 处理人用户 id（预留，单成员恒当前用户；null = 未指派）
   */
  assigneeId: number | null;

  /**
   * 标签（DB JSON 字符串列解析；畸形容错空数组）
   */
  tags: string[];

  /**
   * 自定义字段值（DB JSON 字符串列解析；畸形容错空对象）
   */
  customFields: Record<string, string | number>;

  /**
   * 列内顺序（看板拖拽持久化）
   */
  sortOrder: number;

  /**
   * 创建人用户 id
   */
  createdById: number;

  /**
   * 创建时间（ISO）
   */
  createdAt: string;

  /**
   * 更新时间（ISO）
   */
  updatedAt: string;
}

/**
 * 创建参数：title 必填；其余可选（缺省 not_started/P1/未指派）
 */
export interface PlanItemCreateParams {
  /**
   * 创建人用户 id
   */
  createdById: number;

  /**
   * 标题（trim 后不得为空）
   */
  title: string;

  /**
   * 所属项目 id；缺省 = 本地任务
   */
  projectId?: number;

  /**
   * 状态（缺省 not_started）
   */
  status?: PlanStatus;

  /**
   * 优先级（缺省 P1）
   */
  priority?: PlanPriority;

  /**
   * 处理人用户 id
   */
  assigneeId?: number;

  /**
   * 标签
   */
  tags?: string[];

  /**
   * 自定义字段值
   */
  customFields?: Record<string, string | number>;
}

/**
 * 局部更新参数：仅传入字段写入（未传键不覆盖）
 */
export interface PlanItemUpdateParams {
  /**
   * 事项 id
   */
  id: number;

  /**
   * 新标题（trim 后不得为空）
   */
  title?: string;

  /**
   * 新状态
   */
  status?: PlanStatus;

  /**
   * 新优先级
   */
  priority?: PlanPriority;

  /**
   * 新处理人；null = 显式清空指派
   */
  assigneeId?: number | null;

  /**
   * 新标签（全量替换）
   */
  tags?: string[];

  /**
   * 新自定义字段值（全量替换）
   */
  customFields?: Record<string, string | number>;
}

/**
 * 看板拖拽落点参数：跨列流转 + 列内新序
 */
export interface PlanItemMoveParams {
  /**
   * 事项 id
   */
  id: number;

  /**
   * 目标状态列
   */
  status: PlanStatus;

  /**
   * 目标列内新序
   */
  sortOrder: number;
}

/**
 * 自定义字段类型枚举：text 文本 / number 数字 / date 日期
 */
export const PLAN_FIELD_TYPES = ["text", "number", "date"] as const;
export type PlanFieldType = (typeof PLAN_FIELD_TYPES)[number];

/**
 * 自定义字段定义（planItem:fields:list/save 载荷；
 * 持久化复用 option 表：type = "planFields:<projectId>"，value=字段名，note=类型）
 */
export interface PlanFieldDef {
  /**
   * 字段名（项目内唯一）
   */
  name: string;

  /**
   * 字段类型
   */
  type: PlanFieldType;
}

/**
 * 错误码：事项不存在（update/move 目标行缺失）
 */
export const PLAN_ITEM_NOT_FOUND = "PLAN_ITEM_NOT_FOUND";
