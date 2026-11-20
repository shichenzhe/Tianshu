import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaService } from 'src/commons/database/prisma.service';
import { ensureRunSessionAggregation } from 'src/commons/database/ensure-run-session-aggregation';
import { COMPANION_USER_ID } from 'src/commons/config/tianshu-config.entity';
import { EventBusService } from 'src/commons/event-bus/event-bus.service';
import { AutomationRepository } from 'src/modules/automation/automation.repository';
import { trimAutomationRuns } from 'src/modules/automation/automation-retention';
import { AutomationService } from 'src/modules/automation/automation.service';
import { GraphRepository } from 'src/modules/graph/graph.repository';
import { SessionRepository } from 'src/modules/session/session.repository';
import { SessionQueryDto } from 'src/modules/session/dto/session-query.dto';
import { SessionWireDto } from 'src/modules/session/dto/session-wire.dto';
import { createTestDb, type TestDb } from '../support/test-db';

const UID = COMPANION_USER_ID;
const OTHER_UID = 2;
const SERVER_ROOT = join(__dirname, '..', '..');
const PRISMA_CLI = join(
  SERVER_ROOT,
  'node_modules',
  'prisma',
  'build',
  'index.js',
);

async function createTask(
  db: TestDb,
  workspaceId: number,
  name: string,
  overrides: Record<string, unknown> = {},
) {
  return db.prisma.automationTask.create({
    data: {
      name,
      prompt: 'prompt',
      workspaceId,
      modelId: 1,
      scheduleJson: '{"mode":"interval","value":5,"unit":"minute"}',
      scheduleText: 'every 5 minutes',
      userId: UID,
      ...overrides,
    },
  });
}

async function createRun(db: TestDb, data: Record<string, unknown>) {
  return db.prisma.automationRun.create({
    data: {
      attempt: 1,
      triggerType: 'manual',
      status: 'success',
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...data,
    },
  });
}

async function createSession(
  db: TestDb,
  workspaceId: number,
  title: string,
  data: Record<string, unknown> = {},
) {
  return db.prisma.sessionRecord.create({
    data: { workspaceId, title, userId: UID, ...data },
  });
}

async function createMessage(db: TestDb, sessionId: number) {
  return db.prisma.messageRecord.create({
    data: { sessionId, role: 'user', blocks: '[]' },
  });
}

