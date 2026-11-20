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
}

type OwnedRun =
  | { row: AutomationRun; owner: 'task'; task: TaskOwnerRow }
  | { row: AutomationRun; owner: 'graph'; graph: GraphOwnerRow };

interface SessionTarget {
  workspaceId: number;
  projectId?: number;
}

/** 条件认领未获胜；事务回滚后统一重读真实胜者。 */
class RunClaimConflict extends Error {}

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
    try {
      return await this.createAndClaim(owned, target);
    } catch (error) {
      // 只在此恢复一次；恢复自身异常直接向上抛，不再进入第二次恢复。
      return await this.recoverClaim(dto.runId, error);
    }
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
    const graph = await this.prisma.graphDefinition.findFirst({
      where: { id: graphId, userId },
      select: { id: true, name: true },
    });
    if (!graph) throw runNotFound();
    return { row, owner: 'graph', graph };
  }

  private async resolveSessionTarget(
    owned: OwnedRun,
    userId: number,
    explicitWorkspaceId?: number,
  ): Promise<SessionTarget> {
    const target =
      owned.owner === 'task'
        ? {
            workspaceId: owned.task.workspaceId,
            projectId: owned.task.projectId ?? undefined,
          }
        : this.resolveGraphTarget(owned, explicitWorkspaceId);
    const workspace = await this.sessions.getWorkspaceById(
      target.workspaceId,
      userId,
    );
    if (!workspace) {
      throw new BusinessException('工作空间不存在', ErrorCodeEnum.NOT_FOUND);
    }
    return target;
  }

  private resolveGraphTarget(
    owned: Extract<OwnedRun, { owner: 'graph' }>,
    explicitWorkspaceId?: number,
  ): SessionTarget {
    // server 无 graphDefinition.aiSessionId；该回退仅限桌面本地端。
    const workspaceId = owned.row.workspaceId ?? explicitWorkspaceId;
    if (workspaceId === undefined) {
      throw new BusinessException(
        'RUN_WORKSPACE_REQUIRED',
        'RUN_WORKSPACE_REQUIRED',
      );
    }
    return { workspaceId };
  }

  private async createAndClaim(
    owned: OwnedRun,
    target: SessionTarget,
  ): Promise<RunSessionResult> {
    return await this.prisma.$transaction(async (tx) => {
      const session = await this.sessions.create(
        sessionCreateParams(owned, target),
        tx,
      );
      const claimed = await tx.automationRun.updateMany({
        where: { id: owned.row.id, sessionId: null },
        data: { sessionId: session.id },
      });
      if (claimed.count !== 1) throw new RunClaimConflict();
      return { runId: owned.row.id, sessionId: session.id, created: true };
    });
  }

  private async recoverClaim(
    runId: number,
    originalError: unknown,
  ): Promise<RunSessionResult> {
    const winner = await this.prisma.automationRun.findUnique({
      where: { id: runId },
      select: { sessionId: true },
    });
    if (winner?.sessionId != null) {
      return { runId, sessionId: winner.sessionId, created: false };
    }
    if (winner === null || originalError instanceof RunClaimConflict) {
      throw runNotFound();
    }
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

function sessionCreateParams(owned: OwnedRun, target: SessionTarget) {
  return {
    workspaceId: target.workspaceId,
    projectId: target.projectId,
    userId: COMPANION_USER_ID,
    title: runSessionTitle(owned),
    automationTaskId: owned.owner === 'task' ? owned.task.id : null,
    runGraphId: owned.owner === 'graph' ? owned.graph.id : null,
  };
}
