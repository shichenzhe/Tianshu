// 自 mirror electron/domains/ai/automation/automation.repo.ts 摘取（GA-T3）。
// 改造点：
// 1. prisma → server 自有 PrismaService（NestJS DI 注入，@Injectable）
// 2. Electron IPC 层（ipcMain/handleUser/BrowserWindow 推送）移除——
//    delete/toggle 处理体收为公开方法 deleteTasks/toggleTask 供 service 消费
// 3. 前端类型（mirror src-react automation.api.ts 的 TaskCreateParams/
//    TaskRecord/RunRecord/RunPage 及枚举）跨仓不可引——本文件内联 type-only 副本
// 4. scheduleSchema/ScheduleConfig/eventJsonSchema/EventTriggerConfig/
//    computeNextRun 改自 @tianshu/core 引（GA-T2 收编，mirror 侧经 re-export 同源）
// 5. 摘取边界（server 消费面 spec §4.1 任务管理）：任务 CRUD；runNow（executor
//    执行链）、templates/stat/stats（computeStats/templates 不在共享包且端点
//    面未列）未摘——后续任务按需补
// 6. TaskRow/RunRow 行类型以 @prisma/client 生成模型名替代 mirror 的
//    Awaited<ReturnType> 推导（server 生成器为 prisma-client-js）
// 7. userId 语义对齐 server user：伴生单用户 COMPANION_USER_ID（service 侧
//    写死传入，repo 保持末位参数形态，见 tianshu-config.entity.ts 头注释）
// GA-T5 增量：8. runNow 接线（GA-T3 时按「executor/runner T5 副本接线」
//    舍去——本任务回补，mirror automation:runNow 处理体逐行保持）：
//    notifyTasksChanged（BrowserWindow 推送）→ deps.publishAutomationChanged
//    钩子（EventBus automation.changed，T6 收口）；taskFinished 链式发布 →
//    deps.publishAutomationEvent 钩子（automation-event-bus 未随摘）；
//    disabledTools/safety 装配面同款注入。其余逻辑逐段保持 mirror 原样。
import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { AutomationRun, AutomationTask, Prisma } from '@prisma/client';
import {
  computeNextRun,
  eventJsonSchema,
  scheduleSchema,
  type EventTriggerConfig,
  type ScheduleConfig,
} from '@tianshu/core';
import { PrismaService } from 'src/commons/database/prisma.service';
import type {
  AutomationChangedPayload,
  AutomationRunNodeRecord,
  AutomationRunPage,
  AutomationRunRecord,
} from '@tianshu/protocol';
import {
  executeTask,
  taskFinishedEvent,
  type AutomationChainEvent,
  type AutomationSafetyOptions,
} from './automation-runner';
import { inflight } from './automation-inflight';

/** 可注入依赖（GA-T5 runNow 接线面；生产走 automation.module 工厂装配
 * T6，测试缺省安全侧） */
export interface AutomationRepoDeps {
  /** 工具禁用清单闭包（SP6 裁定 2）：手动触发与调度执行走同一过滤 */
  disabledTools?: () => string[];
  /** 无人值守安全装配（spec §6 联动 config tianshu.chat 段） */
  safety?: () => AutomationSafetyOptions;
  /** 任务级事件出口（mirror notifyTasksChanged 全窗口广播 → EventBus
   * automation.changed，GA-T6 协议收口——载荷见协议包）；未注入不发 */
  publishAutomationChanged?: (payload: AutomationChangedPayload) => void;
  /** 链式事件发布（mirror automation-event-bus publishAutomationEvent，
   * 总线副本未摘——T-后续接线）；缺省 no-op */
  publishAutomationEvent?: (event: AutomationChainEvent) => void;
}

/** Nest 注入 token（缺席时构造缺省依赖，直连单测无需装配） */
export const AUTOMATION_REPO_DEPS = Symbol('AUTOMATION_REPO_DEPS');

const logger = new Logger('automation-repository');

/** DB 行类型（mirror TaskRow/RunRow 同位） */
type TaskRow = AutomationTask;
type RunRow = AutomationRun;

