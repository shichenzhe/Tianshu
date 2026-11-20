import { COMPANION_USER_ID } from 'src/commons/config/tianshu-config.entity';
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
  let workspaceId: number;

  beforeAll(async () => {
    db = await createTestDb();
    service = new RunSessionService(
      db.prisma,
      new SessionRepository(db.prisma),
    );
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

  it('uses the graph AI session workspace before an explicit fallback', async () => {
    const editorWorkspace = await db.prisma.workspace.create({
      data: { name: 'graph-editor-ws', userId: UID },
    });
    const editor = await db.prisma.sessionRecord.create({
      data: {
        workspaceId: editorWorkspace.id,
        title: 'editor',
        userId: UID,
      },
    });
    const graph = await createGraph(db, 'editor-graph');
    const run = await createRun(db, { graphId: graph.id });
    const findGraph = jest
      .spyOn(db.prisma.graphDefinition, 'findFirst')
      .mockResolvedValue({ ...graph, aiSessionId: editor.id } as typeof graph);

    try {
      const result = await service.ensureRunSession({
        runId: run.id,
        workspaceId,
      });
      expect(
        await db.prisma.sessionRecord.findUniqueOrThrow({
          where: { id: result.sessionId },
        }),
      ).toMatchObject({ workspaceId: editorWorkspace.id });
    } finally {
      findGraph.mockRestore();
    }
  });

  it('reuses the deterministic orphan left by a crash before claiming', async () => {
    const graph = await createGraph(db, 'crash-graph');
    const run = await createRun(db, { graphId: graph.id, workspaceId });
    const crash = new Error('claim-crashed');
    const findRun = db.prisma.automationRun.findUnique.bind(
      db.prisma.automationRun,
    );
    const findSpy = jest
      .spyOn(db.prisma.automationRun, 'findUnique')
      .mockImplementationOnce(findRun)
      .mockRejectedValueOnce(crash);
    const claimSpy = jest
      .spyOn(
        service as unknown as {
          claimSession(runId: number, sessionId: number): Promise<boolean>;
        },
        'claimSession',
      )
      .mockRejectedValueOnce(crash);

    try {
      await expect(service.ensureRunSession({ runId: run.id })).rejects.toThrow(
        'claim-crashed',
      );
    } finally {
      findSpy.mockRestore();
      claimSpy.mockRestore();
    }
    const orphans = await db.prisma.sessionRecord.findMany({
      where: { runGraphId: graph.id },
    });
    expect(orphans).toHaveLength(1);

    await expect(service.ensureRunSession({ runId: run.id })).resolves.toEqual({
      runId: run.id,
      sessionId: orphans[0].id,
      created: false,
    });
    expect(
      await db.prisma.sessionRecord.count({
        where: { runGraphId: graph.id },
      }),
    ).toBe(1);
  });

  it('re-reads the winner and removes the loser after a unique conflict', async () => {
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
    const claimSpy = jest
      .spyOn(
        service as unknown as {
          claimSession(runId: number, sessionId: number): Promise<boolean>;
        },
        'claimSession',
      )
      .mockImplementationOnce(async () => {
        await db.prisma.automationRun.update({
          where: { id: run.id },
          data: { sessionId: winner.id },
        });
        throw Object.assign(new Error('unique'), { code: 'P2002' });
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
      claimSpy.mockRestore();
    }
    expect(
      await db.prisma.sessionRecord.findMany({
        where: { runGraphId: graph.id },
        select: { id: true },
      }),
    ).toEqual([{ id: winner.id }]);
  });
});
