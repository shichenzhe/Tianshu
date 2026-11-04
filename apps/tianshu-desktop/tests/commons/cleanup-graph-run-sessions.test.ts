/**
 * 存量图运行会话清理（图执行留痕去会话化 2026-10-28）：cleanupGraphRunSessions
 * 删图 run 会话+消息、run.sessionId 置 null；prompt 型 run graphId 恒 null
 * 不入集合（findMany/updateMany where 双重 graphId 非空前提保证）。幂等：
 * 清后判据不再命中（二跑零删除）。
 * 真库在本机不可行（better-sqlite3 为 Electron ABI，Node 下加载即崩），
 * 替身法同 ensure-graph-run-node.test.ts 先例：mock PrismaClient 依赖。
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
  session: { deleteMany: vi.fn() },
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
      { sessionId: 11 },
      { sessionId: 12 },
    ]);
    await cleanupGraphRunSessions();
    expect(prismaMock.message.deleteMany).toHaveBeenCalledWith({
      where: { sessionId: { in: [11, 12] } },
    });
    expect(prismaMock.session.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [11, 12] } },
    });
    expect(prismaMock.automationRun.updateMany).toHaveBeenCalledWith({
      where: { graphId: { not: null }, sessionId: { not: null } },
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
