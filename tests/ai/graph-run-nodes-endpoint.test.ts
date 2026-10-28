// tests/ai/graph-run-nodes-endpoint.test.ts
/**
 * orchestration:runNodes 通道（去会话化 2026-10-28，Task 5）：按 runId 查
 * graphRunNode 节点详情行。图归属两段校验——automationRun 与
 * graphDefinition 无 Prisma relation（schema 现场核实），先查 run.graphId
 * （prompt 型 run graphId null 直拒），再查图 userId；历史 graph 行
 * userId 可空，null 视为可查（对齐 executor 归属口径）。mock 三件套先例
 * graph-repo.test.ts；ipc-user 以 pass-through 替身直连 ipcMain.handle
 * （真实 handleUser 剥 JWT token 属通用包装，本测聚焦 handler 行为）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  app: { getPath: vi.fn(() => `/tmp/tianshu-run-nodes-test-${process.pid}`) },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
}));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    graphDefinition: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    session: {},
    workspace: { findFirst: vi.fn() },
    automationTask: { findMany: vi.fn() },
    automationRun: {
      count: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      deleteMany: vi.fn(),
    },
    graphRunNode: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("../../electron/commons/ipc-user", async () => {
  const { ipcMain } = await import("electron");
  return {
    handleUser: (
      channel: string,
      handler: (event: unknown, userId: number, ...args: unknown[]) => unknown,
    ) => ipcMain.handle(channel, handler as never),
  };
});
vi.mock("../../electron/domains/ai/orchestration/graph-executor", () => ({
  executeGraphRun: vi.fn(),
  // create-workflow 装配引用（repo 构造期消费，先例 graph-repo.test.ts）
  runGraphToResult: vi.fn(),
  polishNodePrompt: vi.fn(),
}));
vi.mock("../../electron/domains/ai/automation/automation-event-bus", () => ({
  publishAutomationEvent: vi.fn(),
}));

import { ipcMain } from "electron";
import GraphRepository from "../../electron/domains/ai/orchestration/graph.repo";
import prisma from "../../electron/commons/prisma-client";

/** 节点详情行样例（Task 1 表结构全字段，startedAt 为 ISO 字符串原样） */
const NODE_ROW = {
  id: 21,
  runId: 9,
  nodeId: "research",
  nodeName: "调研",
  status: "success",
  input: "调研 x",
  output: "全文…",
  errorJson: null,
  toolCallsJson: null,
  promptTokens: 3,
  completionTokens: 5,
  durationMs: 120,
  startedAt: "2026-10-28T00:00:00.000Z",
  outputImage: null,
  errorOutput: null,
  fallbackJson: null,
};

/** 构造 repo（constructor 即 registerHandlers）并取 runNodes 通道 handler */
async function runNodesHandler(): Promise<
  (event: unknown, userId: number, runId: number) => Promise<unknown>
> {
  new GraphRepository();
  const call = vi
    .mocked(ipcMain.handle)
    .mock.calls.find((c) => c[0] === "orchestration:runNodes");
  if (!call) {
    throw new Error("orchestration:runNodes 通道未注册");
  }
  return call[1] as (
    event: unknown,
    userId: number,
    runId: number,
  ) => Promise<unknown>;
}

describe("orchestration:runNodes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("按 runId 查节点行（经图归属两段校验，行按 id 升序）", async () => {
    vi.mocked(prisma.automationRun.findFirst).mockResolvedValue({
      graphId: 5,
    } as never);
    vi.mocked(prisma.graphDefinition.findUnique).mockResolvedValue({
      userId: 7,
    } as never);
    vi.mocked(prisma.graphRunNode.findMany).mockResolvedValue([
      { ...NODE_ROW },
    ] as never);

    const rows = (await (
      await runNodesHandler()
    )(null, 7, 9)) as Array<{
      nodeId: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].nodeId).toBe("research");
    expect(prisma.automationRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 9, graphId: { not: null } }),
      }),
    );
    expect(prisma.graphDefinition.findUnique).toHaveBeenCalledWith({
      where: { id: 5 },
      select: { userId: true },
    });
    expect(prisma.graphRunNode.findMany).toHaveBeenCalledWith({
      where: { runId: 9 },
      orderBy: { id: "asc" },
    });
  });

  it("非 owner 或 prompt 型 run（graphId null/查无 run）→ 空数组，不触节点表", async () => {
    vi.mocked(prisma.automationRun.findFirst).mockResolvedValue(null);

    const rows = (await (await runNodesHandler())(null, 8, 9)) as unknown[];
    expect(rows).toEqual([]);
    expect(prisma.graphDefinition.findUnique).not.toHaveBeenCalled();
    expect(prisma.graphRunNode.findMany).not.toHaveBeenCalled();
  });

  it("他人图 → 空数组；历史 graph 行 userId 可空（null 视为可查）", async () => {
    vi.mocked(prisma.automationRun.findFirst).mockResolvedValue({
      graphId: 5,
    } as never);
    vi.mocked(prisma.graphDefinition.findUnique)
      .mockResolvedValueOnce({ userId: 99 } as never)
      .mockResolvedValueOnce({ userId: null } as never);
    vi.mocked(prisma.graphRunNode.findMany).mockResolvedValue([
      { ...NODE_ROW },
    ] as never);

    const handler = await runNodesHandler();
    expect(await handler(null, 7, 9)).toEqual([]);
    const rows = (await handler(null, 7, 9)) as unknown[];
    expect(rows).toHaveLength(1);
  });
});
