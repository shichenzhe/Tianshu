import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  automationRun: { findUnique: vi.fn() },
  automationTask: { findFirst: vi.fn() },
  graphDefinition: { findFirst: vi.fn() },
  model: {
    findUnique: vi.fn(),
    findMany: vi.fn(async () => []),
  },
  provider: {
    findUnique: vi.fn(),
    findMany: vi.fn(async () => []),
  },
  assistant: { findUnique: vi.fn(async () => null) },
  message: { findMany: vi.fn(async () => []) },
  workspace: { findMany: vi.fn(async () => []) },
  option: { findMany: vi.fn(async () => []) },
  user: { findUnique: vi.fn(async () => ({ id: 1 })) },
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  clipboard: { writeText: vi.fn() },
}));
vi.mock("../../electron/commons/prisma-client", () => ({ default: db }));
vi.mock("../../electron/domains/security/master-key", () => ({
  getMasterKey: async () => Buffer.alloc(32, 1),
  isMasterKeyDegraded: () => false,
  resetMasterKeyCacheForTest: () => {},
}));
vi.mock("../../electron/domains/ai/agent/skill-loader", () => ({
  loadSkills: vi.fn(() => []),
}));

import ChatService from "../../electron/domains/ai/chat/chat.service";
import { SessionRepository } from "../../electron/domains/ai/chat/session.repo";

function makeRun() {
  return {
    id: 72,
    taskId: null,
    graphId: 8,
    sessionId: 1,
    workspaceId: 3,
    attempt: 1,
    triggerType: "manual",
    status: "success",
    durationMs: 20,
    promptTokens: null,
    completionTokens: null,
    graphTrace: JSON.stringify([
      {
        id: "last",
        name: "Last",
        status: "success",
        outputPreview: "final-output",
      },
    ]),
    graphJsonSnapshot: null,
    error: null,
    startedAt: new Date("2026-11-20T01:02:03.000Z"),
    finishedAt: new Date("2026-11-20T01:02:04.000Z"),
  };
}

function makeSessions(runContext: string | null) {
  return {
    getSession: vi.fn().mockResolvedValue({
      id: 1,
      assistantId: null,
      workspaceId: 1,
      userId: 1,
      mode: null,
      scenario: null,
      compactedUpToId: null,
      summary: null,
      projectId: null,
    }),
    getEffectiveModelId: vi.fn().mockResolvedValue(1),
    getWorkspace: vi.fn().mockResolvedValue(null),
    getRunFollowupContext: vi.fn().mockResolvedValue(runContext),
  };
}

async function assemble(service: ChatService) {
  return (
    service as unknown as {
      assembleContext: (
        sessionId: number,
        userId: number,
      ) => Promise<{
        systemWithSummary: string;
        history: Array<{ role: string; blocks: string }>;
      }>;
    }
  ).assembleContext(1, 1);
}

beforeEach(() => {
  vi.clearAllMocks();
  db.model.findUnique.mockResolvedValue({
    id: 1,
    providerId: 2,
    modelId: "m",
    temperature: null,
    topP: null,
    maxTokens: null,
    contextWindow: null,
  });
  db.provider.findUnique.mockResolvedValue({
    id: 2,
    type: "openai-compatible",
    baseUrl: "https://x.example/v1",
    apiKey: "",
    extraHeaders: "",
    enabled: true,
    contextWindow: null,
  });
  db.automationRun.findUnique.mockResolvedValue(makeRun());
  db.automationTask.findFirst.mockResolvedValue(null);
  db.graphDefinition.findFirst.mockResolvedValue({ id: 8, name: "graph" });
});

describe("run follow-up context", () => {
  it("loads only the referenced run and builds its deterministic summary", async () => {
    const context = await new SessionRepository().getRunFollowupContext(1);

    expect(context).toContain("final-output");
    expect(context).toContain("graph");
    expect(db.automationRun.findUnique).toHaveBeenCalledWith({
      where: { sessionId: 1 },
    });
  });

  it("merges the fixed summary into chat without duplicating prompt history", async () => {
    db.message.findMany.mockResolvedValue([
      {
        role: "user",
        blocks: JSON.stringify([
          { type: "text", text: "original-run-message" },
        ]),
        error: null,
        createdAt: new Date("2026-11-20T01:02:03.000Z"),
      },
    ]);
    const sessions = makeSessions("fixed-run-context");
    const service = new ChatService(sessions as unknown as SessionRepository);

    const context = await assemble(service);

    expect(context.systemWithSummary).toContain("fixed-run-context");
    expect(
      context.history.filter((row) =>
        row.blocks.includes("original-run-message"),
      ),
    ).toHaveLength(1);
    expect(sessions.getRunFollowupContext).toHaveBeenCalledWith(1);
  });
});
