/**
 * 图输入变量归一化（切片 D 2026-10-29）：inputSchema 双形态（旧字符串
 * 简写 ∪ 类型化对象）的统一解析与入口校验/默认值填充。桌面侧试运行与
 * run_workflow 入口统一走这里（required 结构化报错取代模板渲染期的
 * 「模板变量未定义」；default 填充的唯一归一位置）。纯函数零依赖。
 * json 类型（2026-11-05）：容器原生保型/文本 parse 归一，标量互斥拒收。
 */
import type { GraphInputField, InputType } from "./graph-schema";

/** json 容器值形态（2026-11-05 json 类型）：对象/数组原生保型传递，
 *  标量 JSON 与既有标量类型互斥（null 视为缺值） */
export type JsonContainer = Record<string, unknown> | unknown[];

/** 归一化输入变量描述：required 缺省 true——与旧语义等价（此前所有声明
 *  变量事实上必填：模板缺键即报错）；optional 字段按需出现 */
export interface NormalizedInputField {
  key: string;
  type: InputType;
  required: boolean;
  default?: string | number | boolean | JsonContainer;
  enumValues?: string[];
  description?: string;
}

/**
 * inputSchema 原始形态 → 类型化字段清单。非法值防御性按 string 处理
 * （zod 入口 validateGraph 已收口合法形态，此处兜底未过校验的调用方）
 */
export function parseInputSchema(
  raw: Record<string, unknown> | undefined,
): NormalizedInputField[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  return Object.entries(raw).map(([key, value]) => {
    if (value !== null && typeof value === "object") {
      const field = value as GraphInputField;
      return {
        key,
        type: field.type,
        required: field.required ?? true,
        ...(field.default !== undefined ? { default: field.default } : {}),
        ...(field.enumValues ? { enumValues: field.enumValues } : {}),
        ...(field.description ? { description: field.description } : {}),
      };
    }
    return { key, type: "string" as InputType, required: true };
  });
}

/** 输入值类型（模板替换语义下归一为字符串；number/boolean 供 database
 *  参数原生直通；json 容器保型传递——模板替换 stringify 为紧凑文本） */
export type GraphInputValue = string | number | boolean | JsonContainer;

/** 入口校验问题（结构化，切片 D） */
export interface GraphInputIssue {
  key: string;
  code:
    | "required"
    | "invalidNumber"
    | "invalidBoolean"
    | "invalidEnum"
    | "invalidDate"
    | "invalidJson";
  message: string;
}

/** date 归一：yyyy-MM-dd 或可解析日期串 → yyyy-MM-dd；非法返回 null */
function normalizeDate(value: string): string | null {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return trimmed.slice(0, 10);
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString().slice(0, 10);
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);

/**
 * 入口归一（required 校验 + default 填充）：
 * - 缺值（undefined/null/空串）→ default 填充；default === "today" 且
 *   type === "date" → 执行日当天（魔法值仅此一处，归一位置在入口而非
 *   模板层——date 归一为 yyyy-MM-dd，与 strftime('%Y-%m') 等消费兼容）
 * - number：原生数值或可载数字串；boolean：原生或 "true"/"false"
 * - enum：String(value) 须在 enumValues 内；date：归一 yyyy-MM-dd
 * - 未声明键丢弃（防夹带 inputSchema 外的输入）
 */
export function normalizeGraphInputs(
  fields: NormalizedInputField[],
  raw: Record<string, unknown>,
):
  | { ok: true; inputs: Record<string, GraphInputValue> }
  | { ok: false; issues: GraphInputIssue[] } {
  // 空声明直通（旧图语义：inputSchema 未声明但模板仍引用 input.x——
  // 无声明即无从校验，原样透传不设障；有声明才严格收口）。非数组入参
  // 防御性同直通
  if (!Array.isArray(fields) || fields.length === 0) {
    return { ok: true, inputs: raw as Record<string, GraphInputValue> };
  }
  const inputs: Record<string, GraphInputValue> = {};
  const issues: GraphInputIssue[] = [];
  for (const field of fields) {
    const rawValue = raw[field.key];
    let value: unknown =
      rawValue === undefined || rawValue === null || rawValue === ""
        ? undefined
        : rawValue;
    if (value === undefined && field.default !== undefined) {
      value =
        field.default === "today" && field.type === "date"
          ? todayIso()
          : field.default;
    }
    if (value === undefined) {
      if (field.required) {
        issues.push({
          key: field.key,
          code: "required",
          message: `缺少必填输入: ${field.key}（${field.type}）`,
        });
      }
      continue;
    }
    switch (field.type) {
      case "number": {
        const num =
          typeof value === "number" ? value : Number(String(value).trim());
        if (!Number.isFinite(num)) {
          issues.push({
            key: field.key,
            code: "invalidNumber",
            message: `${field.key} 须为数值，收到: ${String(value).slice(0, 40)}`,
          });
          continue;
        }
        inputs[field.key] = num;
        break;
      }
      case "boolean": {
        if (typeof value === "boolean") {
          inputs[field.key] = value;
        } else if (value === "true" || value === "false") {
          inputs[field.key] = value === "true";
        } else {
          issues.push({
            key: field.key,
            code: "invalidBoolean",
            message: `${field.key} 须为布尔（true/false），收到: ${String(value).slice(0, 40)}`,
          });
        }
        break;
      }
      case "enum": {
        const text = String(value);
        if (!field.enumValues || !field.enumValues.includes(text)) {
          issues.push({
            key: field.key,
            code: "invalidEnum",
            message: `${field.key} 须为 [${(field.enumValues ?? []).join("|")}] 之一，收到: ${text.slice(0, 40)}`,
          });
          continue;
        }
        inputs[field.key] = text;
        break;
      }
      case "date": {
        const text = String(value);
        const normalized = normalizeDate(text);
        if (normalized === null) {
          issues.push({
            key: field.key,
            code: "invalidDate",
            message: `${field.key} 须为日期（yyyy-MM-dd 或可解析日期串），收到: ${text.slice(0, 40)}`,
          });
          continue;
        }
        inputs[field.key] = normalized;
        break;
      }
      case "json": {
        // 原生容器保型直收；文本须 parse 为容器归一原生值（标量/null
        // JSON 与既有标量类型互斥——引导改用对应类型）
        if (typeof value === "object" && value !== null) {
          inputs[field.key] = value as JsonContainer;
          break;
        }
        if (typeof value === "string") {
          try {
            const parsed: unknown = JSON.parse(value.trim());
            if (parsed !== null && typeof parsed === "object") {
              inputs[field.key] = parsed as JsonContainer;
              break;
            }
          } catch {
            // 落入下方统一报错
          }
        }
        issues.push({
          key: field.key,
          code: "invalidJson",
          message: `${field.key} 须为 JSON 对象/数组（或其文本），标量请改用对应类型，收到: ${String(value).slice(0, 40)}`,
        });
        break;
      }
      default: {
        inputs[field.key] = typeof value === "string" ? value : String(value);
      }
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, inputs };
}
