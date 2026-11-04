/**
 * 编排区遥控 API（GA-T8）：graph/automation 九端点 IPC 封装 + 编排事件订阅。
 * 消费契约（与 server.api.ts session 面同款）：
 * - 通道返回 {status, body} 全信封，判错查 body.success（graph/run 与
 *   automation/runNow 受理是 202，也是成功）
 * - 启停语义（Ruling 12）：无 toggle 端点——automation/save 全量携
 *   enabled 字段（save 载荷类型 RemoteTaskSaveParams，查询行 TaskRecord
 *   需经 scheduleJson 反序列化还原 schedule 对象）
 * - 事件：graph.run.updated / automation.changed 经 `server:event:<connId>`
 *   合并通道（载荷类型 @tianshu/protocol 单份权威源）。automation.changed
 *   是刷新信号不是状态镜像（协议头注释口径）——消费端一律以重拉列表为准
 * - wire 类型为 tianshu-server graph.repository / automation.repository
 *   出参的 type-only 同构副本（跨仓无共享运行时，字段逐一对齐）
 */
import { on } from "@/lib/ipc";
import type {
  AutomationChangedPayload,
  GraphRunUpdatedPayload,
} from "@tianshu/protocol";
import { requestRemote } from "./server.api";

/** 图定义行（GraphRecord 同构副本：nodeCount 由服务端自 graphJson 派生） */
export interface RemoteGraphRecord {
  id: number;
  name: string;
  description?: string;
  graphJson: string;
  version: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
}

/** webhook 配置提交面（enable 四项全可缺省，缺省即服务端默认值） */
export interface RemoteWebhookConfig {
  responseTemplate?: string;
  statusCode?: number;
  async?: boolean;
  fullAccess?: boolean;
}

/** webhook 管理三端点回参（tianshu-server WebhookManageResult 同构副本：
 * url 为相对路径 /webhook/<token>，控制端按主机地址拼绝对） */
export interface RemoteWebhookManage {
  enabled: boolean;
  url: string;
  responseTemplate?: string;
  statusCode?: number;
  async?: boolean;
  fullAccess?: boolean;
}

export interface RemoteGraphPage {
  page: number;
  pageSize: number;
  total: number;
  records: RemoteGraphRecord[];
}

