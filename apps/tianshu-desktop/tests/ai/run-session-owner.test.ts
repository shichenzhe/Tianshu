import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => `/tmp/tianshu-run-owner-${process.pid}`) },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  Notification: class MockNotification {},
}));

const graphPrisma = vi.hoisted(() => ({
  automationRun: {
    create: vi.fn(async () => ({ id: 9 })),
    update: vi.fn(async () => ({})),
  },
  automationTask: { update: vi.fn() },
  graphRunNode: { upsert: vi.fn() },
}));

vi.mock("../../electron/commons/prisma-client", () => ({
  default: graphPrisma,
}));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/domains/ai/agent/skill-loader", () => ({
  loadSkills: vi.fn(() => []),
}));
vi.mock(
  "../../electron/domains/ai/orchestration/langchain-model-factory",
  () => ({ createChatModel: vi.fn() }),
);
vi.mock("@langchain/langgraph/prebuilt", () => ({
  createReactAgent: vi.fn(),
  ToolNode: class MockToolNode {},
}));

import { executeGraphRun } from "../../electron/domains/ai/orchestration/graph-executor";

interface SessionState {
  id: number;
  title: string;
  automationTaskId: number | null;
  runGraphId: number | null;
}

function makeOwnerDb() {
  const runs = [{ id: 1, sessionId: 9, taskId: 11, graphId: null }];
  const sessions: SessionState[] = [
    { id: 9, title: "daily", automationTaskId: 11, runGraphId: 3 },
    { id: 10, title: "daily", automationTaskId: null, runGraphId: null },
  ];
  const messages = [
    { id: 1, sessionId: 9 },
    { id: 2, sessionId: 9 },
  ];
  const db = {
    automationRun: {
      findMany: vi.fn(
        async (args: {
          where: {
            id?: { in: number[] };
            sessionId?: { not: null };
            taskId?: { not: null };
            graphId?: null;
          };
        }) => {
          if (args.where.id) {
            return runs.filter((run) => args.where.id!.in.includes(run.id));
          }
          return runs.filter(
            (run) =>
              run.sessionId !== null &&
              run.taskId !== null &&
              (args.where.graphId !== null || run.graphId === null),
          );
        },
      ),
    },
    session: {
      updateMany: vi.fn(
        async (args: {
          where: {
            id?: { in: number[] };
            OR?: Array<{
              id?: { in: number[] };
              automationTaskId?: { in: number[] };
              runGraphId?: { in: number[] };
            }>;
          };
          data: {
            automationTaskId?: number | null;
            runGraphId?: number | null;
          };
        }) => {
          const filters =
            args.where.OR ?? (args.where.id ? [{ id: args.where.id }] : []);
          for (const session of sessions) {
            const matched = filters.some(
              (filter) =>
                (filter.id && filter.id.in.includes(session.id)) ||
                (filter.automationTaskId &&
                  session.automationTaskId !== null &&
                  filter.automationTaskId.in.includes(
                    session.automationTaskId,
                  )) ||
                (filter.runGraphId &&
                  session.runGraphId !== null &&
                  filter.runGraphId.in.includes(session.runGraphId)),
            );
            if (matched) Object.assign(session, args.data);
          }
          return { count: args.where.OR?.length ?? 1 };
        },
      ),
    },
    message: {
      count: async (args: { where: { sessionId: number } }) =>
        messages.filter((message) => message.sessionId === args.where.sessionId)
          .length,
    },
  };
  return { db, sessions };
}

describe("run session owner persistence", () => {
  it("回填只处理仍存在的 run，不按标题归组旧会话", async () => {
    const { db, sessions } = makeOwnerDb();
    sessions[0].automationTaskId = null;
    sessions[0].runGraphId = null;
    const { backfillRunSessionOwners } =
      await import("../../electron/domains/ai/automation/run-session-owner");

    await backfillRunSessionOwners(db);
    await backfillRunSessionOwners(db);

    expect(sessions[0]).toMatchObject({
      automationTaskId: 11,
      runGraphId: null,
    });
    expect(sessions[1]).toMatchObject({
      automationTaskId: null,
      runGraphId: null,
    });
  });

  it("清理 run 归属只清两个分组列，不删会话和追问消息", async () => {
    const { db, sessions } = makeOwnerDb();
    const { clearRunSessionOwners } =
      await import("../../electron/domains/ai/automation/run-session-owner");

    await clearRunSessionOwners(db, [1, 999]);

    const afterClear = sessions.find((session) => session.id === 9);
    expect(afterClear).toMatchObject({
      automationTaskId: null,
      runGraphId: null,
    });
    expect(sessions.find((session) => session.id === 10)).toBeDefined();
    expect(await db.message.count({ where: { sessionId: 9 } })).toBe(2);
  });

  it("删 owner 时也解除未关联 run 的空 crash orphan 分组且保留消息", async () => {
    const { db, sessions } = makeOwnerDb();
    sessions[1].automationTaskId = 11;
    const { clearRunSessionOwners } =
      await import("../../electron/domains/ai/automation/run-session-owner");

    await clearRunSessionOwners(db, [], { taskIds: [11] });

    expect(sessions[0]).toMatchObject({
      automationTaskId: null,
      runGraphId: null,
    });
    expect(sessions[1]).toMatchObject({
      automationTaskId: null,
      runGraphId: null,
    });
    expect(await db.message.count({ where: { sessionId: 9 } })).toBe(2);
  });
});

describe("graph run workspace persistence", () => {
  it("createRunRow 写实际执行 workspace", async () => {
    await executeGraphRun({
      graph: {
        id: 3,
        graphJson: "{broken",
        userId: 1,
      } as never,
      task: null,
      inputs: {},
      triggerType: "manual",
      attempt: 1,
      abort: new AbortController().signal,
      workspace: { id: 23, directoryPath: null },
    });

    const run = vi
      .mocked(graphPrisma.automationRun.create)
      .mock.calls.at(-1)?.[0].data;
    expect(run.workspaceId).toBe(23);
  });
});
