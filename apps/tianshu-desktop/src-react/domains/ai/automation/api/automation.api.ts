// src-react/domains/ai/automation/api/automation.api.ts
/**
 * 自动化任务/运行记录/模板 API(IPC 封装)。
 * 日期字段由主进程 toISOString() 归一;source 为后端派生
 * (workspace.directoryPath 有值 = project,无值 = local,spec §0)。
 *
 * 主机路由化（automation/library 批 2026-11-10）：数据面（list/create/
 * update/remove/toggle/runNow/runs）远程态经 remote-catalog 适配器走
 * 无头端 automation 端点——toggle 无专端点（save 全量携 enabled 读改写，
 * Ruling 12）。templates 为本地静态清单（无数据面）远程态直接复用；
 * stat 埋点远程态静默丢弃（fire-and-forget，无远端聚合表）；stats 健康度
 * 聚合依赖本地 automationStat 表即时聚合（server 无等价端点）——远程态
 * 显式拒绝，AutomationStatsPanel 感知主机态渲染占位（挂账：远端聚合端点）。
 */
import { invoke } from "@/lib/ipc";
import { routeInvoke, remoteConnId } from "@/domains/ai/data-source/host-route";
import {
  remoteAutomationDelete,
  remoteAutomationList,
  remoteAutomationRunNow,
  remoteAutomationRuns,
  remoteAutomationSave,
  remoteAutomationStats,
  remoteAutomationToggle,
} from "@/domains/ai/data-source/remote-catalog";
// 健康度总览 wire 类型（core 单源 re-export——2026-11-10 收编：主进程
// IPC 聚合与远程态适配器（automation/stats 原始行端点）同源同口径）
import type { AutomationStats } from "@tianshu/core/automation-stats";
import type { ScheduleConfig } from "./schedule.schema";

export type { AutomationStats };

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
  /** 错过补跑上限（missedPolicy=catchUpOnce 生效，缺省 1；批3A） */
  catchUpLimit: number;
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
  /** 错过补跑上限（批3A）：缺省 1；未携带时 create 落列默认、update 不碰既有值 */
  catchUpLimit?: number;
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
    return routeInvoke({ ch: "automation:list", args: [] }, (connId) =>
      remoteAutomationList(connId),
    );
  }

  static async create(params: TaskCreateParams): Promise<TaskRecord> {
    return routeInvoke(
      { ch: "automation:create", args: [params] },
      (connId) => remoteAutomationSave(params, undefined, connId),
    );
  }

  static async update(
    id: number,
    params: TaskUpdateParams,
  ): Promise<TaskRecord> {
    return routeInvoke(
      { ch: "automation:update", args: [id, params] },
      (connId) => remoteAutomationSave(params, id, connId),
    );
  }

  static async remove(ids: number[]): Promise<void> {
    return routeInvoke({ ch: "automation:delete", args: [ids] }, (connId) =>
      remoteAutomationDelete(ids, connId),
    );
  }

  static async toggle(id: number, enabled: boolean): Promise<TaskRecord> {
    return routeInvoke(
      { ch: "automation:toggle", args: [id, enabled] },
      (connId) => remoteAutomationToggle(id, enabled, connId),
    );
  }

  /** 手动触发一次执行(返回即触发完成,结果经 tasks-changed 事件刷新；
   *  远程态 202 受理同语义——收尾经 automation.changed 事件桥刷新) */
  static async runNow(id: number): Promise<void> {
    return routeInvoke({ ch: "automation:runNow", args: [id] }, (connId) =>
      remoteAutomationRunNow(id, connId),
    );
  }

  static async templates(): Promise<TemplateRecord[]> {
    return invoke<TemplateRecord[]>("automation:templates");
  }

  static async runs(
    page: number,
    taskId?: number,
    status?: RunStatus,
  ): Promise<RunPage> {
    return routeInvoke(
      { ch: "automation:runs:page", args: [page, taskId, status] },
      (connId) => remoteAutomationRuns(page, taskId, status, connId),
    );
  }

  /** 创建埋点(PRD《执行频率》§5)——远程态静默丢弃（本地统计表聚合，
   *  埋点不阻塞不报错语义保持） */
  static async stat(detail: CreateStatDetail): Promise<void> {
    if (remoteConnId() != null) {
      return;
    }
    return invoke<void>("automation:stat", detail);
  }

  /** 健康度总览聚合(spec §6)：本地主进程即时聚合（automationStat rollup
   *  补全）；远程态经 remote-catalog 拉原始行集客户端聚合（时区口径在
   *  computeStats 单源，不跨端假设） */
  static async stats(): Promise<AutomationStats> {
    return routeInvoke({ ch: "automation:stats", args: [] }, (connId) =>
      remoteAutomationStats(connId),
    );
  }
}

/** 任务变更事件通道(scheduler 执行/过期/异常后主进程推送) */
export const AUTOMATION_CHANGED_EVENT = "automation:tasks-changed";
