/**
 * 自动化任务仓储 + IPC(spec §6)。
 * 不实例化 SessionRepository(其构造注册 IPC 有副作用);删除走
 * prisma.$transaction 连带删 run(应用层级联,SQLite 无外键)。
 */
import { ipcMain } from "electron";
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import { handleUser } from "../../../commons/ipc-user";
import {
  scheduleSchema,
  type ScheduleConfig,
} from "../../../../src-react/domains/ai/automation/api/schedule.schema";
import {
  eventJsonSchema,
  type EventTriggerConfig,
} from "../../../../src-react/domains/ai/orchestration/api/graph.schema";
import {
  type TaskCreateParams,
  type TaskRecord,
  type RunRecord,
  type RunPage,
  type TemplateRecord,
  type CreateStatDetail,
  type AutomationStats,
} from "../../../../src-react/domains/ai/automation/api/automation.api";
import { computeStats, type StatsRunRow } from "./automation-stats";
import { computeNextRun } from "./schedule";
import { listAutomationTemplates } from "./automation-templates";
import { recordAutomationEvent } from "./automation-stat";
import { executeTask } from "./automation-runner";
import { inflight } from "./automation-inflight";
import {
  AUTOMATION_TOOL_NAME,
  makeAutomationTool,
} from "../agent/automation-tool";
import { registerTools, unregisterTools } from "../agent/tool-registry";
import {
  publishAutomationEvent,
  taskFinishedEvent,
} from "./automation-event-bus";
import { emitAutomationChanged } from "./automation-change-bus";

type TaskRow = NonNullable<
  Awaited<ReturnType<typeof prisma.automationTask.findFirst>>
>;
type RunRow = NonNullable<
  Awaited<ReturnType<typeof prisma.automationRun.findFirst>>
>;

/** 手动执行收口推送:同 scheduler.notifyChanged 机制(不引 scheduler 实例),
 * executeTask 本身不推送,runNow 须自行通知渲染层刷新——CRUD 批起经
 * automation-change-bus 扇出（face 桥 → automation.changed 远程端） */

