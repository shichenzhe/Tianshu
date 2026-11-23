import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  automationTask: { findFirst: vi.fn() },
  graphDefinition: { findFirst: vi.fn() },
  workspace: { findFirst: vi.fn(), delete: vi.fn() },
  automationRun: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  session: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  message: { deleteMany: vi.fn() },
  $transaction: vi.fn(),
}));

const ipcHandlers = vi.hoisted(
  () =>
    new Map<
      string,
      (event: unknown, userId: number, ...args: unknown[]) => unknown
    >(),
);

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: {},
  shell: {},
}));
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

vi.mock("../../electron/domains/ai/chat/workspace-change-bus", () => ({
  emitWorkspaceChanged: vi.fn(),
}));
vi.mock("../../electron/domains/ai/file-window/granted-paths", () => ({
  revokeSession: vi.fn(async () => undefined),
}));
vi.mock("../../electron/domains/ai/chat/session-change-bus", () => ({
  emitSessionChanged: vi.fn(),
}));

import { RunSessionService } from "../../electron/domains/ai/automation/run-session.service";
import { SessionRepository } from "../../electron/domains/ai/chat/session.repo";

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
  lastMessageAt?: Date | null;
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
  db.session.findMany.mockImplementation(
    async ({
      where,
    }: {
      where: {
        userId?: number;
        title?: string;
        automationTaskId?: number | null;
        runGraphId?: number | null;
        workspaceId?: number;
        projectId?: number | null;
      };
    }) => {
      if (where.title === undefined && where.workspaceId !== undefined) {
        return sessions.filter(
          (session) => session.workspaceId === where.workspaceId,
        );
      }
      return sessions.filter(
        (session) =>
          session.userId === where.userId &&
          session.title === where.title &&
          session.automationTaskId === where.automationTaskId &&
          session.runGraphId === where.runGraphId &&
          (where.workspaceId === undefined ||
            session.workspaceId === where.workspaceId) &&
          (where.projectId === undefined ||
            session.projectId === where.projectId) &&
          session.lastMessageAt == null,
      );
    },
  );
  db.automationRun.findMany.mockImplementation(
    async ({ where }: { where: { sessionId: { in: number[] } } }) =>
      runs.filter(
        (run) =>
          run.sessionId !== null && where.sessionId.in.includes(run.sessionId),
      ),
  );
  db.automationRun.updateMany.mockImplementation(
    async ({
      where,
      data,
    }: {
      where: { id?: number; sessionId: null | number | { in: number[] } };
      data: { sessionId: number | null };
    }) => {
      if (where.id === undefined) {
        const sessionIds =
          typeof where.sessionId === "object" && where.sessionId !== null
            ? where.sessionId.in
            : [where.sessionId];
        const matched = runs.filter(
          (run) => run.sessionId !== null && sessionIds.includes(run.sessionId),
        );
        matched.forEach((run) => {
          run.sessionId = data.sessionId;
        });
        return { count: matched.length };
      }
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
  db.session.deleteMany.mockImplementation(
    async ({ where }: { where: { workspaceId: number } }) => {
      const remaining = sessions.filter(
        (session) => session.workspaceId !== where.workspaceId,
      );
      const count = sessions.length - remaining.length;
      sessions.splice(0, sessions.length, ...remaining);
      return { count };
    },
  );
  db.workspace.findFirst.mockImplementation(
    async ({ where }: { where: { id: number; userId: number } }) => ({
      id: where.id,
      userId: where.userId,
    }),
  );
  db.workspace.delete.mockResolvedValue({});
  db.message.deleteMany.mockResolvedValue({ count: 0 });
  db.$transaction.mockImplementation(
    async (input: Array<Promise<unknown>> | ((tx: typeof db) => unknown)) => {
      if (typeof input === "function") return input(db);
      const results = [];
      for (const operation of input) results.push(await operation);
      return results;
    },
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

  it("reuses a deterministic orphan after a crash between creation and claim", async () => {
    const state = useData({
      graphs: [{ id: 8, userId: 1, name: "graph", aiSessionId: null }],
      runs: [makeRun({ workspaceId: 3 })],
    });
    const { service, createSession } = makeService(state.sessions);
    const crash = new Error("claim-crashed");
    db.automationRun.updateMany.mockRejectedValueOnce(crash);
    db.automationRun.findUnique.mockImplementationOnce(
      async () => state.runs[0],
    );
    db.automationRun.findUnique.mockImplementationOnce(async () => {
      throw crash;
    });

    await expect(service.ensureRunSession(50, 1)).rejects.toThrow(
      "claim-crashed",
    );
    expect(state.sessions).toHaveLength(1);

    await expect(service.ensureRunSession(50, 1)).resolves.toEqual({
      runId: 50,
      sessionId: state.sessions[0].id,
      created: false,
    });
    expect(state.sessions).toHaveLength(1);
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("preserves a reused orphan claimed by another run during recovery", async () => {
    const state = useData({
      graphs: [{ id: 8, userId: 1, name: "graph", aiSessionId: null }],
      runs: [makeRun({ workspaceId: 3 }), makeRun({ id: 51 })],
      sessions: [
        {
          id: 90,
          userId: 1,
          workspaceId: 3,
          projectId: null,
          automationTaskId: null,
          runGraphId: 8,
          title: "graph · 2026-11-20T01:02:03.000Z",
          lastMessageAt: null,
        },
      ],
    });
    const { service } = makeService(state.sessions);
    db.automationRun.updateMany.mockImplementation(
      async ({ data }: { data: { sessionId: number } }) => {
        state.runs[1].sessionId = data.sessionId;
        return { count: 0 };
      },
    );

    await expect(service.ensureRunSession(50, 1)).rejects.toThrow(
      "RUN_NOT_FOUND",
    );

    expect(state.runs[1].sessionId).toBe(90);
    expect(state.sessions.map((session) => session.id)).toEqual([90]);
  });

  it("preserves a newly created candidate claimed by another run before recovery", async () => {
    const state = useData({
      graphs: [{ id: 8, userId: 1, name: "graph", aiSessionId: null }],
      runs: [makeRun({ workspaceId: 3 }), makeRun({ id: 51 })],
    });
    const { service } = makeService(state.sessions);
    const claimRace = new Error("unique-session-race");
    db.automationRun.updateMany.mockImplementation(
      async ({ data }: { data: { sessionId: number } }) => {
        state.runs[1].sessionId = data.sessionId;
        throw claimRace;
      },
    );

    await expect(service.ensureRunSession(50, 1)).rejects.toThrow(claimRace);

    expect(state.runs[1].sessionId).toBe(1);
    expect(state.sessions.map((session) => session.id)).toEqual([1]);
  });

  it("preserves a candidate claimed by the same run after a null winner read", async () => {
    const state = useData({
      graphs: [{ id: 8, userId: 1, name: "graph", aiSessionId: null }],
      runs: [makeRun({ workspaceId: 3 })],
    });
    const { service } = makeService(state.sessions);
    db.automationRun.updateMany.mockResolvedValue({ count: 0 });
    let winnerReadCount = 0;
    db.automationRun.findUnique
      .mockReset()
      .mockImplementation(
        async ({ where }: { where: { id?: number; sessionId?: number } }) => {
          winnerReadCount++;
          const row = state.runs.find(
            (run) =>
              (where.id === undefined || run.id === where.id) &&
              (where.sessionId === undefined ||
                run.sessionId === where.sessionId),
          );
          if (row && winnerReadCount === 2) {
            return { ...row, sessionId: null };
          }
          return row ?? null;
        },
      );
    db.automationRun.findMany.mockImplementation(async () => {
      state.runs[0].sessionId = 1;
      return [{ id: 50, sessionId: 1 }];
    });

    await expect(service.ensureRunSession(50, 1)).resolves.toEqual({
      runId: 50,
      sessionId: 1,
      created: false,
    });
    expect(winnerReadCount).toBe(3);
    expect(state.sessions.map((session) => session.id)).toEqual([1]);

    await expect(service.ensureRunSession(50, 1)).resolves.toEqual({
      runId: 50,
      sessionId: 1,
      created: false,
    });
    expect(state.sessions[0].id).toBe(1);
  });

  it("does not claim a same-title orphan into a different resolved target", async () => {
    const state = useData({
      graphs: [{ id: 8, userId: 1, name: "graph", aiSessionId: null }],
      runs: [makeRun({ workspaceId: 4 })],
      sessions: [
        {
          id: 1,
          userId: 1,
          workspaceId: 3,
          projectId: null,
          automationTaskId: null,
          runGraphId: 8,
          title: "graph · 2026-11-20T01:02:03.000Z",
          lastMessageAt: null,
        },
      ],
    });
    const { service, createSession } = makeService(state.sessions);

    await expect(service.ensureRunSession(50, 1)).resolves.toEqual({
      runId: 50,
      sessionId: 2,
      created: true,
    });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(state.sessions.map((session) => session.id)).toEqual([1, 2]);
    expect(state.sessions[1]).toMatchObject({ workspaceId: 4, runGraphId: 8 });
  });

  it("workspace deletion unlinks the run so ensure creates a fresh companion", async () => {
    const state = useData({
      tasks: [
        { id: 4, userId: 1, name: "prompt", workspaceId: 12, projectId: null },
      ],
      runs: [
        makeRun({
          taskId: 4,
          graphId: null,
          sessionId: 90,
          workspaceId: 12,
        }),
      ],
      sessions: [
        {
          id: 90,
          userId: 1,
          workspaceId: 12,
          projectId: null,
          automationTaskId: 4,
          runGraphId: null,
          title: "old-companion",
        },
      ],
    });
    const sessionRepo = Object.create(
      SessionRepository.prototype,
    ) as SessionRepository;
    const { service } = makeService(state.sessions);

    await sessionRepo.deleteWorkspace(12, 1);

    expect(state.sessions).toHaveLength(0);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0].sessionId).toBeNull();
    await expect(service.ensureRunSession(50, 1)).resolves.toEqual({
      runId: 50,
      sessionId: 1,
      created: true,
    });
    expect(state.sessions[0]).toMatchObject({
      id: 1,
      workspaceId: 12,
      automationTaskId: 4,
    });
  });

  it("registers the user-scoped lazy-creation IPC channel", () => {
    const state = useData({});
    makeService(state.sessions);

    expect(ipcHandlers.has("automation:run:ensureSession")).toBe(true);
  });
});
