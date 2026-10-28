/**
 * plan_* 工具卡片富化摘要（三期批 11 D15）：从 ToolCallCard 现有数据源
 * （toolName + args + output）解析四工具的结构化摘要行。纯函数返回 i18n
 * key 与插值参数，字段缺失/畸形输入返回 null——渲染层据此回退现有文本
 * 形态（宁退不崩）。工具实名与输出文案口径对齐
 * electron/domains/ai/agent/plan-tools.ts（如 plan_list_items 的「共 N 项」、
 * fail 的「错误: ...」无计数形态）；状态取值文案 key 复用 STATUS_LABEL_KEYS
 * （PlanItemDialog/TaskOverview 同一来源，不另造映射）。
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

/** plan_create_item：标题可得即摘要（运行中即可渲染，不依赖输出） */
const createDigest = (args: unknown): PlanToolDigest | null => {
  const title = stringArg(args, "title");
  return title ? { key: "chat:tool.plan.create", values: { title } } : null;
};

/** plan_update_status：入参只有目标状态（旧状态不在数据源）——降级为
 *  「#id → 新状态」；id/status 任一缺失或非法枚举 → null */
const updateDigest = (args: unknown): PlanToolDigest | null => {
  if (typeof args !== "object" || args === null) {
    return null;
  }
  const { id, status } = args as Record<string, unknown>;
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

/** plan_append_summary：摘要行截断（卡片头单行语义，内容层兜底） */
const appendDigest = (args: unknown): PlanToolDigest | null => {
  const text = stringArg(args, "text");
  return text
    ? {
        key: "chat:tool.plan.append",
        values: { text: text.trim().slice(0, 60) },
      }
    : null;
};

/** plan_list_items 输出的条目数：「共 N 项」（失败文案「错误: ...」无此
 *  形态；无输出/未完成 → null） */
const listDigest = (output?: string): PlanToolDigest | null => {
  const match = output?.match(/共\s*(\d+)\s*项/);
  return match
    ? { key: "chat:tool.plan.list", values: { count: Number(match[1]) } }
    : null;
};

/** 富化摘要解析：非四工具或可得字段缺失 → null（回退现有文本形态） */
export function planToolDigest(
  toolName: string,
  args: unknown,
  output?: string,
): PlanToolDigest | null {
  switch (toolName) {
    case "plan_create_item":
      return createDigest(args);
    case "plan_update_status":
      return updateDigest(args);
    case "plan_append_summary":
      return appendDigest(args);
    case "plan_list_items":
      return listDigest(output);
    default:
      return null;
  }
}
