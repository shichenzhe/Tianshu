/**
 * plan 工具卡片富化摘要（三期批 11 D15；2026-10-29 工具名精简批次随
 * todo_write/todo_read 坍缩重塑）：从 ToolCallCard 现有数据源
 * （toolName + args + output）解析结构化摘要行。纯函数返回 i18n
 * key 与插值参数，字段缺失/畸形输入返回 null——渲染层据此回退现有文本
 * 形态（宁退不崩）。工具实名与输出文案口径对齐
 * electron/domains/ai/agent/plan-tools.ts（如 todo_read 的「共 N 项」、
 * fail 的「错误: ...」无计数形态）；状态取值文案 key 复用 STATUS_LABEL_KEYS
 * （PlanItemDialog/TaskOverview 同一来源，不另造映射）。
 * 双形状兼容：新批量 {items:[...]}（取首项，卡片头单行语义）与扁平退化
 * 形状（历史 plan_* 老块不迁移，toolName 老名同样分流）；进展字段新名
 * progress / 老名 text 双读。
 */
import {
  PLAN_STATUSES,
  type PlanStatus,
} from "../../../../../electron/domains/project/plan-item.entity";
import { STATUS_LABEL_KEYS } from "@/domains/project/components/PlanItemDialog";

export interface PlanToolDigest {
  /** 摘要 i18n key（chat:tool.plan.*） */
  key: string;
  /** 插值参数（值为最终显示文本） */
  values?: Record<string, string | number>;
  /** 状态取值的 i18n key（project:plan.status*；渲染层先译再插值） */
  statusKey?: string;
}

/** args 安全取非空字符串字段（非对象/字段非字符串/空白 → null） */
function stringArg(args: unknown, name: string): string | null {
  if (typeof args !== "object" || args === null) {
    return null;
  }
  const value = (args as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** 批量形状取首项，扁平形状原样（历史 plan_* 老块/退化入参） */
function firstItem(args: unknown): unknown {
  if (typeof args !== "object" || args === null) {
    return args;
  }
  const items = (args as Record<string, unknown>).items;
  if (Array.isArray(items) && items.length > 0) {
    return items[0];
  }
  return args;
}

/** 新建摘要：标题可得即成立（运行中即可渲染，不依赖输出） */
const createDigest = (item: unknown): PlanToolDigest | null => {
  const title = stringArg(item, "title");
  return title ? { key: "chat:tool.plan.create", values: { title } } : null;
};

/** 状态流转摘要：入参只有目标状态（旧状态不在数据源）——降级为
 *  「#id → 新状态」；id/status 任一缺失或非法枚举 → null */
const updateDigest = (item: unknown): PlanToolDigest | null => {
  if (typeof item !== "object" || item === null) {
    return null;
  }
  const { id, status } = item as Record<string, unknown>;
  if (typeof id !== "number" || typeof status !== "string") {
    return null;
  }
  if (!(PLAN_STATUSES as readonly string[]).includes(status)) {
    return null;
  }
  return {
    key: "chat:tool.plan.update",
    values: { id },
    statusKey: STATUS_LABEL_KEYS[status as PlanStatus],
  };
};

/** 进展摘要：progress（新名）/text（老名）双读，截断 60 字符
 *  （卡片头单行语义，内容层兜底） */
const appendDigest = (item: unknown): PlanToolDigest | null => {
  const text = stringArg(item, "progress") ?? stringArg(item, "text");
  return text
    ? {
        key: "chat:tool.plan.append",
        values: { text: text.trim().slice(0, 60) },
      }
    : null;
};

/** todo_read 输出的条目数：「共 N 项」（失败文案「错误: ...」无此
 *  形态；无输出/未完成 → null） */
const listDigest = (output?: string): PlanToolDigest | null => {
  const match = output?.match(/共\s*(\d+)\s*项/);
  return match
    ? { key: "chat:tool.plan.list", values: { count: Number(match[1]) } }
    : null;
};

/** todo_write 单项 → 摘要：新建 → 流转 → 进展 逐级回落 */
function writeDigest(args: unknown): PlanToolDigest | null {
  const item = firstItem(args);
  return (
    createDigest(item) ?? updateDigest(item) ?? appendDigest(item)
  );
}

/** 富化摘要解析：非计划工具或可得字段缺失 → null（回退现有文本形态）。
 *  老名 plan_*（历史块）与新名 todo_* 同分流 */
export function planToolDigest(
  toolName: string,
  args: unknown,
  output?: string,
): PlanToolDigest | null {
  switch (toolName) {
    case "todo_write":
    case "plan_create_item":
    case "plan_update_status":
    case "plan_append_summary":
      return writeDigest(args);
    case "todo_read":
    case "plan_list_items":
      return listDigest(output);
    default:
      return null;
  }
}
