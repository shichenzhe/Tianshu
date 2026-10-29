/**
 * graphRunNode 行内 JSON 序列 parse（执行详情批）：服务端 AutomationRunNodeRecord
 * 的 errorJson/toolCallsJson/fallbackJson 为字符串序列原样透传（桌面
 * GraphRunTraceView 同构消费），本层做防御性 parse——畸形/老格式一律回落
 * null / 空数组不抛错（渲染层按缺省处理）。另含运行状态展示色映射
 * （history 列表与详情页共用；"__primary__" 占位由渲染层换主题色）。
 */
import type { AutomationRunStatus } from "@tianshu/protocol";

/** 运行状态 → 展示色（红=失败/绿=成功/主题=运行中/灰=跳过） */
export function runStatusColor(status: AutomationRunStatus): string {
  switch (status) {
    case "success":
      return "#34C759";
    case "failed":
      return "#FF3B30";
    case "skipped":
      return "#8E8E93";
    default:
      return "__primary__";
  }
}

/** 节点失败结构（trace error 同构：code/toolName/message/detail 全可选） */
export interface RunNodeError {
  code?: string;
  toolName?: string;
  message?: string;
  detail?: string;
}

/** 工具调用摘要行（name 必有；ok 缺省视为 true 同桌面渲染口径） */
export interface RunNodeToolCall {
  name: string;
  ok: boolean;
  durationMs?: number;
}

/** 降级继续标记 */
export interface RunNodeFallback {
  code?: string;
  message?: string;
}

function parseJsonObject(json: string | null): Record<string, unknown> | null {
  if (json == null) return null;
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseNodeError(json: string | null): RunNodeError | null {
  const obj = parseJsonObject(json);
  return obj === null
    ? null
    : {
        ...(typeof obj.code === "string" ? { code: obj.code } : {}),
        ...(typeof obj.toolName === "string" ? { toolName: obj.toolName } : {}),
        ...(typeof obj.message === "string" ? { message: obj.message } : {}),
        ...(typeof obj.detail === "string" ? { detail: obj.detail } : {}),
      };
}

export function parseNodeToolCalls(json: string | null): RunNodeToolCall[] {
  if (json == null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((row) => {
    if (typeof row !== "object" || row === null) return [];
    const r = row as Record<string, unknown>;
    if (typeof r.name !== "string") return [];
    return [
      {
        name: r.name,
        ok: typeof r.ok === "boolean" ? r.ok : true,
        ...(typeof r.durationMs === "number" ? { durationMs: r.durationMs } : {}),
      },
    ];
  });
}

export function parseNodeFallback(json: string | null): RunNodeFallback | null {
  const obj = parseJsonObject(json);
  return obj === null
    ? null
    : {
        ...(typeof obj.code === "string" ? { code: obj.code } : {}),
        ...(typeof obj.message === "string" ? { message: obj.message } : {}),
      };
}
