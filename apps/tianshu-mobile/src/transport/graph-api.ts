/**
 * 编排区遥控 API（M2c）：server 二期 graph/automation 九端点的移动端封装，
 * 桌面蓝本 mirror src-react/domains/ai/server/api/graph.api.ts 的 transport 版。
 * 消费契约：
 * - 判错统一走 wireRequest（activeTransport 缺省注入；HTTP 200 亦可能业务错
 *   4xxx 查 body.success，graph/run 与 automation/runNow 的 202 受理同 success）；
 * - 类型单源 @tianshu/protocol（GraphRecord/TaskRecord），行级必填门禁防
 *   畸形 wire 行——坏行丢弃不抛错（sessions.store toBrief 同款防御口径）；
 * - 启停语义（Ruling 12）：无 toggle 端点——automation/save 全量携翻转后
 *   enabled，查询行 TaskRecord 经 toTaskSaveParams 把 scheduleJson（JSON
 *   字符串）parse 回 schedule 对象；graph 任务 prompt=''/modelId=0 为服务端
 *   占位值原样回传（蓝本同款）。
 */
import {
  ENDPOINTS,
  type AccessMode,
  type AutomationRunPage,
  type AutomationRunRecord,
  type AutomationRunStatus,
  type GraphRecord,
  type MissedPolicy,
  type TaskRecord,
  type TaskTargetKind,
} from "@tianshu/protocol";

import { wireRequest } from "./wire";

/** wire 判别结果的编排面投影：失败臂与 wire.ts WireResult 失败臂同形 */
export type ApiFail = { ok: false; code: string; message: string };
export type ApiResult<T> = { ok: true; data: T } | ApiFail;

export interface QueryResult<T> {
  page: number;
  pageSize: number;
  total: number;
  records: T[];
}

export interface RemoteQueryParams {
  page?: number;
  pageSize?: number;
  keyword?: string;
}

/** 图行必填门禁：协议类型单源，缺关键键的行整行丢弃 */
function isGraphRow(row: unknown): row is GraphRecord {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return typeof r.id === "number" && typeof r.name === "string";
}

/** 任务行必填门禁（scheduleJson 供 toTaskSaveParams parse、enabled 供开关） */
export function toTaskRow(row: unknown): TaskRecord | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "number" || typeof r.name !== "string") return null;
  if (typeof r.scheduleJson !== "string" || typeof r.enabled !== "boolean") {
    return null;
  }
  return row as TaskRecord;
}

function parsePage<T>(
  data: unknown,
  coerce: (row: unknown) => T | null,
): QueryResult<T> | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as {
    records?: unknown;
    total?: unknown;
    page?: unknown;
    pageSize?: unknown;
  };
  if (!Array.isArray(d.records) || typeof d.total !== "number") return null;
  const records = d.records.map(coerce).filter((row): row is T => row !== null);
  return {
    page: typeof d.page === "number" ? d.page : 1,
    pageSize: typeof d.pageSize === "number" ? d.pageSize : records.length,
    total: d.total,
    records,
  };
}

export async function graphQuery(
  params: RemoteQueryParams,
): Promise<ApiResult<QueryResult<GraphRecord>>> {
  const r = await wireRequest("POST", ENDPOINTS.graph.query, params);
  if (!r.ok) return r;
  const page = parsePage(r.data, (row) => (isGraphRow(row) ? row : null));
  return page ? { ok: true, data: page } : { ok: false, code: "", message: "" };
}

export async function graphDelete(id: number): Promise<ApiResult<null>> {
  const r = await wireRequest("POST", ENDPOINTS.graph.delete, { id });
  return r.ok ? { ok: true, data: null } : r;
}

/** 触发试运行：202 受理即回 {runId}，执行流经 graph.run.updated 事件回传 */
export async function graphRun(
  graphId: number,
  inputs?: Record<string, string>,
): Promise<ApiResult<{ runId: number }>> {
  const body = inputs ? { graphId, inputs } : { graphId };
  const r = await wireRequest("POST", ENDPOINTS.graph.run, body);
  if (!r.ok) return r;
  const runId = (r.data as { runId?: unknown } | null)?.runId;
  return typeof runId === "number"
    ? { ok: true, data: { runId } }
    : { ok: false, code: "", message: "" };
}

