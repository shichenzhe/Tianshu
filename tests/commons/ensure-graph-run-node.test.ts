/**
 * 图运行节点详情表（图执行留痕去会话化 2026-10-28）：ensureGraphRunNodeTable
 * 启动幂等建表 + runId 索引（不走 v1 快照，同 artifact/monitor 先例——指纹
 * 变化会触发旧库 drop 重建）。
 * 真库用例在本机不可行（better-sqlite3 为 Electron ABI，Node 下加载即崩），
 * 按 brief 预案替身：mock $executeRawUnsafe 断言两跑各发两条幂等 DDL 且不抛。
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

// $executeRawUnsafe 捕获数组（模块工厂提升，须经 vi.hoisted 先于工厂创建）
const executeRawCalls = vi.hoisted(() => [] as unknown[]);

vi.mock("../../electron/generated/prisma/client", () => ({
  PrismaClient: class MockPrismaClient {
    // 顶层 WAL/NORMAL PRAGMA 调用的空实现
    $queryRawUnsafe = vi.fn(async () => []);
    $executeRawUnsafe = vi.fn(async (sql: string) => {
      executeRawCalls.push(sql);
      return 0;
    });
  },
}));

beforeEach(() => {
  executeRawCalls.length = 0;
});

describe("ensureGraphRunNodeTable", () => {
  it("幂等建表：两跑均成功，各发建表 + 建索引两条 IF NOT EXISTS DDL", async () => {
    const { ensureGraphRunNodeTable } =
      await import("../../electron/commons/prisma-client");
    // 两跑均不抛（幂等语义由 IF NOT EXISTS 承担）
    await expect(ensureGraphRunNodeTable()).resolves.toBeUndefined();
    await expect(ensureGraphRunNodeTable()).resolves.toBeUndefined();

    const assertOneRunDdl = (sqls: string[]) => {
      const createTable = sqls.filter((s) =>
        s.includes("CREATE TABLE IF NOT EXISTS graphRunNode"),
      );
      expect(createTable).toHaveLength(1);
      // DDL 字段与 schema.prisma 一一对应（抽样关键列 + 唯一约束）
      const ddl = createTable[0]!;
      for (const col of [
        "runId INTEGER NOT NULL",
        "nodeId TEXT NOT NULL",
        "status TEXT NOT NULL",
        "durationMs INTEGER NOT NULL",
        "startedAt TEXT NOT NULL",
        "errorJson TEXT",
        "fallbackJson TEXT",
        "CONSTRAINT graphRunNode_runId_nodeId_key UNIQUE (runId, nodeId)",
      ]) {
        expect(ddl).toContain(col);
      }
      expect(
        sqls.filter((s) =>
          s.includes(
            "CREATE INDEX IF NOT EXISTS graphRunNode_runId_idx ON graphRunNode (runId)",
          ),
        ),
      ).toHaveLength(1);
    };

    // 首跑两条 DDL
    assertOneRunDdl(executeRawCalls.slice(0, 2).map((s: unknown) => String(s)));
    // 次跑再发两条（幂等重放，无失败即不抛）
    assertOneRunDdl(executeRawCalls.slice(2).map((s: unknown) => String(s)));
  });
});
