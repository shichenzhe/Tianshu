import { COMPANION_USER_ID } from 'src/commons/config/tianshu-config.entity';
import { BusinessException } from 'src/commons/exception/bussiness-exception';
import { ErrorCodeEnum } from 'src/commons/exception/error-code.enum';
import { RunSessionService } from 'src/modules/automation/run-session.service';
import { SessionRepository } from 'src/modules/session/session.repository';
import { createTestDb, type TestDb } from '../support/test-db';

const UID = COMPANION_USER_ID;
const STARTED_AT = new Date('2026-11-20T01:02:03.000Z');

async function createGraph(db: TestDb, name: string) {
  return db.prisma.graphDefinition.create({
    data: { name, graphJson: '{}', userId: UID },
  });
}

async function createRun(
  db: TestDb,
  data: Record<string, unknown>,
): Promise<{ id: number }> {
  return db.prisma.automationRun.create({
    data: {
      attempt: 1,
      triggerType: 'manual',
      status: 'success',
      startedAt: STARTED_AT,
      ...data,
    },
    select: { id: true },
  });
}

describe('RunSessionService.ensureRunSession', () => {
  let db: TestDb;
  let service: RunSessionService;
  let sessions: SessionRepository;
  let workspaceId: number;

  beforeAll(async () => {
    db = await createTestDb();
    sessions = new SessionRepository(db.prisma);
    service = new RunSessionService(db.prisma, sessions);
    const workspace = await db.prisma.workspace.create({
      data: { name: 'run-followup-ws', userId: UID },
    });
    workspaceId = workspace.id;
  }, 120_000);

  afterAll(async () => {
    await db.cleanup();
  });

  it('returns an existing run session without creating another', async () => {
    const graph = await createGraph(db, 'existing-graph');
    const existing = await db.prisma.sessionRecord.create({
      data: {
        workspaceId,
        title: 'existing',
        userId: UID,
        runGraphId: graph.id,
      },
    });
    const run = await createRun(db, {
      graphId: graph.id,
      workspaceId,
      sessionId: existing.id,
    });

    await expect(service.ensureRunSession({ runId: run.id })).resolves.toEqual({
      runId: run.id,
      sessionId: existing.id,
      created: false,
    });
    expect(
      await db.prisma.sessionRecord.count({
        where: { runGraphId: graph.id },
      }),
    ).toBe(1);
  });

  it('returns one winner and retains one session for concurrent first sends', async () => {
    const graph = await createGraph(db, 'concurrent-graph');
    const run = await createRun(db, { graphId: graph.id, workspaceId });
    const dto = { runId: run.id };

    const [a, b] = await Promise.all([
      service.ensureRunSession(dto),
      service.ensureRunSession(dto),
    ]);

    expect(a.sessionId).toBe(b.sessionId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(
      await db.prisma.sessionRecord.count({
        where: { runGraphId: graph.id },
      }),
    ).toBe(1);
  });

  it('creates a companion for a failed prompt run with task ownership', async () => {
    const task = await db.prisma.automationTask.create({
      data: {
        name: 'failed-prompt',
        prompt: 'prompt',
        workspaceId,
        projectId: 6,
        modelId: 1,
        scheduleJson: '{}',
        scheduleText: 'manual',
        userId: UID,
      },
    });
    const run = await createRun(db, {
      taskId: task.id,
      status: 'failed',
      error: 'model_missing',
    });

    const result = await service.ensureRunSession({ runId: run.id });

    expect(result).toMatchObject({ runId: run.id, created: true });
    expect(
      await db.prisma.sessionRecord.findUniqueOrThrow({
        where: { id: result.sessionId },
      }),
    ).toMatchObject({
      workspaceId,
      projectId: 6,
      automationTaskId: task.id,
      runGraphId: null,
      title: 'failed-prompt · 2026-11-20T01:02:03.000Z',
    });
  });

  it.each(['running', 'skipped'])('rejects %s runs', async (status) => {
    const graph = await createGraph(db, `invalid-${status}`);
    const run = await createRun(db, {
      graphId: graph.id,
      workspaceId,
      status,
    });

    await expect(
      service.ensureRunSession({ runId: run.id }),
    ).rejects.toMatchObject({ code: 'RUN_NOT_FOLLOWABLE' });
    expect(
      await db.prisma.sessionRecord.count({
        where: { runGraphId: graph.id },
      }),
    ).toBe(0);
  });

  it('requires an explicit workspace for an unknown historical graph run', async () => {
    const graph = await createGraph(db, 'historical-graph');
    const run = await createRun(db, { graphId: graph.id });

    await expect(
      service.ensureRunSession({ runId: run.id }),
    ).rejects.toMatchObject({ code: 'RUN_WORKSPACE_REQUIRED' });

    const result = await service.ensureRunSession({
      runId: run.id,
      workspaceId,
    });
    expect(
      await db.prisma.sessionRecord.findUniqueOrThrow({
        where: { id: result.sessionId },
      }),
    ).toMatchObject({ workspaceId, runGraphId: graph.id });
  });

  it('rolls back creation atomically when claim fails and retries cleanly', async () => {
    const graph = await createGraph(db, 'atomic-graph');
    const run = await createRun(db, { graphId: graph.id, workspaceId });
    const trigger = `fail_run_claim_${run.id}`;
    await db.prisma.$executeRawUnsafe(
      `CREATE TRIGGER "${trigger}" BEFORE UPDATE OF sessionId ON automationRun WHEN OLD.id = ${run.id} BEGIN SELECT RAISE(ABORT, 'claim-crashed'); END`,
    );
    const recoveryCrash = new Error('recovery-crashed');
    const findRun = db.prisma.automationRun.findUnique.bind(
      db.prisma.automationRun,
    );
    const findSpy = jest
      .spyOn(db.prisma.automationRun, 'findUnique')
      .mockImplementationOnce(findRun)
      .mockRejectedValueOnce(recoveryCrash);

    try {
      await expect(service.ensureRunSession({ runId: run.id })).rejects.toThrow(
        'recovery-crashed',
      );
    } finally {
      findSpy.mockRestore();
      await db.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}"`);
    }
    expect(
      await db.prisma.sessionRecord.count({
        where: { runGraphId: graph.id },
      }),
    ).toBe(0);

    await expect(
      service.ensureRunSession({ runId: run.id }),
    ).resolves.toMatchObject({ runId: run.id, created: true });
    expect(
      await db.prisma.sessionRecord.count({
        where: { runGraphId: graph.id },
      }),
    ).toBe(1);
  });

  it('never claims a stale orphan for a different resolved target', async () => {
    const otherWorkspace = await db.prisma.workspace.create({
      data: { name: 'stale-target-ws', userId: UID },
    });
    const graph = await createGraph(db, 'stale-target');
    const stale = await db.prisma.sessionRecord.create({
      data: {
        workspaceId: otherWorkspace.id,
        projectId: 99,
        title: 'stale-target · 2026-11-20T01:02:03.000Z',
        userId: UID,
        runGraphId: graph.id,
      },
    });
    const run = await createRun(db, { graphId: graph.id, workspaceId });

    const result = await service.ensureRunSession({ runId: run.id });

    expect(result.sessionId).not.toBe(stale.id);
    expect(result.created).toBe(true);
    expect(
      await db.prisma.sessionRecord.findUniqueOrThrow({
        where: { id: result.sessionId },
      }),
    ).toMatchObject({ workspaceId, projectId: null });
  });

  it('returns RUN_NOT_FOUND once when the run is deleted before claim', async () => {
    const graph = await createGraph(db, 'deleted-before-claim');
    const run = await createRun(db, { graphId: graph.id, workspaceId });
    const getWorkspace: SessionRepository['getWorkspaceById'] =
      sessions.getWorkspaceById.bind(sessions);
    const targetSpy = jest
      .spyOn(sessions, 'getWorkspaceById')
      .mockImplementationOnce(async (id: number, targetUserId: number) => {
        const workspace = await getWorkspace(id, targetUserId);
        await db.prisma.automationRun.delete({ where: { id: run.id } });
        return workspace;
      });

    try {
      const error = await service
        .ensureRunSession({ runId: run.id })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BusinessException);
      expect(error).toMatchObject({
        message: 'RUN_NOT_FOUND',
        code: ErrorCodeEnum.NOT_FOUND,
      });
    } finally {
      targetSpy.mockRestore();
    }
    expect(
      await db.prisma.sessionRecord.count({
        where: { runGraphId: graph.id },
      }),
    ).toBe(0);
  });

  it('re-reads a competing winner and rolls back the losing creation', async () => {
    const graph = await createGraph(db, 'unique-graph');
    const winner = await db.prisma.sessionRecord.create({
      data: {
        workspaceId,
        title: 'winner',
        userId: UID,
        runGraphId: graph.id,
      },
    });
    const run = await createRun(db, { graphId: graph.id, workspaceId });
    const getWorkspace: SessionRepository['getWorkspaceById'] =
      sessions.getWorkspaceById.bind(sessions);
    const targetSpy = jest
      .spyOn(sessions, 'getWorkspaceById')
      .mockImplementationOnce(async (id: number, targetUserId: number) => {
        const workspace = await getWorkspace(id, targetUserId);
        await db.prisma.automationRun.update({
          where: { id: run.id },
          data: { sessionId: winner.id },
        });
        return workspace;
      });

    try {
      await expect(
        service.ensureRunSession({ runId: run.id }),
      ).resolves.toEqual({
        runId: run.id,
        sessionId: winner.id,
        created: false,
      });
    } finally {
      targetSpy.mockRestore();
    }
    expect(
      await db.prisma.sessionRecord.findMany({
        where: { runGraphId: graph.id },
        select: { id: true },
      }),
    ).toEqual([{ id: winner.id }]);
  });
});
