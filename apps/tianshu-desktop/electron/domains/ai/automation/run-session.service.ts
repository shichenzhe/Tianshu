import type {
  AutomationRunDetail,
  RunGroupRecord,
  RunSessionResult,
} from "@tianshu/protocol";
import { canFollowUpRun, runOwnerOf } from "@tianshu/core/run-session";
import prisma from "../../../commons/prisma-client";
import { handleUser } from "../../../commons/ipc-user";
import type { Prisma } from "../../../generated/prisma/client";
import type { SessionRepository } from "../chat/session.repo";
import type { SessionCreateParams } from "../../../../src-react/domains/ai/api/session.api";
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

type TaskOwnerRow = TaskGroupRow;
type GraphOwnerRow = GraphGroupRow & { aiSessionId: number | null };
type OwnedRun =
  | { row: RunSummaryRow; owner: "task"; task: TaskOwnerRow }
  | { row: RunSummaryRow; owner: "graph"; graph: GraphOwnerRow };

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
    handleUser(
      "automation:run:ensureSession",
      (_, userId, runId: number, workspaceId?: number) =>
        this.ensureRunSession(runId, userId, workspaceId),
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
    const owned = await this.readOwnedRun(runId, userId);
    const name = owned.owner === "task" ? owned.task.name : owned.graph.name;
    return toRunRecord(owned.row, name);
  }

  private async readOwnedRun(runId: number, userId: number): Promise<OwnedRun> {
    const row = await prisma.automationRun.findUnique({ where: { id: runId } });
    if (!row) throw new Error("RUN_NOT_FOUND");
    const owner = runOwnerOf({
      taskId: row.taskId,
      graphId: row.graphId ?? undefined,
    });
    if (!owner) throw new Error("RUN_NOT_FOUND");
    return owner.kind === "task"
      ? this.readTaskRun(row, owner.ownerId, userId)
      : this.readGraphRun(row, owner.ownerId, userId);
  }

  private async readTaskRun(
    row: RunSummaryRow,
    taskId: number,
    userId: number,
  ): Promise<OwnedRun> {
    const task = await prisma.automationTask.findFirst({
      where: { id: taskId, userId },
      select: { id: true, name: true, workspaceId: true, projectId: true },
    });
    if (!task) throw new Error("RUN_NOT_FOUND");
    return { row, owner: "task", task };
  }

  private async readGraphRun(
    row: RunSummaryRow,
    graphId: number,
    userId: number,
  ): Promise<OwnedRun> {
    const graph = await prisma.graphDefinition.findFirst({
      where: { id: graphId, userId },
      select: { id: true, name: true, aiSessionId: true },
    });
    if (!graph) throw new Error("RUN_NOT_FOUND");
    return { row, owner: "graph", graph };
  }

  async ensureRunSession(
    runId: number,
    userId: number,
    workspaceId?: number,
  ): Promise<RunSessionResult> {
    const owned = await this.readOwnedRun(runId, userId);
    if (!canFollowUpRun(owned.row.status as AutomationRunDetail["status"])) {
      throw new Error("RUN_NOT_FOLLOWABLE");
    }
    if (owned.row.sessionId !== null) {
      return { runId, sessionId: owned.row.sessionId, created: false };
    }
    const target = await this.resolveSessionTarget(owned, userId, workspaceId);
    const orphanId = await this.findOrphanSession(owned, userId);
    if (orphanId !== null) {
      return this.claimOrRecover(runId, orphanId, false);
    }
    const session = await this.sessionRepo.createSession(
      sessionCreateParams(owned, target.workspaceId, target.projectId),
      userId,
    );
    return this.claimOrRecover(runId, session.id, true);
  }

  private async findOrphanSession(
    owned: OwnedRun,
    userId: number,
  ): Promise<number | null> {
    const candidates = await prisma.session.findMany({
      where: orphanSessionWhere(owned, userId),
      orderBy: { id: "asc" },
      select: { id: true },
    });
    if (candidates.length === 0) return null;
    const linked = await prisma.automationRun.findMany({
      where: { sessionId: { in: candidates.map((session) => session.id) } },
      select: { sessionId: true },
    });
    const linkedIds = new Set(linked.map((run) => run.sessionId));
    return candidates.find((session) => !linkedIds.has(session.id))?.id ?? null;
  }

  private async claimOrRecover(
    runId: number,
    sessionId: number,
    created: boolean,
  ): Promise<RunSessionResult> {
    try {
      const claimed = await this.claimSession(runId, sessionId);
      if (claimed) return { runId, sessionId, created };
      return await this.recoverClaim(runId, sessionId);
    } catch (error) {
      return await this.recoverClaim(runId, sessionId, error);
    }
  }

  private async resolveSessionTarget(
    owned: OwnedRun,
    userId: number,
    explicitWorkspaceId?: number,
  ): Promise<{ workspaceId: number; projectId?: number }> {
    if (owned.owner === "task") {
      return {
        workspaceId: owned.task.workspaceId,
        projectId: owned.task.projectId ?? undefined,
      };
    }
    if (owned.row.workspaceId !== null) {
      return { workspaceId: owned.row.workspaceId };
    }
    const editorWorkspaceId = await this.graphEditorWorkspace(owned, userId);
    const workspaceId = editorWorkspaceId ?? explicitWorkspaceId;
    if (workspaceId === undefined) throw new Error("RUN_WORKSPACE_REQUIRED");
    return { workspaceId };
  }

  private async graphEditorWorkspace(
    owned: Extract<OwnedRun, { owner: "graph" }>,
    userId: number,
  ): Promise<number | undefined> {
    if (owned.graph.aiSessionId === null) return undefined;
    const session = await prisma.session.findFirst({
      where: { id: owned.graph.aiSessionId, userId },
      select: { workspaceId: true },
    });
    return session?.workspaceId;
  }

  private async claimSession(
    runId: number,
    sessionId: number,
  ): Promise<boolean> {
    const result = await prisma.$transaction((tx) =>
      tx.automationRun.updateMany({
        where: { id: runId, sessionId: null },
        data: { sessionId },
      }),
    );
    return result.count === 1;
  }

  private async recoverClaim(
    runId: number,
    sessionId: number,
    originalError?: unknown,
  ): Promise<RunSessionResult> {
    const winner = await prisma.automationRun.findUnique({
      where: { id: runId },
      select: { sessionId: true },
    });
    if (winner?.sessionId != null) {
      if (winner.sessionId !== sessionId) {
        await prisma.session.delete({ where: { id: sessionId } });
      }
      return { runId, sessionId: winner.sessionId, created: false };
    }
    await prisma.session.delete({ where: { id: sessionId } });
    throw originalError ?? new Error("RUN_NOT_FOUND");
  }
}

function runSessionTitle(owned: OwnedRun): string {
  const name = owned.owner === "task" ? owned.task.name : owned.graph.name;
  return `${name} · ${owned.row.startedAt.toISOString()}`;
}

function orphanSessionWhere(
  owned: OwnedRun,
  userId: number,
): Prisma.sessionWhereInput {
  return {
    userId,
    title: runSessionTitle(owned),
    lastMessageAt: null,
    automationTaskId: owned.owner === "task" ? owned.task.id : null,
    runGraphId: owned.owner === "graph" ? owned.graph.id : null,
  };
}

function sessionCreateParams(
  owned: OwnedRun,
  workspaceId: number,
  projectId?: number,
): SessionCreateParams {
  return {
    workspaceId,
    projectId,
    title: runSessionTitle(owned),
    automationTaskId: owned.owner === "task" ? owned.task.id : null,
    runGraphId: owned.owner === "graph" ? owned.graph.id : null,
  };
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
