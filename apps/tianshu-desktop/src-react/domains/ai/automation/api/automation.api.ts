// src-react/domains/ai/automation/api/automation.api.ts
/**
 * 自动化任务/运行记录/模板 API(IPC 封装)。
 * 日期字段由主进程 toISOString() 归一;source 为后端派生
 * (workspace.directoryPath 有值 = project,无值 = local,spec §0)。
 */
import { invoke } from "@/lib/ipc";
import type { ScheduleConfig } from "./schedule.schema";

export type AutomationStatus = "active" | "error" | "expired";
export type AutomationSource = "local" | "project";
export type MissedPolicy = "skip" | "catchUpOnce";
export type AccessMode = "default" | "full";
export type RunStatus = "running" | "success" | "failed" | "skipped";
export type TriggerType =
  "schedule" | "catchUp" | "retry" | "manual" | "event" | "subflow" | "webhook";

/** 任务执行体(prompt 单模型 | graph 编排) */
export type TaskTargetKind = "prompt" | "graph";

/** 事件触发配置(spec §5)：appStarted 启动即发；taskFinished 链式——
 * 目标任务/图运行结束按 on 匹配触发。JSON 序列存 automationTask.eventJson */
export type EventTriggerConfig =
  | { source: "appStarted" }
  | {
      source: "taskFinished";
      targetType: "task" | "graph";
      targetId: number;
      on: "success" | "failed" | "any";
    };

export interface TaskRecord {
  id: number;
  name: string;
  prompt: string;
  workspaceId: number;
  workspaceName: string;
  source: AutomationSource;
  modelId: number;
  temperature?: number;
  /** 任务执行体：graph 任务模型在各节点，modelId=0 占位 */
  targetKind: TaskTargetKind;
  /** targetKind=graph 时指向编排图，prompt 任务为 null */
  graphId: number | null;
  /** 事件触发配置(EventTriggerConfig 的 JSON 序列)，null=未配置 */
  eventJson: string | null;
  /** ScheduleConfig 的 JSON 序列(组件用 JSON.parse 还原) */
  scheduleJson: string;
  scheduleText: string;
  startAt?: string;
  endAt?: string;
  missedPolicy: MissedPolicy;
  accessMode: AccessMode;
  enabled: boolean;
  status: AutomationStatus;
  statusNote?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  templateSlug?: string;
  /** 所属项目 id，null = 全局任务（子系统 E） */
  projectId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskCreateParams {
  name: string;
  prompt: string;
  workspaceId: number;
  modelId: number;
  temperature?: number;
  /** 缺省 prompt；graph 任务模型在各节点，modelId 允许 0 占位提交 */
  targetKind?: TaskTargetKind;
  graphId?: number;
  /** EventTriggerConfig 的 JSON 序列，缺省不配置事件触发 */
  eventJson?: string;
  schedule: ScheduleConfig;
  scheduleText: string;
  startAt?: string;
  endAt?: string;
  missedPolicy: MissedPolicy;
  accessMode?: AccessMode;
  templateSlug?: string;
  /** 所属项目 id；缺省/null = 全局任务（子系统 E） */
  projectId?: number | null;
}

export type TaskUpdateParams = TaskCreateParams;

export interface RunRecord {
  id: number;
  /** 图试运行无任务归属时为 null（taskName 取图名） */
  taskId: number | null;
  taskName: string;
  /** 图运行关联的编排图（prompt 任务 run 无此字段） */
  graphId?: number;
  /** 节点级轨迹 JSON(spec §4 graphTrace)，仅图运行 */
  graphTrace?: string;
  sessionId?: number;
  attempt: number;
  triggerType: TriggerType;
  status: RunStatus;
  durationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface RunPage {
  total: number;
  items: RunRecord[];
}

/** 健康度总览聚合(spec §6，IPC automation:stats 即时聚合返回) */
export interface AutomationStats {
  today: {
    total: number;
    success: number;
    failed: number;
    running: number;
    successRate: number;
  };
  trend: Array<{ date: string; success: number; failed: number }>;
  /** 「需要关注」清单：任务级异常(跳任务编辑) + 近 24h 失败 run(跳运行记录/轨迹) */
  attention: Array<
    | {
        kind: "taskError";
        taskId: number;
        name: string;
        statusNote: string;
      }
    | {
        kind: "failedRun";
        runId: number;
        name: string;
        graphId?: number;
        error: string;
        startedAt: string;
      }
  >;
  errorTaskCount: number;
}

export interface TemplateRecord {
  slug: string;
  icon: string;
  titleI18nKey: string;
  descI18nKey: string;
  prompt: string;
  scheduleJson: string;
  temperature: number;
}

/** 创建埋点载荷(PRD《执行频率》§5 三项统计合一) */
export interface CreateStatDetail {
  mode: "periodic" | "interval";
  kind: string;
  hasEndAt: boolean;
  tabSwitchCount: number;
}

export class AutomationApi {
  static async list(): Promise<TaskRecord[]> {
    return invoke<TaskRecord[]>("automation:list");
  }

  static async create(params: TaskCreateParams): Promise<TaskRecord> {
    return invoke<TaskRecord>("automation:create", params);
  }

  static async update(
    id: number,
    params: TaskUpdateParams,
  ): Promise<TaskRecord> {
    return invoke<TaskRecord>("automation:update", id, params);
  }

  static async remove(ids: number[]): Promise<void> {
    return invoke<void>("automation:delete", ids);
  }

  static async toggle(id: number, enabled: boolean): Promise<TaskRecord> {
    return invoke<TaskRecord>("automation:toggle", id, enabled);
  }

  /** 手动触发一次执行(返回即触发完成,结果经 tasks-changed 事件刷新) */
  static async runNow(id: number): Promise<void> {
    return invoke<void>("automation:runNow", id);
  }

  static async templates(): Promise<TemplateRecord[]> {
    return invoke<TemplateRecord[]>("automation:templates");
  }

  static async runs(
    page: number,
    taskId?: number,
    status?: RunStatus,
  ): Promise<RunPage> {
    return invoke<RunPage>("automation:runs:page", page, taskId, status);
  }

  static async stat(detail: CreateStatDetail): Promise<void> {
    return invoke<void>("automation:stat", detail);
  }

  /** 健康度总览聚合(spec §6,主进程即时聚合无分页) */
  static async stats(): Promise<AutomationStats> {
    return invoke<AutomationStats>("automation:stats");
  }
}

/** 任务变更事件通道(scheduler 执行/过期/异常后主进程推送) */
export const AUTOMATION_CHANGED_EVENT = "automation:tasks-changed";
