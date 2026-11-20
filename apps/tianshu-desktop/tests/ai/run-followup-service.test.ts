import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  automationTask: { findFirst: vi.fn() },
  graphDefinition: { findFirst: vi.fn() },
  automationRun: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  session: {
    findFirst: vi.fn(),
    delete: vi.fn(),
  },
  $transaction: vi.fn(),
}));

const ipcHandlers = vi.hoisted(
  () =>
    new Map<
      string,
      (event: unknown, userId: number, ...args: unknown[]) => unknown
    >(),
);

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../../electron/commons/prisma-client", () => ({ default: db }));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/commons/ipc-user", () => ({
  handleUser: vi.fn(
    (
      channel: string,
      handler: (event: unknown, userId: number, ...args: unknown[]) => unknown,
    ) => ipcHandlers.set(channel, handler),
  ),
}));

import { RunSessionService } from "../../electron/domains/ai/automation/run-session.service";
import type { SessionRepository } from "../../electron/domains/ai/chat/session.repo";

interface TaskFixture {
  id: number;
  userId: number;
  name: string;
  workspaceId: number;
  projectId: number | null;
}

interface GraphFixture {
  id: number;
  userId: number;
  name: string;
  aiSessionId: number | null;
}

interface RunFixture {
  id: number;
  taskId: number | null;
  graphId: number | null;
  sessionId: number | null;
  workspaceId: number | null;
  attempt: number;
  triggerType: string;
  status: string;
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  graphTrace: string | null;
  graphJsonSnapshot: string | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

interface SessionFixture {
  id: number;
  userId: number;
  workspaceId: number;
  projectId: number | null;
  automationTaskId: number | null;
  runGraphId: number | null;
  title: string;
}

function makeRun(overrides: Partial<RunFixture> = {}): RunFixture {
  return {
    id: 50,
    taskId: null,
    graphId: 8,
    sessionId: null,
    workspaceId: null,
    attempt: 1,
    triggerType: "manual",
    status: "success",
    durationMs: 100,
    promptTokens: null,
    completionTokens: null,
    graphTrace: null,
    graphJsonSnapshot: null,
    error: null,
    startedAt: new Date("2026-11-20T01:02:03.000Z"),
    finishedAt: new Date("2026-11-20T01:02:04.000Z"),
    ...overrides,
  };
}

function useData(data: {
  tasks?: TaskFixture[];
  graphs?: GraphFixture[];
  runs?: RunFixture[];
  sessions?: SessionFixture[];
}) {
  const tasks = data.tasks ?? [];
  const graphs = data.graphs ?? [];
  const runs = data.runs ?? [];
  const sessions = data.sessions ?? [];

  db.automationTask.findFirst.mockImplementation(
    async ({ where }: { where: { id: number; userId: number } }) =>
      tasks.find(
        (task) => task.id === where.id && task.userId === where.userId,
      ) ?? null,
  );
  db.graphDefinition.findFirst.mockImplementation(
    async ({ where }: { where: { id: number; userId: number } }) =>
      graphs.find(
        (graph) => graph.id === where.id && graph.userId === where.userId,
      ) ?? null,
  );
  db.automationRun.findUnique.mockImplementation(
    async ({ where }: { where: { id?: number; sessionId?: number } }) =>
      runs.find(
        (run) =>
          (where.id === undefined || run.id === where.id) &&
          (where.sessionId === undefined || run.sessionId === where.sessionId),
      ) ?? null,
  );
  db.session.findFirst.mockImplementation(
    async ({ where }: { where: { id: number; userId: number } }) =>
      sessions.find(
        (session) => session.id === where.id && session.userId === where.userId,
      ) ?? null,
  );
  db.automationRun.updateMany.mockImplementation(
    async ({
      where,
      data,
    }: {
      where: { id: number; sessionId: null };
      data: { sessionId: number };
    }) => {
      const run = runs.find((row) => row.id === where.id);
      if (!run || run.sessionId !== null) return { count: 0 };
      run.sessionId = data.sessionId;
      return { count: 1 };
    },
  );
  db.session.delete.mockImplementation(
    async ({ where }: { where: { id: number } }) => {
      const index = sessions.findIndex((session) => session.id === where.id);
      if (index >= 0) sessions.splice(index, 1);
    },
  );
  db.$transaction.mockImplementation(
    async (callback: (tx: typeof db) => unknown) => callback(db),
  );
  return { tasks, graphs, runs, sessions };
}

function makeService(sessions: SessionFixture[]) {
  const createSession = vi.fn(
    async (params: {
      workspaceId?: number;
      projectId?: number;
      automationTaskId?: number | null;
      runGraphId?: number | null;
      title?: string;
    }) => {
      await Promise.resolve();
      const session: SessionFixture = {
        id: sessions.length + 1,
        userId: 1,
        workspaceId: params.workspaceId ?? 0,
        projectId: params.projectId ?? null,
        automationTaskId: params.automationTaskId ?? null,
        runGraphId: params.runGraphId ?? null,
        title: params.title ?? "新会话",
      };
      sessions.push(session);
      return session;
    },
  );
  const service = new RunSessionService({
    createSession,
  } as unknown as SessionRepository);
  return { service, createSession };
}

beforeEach(() => {
  vi.clearAllMocks();
  ipcHandlers.clear();
});

describe("RunSessionService.ensureRunSession", () => {
  it("returns an existing session without creating another", async () => {
    const state = useData({
      graphs: [{ id: 8, userId: 1, name: "graph", aiSessionId: null }],
      runs: [makeRun({ sessionId: 90, workspaceId: 3 })],
      sessions: [
        {
          id: 90,
          userId: 1,
          workspaceId: 3,
          projectId: null,
          automationTaskId: null,
          runGraphId: 8,
          title: "existing",
        },
      ],
    });
    const { service, createSession } = makeService(state.sessions);

    await expect(service.ensureRunSession(50, 1)).resolves.toEqual({
      runId: 50,
      sessionId: 90,
      created: false,
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("returns one winner and one stored session for concurrent first sends", async () => {
    const state = useData({
      graphs: [{ id: 8, userId: 1, name: "graph", aiSessionId: null }],
      runs: [makeRun({ workspaceId: 3 })],
    });
    const { service } = makeService(state.sessions);

    const [a, b] = await Promise.all([
      service.ensureRunSession(50, 1),
      service.ensureRunSession(50, 1),
    ]);

    expect(a.sessionId).toBe(b.sessionId);
    expect(state.sessions).toHaveLength(1);
    expect([a.created, b.created].sort()).toEqual([false, true]);
  });

  it("re-reads the winner after a unique-session conflict", async () => {
    const state = useData({
      graphs: [{ id: 8, userId: 1, name: "graph", aiSessionId: null }],
      runs: [makeRun({ workspaceId: 3 })],
      sessions: [
        {
          id: 90,
          userId: 1,
          workspaceId: 3,
          projectId: null,
          automationTaskId: null,
          runGraphId: 8,
          title: "winner",
        },
      ],
    });
    const { service } = makeService(state.sessions);
    db.automationRun.updateMany.mockImplementation(async () => {
      state.runs[0].sessionId = 90;
      throw Object.assign(new Error("unique"), { code: "P2002" });
    });

    await expect(service.ensureRunSession(50, 1)).resolves.toEqual({
      runId: 50,
      sessionId: 90,
      created: false,
    });
    expect(state.sessions.map((session) => session.id)).toEqual([90]);
  });

  it("creates a companion for a failed prompt run with task ownership", async () => {
    const state = useData({
      tasks: [
        { id: 4, userId: 1, name: "prompt", workspaceId: 12, projectId: 6 },
      ],
      runs: [
        makeRun({
          taskId: 4,
          graphId: null,
          status: "failed",
          error: "model_missing",
        }),
      ],
    });
    const { service, createSession } = makeService(state.sessions);

    await expect(service.ensureRunSession(50, 1)).resolves.toMatchObject({
      runId: 50,
      created: true,
    });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 12,
        projectId: 6,
        automationTaskId: 4,
        runGraphId: null,
        title: "prompt · 2026-11-20T01:02:03.000Z",
      }),
      1,
    );
  });

  it.each(["running", "skipped"])("rejects %s runs", async (status) => {
    const state = useData({
      graphs: [{ id: 8, userId: 1, name: "graph", aiSessionId: null }],
      runs: [makeRun({ status, workspaceId: 3 })],
    });
    const { service, createSession } = makeService(state.sessions);

    await expect(service.ensureRunSession(50, 1)).rejects.toThrow(
      "RUN_NOT_FOLLOWABLE",
    );
    expect(createSession).not.toHaveBeenCalled();
  });

  it("requires a workspace for historical graph runs instead of guessing", async () => {
    const state = useData({
      graphs: [{ id: 8, userId: 1, name: "graph", aiSessionId: null }],
      runs: [makeRun()],
    });
    const { service, createSession } = makeService(state.sessions);

    await expect(service.ensureRunSession(50, 1)).rejects.toThrow(
      "RUN_WORKSPACE_REQUIRED",
    );
    expect(createSession).not.toHaveBeenCalled();
  });

  it("uses the graph AI session workspace before an explicit fallback", async () => {
    const state = useData({
      graphs: [{ id: 8, userId: 1, name: "graph", aiSessionId: 900 }],
      runs: [makeRun()],
      sessions: [
        {
          id: 900,
          userId: 1,
          workspaceId: 31,
          projectId: null,
          automationTaskId: null,
          runGraphId: null,
          title: "editor",
        },
      ],
    });
    const { service, createSession } = makeService(state.sessions);

    await service.ensureRunSession(50, 1, 99);

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 31, runGraphId: 8 }),
      1,
    );
  });

  it("registers the user-scoped lazy-creation IPC channel", () => {
    const state = useData({});
    makeService(state.sessions);

    expect(ipcHandlers.has("automation:run:ensureSession")).toBe(true);
  });
});
