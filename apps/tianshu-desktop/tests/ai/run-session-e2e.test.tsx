// @vitest-environment jsdom
/**
 * 固定运行入口验收：真实 prompt runner、RunSessionService、固定分组组件与
 * retention 串接；仅模型/聊天传输及持久层使用内存替身。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const db = vi.hoisted(() => ({
  workspace: { findUnique: vi.fn() },
  model: { findUnique: vi.fn() },
  provider: { findUnique: vi.fn() },
  project: { findUnique: vi.fn() },
  toolPermission: { findMany: vi.fn() },
  graphDefinition: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  automationTask: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  automationRun: {
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    groupBy: vi.fn(),
    deleteMany: vi.fn(),
  },
  session: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  },
  message: { create: vi.fn() },
  graphRunNode: { deleteMany: vi.fn() },
  option: { findFirst: vi.fn() },
  $transaction: vi.fn(),
  $queryRawUnsafe: vi.fn(),
}));
const runChatStreamMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(() => `/tmp/tianshu-run-e2e-${process.pid}`) },
}));
vi.mock("../../electron/commons/prisma-client", () => ({ default: db }));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/commons/ipc-user", () => ({ handleUser: vi.fn() }));
vi.mock("../../electron/domains/ai/chat/chat.service", () => ({
  runChatStream: runChatStreamMock,
}));
vi.mock("../../electron/domains/ai/automation/resolve-attachments", () => ({
  resolveAttachments: vi.fn(async (prompt: string) => ({
    injected: prompt,
    skills: [],
  })),
}));
vi.mock("../../electron/domains/ai/provider/provider-runtime", () => ({
  openProviderSecrets: vi.fn(async (provider: { apiKey: string }) => provider),
}));
vi.mock(
  "../../electron/domains/ai/orchestration/langchain-model-factory",
  () => ({ createChatModel: vi.fn(() => ({})) }),
);
vi.mock("../../electron/domains/ai/orchestration/graph-executor", () => ({
  executeGraphRun: vi.fn(),
}));
vi.mock("../../electron/domains/ai/monitor/monitor-events", () => ({
  recordLlmCall: vi.fn(),
  recordToolCall: vi.fn(),
}));
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));

import { executeTask } from "../../electron/domains/ai/automation/automation-runner";
import { RunSessionService } from "../../electron/domains/ai/automation/run-session.service";
import {
  DEFAULT_RUN_RETENTION,
  trimAutomationRuns,
  type RetentionDb,
} from "../../electron/domains/ai/automation/automation-retention";
import RunSessionGroup from "../../src-react/domains/ai/layout/components/run-session-group";
import { excludeRunSessions } from "../../src-react/domains/ai/automation/lib/run-group-view";
import type { SessionRecord } from "../../src-react/domains/ai/api/session.api";
import type { SessionRepository } from "../../electron/domains/ai/chat/session.repo";

const USER_ID = 7;
const ORIGINAL_PROMPT = "Summarize today's original automation input";
const FOLLOW_UP = "Explain only the first run's result";

interface RunnerInput {
  history: Array<{ role: string; blocks: string }>;
}

interface RunState {
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

interface SessionState {
  id: number;
  userId: number;
  workspaceId: number;
  projectId: number | null;
  currentModelId: number;
  title: string;
  mode: string;
  automationTaskId: number | null;
  runGraphId: number | null;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MessageState {
  id: number;
  sessionId: number;
  role: string;
  blocks: string;
}

interface WorldState {
  runs: RunState[];
  sessions: SessionState[];
  messages: MessageState[];
  runnerInputs: RunnerInput[];
}

const task = {
  id: 4,
  name: "Daily report",
  prompt: ORIGINAL_PROMPT,
  workspaceId: 9,
  modelId: 1,
  temperature: 0,
  targetKind: "prompt",
  graphId: null,
  projectId: null,
  eventJson: null,
  userId: USER_ID,
  scheduleJson: JSON.stringify({
    mode: "periodic",
    kind: "daily",
    time: "09:00",
  }),
  scheduleText: "每天 09:00",
  startAt: null,
  endAt: null,
  missedPolicy: "skip",
  accessMode: "default",
  enabled: true,
  status: "active",
  statusNote: null,
  lastRunAt: null,
  nextRunAt: null,
  templateSlug: null,
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  updatedAt: new Date("2026-11-01T00:00:00.000Z"),
};

function matchesId(value: number | null, filter: unknown): boolean {
  if (filter === undefined) return true;
  if (filter === null || typeof filter === "number") return value === filter;
  if (typeof filter !== "object") return true;
  const candidate = filter as { in?: number[]; not?: number | null };
  if (candidate.in) return value !== null && candidate.in.includes(value);
  if (candidate.not !== undefined) return value !== candidate.not;
  return true;
}

function matchesRun(run: RunState, where: Record<string, unknown>): boolean {
  if (!matchesId(run.id, where.id)) return false;
  if (!matchesId(run.taskId, where.taskId)) return false;
  if (!matchesId(run.graphId, where.graphId)) return false;
  if (!matchesId(run.sessionId, where.sessionId)) return false;
  if (where.status) {
    const status = where.status as string | { notIn: string[] };
    if (
      typeof status === "string"
        ? run.status !== status
        : status.notIn.includes(run.status)
    ) {
      return false;
    }
  }
  if (where.triggerType) {
    const trigger = where.triggerType as { not: string };
    if (run.triggerType === trigger.not) return false;
  }
  if (where.graphTrace && run.graphTrace === null) return false;
  if (
    where.startedAt instanceof Date &&
    run.startedAt.getTime() !== where.startedAt.getTime()
  ) {
    return false;
  }
  const startedAt = where.startedAt as { lt?: Date } | undefined;
  if (startedAt?.lt && run.startedAt >= startedAt.lt) return false;
  const alternatives = where.OR as Record<string, unknown>[] | undefined;
  return !alternatives || alternatives.some((item) => matchesRun(run, item));
}

function matchesSession(
  session: SessionState,
  where: Record<string, unknown>,
): boolean {
  if (!matchesId(session.id, where.id)) return false;
  if (!matchesId(session.automationTaskId, where.automationTaskId))
    return false;
  if (!matchesId(session.runGraphId, where.runGraphId)) return false;
  if (where.userId !== undefined && session.userId !== where.userId)
    return false;
  if (where.title !== undefined && session.title !== where.title) return false;
  return where.lastMessageAt !== null || session.lastMessageAt === null;
}

function configureDatabase(state: WorldState) {
  db.workspace.findUnique.mockImplementation(async () => ({
    id: task.workspaceId,
    directoryPath: null,
  }));
  db.model.findUnique.mockImplementation(async () => ({
    id: 1,
    providerId: 2,
    modelId: "test-model",
  }));
  db.provider.findUnique.mockImplementation(async () => ({
    type: "openai-compatible",
    baseUrl: "https://transport.invalid",
    apiKey: "test-key",
    extraHeaders: null,
  }));
  db.project.findUnique.mockImplementation(async () => null);
  db.toolPermission.findMany.mockImplementation(async () => []);
  db.graphDefinition.findUnique.mockImplementation(async () => null);
  db.graphDefinition.findMany.mockImplementation(async () => []);
  db.graphDefinition.findFirst.mockImplementation(async () => null);
  db.automationTask.findMany.mockImplementation(async () => [task]);
  db.automationTask.findFirst.mockImplementation(
    async ({ where }: { where: { id: number; userId: number } }) =>
      where.id === task.id && where.userId === USER_ID ? task : null,
  );
  db.automationTask.update.mockImplementation(async ({ data }) => {
    Object.assign(task, data);
    return task;
  });
  configureRunDatabase(state);
  configureSessionDatabase(state);
  db.graphRunNode.deleteMany.mockImplementation(async () => ({ count: 0 }));
  db.option.findFirst.mockImplementation(async () => null);
  db.$transaction.mockImplementation(
    async (callback: (tx: typeof db) => unknown) => callback(db),
  );
  db.$queryRawUnsafe.mockImplementation(async () => []);
}

function configureRunDatabase(state: WorldState) {
  db.automationRun.create.mockImplementation(async ({ data }) => {
    const run: RunState = {
      id: state.runs.length + 1,
      taskId: data.taskId,
      graphId: null,
      sessionId: null,
      workspaceId: data.workspaceId,
      attempt: data.attempt,
      triggerType: data.triggerType,
      status: data.status,
      durationMs: null,
      promptTokens: null,
      completionTokens: null,
      graphTrace: null,
      error: null,
      startedAt: data.startedAt,
      finishedAt: null,
    };
    state.runs.push(run);
    return run;
  });
  db.automationRun.update.mockImplementation(async ({ where, data }) => {
    const run = state.runs.find((item) => item.id === where.id);
    if (!run) throw new Error("RUN_NOT_FOUND");
    Object.assign(run, data);
    return run;
  });
  db.automationRun.updateMany.mockImplementation(async ({ where, data }) => {
    const matched = state.runs.filter((run) => matchesRun(run, where));
    matched.forEach((run) => Object.assign(run, data));
    return { count: matched.length };
  });
  db.automationRun.findUnique.mockImplementation(
    async ({ where }) =>
      state.runs.find((run) => matchesRun(run, where)) ?? null,
  );
  db.automationRun.findMany.mockImplementation(async ({ where }) =>
    state.runs.filter((run) => matchesRun(run, where)),
  );
  db.automationRun.groupBy.mockImplementation(async ({ by, where }) => {
    const key = by[0] as "taskId" | "graphId";
    const latest = new Map<number, Date>();
    for (const run of state.runs.filter((item) => matchesRun(item, where))) {
      const ownerId = run[key];
      if (ownerId === null) continue;
      const previous = latest.get(ownerId);
      if (!previous || run.startedAt > previous)
        latest.set(ownerId, run.startedAt);
    }
    return [...latest].map(([ownerId, startedAt]) => ({
      [key]: ownerId,
      _max: { startedAt },
    }));
  });
  db.automationRun.deleteMany.mockImplementation(async ({ where }) => {
    const deleted = state.runs.filter((run) => matchesRun(run, where)).length;
    state.runs = state.runs.filter((run) => !matchesRun(run, where));
    return { count: deleted };
  });
}

function configureSessionDatabase(state: WorldState) {
  db.session.create.mockImplementation(async ({ data }) => {
    const now = new Date();
    const session: SessionState = {
      id: state.sessions.length + 1,
      userId: data.userId,
      workspaceId: data.workspaceId,
      projectId: data.projectId ?? null,
      currentModelId: data.currentModelId,
      title: data.title,
      mode: data.mode,
      automationTaskId: data.automationTaskId ?? null,
      runGraphId: data.runGraphId ?? null,
      lastMessageAt: null,
      createdAt: now,
      updatedAt: now,
    };
    state.sessions.push(session);
    return session;
  });
  db.session.findFirst.mockImplementation(
    async ({ where }) =>
      state.sessions.find((session) => matchesSession(session, where)) ?? null,
  );
  db.session.findMany.mockImplementation(async ({ where }) =>
    state.sessions.filter((session) => matchesSession(session, where)),
  );
  db.session.updateMany.mockImplementation(async ({ where, data }) => {
    const matched = state.sessions.filter((session) =>
      matchesSession(session, where),
    );
    matched.forEach((session) => Object.assign(session, data));
    return { count: matched.length };
  });
  db.session.delete.mockImplementation(async ({ where }) => {
    state.sessions = state.sessions.filter(
      (session) => session.id !== where.id,
    );
  });
  db.message.create.mockImplementation(async ({ data }) => {
    const message = {
      id: state.messages.length + 1,
      sessionId: data.sessionId,
      role: data.role,
      blocks: data.blocks,
    };
    state.messages.push(message);
    return message;
  });
}

function createWorld() {
  const state: WorldState = {
    runs: [],
    sessions: [],
    messages: [],
    runnerInputs: [],
  };
  configureDatabase(state);
  runChatStreamMock.mockImplementation(async (input: RunnerInput) => {
    state.runnerInputs.push(input);
    return { blocks: [{ type: "text", text: `answer-${state.runs.length}` }] };
  });
  const sessionRepo = {
    createSession: vi.fn(
      async (params: Record<string, unknown>, userId: number) =>
        db.session.create({
          data: {
            ...params,
            userId,
            currentModelId: task.modelId,
            mode: "agent",
          },
        }),
    ),
  } as unknown as SessionRepository;
  const service = new RunSessionService(sessionRepo);
  const run = () =>
    executeTask(task as never, {
      triggerType: "schedule",
      attempt: 1,
      abort: new AbortController().signal,
    });
  const followUp = async (runId: number, text: string) => {
    const resolved = await service.ensureRunSession(runId, USER_ID);
    await db.message.create({
      data: {
        sessionId: resolved.sessionId,
        role: "user",
        blocks: JSON.stringify([{ type: "text", text }]),
      },
    });
    return resolved;
  };
  return { state, service, run, followUp };
}

function asSessionRecord(session: SessionState): SessionRecord {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    currentModelId: session.currentModelId,
    title: session.title,
    mode: "agent",
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    projectId: session.projectId,
    automationTaskId: session.automationTaskId,
    runGraphId: session.runGraphId,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  task.status = "active";
  task.enabled = true;
});

afterEach(cleanup);

describe("run/session acceptance chain", () => {
  it("三次运行共用一个入口，追问留在 run 1，run 4 仅收原始 prompt", async () => {
    const world = createWorld();
    await world.run();
    await world.run();
    await world.run();

    expect(world.state.runs.map((run) => run.sessionId)).toEqual([1, 2, 3]);
    const groups = await world.service.listRunGroups(USER_ID);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      kind: "task",
      ownerId: task.id,
      latestRun: { id: 3, sessionId: 3 },
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <RunSessionGroup groups={groups} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getAllByTestId(/^run-session-/)).toHaveLength(1);
    expect(screen.getByTestId("run-session-task-4")).toBeTruthy();

    const resolved = await world.followUp(1, FOLLOW_UP);
    expect(resolved).toEqual({ runId: 1, sessionId: 1, created: false });
    expect(
      world.state.messages.filter(
        (message) =>
          message.sessionId === 1 && message.blocks.includes(FOLLOW_UP),
      ),
    ).toHaveLength(1);
    expect(
      world.state.messages.some(
        (message) =>
          message.sessionId !== 1 && message.blocks.includes(FOLLOW_UP),
      ),
    ).toBe(false);

    await world.run();
    expect(world.state.runs).toHaveLength(4);
    expect(world.state.runs[3].sessionId).toBe(4);
    expect(world.state.runnerInputs[3].history).toEqual([
      {
        role: "user",
        blocks: JSON.stringify([{ type: "text", text: ORIGINAL_PROMPT }]),
      },
    ]);
    expect(JSON.stringify(world.state.runnerInputs[3].history)).not.toContain(
      FOLLOW_UP,
    );
  });

  it("retention 删除运行后保留追问消息，并将伴随会话转回普通会话", async () => {
    const world = createWorld();
    await world.run();
    await world.followUp(1, FOLLOW_UP);
    world.state.runs[0].startedAt = new Date("2026-11-01T00:00:00.000Z");

    await trimAutomationRuns(
      db as unknown as RetentionDb,
      { ...DEFAULT_RUN_RETENTION, successDays: 7 },
      new Date("2026-11-20T00:00:00.000Z"),
    );

    expect(world.state.runs).toHaveLength(0);
    expect(world.state.sessions).toHaveLength(1);
    expect(world.state.sessions[0]).toMatchObject({
      id: 1,
      automationTaskId: null,
      runGraphId: null,
    });
    expect(
      world.state.messages.some(
        (message) =>
          message.sessionId === 1 && message.blocks.includes(FOLLOW_UP),
      ),
    ).toBe(true);
    expect(
      excludeRunSessions(world.state.sessions.map(asSessionRecord)),
    ).toHaveLength(1);
  });
});
