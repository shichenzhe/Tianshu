/**
 * graph 线上契约类型（GA-T1 自 mirror 收编，原位改 re-export）：
 * - GraphIssue：validateGraph 结构化校验问题的协议形态（编辑器与执行器
 *   共用，服务端二期 run/automation 消费同构）。
 * - GraphRecord/TaskRecord/GraphRunStatus（M2a）：编排区记录契约，自
 *   tianshu-server repository 收编，三端单源（详见下节头注释）。
 * - AutomationRunRecord/AutomationRunPage（CRUD 批）：runPage 运行历史
 *   载荷——桌面 RunRecord 剔 graphTrace 精简面。
 * 收编边界（协议包零运行时依赖铁律）：graph.schema 的 zod schema 常量
 * （节点联合/边/图等全部 schema）与其 z.infer 推断类型（GraphNode/
 * GraphEdge/GraphJson 等）依赖 schema 运行时，留 mirror 原位；本包只收
 * 与 zod 无耦合的纯类型声明。历史出处在 mirror
 * src-react/domains/ai/orchestration/api/graph.schema.ts（现为
 * re-export 兼容层，老 import 链不变）。
 */

/**
 * 结构化校验问题（CLAUDE.md i18n 红线）：code 供渲染端查
 * `chat:orchestration.validation.<code>` 本地化，params 为插值变量；
 * zod 层错误包装为 code:"schema"，message（zod 原文）原样展示；path 中
 * nodes.<下标> 还原为节点 id 并附带 nodeId 供编辑器定位（节点级 refine
 * 的标记 issue 例外，还原为自身 code+params）。
 * 已知 codes：duplicateNodeId / reservedNodeId / uniqueEntry /
 * danglingEdge / conditionNotBranchable / conditionValueOutOfRange /
 * branchOptionsRequired / iterateItemsRequired / iterateCountRequired /
 * iterateBreakRequired / duplicateStartNode / startIncomingEdge / schema。
 */
import type { GraphRunUpdatedPayload } from "./server-event";

export interface GraphIssue {
  code: string;
  params?: Record<string, string | number>;
}

/**
 * 编排区记录契约（M2a 自 tianshu-server repository 收编，三端单源）：
 * - GraphRecord：图记录（出处 src/modules/graph/graph.repository.ts，与
 *   mirror orchestration.api.ts 逐字段一致）；
 * - TaskRecord：自动化任务记录（出处 src/modules/automation/
 *   automation.repository.ts，与 mirror automation.api.ts 逐字段一致）及
 *   其字面量枚举（AutomationSource/TaskTargetKind/MissedPolicy/
 *   AccessMode/AutomationStatus）。
 * server 仓后续可改 import 此处消双份（本次仅收编，不改动其消费）。
 * 时间字段 ISO string——wire 口径同 server-event 头注记（server 仓内
 * toGraphRecord/toTaskRecord 出参即 .toISOString() 字符串，无 Date 直传）。
 * 收编边界（协议包零运行时依赖铁律）：TaskCreateParams 等入参类型依赖
 * @tianshu/core 的 ScheduleConfig（zod schema 运行时域），留各仓原位；
 * 本包只收与运行时无耦合的记录形态。
 */
export type AutomationStatus = "active" | "error" | "expired";
export type AutomationSource = "local" | "project";
export type MissedPolicy = "skip" | "catchUpOnce";
export type AccessMode = "default" | "full";

/** 任务执行体（prompt 单模型 | graph 编排） */
export type TaskTargetKind = "prompt" | "graph";

/** 前端图记录（nodeCount 由 graphJson 派生，坏 JSON 容错 0，列表卡片直显） */
export interface GraphRecord {
  id: number;
  name: string;
  description?: string;
  graphJson: string;
  /** 乐观锁：编辑保存需携带，与库内不符 → VERSION_CONFLICT */
  version: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
}

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
  /** 事件触发配置（EventTriggerConfig 的 JSON 序列），null=未配置 */
  eventJson: string | null;
  /** ScheduleConfig 的 JSON 序列（组件用 JSON.parse 还原） */
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

/** 运行状态（automationRun.status；RunStatus 四值，桌面 automation.api.ts 同款） */
export type AutomationRunStatus = "running" | "success" | "failed" | "skipped";

/** 触发类型（automationRun.triggerType，桌面 automation.api.ts TriggerType 同款） */
export type AutomationTriggerType =
  "schedule" | "catchUp" | "retry" | "manual" | "event" | "subflow" | "webhook";

/**
 * 运行记录契约（automation/runPage 端点载荷，移动端 CRUD+运行历史批）：
 * 桌面 RunRecord（automation.api.ts）剔 graphTrace——节点轨迹 JSON 体积大
 * 且小屏无消费面，轨迹详情留档；桌面被控面与无头端 runPage 同构产出。
 * 时间字段 ISO string，口径同上节注记。
 */
export interface AutomationRunRecord {
  id: number;
  /** 图试运行无任务归属时为 null（taskName 取图名） */
  taskId: number | null;
  taskName: string;
  /** 图运行关联的编排图（prompt 任务 run 无此字段） */
  graphId?: number;
  /** 图运行去会话化（2026-10-28）后恒 null——face runPage wire 实际可空 */
  sessionId?: number | null;
  attempt: number;
  triggerType: AutomationTriggerType;
  status: AutomationRunStatus;
  durationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

/** runPage 分页载荷（total + 当前页 items） */
export interface AutomationRunPage {
  total: number;
  items: AutomationRunRecord[];
}

/** run 状态投影便捷别名（单源自 server-event GraphRunUpdatedPayload 的
 * state——勿在别处双写枚举值；aborted=failed+user_aborted 展示精化，
 * queued 保留给控制层队列语义，见该处注释。M2c 改名 State→Status：与
 * @tianshu/core 的 GraphRunState 执行态 interface 同名异义，移动端遥控
 * 消费面先撞名，三端以 Status 统称投影枚举） */
export type GraphRunStatus = GraphRunUpdatedPayload["state"];
