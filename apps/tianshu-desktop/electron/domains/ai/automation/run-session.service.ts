import type { AutomationRunDetail, RunGroupRecord } from "@tianshu/protocol";
import { runOwnerOf } from "@tianshu/core/run-session";
import prisma from "../../../commons/prisma-client";
import { handleUser } from "../../../commons/ipc-user";
import type { Prisma } from "../../../generated/prisma/client";
import type { SessionRepository } from "../chat/session.repo";
import { toRunRecord } from "./automation.repo";

const RUN_SUMMARY_SELECT = {
  id: true,
  taskId: true,
  graphId: true,
  sessionId: true,
  workspaceId: true,
  attempt: true,
  triggerType: true,
  status: true,
  durationMs: true,
  promptTokens: true,
  completionTokens: true,
  error: true,
  startedAt: true,
  finishedAt: true,
} as const;

interface TaskGroupRow {
  id: number;
  name: string;
  workspaceId: number;
  projectId: number | null;
}

interface GraphGroupRow {
  id: number;
  name: string;
}

type RunSummaryRow = Parameters<typeof toRunRecord>[0];
type RunOwnerKey = "taskId" | "graphId";

interface RunMaximum {
  ownerId: number;
  startedAt: Date;
}

interface RunAggregateRow {
  taskId?: number | null;
  graphId?: number | null;
  _max: { startedAt: Date | null };
}

/** 固定运行入口读面；Task 4 在同一实例扩展伴随会话创建。 */
export class RunSessionService {
  constructor(protected readonly sessionRepo: SessionRepository) {
    this.registerHandlers();
  }

  private registerHandlers(): void {
    handleUser("automation:runGroups", (_, userId) =>
      this.listRunGroups(userId),
    );
    handleUser("automation:run:get", (_, userId, runId: number) =>
      this.getRun(runId, userId),
    );
  }

  async listRunGroups(userId: number): Promise<RunGroupRecord[]> {
    const [tasks, graphs] = await Promise.all([
      prisma.automationTask.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          workspaceId: true,
          projectId: true,
        },
      }),
      prisma.graphDefinition.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true },
      }),
    ]);
    const [groupedSessions, taskRuns, graphRuns] = await Promise.all([
      this.listGraphSessions(userId, graphs),
      this.latestTaskRuns(tasks.map((task) => task.id)),
      this.latestGraphRuns(graphs.map((graph) => graph.id)),
    ]);
    const taskGroups = tasks.map((task) =>
      this.taskGroup(task, taskRuns.get(task.id)),
    );
    const graphGroups = graphs.map((graph) =>
      this.graphGroup(
        graph,
        graphRuns.get(graph.id),
        groupedSessions.get(graph.id),
      ),
    );
    return [...taskGroups, ...graphGroups]
      .filter((group): group is RunGroupRecord => group !== null)
      .sort(compareRunGroups);
  }

  private async listGraphSessions(
    userId: number,
    graphs: GraphGroupRow[],
  ): Promise<Map<number, { workspaceId: number }>> {
    if (graphs.length === 0) return new Map();
    const rows = await prisma.session.findMany({
      where: { userId, runGraphId: { in: graphs.map((graph) => graph.id) } },
      orderBy: { updatedAt: "desc" },
      select: { runGraphId: true, workspaceId: true },
    });
    const result = new Map<number, { workspaceId: number }>();
    for (const row of rows) {
      if (row.runGraphId !== null && !result.has(row.runGraphId)) {
        result.set(row.runGraphId, { workspaceId: row.workspaceId });
      }
    }
    return result;
  }

  private async latestTaskRuns(
    taskIds: number[],
  ): Promise<Map<number, RunSummaryRow>> {
    if (taskIds.length === 0) return new Map();
    const aggregates = await prisma.automationRun.groupBy({
      by: ["taskId"],
      where: { taskId: { in: taskIds } },
      _max: { startedAt: true },
    });
    const maxima = readRunMaxima(aggregates, "taskId");
    const rows = await findLatestRuns("task", maxima);
    return latestRunMap(rows, "taskId");
  }

  private async latestGraphRuns(
    graphIds: number[],
  ): Promise<Map<number, RunSummaryRow>> {
    if (graphIds.length === 0) return new Map();
    const aggregates = await prisma.automationRun.groupBy({
      by: ["graphId"],
      where: {
        taskId: null,
        graphId: { in: graphIds },
        triggerType: { not: "subflow" },
      },
      _max: { startedAt: true },
    });
    const maxima = readRunMaxima(aggregates, "graphId");
    const rows = await findLatestRuns("graph", maxima);
    return latestRunMap(rows, "graphId");
  }

  private taskGroup(
    task: TaskGroupRow,
    latestRun?: RunSummaryRow,
  ): RunGroupRecord {
    return {
      kind: "task",
      ownerId: task.id,
      name: task.name,
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      latestRun: latestRun
        ? toRunRecord(latestRun, task.name, false)
        : undefined,
      hasRuns: latestRun !== undefined,
    };
  }

  private graphGroup(
    graph: GraphGroupRow,
    latestRun?: RunSummaryRow,
    groupedSession?: { workspaceId: number },
  ): RunGroupRecord | null {
    if (!latestRun && !groupedSession) return null;
    return {
      kind: "graph",
      ownerId: graph.id,
      name: graph.name,
      workspaceId: latestRun?.workspaceId ?? groupedSession?.workspaceId,
      latestRun: latestRun
        ? toRunRecord(latestRun, graph.name, false)
        : undefined,
      hasRuns: latestRun !== undefined,
    };
  }

  async getRun(runId: number, userId: number): Promise<AutomationRunDetail> {
    const row = await prisma.automationRun.findUnique({ where: { id: runId } });
    if (!row) throw new Error("RUN_NOT_FOUND");
    const owner = runOwnerOf({
      taskId: row.taskId,
      graphId: row.graphId ?? undefined,
    });
    if (!owner) throw new Error("RUN_NOT_FOUND");
    const ownerRow =
      owner.kind === "task"
        ? await prisma.automationTask.findFirst({
            where: { id: owner.ownerId, userId },
            select: { id: true, name: true },
          })
        : await prisma.graphDefinition.findFirst({
            where: { id: owner.ownerId, userId },
            select: { id: true, name: true },
          });
    if (!ownerRow) throw new Error("RUN_NOT_FOUND");
    return toRunRecord(row, ownerRow.name);
  }
}

