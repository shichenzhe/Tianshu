// apps/tianshu-mobile/src/logic/plan-view.ts
/**
 * 计划视图筛选引擎移动端双份移植（同 widget-srcdoc/file-refs 先例）：
 * @tianshu/core 带 langChain peer 依赖不宜进 metro bundle，故纯函数
 * 双份落此。与 packages/tianshu-core/src/plan-view-engine.ts|plan-date.ts
 * 保持同步——改算法必须双改（桌面/服务端走 core 单份，本文件是第二份）。
 * 移动端仅移植实际消费的六函数（筛选/排序/分组/配置解析 + 两个日期键）。
 */
import {
  PLAN_PRIORITIES,
  PLAN_STATUSES,
  type PlanItemRecordDto,
  type ProjectMemberItemDto,
} from "@tianshu/protocol";

export interface PlanFilterCondition {
  field: "title" | "status" | "assigneeId" | "source" | "priority" | "tags";
  op: "contains" | "in" | "notIn" | "isMe" | "notMe";
  value: string | string[];
}

export type PlanSortField =
  "status" | "priority" | "dueDate" | "createdAt" | "title";
export interface PlanSortRule {
  field: PlanSortField;
  dir: "asc" | "desc";
}

export interface PlanItemGroup {
  key: string;
  items: PlanItemRecordDto[];
}

const FILTER_FIELDS: ReadonlySet<string> = new Set([
  "title",
  "status",
  "assigneeId",
  "source",
  "priority",
  "tags",
]);
const FILTER_OPS: ReadonlySet<string> = new Set([
  "contains",
  "in",
  "notIn",
  "isMe",
  "notMe",
]);
const SORT_FIELDS: ReadonlySet<string> = new Set([
  "status",
  "priority",
  "dueDate",
  "createdAt",
  "title",
]);

const valueList = (value: string | string[]): string[] =>
  Array.isArray(value) ? value : [value];

function matchCondition(
  item: PlanItemRecordDto,
  condition: PlanFilterCondition,
  currentUserId: number,
): boolean {
  const values = valueList(condition.value).map(String);
  switch (`${condition.field}:${condition.op}`) {
    case "title:contains":
      return item.title.toLowerCase().includes(values[0]?.toLowerCase() ?? "");
    case "status:in":
      return values.includes(item.status);
    case "status:notIn":
      return !values.includes(item.status);
    case "priority:in":
      return values.includes(item.priority);
    case "priority:notIn":
      return !values.includes(item.priority);
    case "source:in":
      return values.includes(item.source);
    case "source:notIn":
      return !values.includes(item.source);
    case "assigneeId:in":
      return (
        item.assigneeId !== null && values.includes(String(item.assigneeId))
      );
    case "assigneeId:notIn":
      return (
        item.assigneeId === null || !values.includes(String(item.assigneeId))
      );
    case "assigneeId:isMe":
      return item.assigneeId === currentUserId;
    case "assigneeId:notMe":
      return item.assigneeId !== currentUserId;
    case "tags:contains":
      return values.some((tag) => item.tags.includes(tag));
    default:
      return true;
  }
}

/** 筛选 + 标题搜索（大小写不敏感子串）：条件 AND，搜索独立叠加 */
export function filterPlanItems(
  items: PlanItemRecordDto[],
  conditions: PlanFilterCondition[],
  searchKeyword: string,
  currentUserId: number,
): PlanItemRecordDto[] {
  const keyword = searchKeyword.trim().toLowerCase();
  const valid = conditions.filter(
    (condition) =>
      FILTER_FIELDS.has(condition.field) &&
      FILTER_OPS.has(condition.op) &&
      condition.value !== undefined &&
      condition.value !== null,
  );
  return items.filter(
    (item) =>
      valid.every((condition) =>
        matchCondition(item, condition, currentUserId),
      ) &&
      (keyword === "" || item.title.toLowerCase().includes(keyword)),
  );
}

function compareDefault(a: PlanItemRecordDto, b: PlanItemRecordDto): number {
  const statusGap =
    PLAN_STATUSES.indexOf(a.status) - PLAN_STATUSES.indexOf(b.status);
  if (statusGap !== 0) {
    return statusGap;
  }
  return a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.id - b.id;
}

