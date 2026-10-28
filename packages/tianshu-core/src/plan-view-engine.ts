// packages/tianshu-core/src/plan-view-engine.ts
/**
 * 计划视图筛选引擎（A7 批自 src-react/domains/project/model 下沉，双端复用）：
 * 视图配置（filterJson/sortJson/groupBy）的解释执行层，三纯函数 + 容错解析。
 * 非法条件/规则防御性忽略（单视图坏配置不打崩计划页）。类型以协议包
 * PlanItemRecordDto/ProjectMemberItemDto 为准（与桌面记录结构同形）。
 */
import {
  PLAN_PRIORITIES,
  PLAN_STATUSES,
  type PlanItemRecordDto,
  type ProjectMemberItemDto,
} from "@tianshu/protocol";

export interface FilterCondition {
  field: "title" | "status" | "assigneeId" | "source" | "priority" | "tags";
  op: "contains" | "in" | "notIn" | "isMe" | "notMe";
  value: string | string[];
}

export type SortField =
  "status" | "priority" | "dueDate" | "createdAt" | "title";
export interface SortRule {
  field: SortField;
  dir: "asc" | "desc";
}

export type GroupByField = "status" | "priority" | "assignee";
export interface ItemGroup {
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

/** 值规整为数组（contains 单值也归一） */
const valueList = (value: string | string[]): string[] =>
  Array.isArray(value) ? value : [value];

/** 单条件匹配（未知 field/op 恒真 = 忽略） */
function matchCondition(
  item: PlanItemRecordDto,
  condition: FilterCondition,
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

/** 筛选 + 搜索（标题子串，大小写不敏感）：条件 AND；搜索为独立参数叠加 */
export function filterItems(
  items: PlanItemRecordDto[],
  conditions: FilterCondition[],
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

/** 缺省序（视图无排序规则时沿用现状）：状态序 → sortOrder → id */
function compareDefault(a: PlanItemRecordDto, b: PlanItemRecordDto): number {
  const statusGap =
    PLAN_STATUSES.indexOf(a.status) - PLAN_STATUSES.indexOf(b.status);
  if (statusGap !== 0) {
    return statusGap;
  }
  return a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.id - b.id;
}

/** 规则字段取值（用于比较器） */
function sortValue(item: PlanItemRecordDto, field: SortField): string | number {
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

/** 排序：规则数组按序比较；空规则走缺省序；空字符串日期恒排最后 */
export function sortItems(
  items: PlanItemRecordDto[],
  rules: SortRule[],
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

/** 分组：全枚举组保留（空列也显示）；assignee = un指派 + 候选成员 + 数据内出现者 */
export function groupItems(
  items: PlanItemRecordDto[],
  groupBy: GroupByField,
  assigneeOptions?: ProjectMemberItemDto[],
): ItemGroup[] {
  if (groupBy === "assignee") {
    const groups = new Map<string, PlanItemRecordDto[]>([["unassigned", []]]);
    assigneeOptions?.forEach((member) => groups.set(String(member.userId), []));
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
export function parseViewConfig(
  filterJson: string,
  sortJson: string,
): { conditions: FilterCondition[]; sortRules: SortRule[] } {
  let conditions: FilterCondition[] = [];
  let sortRules: SortRule[] = [];
  try {
    const parsed: unknown = JSON.parse(filterJson);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { conditions?: unknown }).conditions)
    ) {
      conditions = (parsed as { conditions: FilterCondition[] }).conditions;
    }
  } catch {
    // 降级空配置
  }
  try {
    const parsed: unknown = JSON.parse(sortJson);
    if (Array.isArray(parsed)) {
      sortRules = parsed as SortRule[];
    }
  } catch {
    // 降级空规则
  }
  return { conditions, sortRules };
}
