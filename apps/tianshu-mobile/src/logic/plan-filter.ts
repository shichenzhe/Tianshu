// apps/tianshu-mobile/src/logic/plan-filter.ts
/**
 * 计划筛选条件管理纯函数（#8 桌面对齐批）：与桌面 PlanFilterPopover
 * 的 updater 纯函数同构移植（先例同 logic/plan-view.ts 双份落法）——
 * 条件字段在面板内唯一由调用方（字段 chips toggle）保证，updater 族
 * 本身纯追加/滤除/补丁；op 切换统一经 setConditionOpUpdater 重置空值。
 */
import type { PlanFilterCondition } from "./plan-view";

/** 可筛选字段（面板添加区顺序；字段唯一即条件数上限 6） */
export const PLAN_FILTER_FIELDS = [
  "title",
  "status",
  "assigneeId",
  "source",
  "priority",
  "tags",
] as const;

/** 新增条件的缺省操作符 */
export const DEFAULT_OPS: Record<
  PlanFilterCondition["field"],
  PlanFilterCondition["op"]
> = {
  title: "contains",
  tags: "contains",
  status: "in",
  priority: "in",
  source: "in",
  assigneeId: "isMe",
};

/** 操作符对应的空值（列表操作符空数组，其余空串） */
export function emptyValueOf(op: PlanFilterCondition["op"]): string | string[] {
  return op === "in" || op === "notIn" ? [] : "";
}

/** 新增条件（缺省操作符 + 空值） */
export const addConditionUpdater =
  (field: PlanFilterCondition["field"]) =>
  (prev: PlanFilterCondition[]): PlanFilterCondition[] => [
    ...prev,
    { field, op: DEFAULT_OPS[field], value: emptyValueOf(DEFAULT_OPS[field]) },
  ];

/** 删除指定字段的条件 */
export const removeConditionUpdater =
  (field: PlanFilterCondition["field"]) =>
  (prev: PlanFilterCondition[]): PlanFilterCondition[] =>
    prev.filter((condition) => condition.field !== field);

/** 局部补丁指定字段条件 */
export const patchConditionUpdater =
  (
    field: PlanFilterCondition["field"],
    patch: Partial<PlanFilterCondition>,
  ) =>
  (prev: PlanFilterCondition[]): PlanFilterCondition[] =>
    prev.map((condition) =>
      condition.field === field ? { ...condition, ...patch } : condition,
    );

/** 切换操作符并重置为对应空值（防跨形态残留旧值） */
export const setConditionOpUpdater =
  (field: PlanFilterCondition["field"], op: PlanFilterCondition["op"]) =>
  (prev: PlanFilterCondition[]): PlanFilterCondition[] =>
    prev.map((condition) =>
      condition.field === field
        ? { ...condition, op, value: emptyValueOf(op) }
        : condition,
    );

/** 多选值切换（勾选/取消；遗留单值字符串容错归一为列表） */
export const toggleConditionValueUpdater =
  (field: PlanFilterCondition["field"], value: string) =>
  (prev: PlanFilterCondition[]): PlanFilterCondition[] =>
    prev.map((condition) => {
      if (condition.field !== field) {
        return condition;
      }
      const raw = condition.value;
      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const next = list.includes(value)
        ? list.filter((v) => v !== value)
        : [...list, value];
      return { ...condition, value: next };
    });