function readRunMaxima(
  rows: RunAggregateRow[],
  ownerKey: RunOwnerKey,
): RunMaximum[] {
  return rows.flatMap((row) => {
    const ownerId = row[ownerKey];
    const startedAt = row._max.startedAt;
    return ownerId == null || !startedAt ? [] : [{ ownerId, startedAt }];
  });
}

async function findLatestRuns(
  kind: "task" | "graph",
  maxima: RunMaximum[],
): Promise<RunSummaryRow[]> {
  if (maxima.length === 0) return [];
  const ownerFilters: Prisma.automationRunWhereInput[] = maxima.map(
    ({ ownerId, startedAt }) => ({
      ...(kind === "task" ? { taskId: ownerId } : { graphId: ownerId }),
      startedAt,
    }),
  );
  return prisma.automationRun.findMany({
    where: {
      ...(kind === "graph" && {
        taskId: null,
        triggerType: { not: "subflow" },
      }),
      OR: ownerFilters,
    },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: RUN_SUMMARY_SELECT,
  });
}

function latestRunMap(
  rows: RunSummaryRow[],
  ownerKey: RunOwnerKey,
): Map<number, RunSummaryRow> {
  const result = new Map<number, RunSummaryRow>();
  for (const row of rows) {
    const ownerId = row[ownerKey];
    if (ownerId === null) continue;
    const current = result.get(ownerId);
    if (
      !current ||
      row.startedAt > current.startedAt ||
      (row.startedAt.getTime() === current.startedAt.getTime() &&
        row.id > current.id)
    ) {
      result.set(ownerId, row);
    }
  }
  return result;
}

function compareRunGroups(left: RunGroupRecord, right: RunGroupRecord): number {
  const leftStartedAt = left.latestRun?.startedAt;
  const rightStartedAt = right.latestRun?.startedAt;
  if (leftStartedAt && rightStartedAt) {
    return rightStartedAt.localeCompare(leftStartedAt);
  }
  if (leftStartedAt) return -1;
  if (rightStartedAt) return 1;
  return 0;
}
