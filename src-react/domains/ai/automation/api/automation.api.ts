// src-react/domains/ai/automation/api/automation.api.ts
/**
 * 自动化任务/运行记录/模板 API(IPC 封装)。
 * 日期字段由主进程 toISOString() 归一;soruce 为后端派生
 * (workspace.directoryPath 有值 = project,无值 = local,spec §0)。
 */
import { invoke } from "@/lib/ipc";
import type { ScheduleConfig } from "./schedule.schema";

export type AutomationStatus = "active" | "error" | "expired";
export type AutomationSource = "local" | "project";
export type MissedPolicy = "skip" | "catchUpOnce";
export type RunStatus = "running" | "success" | "failed" | "skipped";
export type TriggerType = "schedule" | "catchUp" | "retry";

export interface TaskRecord {
  id: number;
  name: string;
  prompt: string;
  workspaceId: number;
  workspaceName: string;
  source: AutomationSource;
  modelId: number;
  temperature?: number;
  /** ScheduleConfig 的 JSON 序列(组件用 JSON.parse 还原) */
  scheduleJson: string;
  scheduleText: string;
  startAt?: string;
  endAt?: string;
  missedPolicy: MissedPolicy;
  enabled: boolean;
  status: AutomationStatus;
  statusNote?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  templateSlug?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskCreateParams {
  name: string;
  prompt: string;
  workspaceId: number;
  modelId: number;
  temperature?: number;
  schedule: ScheduleConfig;
  scheduleText: string;
  startAt?: string;
  endAt?: string;
  missedPolicy: MissedPolicy;
  templateSlug?: string;
}

export type TaskUpdateParams = TaskCreateParams;

export interface RunRecord {
  id: number;
  taskId: number;
  taskName: string;
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

  static async templates(): Promise<TemplateRecord[]> {
    return invoke<TemplateRecord[]>("automation:templates");
  }

  static async runs(page: number, taskId?: number): Promise<RunPage> {
    return invoke<RunPage>("automation:runs:page", page, taskId);
  }

  static async stat(detail: CreateStatDetail): Promise<void> {
    return invoke<void>("automation:stat", detail);
  }
}

/** 任务变更事件通道(scheduler 执行/过期/异常后主进程推送) */
export const AUTOMATION_CHANGED_EVENT = "automation:tasks-changed";