// ===== 前端契约类型副本（type-only，逐字段自 mirror automation.api.ts）=====

export type AutomationStatus = 'active' | 'error' | 'expired';
export type AutomationSource = 'local' | 'project';
export type MissedPolicy = 'skip' | 'catchUpOnce';
export type AccessMode = 'default' | 'full';
export type RunStatus = 'running' | 'success' | 'failed' | 'skipped';
export type TriggerType =
  'schedule' | 'catchUp' | 'retry' | 'manual' | 'event' | 'subflow' | 'webhook';

/** 任务执行体（prompt 单模型 | graph 编排） */
export type TaskTargetKind = 'prompt' | 'graph';

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
  /** 节点级轨迹 JSON（graphTrace），仅图运行 */
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

// ===== 摘取逻辑（逐段保持 mirror）=====

/** DB 行 + workspace → 前端记录（source 派生规则 spec §0） */
export function toTaskRecord(
  row: TaskRow,
  workspace: { id: number; name: string; directoryPath: string | null } | null,
): TaskRecord {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    workspaceId: row.workspaceId,
    workspaceName: workspace?.name ?? '-',
    source: workspace?.directoryPath ? 'project' : 'local',
    modelId: row.modelId,
    temperature: row.temperature ?? undefined,
    targetKind: row.targetKind === 'graph' ? 'graph' : 'prompt',
    graphId: row.graphId ?? null,
    eventJson: row.eventJson ?? null,
    scheduleJson: row.scheduleJson,
    scheduleText: row.scheduleText,
    startAt: row.startAt?.toISOString(),
    endAt: row.endAt?.toISOString(),
    missedPolicy: row.missedPolicy === 'catchUpOnce' ? 'catchUpOnce' : 'skip',
    accessMode: row.accessMode === 'full' ? 'full' : 'default',
    enabled: row.enabled,
    status: row.status as TaskRecord['status'],
    statusNote: row.statusNote ?? undefined,
    lastRunAt: row.lastRunAt?.toISOString(),
    nextRunAt: row.nextRunAt?.toISOString(),
    templateSlug: row.templateSlug ?? undefined,
    projectId: row.projectId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 创建/更新共用：create params → prisma data（nextRunAt 初算）。不含
 * enabled/status——编辑已暂停任务不得重置用户开关。projectId 未传时写
 * null = 解除项目关联（TaskUpdateParams 全量更新语义，子系统 E）。
 * graph 任务：模型在各节点，modelId=0 占位、prompt 清空；eventJson 经
 * eventJsonSchema 校验后规范化序列（非法结构在保存期即拒） */
export function buildTaskData(params: TaskCreateParams, now: Date) {
  const schedule = scheduleSchema.parse(params.schedule);
  const startAt = params.startAt ? new Date(params.startAt) : null;
  // 以 max(now, startAt) 为起点求首个调度点：触发点永远落在调度语义时刻
  // （如 daily 09:00）而非生效边界，避免生效日零点伪触发一次造成当天双跑
  const base = startAt && startAt > now ? startAt : now;
  const next = computeNextRun(schedule, base);
  return {
    name: params.name,
    workspaceId: params.workspaceId,
    temperature: params.temperature ?? null,
    ...(params.targetKind === 'graph'
      ? {
          targetKind: 'graph' as const,
          graphId: params.graphId ?? null,
          prompt: '',
          modelId: 0,
        }
      : {
          targetKind: 'prompt' as const,
          graphId: null,
          prompt: params.prompt,
          modelId: params.modelId,
        }),
    eventJson: params.eventJson
      ? JSON.stringify(parseEventJson(params.eventJson))
      : null,
    scheduleJson: JSON.stringify(schedule),
    scheduleText: params.scheduleText,
    startAt,
    endAt: params.endAt ? new Date(params.endAt) : null,
    missedPolicy: params.missedPolicy,
    accessMode: params.accessMode ?? 'default',
    templateSlug: params.templateSlug ?? null,
    projectId: params.projectId ?? null,
    nextRunAt: next,
  };
}

/** eventJson → EventTriggerConfig（JSON 非法/结构不合 schema 即抛错） */
export function parseEventJson(eventJson: string): EventTriggerConfig {
  return eventJsonSchema.parse(JSON.parse(eventJson));
}

/** spec §5 防环：taskFinished 目标不得指向任务自身。任务自引用：targetId=
 * 任务 id（create 无 id 传 null 恒过）；图自引用：graph 任务监听自身
 * graphId 的完成——经总线自触发放大执行。graphId 以保存后状态为准
 * （p.graphId 即将落库，create/update 同口径，含 update 改 graphId 撞
 * 事件目标的情形；prompt 任务 graphId=null 恒放行） */
export function assertNoSelfReference(
  eventConfig: EventTriggerConfig,
  taskId: number | null,
  graphId: number | null,
): void {
  if (
    eventConfig.source === 'taskFinished' &&
    eventConfig.targetType === 'task' &&
    eventConfig.targetId === taskId
  ) {
    throw new Error('EVENT_SELF_REFERENCE');
  }
  if (
    eventConfig.source === 'taskFinished' &&
    eventConfig.targetType === 'graph' &&
    graphId !== null &&
    eventConfig.targetId === graphId
  ) {
    throw new Error('EVENT_SELF_REFERENCE');
  }
}

export function toRunRecord(row: RunRow, taskName: string): RunRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    taskName,
    graphId: row.graphId ?? undefined,
    graphTrace: row.graphTrace ?? undefined,
    sessionId: row.sessionId ?? undefined,
    attempt: row.attempt,
    triggerType: row.triggerType as RunRecord['triggerType'],
    status: row.status as RunRecord['status'],
    durationMs: row.durationMs ?? undefined,
    promptTokens: row.promptTokens ?? undefined,
    completionTokens: row.completionTokens ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
  };
}

