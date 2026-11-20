import { Injectable } from '@nestjs/common';
import type { AutomationRun } from '@prisma/client';
import { canFollowUpRun, runOwnerOf } from '@tianshu/core';
import type { AutomationRunDetail, RunSessionResult } from '@tianshu/protocol';
import { PrismaService } from 'src/commons/database/prisma.service';
import { COMPANION_USER_ID } from 'src/commons/config/tianshu-config.entity';
import { BusinessException } from 'src/commons/exception/bussiness-exception';
import { ErrorCodeEnum } from 'src/commons/exception/error-code.enum';
import { SessionRepository } from 'src/modules/session/session.repository';
import type { EnsureRunSessionDto } from './dto/run-session.dto';

interface TaskOwnerRow {
  id: number;
  name: string;
  workspaceId: number;
  projectId: number | null;
}

interface GraphOwnerRow {
  id: number;
  name: string;
  /** server 当前图模型尚无此列；存在时优先使用 AI 编排会话空间。 */
  aiSessionId?: number | null;
}

type OwnedRun =
  | { row: AutomationRun; owner: 'task'; task: TaskOwnerRow }
  | { row: AutomationRun; owner: 'graph'; graph: GraphOwnerRow };

/** 单次运行的幂等伴随会话；所有归属固定为伴生用户。 */
@Injectable()
export class RunSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionRepository,
  ) {}

  async ensureRunSession(dto: EnsureRunSessionDto): Promise<RunSessionResult> {
    const userId = COMPANION_USER_ID;
    const owned = await this.readOwnedRun(dto.runId, userId);
    const status = owned.row.status as AutomationRunDetail['status'];
    if (!canFollowUpRun(status)) {
      throw new BusinessException('RUN_NOT_FOLLOWABLE', 'RUN_NOT_FOLLOWABLE');
    }
    if (owned.row.sessionId !== null) {
      return {
        runId: dto.runId,
        sessionId: owned.row.sessionId,
        created: false,
      };
    }
    const target = await this.resolveSessionTarget(
      owned,
      userId,
      dto.workspaceId,
    );
    const orphanId = await this.findOrphanSession(owned, userId);
    if (orphanId !== null) {
      return this.claimOrRecover(dto.runId, orphanId, false);
    }
    const session = await this.sessions.create({
      workspaceId: target.workspaceId,
      projectId: target.projectId,
      userId,
      title: runSessionTitle(owned),
      automationTaskId: owned.owner === 'task' ? owned.task.id : null,
      runGraphId: owned.owner === 'graph' ? owned.graph.id : null,
    });
    return this.claimOrRecover(dto.runId, session.id, true);
  }

  private async readOwnedRun(runId: number, userId: number): Promise<OwnedRun> {
    const row = await this.prisma.automationRun.findUnique({
      where: { id: runId },
    });
    if (!row) throw runNotFound();
    const owner = runOwnerOf({
      taskId: row.taskId,
      graphId: row.graphId ?? undefined,
    });
    if (!owner) throw runNotFound();
    return owner.kind === 'task'
      ? this.readTaskRun(row, owner.ownerId, userId)
      : this.readGraphRun(row, owner.ownerId, userId);
  }

  private async readTaskRun(
    row: AutomationRun,
    taskId: number,
    userId: number,
  ): Promise<OwnedRun> {
    const task = await this.prisma.automationTask.findFirst({
      where: { id: taskId, userId },
      select: { id: true, name: true, workspaceId: true, projectId: true },
    });
    if (!task) throw runNotFound();
    return { row, owner: 'task', task };
  }

  private async readGraphRun(
    row: AutomationRun,
    graphId: number,
    userId: number,
  ): Promise<OwnedRun> {
    const graph: GraphOwnerRow | null =
      await this.prisma.graphDefinition.findFirst({
        where: { id: graphId, userId },
      });
    if (!graph) throw runNotFound();
    return { row, owner: 'graph', graph };
  }

  private async resolveSessionTarget(
    owned: OwnedRun,
    userId: number,
    explicitWorkspaceId?: number,
  ): Promise<{ workspaceId: number; projectId?: number }> {
    const target =
      owned.owner === 'task'
        ? {
            workspaceId: owned.task.workspaceId,
            projectId: owned.task.projectId ?? undefined,
          }
        : await this.resolveGraphTarget(owned, userId, explicitWorkspaceId);
    const workspace = await this.sessions.getWorkspaceById(
      target.workspaceId,
      userId,
    );
    if (!workspace) {
      throw new BusinessException('工作空间不存在', ErrorCodeEnum.NOT_FOUND);
    }
    return target;
  }

  private async resolveGraphTarget(
    owned: Extract<OwnedRun, { owner: 'graph' }>,
    userId: number,
    explicitWorkspaceId?: number,
  ): Promise<{ workspaceId: number }> {
    if (owned.row.workspaceId !== null) {
      return { workspaceId: owned.row.workspaceId };
    }
    const editorWorkspaceId = await this.graphEditorWorkspace(owned, userId);
    const workspaceId = editorWorkspaceId ?? explicitWorkspaceId;
    if (workspaceId === undefined) {
      throw new BusinessException(
        'RUN_WORKSPACE_REQUIRED',
        'RUN_WORKSPACE_REQUIRED',
      );
    }
    return { workspaceId };
  }

  private async graphEditorWorkspace(
    owned: Extract<OwnedRun, { owner: 'graph' }>,
    userId: number,
  ): Promise<number | undefined> {
    const aiSessionId = owned.graph.aiSessionId;
    if (aiSessionId == null) return undefined;
    const session = await this.prisma.sessionRecord.findFirst({
      where: { id: aiSessionId, userId },
      select: { workspaceId: true },
    });
    return session?.workspaceId;
  }

  private async findOrphanSession(
    owned: OwnedRun,
    userId: number,
  ): Promise<number | null> {
    const candidates = await this.prisma.sessionRecord.findMany({
      where: orphanSessionWhere(owned, userId),
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    if (candidates.length === 0) return null;
    const linked = await this.prisma.automationRun.findMany({
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

  private async claimSession(
    runId: number,
    sessionId: number,
  ): Promise<boolean> {
    return await this.prisma.$transaction(async (tx) => {
      const result = await tx.automationRun.updateMany({
        where: { id: runId, sessionId: null },
        data: { sessionId },
      });
      return result.count === 1;
    });
  }

  private async recoverClaim(
    runId: number,
    sessionId: number,
    originalError?: unknown,
  ): Promise<RunSessionResult> {
    const winner = await this.prisma.automationRun.findUnique({
      where: { id: runId },
      select: { sessionId: true },
    });
    if (winner?.sessionId != null) {
      if (winner.sessionId !== sessionId) {
        await this.prisma.sessionRecord.delete({ where: { id: sessionId } });
      }
      return { runId, sessionId: winner.sessionId, created: false };
    }
    await this.prisma.sessionRecord.delete({ where: { id: sessionId } });
    const failure =
      originalError instanceof Error ? originalError : runNotFound();
    throw failure;
  }
}

function runNotFound(): BusinessException {
  return new BusinessException('RUN_NOT_FOUND', ErrorCodeEnum.NOT_FOUND);
}

function runSessionTitle(owned: OwnedRun): string {
  const name = owned.owner === 'task' ? owned.task.name : owned.graph.name;
  return `${name} · ${owned.row.startedAt.toISOString()}`;
}

function orphanSessionWhere(owned: OwnedRun, userId: number) {
  return {
    userId,
    title: runSessionTitle(owned),
    lastMessageAt: null,
    automationTaskId: owned.owner === 'task' ? owned.task.id : null,
    runGraphId: owned.owner === 'graph' ? owned.graph.id : null,
  };
}