function sortValue(item: PlanItemRecordDto, field: PlanSortField) {
  if (field === "status") {
    return PLAN_STATUSES.indexOf(item.status);
  }
  if (field === "priority") {
    return PLAN_PRIORITIES.indexOf(item.priority);
  }
  if (field === "dueDate" || field === "createdAt") {
    return item[field] || "";
  }
  return item[field].toLowerCase();
}

/** 排序：规则按序比较；空规则走缺省序（状态→sortOrder→id）；空日期恒排最后 */
export function sortPlanItems(
  items: PlanItemRecordDto[],
  rules: PlanSortRule[],
): PlanItemRecordDto[] {
  const valid = rules.filter(
    (rule) =>
      SORT_FIELDS.has(rule.field) &&
      (rule.dir === "asc" || rule.dir === "desc"),
  );
  if (valid.length === 0) {
    return [...items].sort(compareDefault);
  }
  return [...items].sort((a, b) => {
    for (const rule of valid) {
      const va = sortValue(a, rule.field);
      const vb = sortValue(b, rule.field);
      const aEmpty = va === "";
      const bEmpty = vb === "";
      if (aEmpty !== bEmpty) {
        return aEmpty ? 1 : -1;
      }
      if (va !== vb) {
        const gap = va < vb ? -1 : 1;
        return rule.dir === "asc" ? gap : -gap;
      }
    }
    return compareDefault(a, b);
  });
}

/** 分组：全枚举组保留；assignee = 未指派 + 候选成员 + 数据内出现者 */
export function groupPlanItems(
  items: PlanItemRecordDto[],
  groupBy: "status" | "priority" | "assignee",
  assigneeOptions?: ProjectMemberItemDto[],
): PlanItemGroup[] {
  if (groupBy === "assignee") {
    const groups = new Map<string, PlanItemRecordDto[]>([["unassigned", []]]);
    assigneeOptions?.forEach((member) =>
      groups.set(String(member.userId), []),
    );
    items.forEach((item) => {
      const key =
        item.assigneeId === null ? "unassigned" : String(item.assigneeId);
      const list = groups.get(key) ?? [];
      list.push(item);
      groups.set(key, list);
    });
    const order = [
      "unassigned",
      ...(assigneeOptions?.map((m) => String(m.userId)) ?? []),
    ];
    const extras = [...groups.keys()]
      .filter((key) => !order.includes(key))
      .sort((a, b) => Number(a) - Number(b));
    return [...order, ...extras].map((key) => ({
      key,
      items: groups.get(key) ?? [],
    }));
  }
  const keys = groupBy === "status" ? PLAN_STATUSES : PLAN_PRIORITIES;
  return keys.map((key) => ({
    key,
    items: items.filter((item) =>
      groupBy === "status" ? item.status === key : item.priority === key,
    ),
  }));
}

/** 视图配置容错解析：畸形 JSON / 形状不符 → 空配置 */
export function parsePlanViewConfig(
  filterJson: string,
  sortJson: string,
): { conditions: PlanFilterCondition[]; sortRules: PlanSortRule[] } {
  let conditions: PlanFilterCondition[] = [];
  let sortRules: PlanSortRule[] = [];
  try {
    const parsed: unknown = JSON.parse(filterJson);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { conditions?: unknown }).conditions)
    ) {
      conditions = (parsed as { conditions: PlanFilterCondition[] })
        .conditions;
    }
  } catch {
    // 降级空配置
  }
  try {
    const parsed: unknown = JSON.parse(sortJson);
    if (Array.isArray(parsed)) {
      sortRules = parsed as PlanSortRule[];
    }
  } catch {
    // 降级空规则
  }
  return { conditions, sortRules };
}

/** ISO → 日历日 key（slice 语义，无时区偏移）；空串透传 */
export const isoToDateKey = (iso: string): string => iso.slice(0, 10);

/** 日历日 key → 入库 ISO（UTC 零点，与桌面 dateKeyToIso 同口径） */
export const dateKeyToIso = (key: string): string =>
  `${key}T00:00:00.000Z`;
