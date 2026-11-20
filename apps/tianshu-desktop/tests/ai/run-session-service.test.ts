import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  automationTask: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  graphDefinition: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  automationRun: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    groupBy: vi.fn(),
  },
  session: {
    findMany: vi.fn(),
  },
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

import { RunSessionService } from "../../electron/domains/ai/automation/run-session.service";

interface TaskFixture {
  id: number;
  userId: number;
  name: string;
  workspaceId: number;
  projectId: number | null;
  createdAt: Date;
}

interface GraphFixture {
  id: number;
  userId: number;
  name: string;
  createdAt: Date;
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
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

interface RunWhere {
  taskId?: number | null | { in: number[] };
  graphId?: number | null | { in: number[] };
  triggerType?: { not: string };
  startedAt?: Date;
  OR?: RunWhere[];
}

function matchesId(
  value: number | null,
  filter?: number | null | { in: number[] },
): boolean {
  if (filter === undefined) return true;
  if (typeof filter === "object" && filter !== null) {
    return value !== null && filter.in.includes(value);
  }
  return value === filter;
}

function matchesRunWhere(run: RunFixture, where: RunWhere): boolean {
  if (!matchesId(run.taskId, where.taskId)) return false;
  if (!matchesId(run.graphId, where.graphId)) return false;
  if (where.triggerType && run.triggerType === where.triggerType.not) {
    return false;
  }
  if (
    where.startedAt &&
    run.startedAt.getTime() !== where.startedAt.getTime()
  ) {
    return false;
  }
  return (
    !where.OR || where.OR.some((candidate) => matchesRunWhere(run, candidate))
  );
}

function makeRun(id: number, overrides: Partial<RunFixture> = {}): RunFixture {
  return {
    id,
    taskId: null,
    graphId: null,
    sessionId: null,
    workspaceId: null,
    attempt: 1,
    triggerType: "manual",
    status: "success",
    durationMs: 100,
    promptTokens: 10,
    completionTokens: 20,
    graphTrace: null,
    error: null,
    startedAt: new Date("2026-11-01T00:00:00.000Z"),
    finishedAt: new Date("2026-11-01T00:00:01.000Z"),
    ...overrides,
  };
}

function useData(data: {
  tasks?: TaskFixture[];
  graphs?: GraphFixture[];
  runs?: RunFixture[];
  sessions?: Array<{
    id: number;
    userId: number;
    runGraphId: number | null;
    workspaceId: number;
  }>;
}) {
  const tasks = data.tasks ?? [];
  const graphs = data.graphs ?? [];
  const runs = data.runs ?? [];
  const sessions = data.sessions ?? [];

  db.automationTask.findMany.mockImplementation(
    async ({ where }: { where: { userId: number } }) =>
      tasks.filter((task) => task.userId === where.userId),
  );
  db.automationTask.findFirst.mockImplementation(
    async ({ where }: { where: { id: number; userId: number } }) =>
      tasks.find(
        (task) => task.id === where.id && task.userId === where.userId,
      ) ?? null,
  );
  db.graphDefinition.findMany.mockImplementation(
    async ({ where }: { where: { userId: number } }) =>
      graphs.filter((graph) => graph.userId === where.userId),
  );
  db.graphDefinition.findFirst.mockImplementation(
    async ({ where }: { where: { id: number; userId: number } }) =>
      graphs.find(
        (graph) => graph.id === where.id && graph.userId === where.userId,
      ) ?? null,
  );
  db.session.findMany.mockImplementation(
    async ({
      where,
    }: {
      where: { userId: number; runGraphId: { in: number[] } };
    }) =>
      sessions.filter(
        (session) =>
          session.userId === where.userId &&
          session.runGraphId !== null &&
          where.runGraphId.in.includes(session.runGraphId),
      ),
  );
  db.automationRun.findFirst.mockImplementation(
    async ({ where }: { where: RunWhere }) => {
      const matches = runs.filter((run) => matchesRunWhere(run, where));
      return (
        matches.sort(
          (left, right) => right.startedAt.getTime() - left.startedAt.getTime(),
        )[0] ?? null
      );
    },
  );
  db.automationRun.findMany.mockImplementation(
    async ({ where }: { where: RunWhere }) =>
      runs.filter((run) => matchesRunWhere(run, where)),
  );
  db.automationRun.groupBy.mockImplementation(
    async ({
      by,
      where,
    }: {
      by: Array<"taskId" | "graphId">;
      where: RunWhere;
    }) => {
      const ownerKey = by[0];
      const latest = new Map<number, Date>();
      for (const run of runs.filter((row) => matchesRunWhere(row, where))) {
        const ownerId = run[ownerKey];
        if (ownerId === null) continue;
        const previous = latest.get(ownerId);
        if (!previous || run.startedAt > previous) {
          latest.set(ownerId, run.startedAt);
        }
      }
      return [...latest].map(([ownerId, startedAt]) => ({
        [ownerKey]: ownerId,
        _max: { startedAt },
      }));
    },
  );
  db.automationRun.findUnique.mockImplementation(
    async ({ where }: { where: { id: number } }) =>
      runs.find((run) => run.id === where.id) ?? null,
  );
}

function makeService() {
  return new RunSessionService({} as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  ipcHandlers.clear();
});

describe("RunSessionService.listRunGroups", () => {
  it("保留全部本人任务，图组只收顶层运行且任务运行不重复归图", async () => {
    useData({
      tasks: [
        {
          id: 1,
          userId: 1,
          name: "empty-task",
          workspaceId: 10,
          projectId: null,
          createdAt: new Date("2026-11-03T00:00:00.000Z"),
        },
        {
          id: 2,
          userId: 1,
          name: "graph-task",
          workspaceId: 11,
          projectId: 7,
          createdAt: new Date("2026-11-02T00:00:00.000Z"),
        },
        {
          id: 3,
          userId: 2,
          name: "other-task",
          workspaceId: 12,
          projectId: null,
          createdAt: new Date("2026-11-01T00:00:00.000Z"),
        },
      ],
      graphs: [
        {
          id: 20,
          userId: 1,
          name: "task-only-graph",
          createdAt: new Date("2026-11-01T00:00:00.000Z"),
        },
        {
          id: 30,
          userId: 1,
          name: "top-level-graph",
          createdAt: new Date("2026-11-01T00:00:00.000Z"),
        },
        {
          id: 50,
          userId: 1,
          name: "empty-graph",
          createdAt: new Date("2026-11-01T00:00:00.000Z"),
        },
        {
          id: 60,
          userId: 2,
          name: "other-graph",
          createdAt: new Date("2026-11-01T00:00:00.000Z"),
        },
      ],
      runs: [
        makeRun(790, {
          taskId: 2,
          graphId: 20,
          startedAt: new Date("2026-11-02T00:00:00.000Z"),
        }),
        makeRun(800, {
          taskId: 2,
          graphId: 20,
          startedAt: new Date("2026-11-05T00:00:00.000Z"),
        }),
        makeRun(900, {
          graphId: 30,
          graphTrace: "old-trace",
          startedAt: new Date("2026-11-03T00:00:00.000Z"),
        }),
        makeRun(999, {
          graphId: 30,
          graphTrace: "latest-trace",
          workspaceId: 23,
          startedAt: new Date("2026-11-04T00:00:00.000Z"),
        }),
        makeRun(1000, { graphId: 60 }),
      ],
    });

    const groups = await makeService().listRunGroups(1);

    expect(groups).toContainEqual(
      expect.objectContaining({
        kind: "task",
        ownerId: 1,
        name: "empty-task",
        hasRuns: false,
      }),
    );
    expect(groups.filter((group) => group.kind === "graph")).toHaveLength(1);
    expect(groups).toContainEqual(
      expect.objectContaining({
        kind: "graph",
        ownerId: 30,
        name: "top-level-graph",
        workspaceId: 23,
        hasRuns: true,
        latestRun: expect.objectContaining({ id: 999 }),
      }),
    );
    expect(groups).toContainEqual(
      expect.objectContaining({
        kind: "task",
        ownerId: 2,
        projectId: 7,
        latestRun: expect.objectContaining({ id: 800, graphId: 20 }),
      }),
    );
    expect(groups).toHaveLength(3);
    expect(groups.map((group) => `${group.kind}:${group.ownerId}`)).toEqual([
      "task:2",
      "graph:30",
      "task:1",
    ]);
    for (const group of groups) {
      if (group.latestRun) {
        expect(group.latestRun).not.toHaveProperty("graphTrace");
      }
    }
    expect(db.automationTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 1 } }),
    );
    expect(db.graphDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 1 } }),
    );
    const summaryQueries = [
      ...db.automationRun.findFirst.mock.calls,
      ...db.automationRun.findMany.mock.calls,
    ];
    expect(summaryQueries).toHaveLength(2);
    expect(db.automationRun.groupBy).toHaveBeenCalledTimes(2);
    for (const call of summaryQueries) {
      expect(call[0]).toMatchObject({
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      });
      expect(call[0].select).not.toHaveProperty("graphTrace");
      expect(call[0].select).not.toHaveProperty("graphJsonSnapshot");
    }
  });

  it("有本人 runGraphId 会话的无运行图也有组，他人会话不开组", async () => {
    useData({
      graphs: [
        {
          id: 40,
          userId: 1,
          name: "session-graph",
          createdAt: new Date("2026-11-01T00:00:00.000Z"),
        },
        {
          id: 50,
          userId: 1,
          name: "other-session-graph",
          createdAt: new Date("2026-11-01T00:00:00.000Z"),
        },
      ],
      sessions: [
        { id: 70, userId: 1, runGraphId: 40, workspaceId: 22 },
        { id: 71, userId: 2, runGraphId: 50, workspaceId: 24 },
      ],
    });

    const groups = await makeService().listRunGroups(1);

    expect(groups).toEqual([
      expect.objectContaining({
        kind: "graph",
        ownerId: 40,
        workspaceId: 22,
        hasRuns: false,
        latestRun: undefined,
      }),
    ]);
    expect(db.session.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 1, runGraphId: { in: [40, 50] } },
      }),
    );
  });

  it("子工作流运行不开图组，也不能取代更新的顶层最近运行", async () => {
    useData({
      graphs: [
        {
          id: 30,
          userId: 1,
          name: "top-level-graph",
          createdAt: new Date("2026-11-01T00:00:00.000Z"),
        },
        {
          id: 40,
          userId: 1,
          name: "subflow-only-graph",
          createdAt: new Date("2026-11-01T00:00:00.000Z"),
        },
      ],
      runs: [
        makeRun(100, {
          graphId: 30,
          startedAt: new Date("2026-11-02T00:00:00.000Z"),
        }),
        makeRun(200, {
          graphId: 30,
          triggerType: "subflow",
          startedAt: new Date("2026-11-05T00:00:00.000Z"),
        }),
        makeRun(300, {
          graphId: 40,
          triggerType: "subflow",
          startedAt: new Date("2026-11-06T00:00:00.000Z"),
        }),
      ],
    });

    const groups = await makeService().listRunGroups(1);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      kind: "graph",
      ownerId: 30,
      latestRun: { id: 100, triggerType: "manual" },
    });
    expect(db.automationRun.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          taskId: null,
          triggerType: { not: "subflow" },
        }),
      }),
    );
  });
});

