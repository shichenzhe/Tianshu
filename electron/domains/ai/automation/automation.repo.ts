/**
 * 自动化任务仓储 + IPC(spec §6)。
 * 不实例化 SessionRepository(其构造注册 IPC 有副作用);删除走
 * prisma.$transaction 连带删 run(应用层级联,SQLite 无外键)。
 */
import { BrowserWindow, ipcMain } from "electron";
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import { handleUser } from "../../../commons/ipc-user";
import {
  scheduleSchema,
  type ScheduleConfig,
} from "../../../../src-react/domains/ai/automation/api/schedule.schema";
import {
  AUTOMATION_CHANGED_EVENT,
  type TaskCreateParams,
  type TaskRecord,
  type RunRecord,
  type RunPage,
  type TemplateRecord,
  type CreateStatDetail,
} from "../../../../src-react/domains/ai/automation/api/automation.api";
import { computeNextRun } from "./schedule";
import { listAutomationTemplates } from "./automation-templates";
import { recordAutomationEvent } from "./automation-stat";
import { executeTask } from "./automation-runner";
import { inflight } from "./automation-inflight";

type TaskRow = NonNullable<
  Awaited<ReturnType<typeof prisma.automationTask.findFirst>>
>;
type RunRow = NonNullable<
  Awaited<ReturnType<typeof prisma.automationRun.findFirst>>
>;

/** 手动执行收口推送:同 scheduler.notifyChanged 机制(不引 scheduler 实例),
 * executeTask 本身不推送,runNow 须自行通知渲染层刷新 */
function notifyTasksChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(AUTOMATION_CHANGED_EVENT);
  }
}

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
 * null = 解除项目关联（TaskUpdateParams 全量更新语义，子系统 E） */
export function buildTaskData(params: TaskCreateParams, now: Date) {
  const schedule = scheduleSchema.parse(params.schedule) as ScheduleConfig;
  const startAt = params.startAt ? new Date(params.startAt) : null;
  // 以 max(now, startAt) 为起点求首个调度点:触发点永远落在调度语义时刻
  // (如 daily 09:00)而非生效边界,避免生效日零点伪触发一次造成当天双跑
  const base = startAt && startAt > now ? startAt : now;
  const next = computeNextRun(schedule, base);
  return {
    name: params.name,
    prompt: params.prompt,
    workspaceId: params.workspaceId,
    modelId: params.modelId,
    temperature: params.temperature ?? null,
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

function toRunRecord(row: RunRow, taskName: string): RunRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    taskName,
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
    handleUser(
      "automation:delete",
      async (_, userId, ids: number[]): Promise<void> => {
        // 仅删本人任务（他人 id 混入被过滤），run 随任务级联
        const owned = await prisma.automationTask.findMany({
          where: { id: { in: ids }, userId },
          select: { id: true },
        });
        const ownedIds = owned.map((row) => row.id);
        if (ownedIds.length === 0) {
          return;
        }
        await prisma.$transaction([
          prisma.automationRun.deleteMany({
            where: { taskId: { in: ownedIds } },
          }),
          prisma.automationTask.deleteMany({ where: { id: { in: ownedIds } } }),
        ]);
      },
    );
    handleUser(
      "automation:toggle",
      async (_, userId, id: number, enabled: boolean): Promise<TaskRecord> => {
        await this.assertTaskOwned(id, userId);
        // 重新启用 = 给异常任务恢复路径:清 statusNote,status 回 active
        const row = await prisma.automationTask.update({
          where: { id },
          data: {
            enabled,
            ...(enabled && { status: "active", statusNote: null }),
          },
        });
        return this.hydrate(row);
      },
    );
    handleUser(
      "automation:runNow",
      async (_, userId, id: number): Promise<void> => {
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
        // 异常落库,catch 仅兜 create run 之前的意外;收口推送 tasks-changed
        void executeTask(task, {
          triggerType: "manual",
          attempt: 1,
          abort: abort.signal,
          // SP6 裁定 2：手动触发同样受注入层工具禁用约束
          disabledTools: this.disabledTools,
        })
          .catch((e) => Log.error("自动化执行失败", task.id, e))
          .finally(() => {
            inflight.delete(task.id);
            notifyTasksChanged();
          });
      },
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

  /** 校验任务引用的工作空间与模型归当前用户（model 经 provider 链路） */
  private async assertTaskRefsOwned(
    workspaceId: number,
    modelId: number,
    userId: number,
  ): Promise<void> {
    const workspace = await prisma.workspace.findFirst({
      where: { id: workspaceId, userId },
    });
    if (!workspace) {
      throw new Error("WORKSPACE_NOT_FOUND");
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

  async listTasks(userId: number): Promise<TaskRecord[]> {
    const rows = await prisma.automationTask.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    return Promise.all(rows.map((row) => this.hydrate(row)));
  }

  private async createTask(
    p: TaskCreateParams,
    userId: number,
  ): Promise<TaskRecord> {
    await this.assertTaskRefsOwned(p.workspaceId, p.modelId, userId);
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

  private async updateTask(
    id: number,
    p: TaskCreateParams,
    userId: number,
  ): Promise<TaskRecord> {
    await this.assertTaskOwned(id, userId);
    await this.assertTaskRefsOwned(p.workspaceId, p.modelId, userId);
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
    const where = {
      taskId: taskFilter,
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
    const names = new Map(
      (
        await prisma.automationTask.findMany({
          where: { id: { in: rows.map((r) => r.taskId) } },
          select: { id: true, name: true },
        })
      ).map((t) => [t.id, t.name]),
    );
    return {
      total,
      items: rows.map((r) => toRunRecord(r, names.get(r.taskId) ?? "-")),
    };
  }
}