/** 自动化任务行（TaskRecord 同构副本；时间均为 ISO 字符串，按字符串展示） */
export interface RemoteTaskRecord {
  id: number;
  name: string;
  prompt: string;
  workspaceId: number;
  workspaceName: string;
  source: "local" | "project";
  modelId: number;
  temperature?: number;
  targetKind: "prompt" | "graph";
  graphId: number | null;
  eventJson: string | null;
  scheduleJson: string;
  scheduleText: string;
  startAt?: string;
  endAt?: string;
  missedPolicy: "skip" | "catchUpOnce";
  accessMode: "default" | "full";
  enabled: boolean;
  status: "active" | "error" | "expired";
  statusNote?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  templateSlug?: string;
  projectId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteTaskPage {
  page: number;
  pageSize: number;
  total: number;
  records: RemoteTaskRecord[];
}

/** automation/save 全量载荷（AutomationSaveDto 字段面 + enabled，Ruling 12） */
export interface RemoteTaskSaveParams {
  id?: number;
  name: string;
  prompt: string;
  workspaceId: number;
  modelId: number;
  temperature?: number;
  targetKind?: "prompt" | "graph";
  graphId?: number;
  eventJson?: string;
  /** ScheduleConfig 对象（查询行 scheduleJson 需 JSON.parse 还原） */
  schedule: Record<string, unknown>;
  scheduleText: string;
  startAt?: string;
  endAt?: string;
  missedPolicy: "skip" | "catchUpOnce";
  accessMode?: "default" | "full";
  templateSlug?: string;
  projectId?: number | null;
  enabled: boolean;
}

/** 查询行 → save 全量载荷（enabled 翻转由调用方决定；无编辑器，其余
 * 字段原样回传保持「全量」语义） */
export function toTaskSaveParams(
  task: RemoteTaskRecord,
  enabled: boolean,
): RemoteTaskSaveParams {
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

/** run 状态展示态（wire 投影枚举 + 客户端初始 idle） */
export type GraphRunState = GraphRunUpdatedPayload["state"] | "idle";

export interface RemoteQueryParams {
  page?: number;
  pageSize?: number;
  keyword?: string;
}

export default class GraphApi {
  static async graphList(
    params: RemoteQueryParams,
    connId: string,
  ): Promise<RemoteGraphPage> {
    return requestRemote<RemoteGraphPage>("server:graphQuery", params, connId);
  }

  static async graphSave(
    record: unknown,
    connId: string,
  ): Promise<RemoteGraphRecord> {
    return requestRemote<RemoteGraphRecord>("server:graphSave", record, connId);
  }

  static async graphDelete(id: number, connId: string): Promise<void> {
    await requestRemote("server:graphDelete", { id }, connId);
  }

  /** webhook 配置（WH 消费端批）：开启（重开换 token 旧失效）——config
   * 四项全可缺省；返回相对 url（控制端拼主机地址，WH 批适配点 6） */
  static async webhookEnable(
    graphId: number,
    connId: string,
    config?: RemoteWebhookConfig,
  ): Promise<RemoteWebhookManage> {
    return requestRemote<RemoteWebhookManage>(
      "server:webhookEnable",
      { graphId, ...config },
      connId,
    );
  }

  /** 关闭（幂等；该图在途 webhook 运行一并中止） */
  static async webhookDisable(
    graphId: number,
    connId: string,
  ): Promise<RemoteWebhookManage> {
    return requestRemote<RemoteWebhookManage>(
      "server:webhookDisable",
      { graphId },
      connId,
    );
  }

  /** 状态回显（未注册 {enabled:false,url:""}） */
  static async webhookStatus(
    graphId: number,
    connId: string,
  ): Promise<RemoteWebhookManage> {
    return requestRemote<RemoteWebhookManage>(
      "server:webhookStatus",
      { graphId },
      connId,
    );
  }

  /** 触发试运行：202 受理即回 {runId}，执行流经 graph.run.updated 事件回传 */
  static async graphRun(
    graphId: number,
    connId: string,
    inputs?: Record<string, string>,
  ): Promise<{ runId: number }> {
    return requestRemote<{ runId: number }>(
      "server:graphRun",
      inputs ? { graphId, inputs } : { graphId },
      connId,
    );
  }

  static async graphRunAbort(
    runId: number,
    connId: string,
  ): Promise<{ aborted: boolean }> {
    return requestRemote<{ aborted: boolean }>(
      "server:graphRunAbort",
      { runId },
      connId,
    );
  }

  static async automationList(
    params: RemoteQueryParams,
    connId: string,
  ): Promise<RemoteTaskPage> {
    return requestRemote<RemoteTaskPage>(
      "server:automationQuery",
      params,
      connId,
    );
  }

  static async automationSave(
    task: RemoteTaskSaveParams,
    connId: string,
  ): Promise<RemoteTaskRecord> {
    return requestRemote<RemoteTaskRecord>(
      "server:automationSave",
      task,
      connId,
    );
  }

  static async automationDelete(ids: number[], connId: string): Promise<void> {
    await requestRemote("server:automationDelete", { ids }, connId);
  }

  /** 手动触发：202 受理（不消耗调度字段；收尾经 automation.changed） */
  static async automationRunNow(
    taskId: number,
    connId: string,
  ): Promise<{ accepted: boolean }> {
    return requestRemote<{ accepted: boolean }>(
      "server:automationRunNow",
      { taskId },
      connId,
    );
  }
}

/** 编排区消费的合并通道事件（server:event:<connId> 载荷子集；事件类型
 * 自 @tianshu/protocol 单份权威源派生，server.connected 供重连全量刷新） */
export type RemoteOrchestrationEvent =
  | { type: "graph.run.updated"; payload: GraphRunUpdatedPayload }
  | { type: "automation.changed"; payload: AutomationChangedPayload }
  | {
      type: "server.connected";
      payload: { instanceId: string; capabilities: string[] };
    };

/**
 * 订阅连接级编排事件（server:event:<connId> 合并通道——与
 * server.api.onRemoteEvent 同通道多监听器并存），返回卸载
 */
export function onRemoteGraphEvent(
  connId: string,
  listener: (event: RemoteOrchestrationEvent) => void,
): () => void {
  return on(`server:event:${connId}`, (_, event) => {
    const type = (event as { type?: unknown } | null)?.type;
    if (
      type === "graph.run.updated" ||
      type === "automation.changed" ||
      type === "server.connected"
    ) {
      listener(event as RemoteOrchestrationEvent);
    }
  });
}
