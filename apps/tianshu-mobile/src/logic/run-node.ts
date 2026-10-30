/**
 * graphRunNode 行内 JSON 序列 parse（执行详情批）：服务端 AutomationRunNodeRecord
 * 的 errorJson/toolCallsJson/fallbackJson 为字符串序列原样透传（桌面
 * GraphRunTraceView 同构消费），本层做防御性 parse——畸形/老格式一律回落
 * null / 空数组不抛错（渲染层按缺省处理）。另含运行状态展示色映射
 * （history 列表与详情页共用；"__primary__" 占位由渲染层换主题色）。
 */
import type { AutomationRunStatus } from "@tianshu/protocol";

/** 运行状态 → 展示色（红=失败/绿=成功/主题=运行中/灰=跳过；主题色
 * 由调用方注入——历史列表与详情页共用，无 sentinel 泄漏） */
export function runStatusColor(
  status: AutomationRunStatus,
  primary: string,
): string {
  switch (status) {
    case "success":
      return "#34C759";
    case "failed":
      return "#FF3B30";
    case "skipped":
      return "#8E8E93";
    default:
      return primary;
  }
}

/** 运行状态 → orchestration i18n 键名（Record 全枚举：新增状态漏配
 * 即编译错，不静默归入运行中） */
export function runStatusKey(status: AutomationRunStatus): string {
  return STATUS_KEY[status];
}

const STATUS_KEY: Record<AutomationRunStatus, string> = {
  running: "statusRunning",
  success: "statusSuccess",
  failed: "statusFailed",
  skipped: "statusSkipped",
};

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

/** 降级继续标记（code 无消费面，只透出 message） */
export interface RunNodeFallback {
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

function pickString(obj: Record<string, unknown>, key: string): string | undefined {
  return typeof obj[key] === "string" ? (obj[key] as string) : undefined;
}

export function parseNodeError(json: string | null): RunNodeError | null {
  const obj = parseJsonObject(json);
  if (obj === null) return null;
  return {
    code: pickString(obj, "code"),
    toolName: pickString(obj, "toolName"),
    message: pickString(obj, "message"),
    detail: pickString(obj, "detail"),
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
  if (obj === null) return null;
  return { message: pickString(obj, "message") };
}
