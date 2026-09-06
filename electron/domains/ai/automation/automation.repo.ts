/**
 * 自动化任务仓储 + IPC(spec §6)。
 * 不实例化 SessionRepository(其构造注册 IPC 有副作用);删除走
 * prisma.$transaction 连带删 run(应用层级联,SQLite 无外键)。
 */
import { ipcMain } from "electron";
import prisma from "../../../commons/prisma-client";
import {
  scheduleSchema,
  type ScheduleConfig,
} from "../../../../src-react/domains/ai/automation/api/schedule.schema";
import type {
  TaskCreateParams,
  TaskRecord,
  RunRecord,
  RunPage,
  TemplateRecord,
  CreateStatDetail,
} from "../../../../src-react/domains/ai/automation/api/automation.api";
import { computeNextRun } from "./schedule";
import { listAutomationTemplates } from "./automation-templates";
import { recordAutomationEvent } from "./automation-stat";

type TaskRow = NonNullable<
  Awaited<ReturnType<typeof prisma.automationTask.findFirst>>
>;
type RunRow = NonNullable<
  Awaited<ReturnType<typeof prisma.automationRun.findFirst>>
>;

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
    enabled: row.enabled,
    status: row.status as TaskRecord["status"],
    statusNote: row.statusNote ?? undefined,
    lastRunAt: row.lastRunAt?.toISOString(),
    nextRunAt: row.nextRunAt?.toISOString(),
    templateSlug: row.templateSlug ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 创建/更新共用:create params → prisma data(nextRunAt 初算)。不含
 * enabled/status——编辑已暂停任务不得重置用户开关 */
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
    templateSlug: params.templateSlug ?? null,
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
  constructor() {
    this.registerHandlers();
  }

  private registerHandlers(): void {
    ipcMain.handle("automation:list", () => this.listTasks());
    ipcMain.handle("automation:create", (_, p: TaskCreateParams) =>
      this.createTask(p),
    );
    ipcMain.handle("automation:update", (_, id: number, p: TaskCreateParams) =>
      this.updateTask(id, p),
    );
    ipcMain.handle(
      "automation:delete",
      async (_, ids: number[]): Promise<void> => {
        await prisma.$transaction([
          prisma.automationRun.deleteMany({ where: { taskId: { in: ids } } }),
          prisma.automationTask.deleteMany({ where: { id: { in: ids } } }),
        ]);
      },
    );
    ipcMain.handle(
      "automation:toggle",
      async (_, id: number, enabled: boolean): Promise<TaskRecord> => {
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
    ipcMain.handle("automation:templates", (): TemplateRecord[] =>
      listAutomationTemplates().map(toTemplateRecord),
    );
    ipcMain.handle("automation:runs:page", (_, page: number, taskId?: number) =>
      this.listRuns(page, taskId),
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

  async listTasks(): Promise<TaskRecord[]> {
    const rows = await prisma.automationTask.findMany({
      orderBy: { createdAt: "desc" },
    });
    return Promise.all(rows.map((row) => this.hydrate(row)));
  }

  private async createTask(p: TaskCreateParams): Promise<TaskRecord> {
    const row = await prisma.automationTask.create({
      data: {
        ...buildTaskData(p, new Date()),
        enabled: true,
        status: "active",
      },
    });
    return this.hydrate(row);
  }

  private async updateTask(
    id: number,
    p: TaskCreateParams,
  ): Promise<TaskRecord> {
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

  async listRuns(page: number, taskId?: number): Promise<RunPage> {
    const where = taskId ? { taskId } : {};
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