/**
 * 自动化任务仓储（relationMode=prisma 无外键，userId 归属过滤在查询条件
 * 维护；删除走 prisma.$transaction 连带删 run——应用层级联）。
 */
@Injectable()
export class AutomationRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(AUTOMATION_REPO_DEPS)
    private readonly deps: AutomationRepoDeps = {},
  ) {}

  /** 手动触发（GA-T5 接线，mirror automation:runNow 处理体逐行保持）：
   * triggerType=manual 不消耗调度字段（advanceTask 内直返——lastRunAt/
   * nextRunAt/once expired 均不动，spec §5 与调度对齐） */
  async runNow(id: number, userId: number): Promise<void> {
    const task = await this.prisma.automationTask.findFirst({
      where: { id, userId },
    });
    if (!task) {
      throw new Error(`automation task ${id} not found`);
    }
    // 与调度器共用 inflight 互斥：调度执行中/连点播放直接拒发，防同一
    // 任务并发双跑(重复会话/full 模式重复写盘)
    if (inflight.has(id)) {
      throw new Error('TASK_ALREADY_RUNNING');
    }
    const abort = new AbortController();
    inflight.set(id, abort);
    // 不 await：单次执行可达分钟级，触发即返回。executeTask 内部吞
    // 异常落库，catch 仅兜 create run 之前的意外；收口推送 tasks-changed。
    // taskFinished 收口发布(spec §5)：outcome 在 finally 前取得，手动
    // 触发的运行结束同样成为链式事件源
    void executeTask(task, {
      triggerType: 'manual',
      attempt: 1,
      abort: abort.signal,
      disabledTools: this.deps.disabledTools,
      safety: this.deps.safety?.(),
    })
      .catch((e): 'failed' => {
        logger.error(`自动化执行失败 ${task.id} ${String(e)}`);
        return 'failed';
      })
      .then((outcome) => {
        this.deps.publishAutomationEvent?.(taskFinishedEvent(task, outcome));
      })
      .finally(() => {
        inflight.delete(task.id);
        this.deps.publishAutomationChanged?.({ taskId: task.id });
      });
  }

  /** 供 runner/scheduler 复用的查询：行 → TaskRecord（带 workspace 派生） */
  async hydrate(row: TaskRow): Promise<TaskRecord> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: row.workspaceId },
      select: { id: true, name: true, directoryPath: true },
    });
    return toTaskRecord(row, workspace);
  }

  /** 校验任务归当前用户（不存在与他人所有同报错，不泄露存在性） */
  private async assertTaskOwned(id: number, userId: number): Promise<void> {
    const row = await this.prisma.automationTask.findFirst({
      where: { id, userId },
    });
    if (!row) {
      throw new Error(`automation task ${id} not found`);
    }
  }

  /** 校验任务引用的工作空间与模型归当前用户（model 经 provider 链路）。
   * graph 任务跳过模型校验——模型在各节点，由 executor 自查；graphId
   * 归属在 assertTriggerRefsOwned 另行校验 */
  private async assertTaskRefsOwned(
    workspaceId: number,
    modelId: number,
    userId: number,
    targetKind: TaskCreateParams['targetKind'],
  ): Promise<void> {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, userId },
    });
    if (!workspace) {
      throw new Error('WORKSPACE_NOT_FOUND');
    }
    if (targetKind === 'graph') {
      return;
    }
    const model = await this.prisma.model.findUnique({
      where: { id: modelId },
    });
    if (!model) {
      throw new Error('MODEL_MISSING');
    }
    const provider = await this.prisma.provider.findFirst({
      where: { id: model.providerId, userId },
    });
    if (!provider) {
      throw new Error('PROVIDER_NOT_FOUND');
    }
  }

  /** 触发引用校验（createTask/updateTask 在 assertTaskRefsOwned 后）：
   * graph 任务 graphId 归本人；eventJson 结构合法（buildTaskData 序列化前
   * 先行拒绝）、目标归本人、自引用拒绝（spec §5 防环——任务目标比对任务
   * id，update 用被编辑任务 id、create 传 null；图目标比对 p.graphId） */
  private async assertTriggerRefsOwned(
    p: TaskCreateParams,
    userId: number,
    taskId: number | null,
  ): Promise<void> {
    if (p.targetKind === 'graph') {
      const g = await this.prisma.graphDefinition.findFirst({
        where: { id: p.graphId ?? -1, userId },
      });
      if (!g) {
        throw new Error('GRAPH_NOT_FOUND');
      }
    }
    if (!p.eventJson) {
      return;
    }
    const ev = parseEventJson(p.eventJson);
    assertNoSelfReference(
      ev,
      taskId,
      // 图自引用比对用保存后状态（p.graphId 即将落库）——比查旧行更严，
      // create 无行可查与 update 改 graphId 两态统一覆盖
      p.targetKind === 'graph' ? (p.graphId ?? null) : null,
    );
    if (ev.source === 'taskFinished' && ev.targetType === 'task') {
      await this.assertTaskOwned(ev.targetId, userId);
    } else if (ev.source === 'taskFinished') {
      const g = await this.prisma.graphDefinition.findFirst({
        where: { id: ev.targetId, userId },
      });
      if (!g) {
        throw new Error('EVENT_TARGET_NOT_FOUND');
      }
    }
  }

  async listTasks(userId: number): Promise<TaskRecord[]> {
    const rows = await this.prisma.automationTask.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(rows.map((row) => this.hydrate(row)));
  }

  /** 创建任务（mirror public 同位：IPC 与 create_schedule 工具共用；
   * server 侧供 service/controller 消费） */
  async createTask(p: TaskCreateParams, userId: number): Promise<TaskRecord> {
    await this.assertTaskRefsOwned(
      p.workspaceId,
      p.modelId,
      userId,
      p.targetKind,
    );
    await this.assertTriggerRefsOwned(p, userId, null);
    const row = await this.prisma.automationTask.create({
      data: {
        ...buildTaskData(p, new Date()),
        enabled: true,
        status: 'active',
        userId,
      },
    });
    return this.hydrate(row);
  }

  /** 更新任务（mirror private 经 IPC 暴露，server 改 public 供 service） */
  async updateTask(
    id: number,
    p: TaskCreateParams,
    userId: number,
  ): Promise<TaskRecord> {
    await this.assertTaskOwned(id, userId);
    await this.assertTaskRefsOwned(
      p.workspaceId,
      p.modelId,
      userId,
      p.targetKind,
    );
    await this.assertTriggerRefsOwned(p, userId, id);
    const row = await this.prisma.automationTask.findUnique({ where: { id } });
    const updated = await this.prisma.automationTask.update({
      where: { id },
      data: {
        ...buildTaskData(p, new Date()),
        // 编辑视为续命：原任务已过期（expired）则以新配置复活回 active
        // （nextRunAt 已由 buildTaskData 重算）；其余状态不动——
        // Prisma 传 undefined 表示不更新该字段，不重置用户开关语义
        status: row?.status === 'expired' ? 'active' : undefined,
      },
    });
    return this.hydrate(updated);
  }

  /** 批量删除（mirror automation:delete 处理体）：仅删本人任务（他人 id
   * 混入被过滤），run 与其节点行随任务级联（事务三删，SQLite 无外键）。
   * GA-T6：返回实删 id 清单（控制器据此逐 id 发 automation.changed——
   * 原 void，仅出参增面，处理体逐行保持） */
  async deleteTasks(ids: number[], userId: number): Promise<number[]> {
    const owned = await this.prisma.automationTask.findMany({
      where: { id: { in: ids }, userId },
      select: { id: true },
    });
    const ownedIds = owned.map((row) => row.id);
    if (ownedIds.length === 0) {
      return [];
    }
    // graphRunNode 无 taskId 列（去会话化 2026-10-28，spec §3.1）：run 行
    // 删除前先取 run id 集合连带删节点行，避免孤儿行（graph.repository
    // 删图同款）
    const runIds = (
      await this.prisma.automationRun.findMany({
        where: { taskId: { in: ownedIds } },
        select: { id: true },
      })
    ).map((row) => row.id);
    await this.prisma.$transaction([
      this.prisma.graphRunNode.deleteMany({ where: { runId: { in: runIds } } }),
      this.prisma.automationRun.deleteMany({
        where: { taskId: { in: ownedIds } },
      }),
      this.prisma.automationTask.deleteMany({
        where: { id: { in: ownedIds } },
      }),
    ]);
    return ownedIds;
  }

  /** 启停（mirror automation:toggle 处理体）：重新启用 = 给异常任务恢复
   * 路径——清 statusNote，status 回 active */
  async toggleTask(
    id: number,
    enabled: boolean,
    userId: number,
  ): Promise<TaskRecord> {
    await this.assertTaskOwned(id, userId);
    const row = await this.prisma.automationTask.update({
      where: { id },
      data: {
        enabled,
        ...(enabled && { status: 'active', statusNote: null }),
      },
    });
    return this.hydrate(row);
  }

  /** 运行历史查询条件（mirror listRuns 同语义）：taskId 指定 = 任务口径
   * （归属校验——非本人/不存在返回 null 由调用方出空页，列表语义不暴露
   * 存在性）；缺省 = 本人任务集 OR 并入本人图集（图试运行 run
   * taskId=null 归属图，得以出现在全量列表）；status 服务端下推 */
  private async buildRunWhere(
    taskId: number | undefined,
    status: RunStatus | undefined,
    userId: number,
  ): Promise<Prisma.AutomationRunWhereInput | null> {
    if (taskId !== undefined) {
      const owned = await this.prisma.automationTask.findFirst({
        where: { id: taskId, userId },
        select: { id: true },
      });
      if (!owned) return null;
      return { taskId, ...(status ? { status } : {}) };
    }
    const ownedTasks = await this.prisma.automationTask.findMany({
      where: { userId },
      select: { id: true },
    });
    const ownedGraphIds = (
      await this.prisma.graphDefinition.findMany({
        where: { userId },
        select: { id: true },
      })
    ).map((row) => row.id);
    return {
      OR: [
        { taskId: { in: ownedTasks.map((row) => row.id) } },
        { graphId: { in: ownedGraphIds } },
      ],
      ...(status ? { status } : {}),
    };
  }

  /** 运行历史分页（移动端 CRUD+运行历史批，mirror listRuns 移植）：
   * startedAt desc、PAGE_SIZE 20；taskName 联查补位（图试运行取图名）；
   * 载荷 AutomationRunRecord 剔 graphTrace（协议包 wire 精简面） */
  async listRuns(
    page: number,
    taskId: number | undefined,
    status: RunStatus | undefined,
    userId: number,
  ): Promise<AutomationRunPage> {
    const where = await this.buildRunWhere(taskId, status, userId);
    if (where === null) return { total: 0, items: [] };
    const PAGE_SIZE = 20;
    const [total, rows] = await Promise.all([
      this.prisma.automationRun.count({ where }),
      this.prisma.automationRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ]);
    return {
      total,
      items: await hydrateRunNames(this.prisma, rows),
    };
  }

  /** 运行节点详情（移动端执行详情批，mirror orchestration:runNodes 同
   * 语义移植）：graphRunNode 无用户列，归属两段校验——先查 run 的
   * graphId（prompt 型 run graphId null 直拒空集），再查图 userId（历史
   * graph 行 userId 可空，null 视为可查，对齐 executor 归属口径）；
   * 不符/不存在/老 run 无节点行一律空集（列表语义不暴露存在性）；
   * 行原样透传（input/output 全文库内已截 64KB） */
  async listRunNodes(
    runId: number,
    userId: number,
  ): Promise<AutomationRunNodeRecord[]> {
    const run = await this.prisma.automationRun.findFirst({
      where: { id: runId, graphId: { not: null } },
      select: { graphId: true },
    });
    if (!run?.graphId) {
      return [];
    }
    const graph = await this.prisma.graphDefinition.findUnique({
      where: { id: run.graphId },
      select: { userId: true },
    });
    if (!graph || (graph.userId !== null && graph.userId !== userId)) {
      return [];
    }
    return this.prisma.graphRunNode.findMany({
      where: { runId },
      orderBy: { id: 'asc' },
    });
  }
}

