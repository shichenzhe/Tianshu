/**
 * 监控事件表（token/工具监控 spec §3.2）：ensureMonitorTables 启动幂等
 * 建两张表 + 三条索引（不走 v1 快照，同 artifact 先例——指纹变化会触发
 * 旧库 drop 重建）；ensureEventStatMaintenance 扩展两表 90 天保留期裁剪
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  dialog: { showSaveDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() },
  // prisma-client 顶层读取 app.getPath/getAppPath 计算库文件目录
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

// 副作用导入会 require 原生 better-sqlite3，测试环境替换为空模块解除依赖
vi.mock("../../electron/commons/sqlite-stmt-cache", () => ({}));

// adapter 仅被构造不真正连库：库操作全部落在下方 mock 的 PrismaClient 上
vi.mock("@prisma/adapter-better-sqlite3", () => ({
  PrismaBetterSqlite3: class MockPrismaBetterSqlite3 {
    constructor(public url: string) {}
  },
}));

// $executeRawUnsafe 捕获数组 + 四张事件表 deleteMany spy（模块工厂提升，
// 须经 vi.hoisted 先于工厂创建）
const executeRawCalls = vi.hoisted(() => [] as unknown[]);
const deleteManySpies = vi.hoisted(() => ({
  skillStat: vi.fn(async () => ({ count: 0 })),
  automationStat: vi.fn(async () => ({ count: 0 })),
  llmCallEvent: vi.fn(async () => ({ count: 0 })),
  toolCallEvent: vi.fn(async () => ({ count: 0 })),
}));

vi.mock("../../electron/generated/prisma/client", () => ({
  PrismaClient: class MockPrismaClient {
    // 顶层 WAL/NORMAL PRAGMA 调用的空实现
    $queryRawUnsafe = vi.fn(async () => []);
    $executeRawUnsafe = vi.fn(async (sql: string) => {
      executeRawCalls.push(sql);
      return 0;
    });
    skillStat = { deleteMany: deleteManySpies.skillStat };
    automationStat = { deleteMany: deleteManySpies.automationStat };
    llmCallEvent = { deleteMany: deleteManySpies.llmCallEvent };
    toolCallEvent = { deleteMany: deleteManySpies.toolCallEvent };
  },
}));

beforeEach(() => {
  executeRawCalls.length = 0;
  for (const spy of Object.values(deleteManySpies)) spy.mockClear();
});

describe("ensureMonitorTables", () => {
  it("建两张表 + 三条索引，全部幂等 IF NOT EXISTS", async () => {
    const { ensureMonitorTables } =
      await import("../../electron/commons/prisma-client");
    await ensureMonitorTables();
    const sqls = executeRawCalls.map((s: unknown) => String(s));
    expect(
      sqls.filter((s) => s.includes("CREATE TABLE IF NOT EXISTS llmCallEvent")),
    ).toHaveLength(1);
    expect(
      sqls.filter((s) =>
        s.includes("CREATE TABLE IF NOT EXISTS toolCallEvent"),
      ),
    ).toHaveLength(1);
    expect(
      sqls.filter((s) => s.includes("CREATE INDEX IF NOT EXISTS")),
    ).toHaveLength(3);
  });
});

describe("ensureEventStatMaintenance 保留期裁剪", () => {
  it("四张事件表各裁剪一次，cutoff ≈ 90 天前", async () => {
    const { ensureEventStatMaintenance } =
      await import("../../electron/commons/prisma-client");
    await ensureEventStatMaintenance();
    const expected = expect.objectContaining({
      where: { createdAt: { lt: expect.any(Date) } },
    });
    expect(deleteManySpies.skillStat).toHaveBeenCalledWith(expected);
    expect(deleteManySpies.automationStat).toHaveBeenCalledWith(expected);
    expect(deleteManySpies.llmCallEvent).toHaveBeenCalledWith(expected);
    expect(deleteManySpies.toolCallEvent).toHaveBeenCalledWith(expected);
    // cutoff 与 90 天前的偏差控制在 ±1 小时（宽松断言防时钟精度抖动）
    const cutoff = (
      deleteManySpies.skillStat.mock.calls[0]![0] as {
        where: { createdAt: { lt: Date } };
      }
    ).where.createdAt.lt;
    const ageDays = (Date.now() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
    expect(Math.abs(ageDays - 90)).toBeLessThan(1 / 24);
  });
});
