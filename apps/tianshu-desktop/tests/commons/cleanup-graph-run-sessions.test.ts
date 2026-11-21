/**
 * 存量图运行会话清理（图执行留痕去会话化 2026-10-28）：cleanupGraphRunSessions
 * 删图 run 会话+消息、run.sessionId 置 null；prompt 型 run graphId 恒 null
 * 不入集合（findMany/updateMany where 双重 graphId 非空前提保证）。幂等：
 * 清后判据不再命中（二跑零删除）。
 * 真库经 .native-node node-ABI 副本可跑（2026-11-04 双 ABI 根治，先例
 * graph-db-page.test.ts）；本文件沿用替身法先例：mock PrismaClient 依赖，
 * 断言焦点在清理语义而非引擎行为。
 * （brief 原稿整模块 mock prisma-client 会连被测函数一起替身掉，且顶层
 * prismaMock 进 hoisted 工厂 TDZ 报错——按现场最小适配接线，断言逐字保留。）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
  },
}));

// 副作用导入会 require 原生 better-sqlite3，测试环境替换为空模块解除依赖
vi.mock("../../electron/commons/sqlite-stmt-cache", () => ({}));

// adapter 仅被构造不真正连库：库操作全部落在下方 mock 的 PrismaClient 上
vi.mock("@prisma/adapter-better-sqlite3", () => ({
  PrismaBetterSqlite3: class MockPrismaBetterSqlite3 {
    constructor(public url: string) {}
  },
}));

// 被测函数的落库面（vi.hoisted：先于提升到顶层的 vi.mock 工厂创建）
const prismaMock = vi.hoisted(() => ({
  automationRun: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  message: { deleteMany: vi.fn() },
  session: { deleteMany: vi.fn(), findMany: vi.fn() },
}));

vi.mock("../../electron/generated/prisma/client", () => ({
  PrismaClient: class MockPrismaClient {
    automationRun = prismaMock.automationRun;
    message = prismaMock.message;
    session = prismaMock.session;
    // 顶层 WAL/NORMAL PRAGMA 调用的空实现
    $queryRawUnsafe = vi.fn(async () => []);
  },
}));

import { cleanupGraphRunSessions } from "../../electron/commons/prisma-client";

describe("cleanupGraphRunSessions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("图运行会话连带消息删除、run.sessionId 置 null", async () => {
    prismaMock.automationRun.findMany.mockResolvedValue([
      { id: 1, sessionId: 11 },
      { id: 2, sessionId: 12 },
    ]);
    prismaMock.session.findMany.mockResolvedValue([{ id: 11 }, { id: 12 }]);
    await cleanupGraphRunSessions();
    expect(prismaMock.message.deleteMany).toHaveBeenCalledWith({
      where: { sessionId: { in: [11, 12] } },
    });
    expect(prismaMock.session.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [11, 12] } },
    });
    expect(prismaMock.automationRun.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [1, 2] } },
      data: { sessionId: null },
    });
  });

  it("多个旧图运行共享会话时清除每一个 run 链接", async () => {
    const linkedRuns = [
      { id: 1, sessionId: 11 },
      { id: 2, sessionId: 11 },
    ];
    prismaMock.automationRun.findMany.mockImplementation(
      async (args: { distinct?: string[] }) =>
        args.distinct?.includes("sessionId") ? [linkedRuns[0]] : linkedRuns,
    );
    prismaMock.session.findMany.mockResolvedValue([{ id: 11 }]);

    await cleanupGraphRunSessions();

    expect(prismaMock.automationRun.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [1, 2] } },
      data: { sessionId: null },
    });
  });

  it("超过 500 个旧 run 共享会话时分批清除全部链接", async () => {
    const runIds = Array.from({ length: 501 }, (_, index) => index + 1);
    prismaMock.automationRun.findMany.mockResolvedValue(
      runIds.map((id) => ({ id, sessionId: 11 })),
    );
    prismaMock.session.findMany.mockResolvedValue([{ id: 11 }]);

    await cleanupGraphRunSessions();

    const batches = prismaMock.automationRun.updateMany.mock.calls.map(
      ([args]) => args.where.id.in as number[],
    );
    expect(batches.map((batch) => batch.length)).toEqual([500, 1]);
    expect(batches.every((batch) => batch.length <= 500)).toBe(true);
    expect(batches.flat()).toEqual(runIds);
    for (const [args] of prismaMock.automationRun.updateMany.mock.calls) {
      expect(args.data).toEqual({ sessionId: null });
    }
  });

  it("已有运行分组的 graph 伴随会话不属于旧迁移，会话和 run 链接均保留", async () => {
    prismaMock.automationRun.findMany.mockResolvedValue([
      { id: 1, sessionId: 11 },
      { id: 2, sessionId: 12 },
    ]);
    prismaMock.session.findMany.mockResolvedValue([{ id: 11 }]);

    await cleanupGraphRunSessions();

    expect(prismaMock.session.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: [11, 12] },
        automationTaskId: null,
        runGraphId: null,
      },
      select: { id: true },
    });
    expect(prismaMock.message.deleteMany).toHaveBeenCalledWith({
      where: { sessionId: { in: [11] } },
    });
    expect(prismaMock.session.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [11] } },
    });
    expect(prismaMock.automationRun.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [1] } },
      data: { sessionId: null },
    });
  });

  it("无待清数据时零删除（幂等二跑）", async () => {
    prismaMock.automationRun.findMany.mockResolvedValue([]);
    await cleanupGraphRunSessions();
    expect(prismaMock.message.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.session.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.automationRun.updateMany).not.toHaveBeenCalled();
  });
});