describe("RunSessionService.getRun", () => {
  it("按 id 直读非第一页运行并保留 graphTrace", async () => {
    const target = makeRun(999, {
      graphId: 30,
      workspaceId: 23,
      graphTrace: "full-graph-trace",
      startedAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    useData({
      graphs: [
        {
          id: 30,
          userId: 1,
          name: "graph-name",
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      ],
      runs: [
        ...Array.from({ length: 20 }, (_, index) =>
          makeRun(1200 + index, {
            graphId: 30,
            startedAt: new Date(
              `2026-11-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
            ),
          }),
        ),
        target,
      ],
    });

    const detail = await makeService().getRun(999, 1);

    expect(detail).toMatchObject({
      id: 999,
      taskId: null,
      taskName: "graph-name",
      graphId: 30,
      workspaceId: 23,
      graphTrace: "full-graph-trace",
    });
    expect(db.automationRun.findUnique).toHaveBeenCalledWith({
      where: { id: 999 },
    });
  });

  it("他人运行与不存在运行都返回 RUN_NOT_FOUND", async () => {
    useData({
      graphs: [
        {
          id: 30,
          userId: 1,
          name: "owned-graph",
          createdAt: new Date("2026-11-01T00:00:00.000Z"),
        },
      ],
      runs: [makeRun(999, { graphId: 30 })],
    });
    const service = makeService();

    await expect(service.getRun(999, 2)).rejects.toThrow("RUN_NOT_FOUND");
    await expect(service.getRun(123456, 1)).rejects.toThrow("RUN_NOT_FOUND");
  });

  it("任务归属优先于图归属，不能借本人图读取他人任务运行", async () => {
    useData({
      tasks: [
        {
          id: 2,
          userId: 2,
          name: "other-task",
          workspaceId: 10,
          projectId: null,
          createdAt: new Date("2026-11-01T00:00:00.000Z"),
        },
      ],
      graphs: [
        {
          id: 30,
          userId: 1,
          name: "owned-graph",
          createdAt: new Date("2026-11-01T00:00:00.000Z"),
        },
      ],
      runs: [makeRun(999, { taskId: 2, graphId: 30 })],
    });

    await expect(makeService().getRun(999, 1)).rejects.toThrow("RUN_NOT_FOUND");
    expect(db.automationTask.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 2, userId: 1 } }),
    );
    expect(db.graphDefinition.findFirst).not.toHaveBeenCalled();
  });
});

describe("RunSessionService IPC", () => {
  it("构造时注册固定分组与单运行用户通道", () => {
    makeService();

    expect([...ipcHandlers.keys()]).toEqual(
      expect.arrayContaining(["automation:runGroups", "automation:run:get"]),
    );
  });
});
