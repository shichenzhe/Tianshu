import type { AutomationRunDetail, RunGroupRecord } from "@tianshu/protocol";
import { runOwnerOf } from "@tianshu/core/run-session";
import prisma from "../../../commons/prisma-client";
import { handleUser } from "../../../commons/ipc-user";
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
    const groupedSessions = await this.listGraphSessions(userId, graphs);
    const [taskGroups, graphGroups] = await Promise.all([
      Promise.all(tasks.map((task) => this.taskGroup(task))),
      Promise.all(
        graphs.map((graph) =>
          this.graphGroup(graph, groupedSessions.get(graph.id)),
        ),
      ),
    ]);
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

  private async taskGroup(task: TaskGroupRow): Promise<RunGroupRecord> {
    const latestRun = await prisma.automationRun.findFirst({
      where: { taskId: task.id },
      orderBy: { startedAt: "desc" },
      select: RUN_SUMMARY_SELECT,
    });
    return {
      kind: "task",
      ownerId: task.id,
      name: task.name,
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      latestRun: latestRun
        ? toRunRecord(latestRun, task.name, false)
        : undefined,
      hasRuns: latestRun !== null,
    };
  }

  private async graphGroup(
    graph: GraphGroupRow,
    groupedSession?: { workspaceId: number },
  ): Promise<RunGroupRecord | null> {
    const latestRun = await prisma.automationRun.findFirst({
      where: { taskId: null, graphId: graph.id },
      orderBy: { startedAt: "desc" },
      select: RUN_SUMMARY_SELECT,
    });
    if (!latestRun && !groupedSession) return null;
    return {
      kind: "graph",
      ownerId: graph.id,
      name: graph.name,
      workspaceId: latestRun?.workspaceId ?? groupedSession?.workspaceId,
      latestRun: latestRun
        ? toRunRecord(latestRun, graph.name, false)
        : undefined,
      hasRuns: latestRun !== null,
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