export async function graphRunAbort(
  runId: number,
): Promise<ApiResult<{ aborted: boolean }>> {
  const r = await wireRequest("POST", ENDPOINTS.graph.runAbort, { runId });
  return r.ok ? { ok: true, data: { aborted: true } } : r;
}

export async function automationList(
  params: RemoteQueryParams,
): Promise<ApiResult<QueryResult<TaskRecord>>> {
  const r = await wireRequest("POST", ENDPOINTS.automation.query, params);
  if (!r.ok) return r;
  const page = parsePage(r.data, toTaskRow);
  return page ? { ok: true, data: page } : { ok: false, code: "", message: "" };
}

/** automation/save 全量载荷（AutomationSaveDto 字段面 + enabled，Ruling 12） */
export interface TaskSaveParams {
  id?: number;
  name: string;
  prompt: string;
  workspaceId: number;
  modelId: number;
  temperature?: number;
  targetKind?: TaskTargetKind;
  graphId?: number;
  eventJson?: string;
  /** ScheduleConfig 对象（查询行 scheduleJson 需 JSON.parse 还原） */
  schedule: Record<string, unknown>;
  scheduleText: string;
  startAt?: string;
  endAt?: string;
  missedPolicy: MissedPolicy;
  accessMode?: AccessMode;
  templateSlug?: string;
  projectId?: number | null;
  enabled: boolean;
}

/** 查询行 → save 全量载荷（enabled 翻转由调用方决定；scheduleJson parse
 * 还原 schedule 对象，坏 JSON 兜底空对象；其余字段原样回传保持全量语义） */
export function toTaskSaveParams(
  task: TaskRecord,
  enabled: boolean,
): TaskSaveParams {
  let schedule: Record<string, unknown>;
  try {
    schedule = JSON.parse(task.scheduleJson) as Record<string, unknown>;
  } catch {
    schedule = {};
  }
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    workspaceId: task.workspaceId,
    modelId: task.modelId,
    temperature: task.temperature,
    targetKind: task.targetKind,
    graphId: task.graphId ?? undefined,
    eventJson: task.eventJson ?? undefined,
    schedule,
    scheduleText: task.scheduleText,
    startAt: task.startAt,
    endAt: task.endAt,
    missedPolicy: task.missedPolicy,
    accessMode: task.accessMode,
    templateSlug: task.templateSlug,
    projectId: task.projectId,
    enabled,
  };
}

export async function automationSave(
  task: TaskSaveParams,
): Promise<ApiResult<TaskRecord | null>> {
  const r = await wireRequest("POST", ENDPOINTS.automation.save, task);
  if (!r.ok) return r;
  return { ok: true, data: toTaskRow(r.data) };
}

export async function automationDelete(
  ids: number[],
): Promise<ApiResult<null>> {
  const r = await wireRequest("POST", ENDPOINTS.automation.delete, { ids });
  return r.ok ? { ok: true, data: null } : r;
}

/** 手动触发：202 受理（不消耗调度字段；收尾经 automation.changed） */
/** 运行历史行判别（CRUD 批）：AutomationRunRecord 必填字段门禁 */
export function toRunRow(row: unknown): AutomationRunRecord | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  if (
    typeof r.id !== "number" ||
    typeof r.taskId !== "number" ||
    typeof r.taskName !== "string" ||
    typeof r.status !== "string" ||
    typeof r.startedAt !== "string"
  ) {
    return null;
  }
  return r as unknown as AutomationRunRecord;
}

/** 运行历史分页（CRUD 批）：page/taskId?/status? 下推；双端同构 */
export async function automationRunPage(params: {
  page: number;
  taskId?: number;
  status?: AutomationRunStatus;
}): Promise<ApiResult<AutomationRunPage>> {
  const r = await wireRequest("POST", ENDPOINTS.automation.runPage, params);
  if (!r.ok) return r;
  const data = r.data as Record<string, unknown>;
  const items = Array.isArray(data.items)
    ? data.items
        .map(toRunRow)
        .filter((row): row is AutomationRunRecord => row !== null)
    : [];
  return {
    ok: true,
    data: {
      total: typeof data.total === "number" ? data.total : items.length,
      items,
    },
  };
}

export async function automationRunNow(
  taskId: number,
): Promise<ApiResult<{ accepted: boolean }>> {
  const r = await wireRequest("POST", ENDPOINTS.automation.runNow, { taskId });
  return r.ok ? { ok: true, data: { accepted: true } } : r;
}