/** run 行批量补名（mirror listRuns 同款）：taskId 行联查任务名、图试运行
 * 行（taskId=null）联查图名补位 */
async function hydrateRunNames(
  prisma: PrismaService,
  rows: RunRow[],
): Promise<AutomationRunRecord[]> {
  const taskIds = rows
    .map((r) => r.taskId)
    .filter((id): id is number => id !== null);
  const graphIds = rows
    .filter((r) => r.taskId === null)
    .map((r) => r.graphId)
    .filter((id): id is number => id !== null);
  const [taskRows, graphRows] = await Promise.all([
    prisma.automationTask.findMany({
      where: { id: { in: taskIds } },
      select: { id: true, name: true },
    }),
    prisma.graphDefinition.findMany({
      where: { id: { in: graphIds } },
      select: { id: true, name: true },
    }),
  ]);
  const names = new Map(taskRows.map((t) => [t.id, t.name]));
  const graphNames = new Map(graphRows.map((g) => [g.id, g.name]));
  return rows.map((r) =>
    toRunRecordWire(
      r,
      r.taskId !== null
        ? (names.get(r.taskId) ?? '-')
        : (graphNames.get(r.graphId ?? -1) ?? '-'),
    ),
  );
}

/** DB 行 + 名 → 运行记录（CRUD 批 wire 精简面：剔 graphTrace——协议包
 * graph-contract.ts AutomationRunRecord 同源注释；与上方 runner 消费的
 * toRunRecord（含 graphTrace 全量面）按消费面区分命名） */
function toRunRecordWire(row: RunRow, taskName: string): AutomationRunRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    taskName,
    graphId: row.graphId ?? undefined,
    sessionId: row.sessionId ?? undefined,
    attempt: row.attempt,
    triggerType: row.triggerType as TriggerType,
    status: row.status as RunStatus,
    durationMs: row.durationMs ?? undefined,
    promptTokens: row.promptTokens ?? undefined,
    completionTokens: row.completionTokens ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
  };
}