describe('run session persistence and queries', () => {
  let db: TestDb;
  let automations: AutomationRepository;
  let graphs: GraphRepository;
  let service: AutomationService;
  let workspaceId: number;

  beforeAll(async () => {
    db = await createTestDb();
    automations = new AutomationRepository(db.prisma);
    graphs = new GraphRepository(db.prisma);
    service = new AutomationService(
      db.prisma,
      automations,
      new EventBusService(),
    );
    const workspace = await db.prisma.workspace.create({
      data: { name: 'run-session-ws', userId: UID },
    });
    workspaceId = workspace.id;
  }, 120_000);

  afterAll(async () => {
    await db.cleanup();
  });

  it('graph createRun writes the actual workspace and sessionId is unique', async () => {
    const graph = await db.prisma.graphDefinition.create({
      data: { name: 'workspace-graph', graphJson: '{}', userId: UID },
    });
    const session = await createSession(db, workspaceId, 'unique-session');
    const runId = await graphs.createRun({
      taskId: null,
      graphId: graph.id,
      workspaceId,
      attempt: 1,
      triggerType: 'manual',
      graphJsonSnapshot: '{}',
    });
    await db.prisma.automationRun.update({
      where: { id: runId },
      data: { sessionId: session.id },
    });
    const run = await db.prisma.automationRun.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(run.workspaceId).toBe(workspaceId);
    await expect(
      createRun(db, { graphId: graph.id, sessionId: session.id }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('runGroups includes all tasks and only top-level or companion graph groups', async () => {
    const emptyTask = await createTask(db, workspaceId, 'empty-task');
    const promptTask = await createTask(db, workspaceId, 'prompt-task');
    const promptRun = await createRun(db, {
      taskId: promptTask.id,
      workspaceId,
      startedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    const topGraph = await db.prisma.graphDefinition.create({
      data: { name: 'top-graph', graphJson: '{}', userId: UID },
    });
    const topRun = await createRun(db, {
      graphId: topGraph.id,
      workspaceId,
      graphTrace: '[{"output":"top"}]',
      graphJsonSnapshot: '{"secret":true}',
      startedAt: new Date('2026-01-03T00:00:00.000Z'),
    });
    await createRun(db, {
      graphId: topGraph.id,
      triggerType: 'subflow',
      startedAt: new Date('2026-01-04T00:00:00.000Z'),
    });
    const subflowGraph = await db.prisma.graphDefinition.create({
      data: { name: 'subflow-only', graphJson: '{}', userId: UID },
    });
    await createRun(db, {
      graphId: subflowGraph.id,
      triggerType: 'subflow',
    });
    const companionGraph = await db.prisma.graphDefinition.create({
      data: { name: 'companion-only', graphJson: '{}', userId: UID },
    });
    await createSession(db, workspaceId, 'companion', {
      runGraphId: companionGraph.id,
    });
    const graphTask = await createTask(db, workspaceId, 'graph-task', {
      targetKind: 'graph',
      graphId: topGraph.id,
    });
    const graphTaskRun = await createRun(db, {
      taskId: graphTask.id,
      graphId: topGraph.id,
      startedAt: new Date('2026-01-05T00:00:00.000Z'),
    });

    const runFindMany = jest.spyOn(db.prisma.automationRun, 'findMany');
    const groups = await service.runGroups();
    const runFindManyCalls = [...runFindMany.mock.calls];
    runFindMany.mockRestore();

    expect(groups).toContainEqual(
      expect.objectContaining({
        kind: 'task',
        ownerId: emptyTask.id,
        hasRuns: false,
      }),
    );
    expect(groups).toContainEqual(
      expect.objectContaining({
        kind: 'task',
        ownerId: promptTask.id,
        latestRun: expect.objectContaining({
          id: promptRun.id,
          workspaceId,
        }),
      }),
    );
    expect(groups).toContainEqual(
      expect.objectContaining({
        kind: 'task',
        ownerId: graphTask.id,
        latestRun: expect.objectContaining({ id: graphTaskRun.id }),
      }),
    );
    expect(groups).toContainEqual(
      expect.objectContaining({
        kind: 'graph',
        ownerId: topGraph.id,
        latestRun: expect.objectContaining({ id: topRun.id }),
      }),
    );
    expect(groups).toContainEqual(
      expect.objectContaining({
        kind: 'graph',
        ownerId: companionGraph.id,
        workspaceId,
        hasRuns: false,
      }),
    );
    expect(
      groups.some(
        (group) => group.kind === 'graph' && group.ownerId === subflowGraph.id,
      ),
    ).toBe(false);
    const topGroup = groups.find(
      (group) => group.kind === 'graph' && group.ownerId === topGraph.id,
    );
    expect(topGroup?.latestRun).not.toHaveProperty('graphTrace');
    expect(topGroup?.latestRun).not.toHaveProperty('graphJsonSnapshot');
    expect(runFindManyCalls).toHaveLength(2);
    for (const [rawArgs] of runFindManyCalls) {
      const args = rawArgs as { select?: Record<string, boolean> };
      expect(args.select).toBeDefined();
      expect(args.select).not.toHaveProperty('graphTrace');
      expect(args.select).not.toHaveProperty('graphJsonSnapshot');
    }
  });

  it('runById reads a run beyond the first page with graphTrace and rejects other owners', async () => {
    const graph = await db.prisma.graphDefinition.create({
      data: { name: 'detail-graph', graphJson: '{}', userId: UID },
    });
    const target = await createRun(db, {
      graphId: graph.id,
      graphTrace: '[{"output":"final-output"}]',
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    for (let index = 1; index <= 20; index += 1) {
      await createRun(db, {
        graphId: graph.id,
        startedAt: new Date(2026, 0, index + 1),
      });
    }
    const detail = await service.runById({ runId: target.id });
    expect(detail.id).toBe(target.id);
    expect(detail.graphTrace).toBe('[{"output":"final-output"}]');

    const otherWorkspace = await db.prisma.workspace.create({
      data: { name: 'other-ws', userId: OTHER_UID },
    });
    const otherTask = await db.prisma.automationTask.create({
      data: {
        name: 'other-task',
        prompt: 'p',
        workspaceId: otherWorkspace.id,
        modelId: 1,
        scheduleJson: '{}',
        scheduleText: 'other',
        userId: OTHER_UID,
      },
    });
    const otherUsersRun = await createRun(db, { taskId: otherTask.id });
    await expect(
      service.runById({ runId: otherUsersRun.id }),
    ).rejects.toMatchObject({ code: expect.any(String) });
  });

  it('deleting a task clears grouping before runs and preserves messages', async () => {
    const task = await createTask(db, workspaceId, 'delete-task');
    const session = await createSession(db, workspaceId, 'task-history', {
      automationTaskId: task.id,
    });
    await createMessage(db, session.id);
    await createRun(db, { taskId: task.id, sessionId: session.id });

    await automations.deleteTasks([task.id], UID);

    const after = await db.prisma.sessionRecord.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(after).toMatchObject({ automationTaskId: null, runGraphId: null });
    expect(
      await db.prisma.messageRecord.count({ where: { sessionId: session.id } }),
    ).toBe(1);
  });

  it('deleting a graph clears grouping before runs and preserves messages', async () => {
    const graph = await db.prisma.graphDefinition.create({
      data: { name: 'delete-graph', graphJson: '{}', userId: UID },
    });
    const session = await createSession(db, workspaceId, 'graph-history', {
      runGraphId: graph.id,
    });
    await createMessage(db, session.id);
    await createRun(db, { graphId: graph.id, sessionId: session.id });

    await graphs.deleteGraph(graph.id, UID);

    const after = await db.prisma.sessionRecord.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(after).toMatchObject({ automationTaskId: null, runGraphId: null });
    expect(
      await db.prisma.messageRecord.count({ where: { sessionId: session.id } }),
    ).toBe(1);
  });

  it('retention clears grouping for day and count deletions without deleting messages', async () => {
    const dayTask = await createTask(db, workspaceId, 'retention-day');
    const daySession = await createSession(db, workspaceId, 'retention-day', {
      automationTaskId: dayTask.id,
    });
    await createMessage(db, daySession.id);
    await createRun(db, {
      taskId: dayTask.id,
      sessionId: daySession.id,
      startedAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    await trimAutomationRuns(
      db.prisma,
      {
        enabled: true,
        traceDays: 3650,
        successDays: 1,
        successKeep: 10000,
        failureDays: 30,
        failureKeep: 500,
      },
      new Date('2026-01-10T00:00:00.000Z'),
    );
    expect(
      await db.prisma.sessionRecord.findUniqueOrThrow({
        where: { id: daySession.id },
      }),
    ).toMatchObject({ automationTaskId: null, runGraphId: null });
    expect(
      await db.prisma.messageRecord.count({
        where: { sessionId: daySession.id },
      }),
    ).toBe(1);

    const keepTask = await createTask(db, workspaceId, 'retention-keep');
    const oldSession = await createSession(db, workspaceId, 'retention-old', {
      automationTaskId: keepTask.id,
    });
    await createMessage(db, oldSession.id);
    const oldRun = await createRun(db, {
      taskId: keepTask.id,
      sessionId: oldSession.id,
      startedAt: new Date('2026-01-08T00:00:00.000Z'),
    });
    await createRun(db, {
      taskId: keepTask.id,
      startedAt: new Date('2026-01-09T00:00:00.000Z'),
    });
    await trimAutomationRuns(
      db.prisma,
      {
        enabled: true,
        traceDays: 3650,
        successDays: 3650,
        successKeep: 1,
        failureDays: 3650,
        failureKeep: 500,
      },
      new Date('2026-01-10T00:00:00.000Z'),
    );
    expect(
      await db.prisma.automationRun.findUnique({ where: { id: oldRun.id } }),
    ).toBeNull();
    expect(
      await db.prisma.sessionRecord.findUniqueOrThrow({
        where: { id: oldSession.id },
      }),
    ).toMatchObject({ automationTaskId: null, runGraphId: null });
    expect(
      await db.prisma.messageRecord.count({
        where: { sessionId: oldSession.id },
      }),
    ).toBe(1);
  });

  it('session reads expose grouping fields and the linked automationRunId', async () => {
    const task = await createTask(db, workspaceId, 'wire-task');
    const sessions = new SessionRepository(db.prisma);
    const session = await sessions.create({
      workspaceId,
      userId: UID,
      title: 'wire-session',
      automationTaskId: task.id,
      runGraphId: null,
    });
    const run = await createRun(db, {
      taskId: task.id,
      sessionId: session.id,
    });

    const detail = await sessions.findById(session.id, UID);
    expect(detail).toMatchObject({
      automationTaskId: task.id,
      runGraphId: null,
      automationRunId: run.id,
    });
    expect(SessionWireDto.of(detail!)).toMatchObject({
      automationTaskId: task.id,
      runGraphId: null,
      automationRunId: run.id,
    });
    const query = Object.assign(new SessionQueryDto(), {
      page: 1,
      pageSize: 100,
    });
    const page = await sessions.query(query, UID);
    expect(page.records.find((row) => row.id === session.id)).toMatchObject({
      automationTaskId: task.id,
      runGraphId: null,
      automationRunId: run.id,
    });

    await sessions.delete(session.id);
    expect(
      await db.prisma.automationRun.findUniqueOrThrow({
        where: { id: run.id },
      }),
    ).toMatchObject({ sessionId: null });
  });
});

describe('run session migration 5 and SQLite upgrade', () => {
  it('migration backfills only prompt sessions linked to surviving runs and enforces uniqueness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tianshu-run-migration-'));
    const schemaPath = join(root, 'schema.prisma');
    const dbUrl = `file:${join(root, 'legacy.db')}`;
    const schema = readFileSync(
      join(SERVER_ROOT, 'prisma', 'schema.prisma'),
      'utf8',
    ).replace(/url\s*=\s*"file:\.\/local\.db"/, 'url = env("DATABASE_URL")');
    writeFileSync(schemaPath, schema);
    mkdirSync(join(root, 'migrations'));
    cpSync(
      join(SERVER_ROOT, 'prisma', 'migrations', 'migration_lock.toml'),
      join(root, 'migrations', 'migration_lock.toml'),
    );
    for (const name of [
      '0_init',
      '1_automation_run_graph_snapshot',
      '2_automation_task_catch_up_limit',
      '3_model_capability_matrix',
      '4_permission_pattern_last_used',
    ]) {
      cpSync(
        join(SERVER_ROOT, 'prisma', 'migrations', name),
        join(root, 'migrations', name),
        { recursive: true },
      );
    }
    const deploy = () =>
      execFileSync(
        process.execPath,
        [PRISMA_CLI, 'migrate', 'deploy', '--schema', schemaPath],
        { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'pipe' },
      );
    deploy();
    const prisma = new PrismaService({
      datasources: { db: { url: dbUrl } },
    });
    try {
      await prisma.$connect();
      await prisma.$executeRawUnsafe(
        "INSERT INTO automationTask (id,name,prompt,workspaceId,modelId,scheduleJson,scheduleText,updatedAt) VALUES (1,'task','p',1,1,'{}','task',CURRENT_TIMESTAMP)",
      );
      for (const id of [1, 2, 3]) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO session (id,workspaceId,title,updatedAt) VALUES (${id},1,'s${id}',CURRENT_TIMESTAMP)`,
        );
      }
      await prisma.$executeRawUnsafe(
        "INSERT INTO automationRun (id,taskId,sessionId,attempt,triggerType,status) VALUES (1,1,1,1,'manual','success')",
      );
      await prisma.$executeRawUnsafe(
        "INSERT INTO automationRun (id,taskId,sessionId,graphId,attempt,triggerType,status) VALUES (2,NULL,3,9,1,'manual','success')",
      );
      cpSync(
        join(SERVER_ROOT, 'prisma', 'migrations', '5_run_session_aggregation'),
        join(root, 'migrations', '5_run_session_aggregation'),
        { recursive: true },
      );
      deploy();
      const rows = await prisma.$queryRawUnsafe<
        Array<{
          id: number;
          automationTaskId: number | null;
          runGraphId: number | null;
        }>
      >('SELECT id, automationTaskId, runGraphId FROM session ORDER BY id');
      expect(rows).toEqual([
        { id: 1, automationTaskId: 1, runGraphId: null },
        { id: 2, automationTaskId: null, runGraphId: null },
        { id: 3, automationTaskId: null, runGraphId: null },
      ]);
      await expect(
        prisma.$executeRawUnsafe(
          "INSERT INTO automationRun (id,taskId,sessionId,attempt,triggerType,status) VALUES (3,1,1,1,'manual','success')",
        ),
      ).rejects.toThrow();
    } finally {
      await prisma.$disconnect();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('SQLite startup upgrade adds missing columns and PG leaves migration to deploy', async () => {
    const calls: string[] = [];
    const columns: Record<string, Array<{ name: string }>> = {
      session: [{ name: 'id' }],
      automationRun: [{ name: 'id' }],
    };
    const db = {
      $queryRawUnsafe: jest.fn((sql: string) =>
        Promise.resolve(
          sql.includes("pragma_table_info('session')")
            ? columns.session
            : columns.automationRun,
        ),
      ),
      $executeRawUnsafe: jest.fn((sql: string) => {
        calls.push(sql);
        return Promise.resolve(0);
      }),
    };
    await ensureRunSessionAggregation(db, 'sqlite');
    expect(
      calls.some((sql) => sql.includes('ADD COLUMN "automationTaskId"')),
    ).toBe(true);
    expect(calls.some((sql) => sql.includes('ADD COLUMN "workspaceId"'))).toBe(
      true,
    );
    expect(
      calls.some((sql) => sql.includes('automationRun_sessionId_key')),
    ).toBe(true);
    await ensureRunSessionAggregation(db, 'postgres');
    expect(db.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });
});