/** DB 行 + workspace → 前端记录(source 派生规则 spec §0) */
export function toTaskRecord(
  row: TaskRow,
  workspace: { id: number; name: string; directoryPath: string | null } | null,
): TaskRecord {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    workspaceId: row.workspaceId,
    workspaceName: workspace?.name ?? "-",
    source: workspace?.directoryPath ? "project" : "local",
    modelId: row.modelId,
    temperature: row.temperature ?? undefined,
    targetKind: row.targetKind === "graph" ? "graph" : "prompt",
    graphId: row.graphId ?? null,
    eventJson: row.eventJson ?? null,
    scheduleJson: row.scheduleJson,
    scheduleText: row.scheduleText,
    startAt: row.startAt?.toISOString(),
    endAt: row.endAt?.toISOString(),
    missedPolicy: row.missedPolicy === "catchUpOnce" ? "catchUpOnce" : "skip",
    accessMode: row.accessMode === "full" ? "full" : "default",
    enabled: row.enabled,
    status: row.status as TaskRecord["status"],
    statusNote: row.statusNote ?? undefined,
    lastRunAt: row.lastRunAt?.toISOString(),
    nextRunAt: row.nextRunAt?.toISOString(),
    templateSlug: row.templateSlug ?? undefined,
    projectId: row.projectId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 创建/更新共用:create params → prisma data(nextRunAt 初算)。不含
 * enabled/status——编辑已暂停任务不得重置用户开关。projectId 未传时写
 * null = 解除项目关联（TaskUpdateParams 全量更新语义，子系统 E）。
 * graph 任务:模型在各节点，modelId=0 占位、prompt 清空；eventJson 经
 * eventJsonSchema 校验后规范化序列（非法结构在保存期即拒） */
export function buildTaskData(params: TaskCreateParams, now: Date) {
  const schedule = scheduleSchema.parse(params.schedule) as ScheduleConfig;
  const startAt = params.startAt ? new Date(params.startAt) : null;
  // 以 max(now, startAt) 为起点求首个调度点:触发点永远落在调度语义时刻
  // (如 daily 09:00)而非生效边界,避免生效日零点伪触发一次造成当天双跑
  const base = startAt && startAt > now ? startAt : now;
  const next = computeNextRun(schedule, base);
  return {
    name: params.name,
    workspaceId: params.workspaceId,
    temperature: params.temperature ?? null,
    ...(params.targetKind === "graph"
      ? {
          targetKind: "graph" as const,
          graphId: params.graphId ?? null,
          prompt: "",
          modelId: 0,
        }
      : {
          targetKind: "prompt" as const,
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
    accessMode: params.accessMode ?? "default",
    templateSlug: params.templateSlug ?? null,
    projectId: params.projectId ?? null,
    nextRunAt: next,
  };
}

/** eventJson → EventTriggerConfig(JSON 非法/结构不合 schema 即抛错) */
export function parseEventJson(eventJson: string): EventTriggerConfig {
  return eventJsonSchema.parse(JSON.parse(eventJson)) as EventTriggerConfig;
}

/** spec §5 防环:taskFinished 目标不得指向任务自身。任务自引用:targetId=
 * 任务 id（create 无 id 传 null 恒过）；图自引用:graph 任务监听自身
 * graphId 的完成——经总线自触发放大执行。graphId 以保存后状态为准
 * （p.graphId 即将落库，create/update 同口径，含 update 改 graphId 撞
 * 事件目标的情形；prompt 任务 graphId=null 恒放行） */
export function assertNoSelfReference(
  eventConfig: EventTriggerConfig,
  taskId: number | null,
  graphId: number | null,
): void {
  if (
    eventConfig.source === "taskFinished" &&
    eventConfig.targetType === "task" &&
    eventConfig.targetId === taskId
  ) {
    throw new Error("EVENT_SELF_REFERENCE");
  }
  if (
    eventConfig.source === "taskFinished" &&
    eventConfig.targetType === "graph" &&
    graphId !== null &&
    eventConfig.targetId === graphId
  ) {
    throw new Error("EVENT_SELF_REFERENCE");
  }
}

function toRunRecord(row: RunRow, taskName: string): RunRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    taskName,
    graphId: row.graphId ?? undefined,
    graphTrace: row.graphTrace ?? undefined,
    sessionId: row.sessionId ?? undefined,
    attempt: row.attempt,
    triggerType: row.triggerType as RunRecord["triggerType"],
    status: row.status as RunRecord["status"],
    durationMs: row.durationMs ?? undefined,
    promptTokens: row.promptTokens ?? undefined,
    completionTokens: row.completionTokens ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
  };
}

function toTemplateRecord(
  t: ReturnType<typeof listAutomationTemplates>[number],
): TemplateRecord {
  return {
    slug: t.slug,
    icon: t.icon,
    titleI18nKey: t.titleI18nKey,
    descI18nKey: t.descI18nKey,
    prompt: t.prompt,
    scheduleJson: JSON.stringify(t.scheduleJson),
    temperature: t.temperature,
  };
}

export default class AutomationRepository {
  /** 工具禁用清单闭包（SP6 裁定 2）：Application 注入（实时读安全配置），
   * 缺省不滤（测试）；runNow 手动触发与调度执行走同一过滤 */
  constructor(private disabledTools: () => string[] = () => []) {
    this.registerHandlers();
    // create_automation_task 静态注册进聚合 registry（SkillRepository 构造
    // 注册 create_skill 先例）；落库复用本类 createTask（归属校验 +
    // userId 隔离同一链路）。先注销再注册保证幂等（测试同文件多次 new）
    unregisterTools(AUTOMATION_TOOL_NAME);
    registerTools([
      makeAutomationTool({
        createTask: (p, userId) => this.createTask(p, userId),
        // graphId 直连归属校验（防幻觉引用他人图；prompt 型不经此）
        graphFirst: (args) =>
          prisma.graphDefinition.findFirst({
            where: args.where,
            select: { id: true },
          }),
        // 对话创建任务无前端调用方 invalidate，落库即广播失效
        // （IPC automation:create 仍响应即回不推，调用方自失效）
        notify: (taskId) => emitAutomationChanged(taskId),
      }),
    ]);
  }

  private registerHandlers(): void {
    handleUser("automation:list", (_, userId) => this.listTasks(userId));
    handleUser("automation:create", (_, userId, p: TaskCreateParams) =>
      this.createTask(p, userId),
    );
    handleUser(
      "automation:update",
      (_, userId, id: number, p: TaskCreateParams) =>
        this.updateTask(id, p, userId),
    );
    handleUser("automation:delete", (_, userId, ids: number[]) =>
      this.deleteTasks(ids, userId),
    );
    handleUser("automation:toggle", (_, userId, id: number, enabled: boolean) =>
      this.toggleTask(id, enabled, userId),
    );
    handleUser("automation:runNow", (_, userId, id: number) =>
      this.runNow(id, userId),
    );
    // templates 为静态模板、stat 为匿名埋点：不涉用户数据，保留匿名通道
    // （渲染端统一追加的 token 会被忽略）
    ipcMain.handle("automation:templates", (): TemplateRecord[] =>
      listAutomationTemplates().map(toTemplateRecord),
    );
    handleUser(
      "automation:runs:page",
      (
        _,
        userId,
        page: number,
        taskId?: number,
        status?: RunRecord["status"],
      ) => this.listRuns(page, taskId, status, userId),
    );
    ipcMain.handle("automation:stat", (_, detail: CreateStatDetail) => {
      void recordAutomationEvent(prisma, "create", detail);
    });
    handleUser("automation:stats", (_, userId) => this.getStats(userId));
  }

  /** 供 runner/scheduler 复用的查询:行 → TaskRecord(带 workspace 派生) */
  async hydrate(row: TaskRow): Promise<TaskRecord> {
    const workspace = await prisma.workspace.findUnique({
      where: { id: row.workspaceId },
      select: { id: true, name: true, directoryPath: true },
    });
    return toTaskRecord(row, workspace);
  }

  /** 校验任务归当前用户（不存在与他人所有同报错，不泄露存在性） */
  private async assertTaskOwned(id: number, userId: number): Promise<void> {
    const row = await prisma.automationTask.findFirst({
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
    targetKind: TaskCreateParams["targetKind"],
  ): Promise<void> {
    const workspace = await prisma.workspace.findFirst({
      where: { id: workspaceId, userId },
    });
    if (!workspace) {
      throw new Error("WORKSPACE_NOT_FOUND");
    }
    if (targetKind === "graph") {
      return;
    }
    const model = await prisma.model.findUnique({ where: { id: modelId } });
    if (!model) {
      throw new Error("MODEL_MISSING");
    }
    const provider = await prisma.provider.findFirst({
      where: { id: model.providerId, userId },
    });
    if (!provider) {
      throw new Error("PROVIDER_NOT_FOUND");
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
    if (p.targetKind === "graph") {
      const g = await prisma.graphDefinition.findFirst({
        where: { id: p.graphId ?? -1, userId },
      });
      if (!g) {
        throw new Error("GRAPH_NOT_FOUND");
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
      p.targetKind === "graph" ? (p.graphId ?? null) : null,
    );
    if (ev.source === "taskFinished" && ev.targetType === "task") {
      await this.assertTaskOwned(ev.targetId, userId);
    } else if (ev.source === "taskFinished") {
      const g = await prisma.graphDefinition.findFirst({
        where: { id: ev.targetId, userId },
      });
      if (!g) {
        throw new Error("EVENT_TARGET_NOT_FOUND");
      }
    }
  }

  async listTasks(userId: number): Promise<TaskRecord[]> {
    const rows = await prisma.automationTask.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    return Promise.all(rows.map((row) => this.hydrate(row)));
  }

  /** 创建任务（public：IPC automation:create 与 create_automation_task 工具共用） */
  async createTask(p: TaskCreateParams, userId: number): Promise<TaskRecord> {
    await this.assertTaskRefsOwned(
      p.workspaceId,
      p.modelId,
      userId,
      p.targetKind,
    );
    await this.assertTriggerRefsOwned(p, userId, null);
    const row = await prisma.automationTask.create({
      data: {
        ...buildTaskData(p, new Date()),
        enabled: true,
        status: "active",
        userId,
      },
    });
    return this.hydrate(row);
  }

  /** 全量更新（CRUD 批去 private：face automation-tap 同链路消费——
   * IPC 与被控面单源，无头端 AutomationRepository.updateTask 同位） */
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
    const row = await prisma.automationTask.findUnique({ where: { id } });
    const updated = await prisma.automationTask.update({
      where: { id },
      data: {
        ...buildTaskData(p, new Date()),
        // 编辑视为续命:原任务已过期(expired)则以新配置复活回 active
        // (nextRunAt 已由 buildTaskData 重算);其余状态不动——
        // Prisma 传 undefined 表示不更新该字段,不重置用户开关语义
        status: row?.status === "expired" ? "active" : undefined,
      },
    });
    return this.hydrate(updated);
  }

  /** 批量删除（原 automation:delete 处理体收拢——CRUD 批 face 同链路；
   * 仅删本人任务（他人 id 混入被过滤），run 与其节点行随任务级联；返回
   * 实删 id（face 事件发布逐 id，无头端 service 同口径） */
  async deleteTasks(ids: number[], userId: number): Promise<number[]> {
    const owned = await prisma.automationTask.findMany({
      where: { id: { in: ids }, userId },
      select: { id: true },
    });
    const ownedIds = owned.map((row) => row.id);
    if (ownedIds.length === 0) {
      return [];
    }
    // graphRunNode 无 taskId 列（去会话化 2026-10-28，spec §3.1）：run 行
    // 删除前先取 run id 集合连带删节点行，避免孤儿行（graph.repo 删图同款）
    const runIds = (
      await prisma.automationRun.findMany({
        where: { taskId: { in: ownedIds } },
        select: { id: true },
      })
    ).map((row) => row.id);
    await prisma.$transaction([
      prisma.graphRunNode.deleteMany({ where: { runId: { in: runIds } } }),
      prisma.automationRun.deleteMany({
        where: { taskId: { in: ownedIds } },
      }),
      prisma.automationTask.deleteMany({ where: { id: { in: ownedIds } } }),
    ]);
    return ownedIds;
  }

  /** 启停（原 automation:toggle 处理体收拢）：重新启用 = 给异常任务恢复
   * 路径——清 statusNote，status 回 active（无头端 toggleTask 同语义） */
  async toggleTask(
    id: number,
    enabled: boolean,
    userId: number,
  ): Promise<TaskRecord> {
    await this.assertTaskOwned(id, userId);
    const row = await prisma.automationTask.update({
      where: { id },
      data: {
        enabled,
        ...(enabled && { status: "active", statusNote: null }),
      },
    });
    return this.hydrate(row);
  }

  /** 手动触发（原 automation:runNow 处理体收拢——CRUD 批 face 同链路；
   * 无头端 runNow 同位）。202 受理语义：触发即返回不 await */
  async runNow(id: number, userId: number): Promise<void> {
    const task = await prisma.automationTask.findFirst({
      where: { id, userId },
    });
    if (!task) {
      throw new Error(`automation task ${id} not found`);
    }
    // 与调度器共用 inflight 互斥:调度执行中/连点播放直接拒发,防同一
    // 任务并发双跑(重复会话/full 模式重复写盘);渲染端按码映射文案
    if (inflight.has(id)) {
      throw new Error("TASK_ALREADY_RUNNING");
    }
    const abort = new AbortController();
    inflight.set(id, abort);
    // 不 await:单次执行可达分钟级,触发即返回。executeTask 内部吞
    // 异常落库,catch 仅兜 create run 之前的意外;收口推送 tasks-changed。
    // taskFinished 收口发布(spec §5):outcome 在 finally 前取得,手动
    // 触发的运行结束同样成为链式事件源
    void executeTask(task, {
      triggerType: "manual",
      attempt: 1,
      abort: abort.signal,
      // SP6 裁定 2：手动触发同样受注入层工具禁用约束
      disabledTools: this.disabledTools,
    })
      .catch((e): "failed" => {
        Log.error("自动化执行失败", task.id, e);
        return "failed";
      })
      .then((outcome) => {
        void publishAutomationEvent(taskFinishedEvent(task, outcome));
      })
      .finally(() => {
        inflight.delete(task.id);
        emitAutomationChanged(task.id);
      });
  }

  async listRuns(
    page: number,
    taskId: number | undefined,
    status: RunRecord["status"] | undefined,
    userId: number,
  ): Promise<RunPage> {
    // 运行记录经任务归属限定当前用户；指定 taskId 时先校验归属
    let taskFilter: number | { in: number[] };
    if (taskId !== undefined) {
      await this.assertTaskOwned(taskId, userId);
      taskFilter = taskId;
    } else {
      const ownedTasks = await prisma.automationTask.findMany({
        where: { userId },
        select: { id: true },
      });
      taskFilter = { in: ownedTasks.map((row) => row.id) };
    }
    // 图试运行 run(taskId=null,spec §5)不在本人任务集——OR 并入本人图
    // id 集合,图运行得以出现在运行记录列表;指定 taskId(任务详情视图)
    // 不并图,保持任务口径(T11 评审移交)
    const ownedGraphIds =
      taskId === undefined
        ? (
            await prisma.graphDefinition.findMany({
              where: { userId },
              select: { id: true },
            })
          ).map((row) => row.id)
        : [];
    const where =
      taskId !== undefined
        ? { taskId, ...(status ? { status } : {}) }
        : {
            OR: [{ taskId: taskFilter }, { graphId: { in: ownedGraphIds } }],
            ...(status ? { status } : {}),
          };
    const PAGE_SIZE = 20;
    const [total, rows] = await Promise.all([
      prisma.automationRun.count({ where }),
      prisma.automationRun.findMany({
        where,
        orderBy: { startedAt: "desc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ]);
    const taskIds = rows
      .map((r) => r.taskId)
      .filter((id): id is number => id !== null);
    // 图试运行 run(taskId=null,spec §5 图详情试运行)无任务名——联查
    // graphDefinition 名补位，图运行在列表仍可辨
    const graphIds = rows
      .filter((r) => r.taskId === null)
      .map((r) => r.graphId)
      .filter((id): id is number => id !== null);
    const names = new Map(
      (
        await prisma.automationTask.findMany({
          where: { id: { in: taskIds } },
          select: { id: true, name: true },
        })
      ).map((t) => [t.id, t.name]),
    );
    const graphNames = new Map(
      (
        await prisma.graphDefinition.findMany({
          where: { id: { in: graphIds } },
          select: { id: true, name: true },
        })
      ).map((g) => [g.id, g.name]),
    );
    return {
      total,
      items: rows.map((r) =>
        toRunRecord(
          r,
          r.taskId !== null
            ? (names.get(r.taskId) ?? "-")
            : (graphNames.get(r.graphId ?? -1) ?? "-"),
        ),
      ),
    };
  }

  /** 健康度总览(spec §6):本人任务集+图集口径拉近 7 天 runs(OR 并入
   * 模式同 listRuns——图试运行 taskId=null 归本人图),error 任务全列,
   * 名称联查补位后交 computeStats 纯函数算口径。即时聚合不落表 */
  async getStats(userId: number): Promise<AutomationStats> {
    const now = new Date();
    const [tasks, graphs, errorTasks] = await Promise.all([
      prisma.automationTask.findMany({
        where: { userId },
        select: { id: true, name: true },
      }),
      prisma.graphDefinition.findMany({
        where: { userId },
        select: { id: true, name: true },
      }),
      prisma.automationTask.findMany({
        where: { userId, status: "error" },
        select: { id: true, name: true, statusNote: true },
      }),
    ]);
    const taskNames = new Map(tasks.map((t) => [t.id, t.name]));
    const graphNames = new Map(graphs.map((g) => [g.id, g.name]));
    // now-7d 为瞬时窗口,恒早于 7 个自然日窗口起点,查询侧取超集,
    // 自然日截断由 computeStats 完成(时区口径集中在一处)
    const runs = await prisma.automationRun.findMany({
      where: {
        startedAt: { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
        OR: [
          { taskId: { in: [...taskNames.keys()] } },
          { graphId: { in: [...graphNames.keys()] } },
        ],
      },
      // 统计只消费六列：graphTrace（节点级轨迹大 JSON）随行读回是纯搬运
      select: {
        id: true,
        status: true,
        error: true,
        startedAt: true,
        taskId: true,
        graphId: true,
      },
    });
    const statsRuns: StatsRunRow[] = runs.map((r) => ({
      id: r.id,
      status: r.status as StatsRunRow["status"],
      error: r.error ?? undefined,
      startedAt: r.startedAt,
      name:
        r.taskId !== null
          ? (taskNames.get(r.taskId) ?? "-")
          : (graphNames.get(r.graphId ?? -1) ?? "-"),
      graphId: r.graphId ?? undefined,
    }));
    return computeStats(
      statsRuns,
      errorTasks.map((e) => ({
        id: e.id,
        name: e.name,
        statusNote: e.statusNote ?? "",
      })),
      now,
    );
  }
}
