/**
 * v0.1.1 缺列事故回归（2026-11-24）：0.1.1 两个提交（dd059b5c/4c85a37c）
 * 直接改 v1 快照加列而未走 ensure 幂等补列惯例——打包态旧库
 * CREATE TABLE IF NOT EXISTS 不补列 + 快照守卫永不重置，Prisma 按新
 * schema SELECT 显式列清单 → no such column → 会话/工作流列表全空。
 *
 * 测试形态（monitor-table.test.ts mock 先例 + 真库重放）：mock
 * PrismaClient 的 $queryRawUnsafe/$executeRawUnsafe 转发到 .native-node
 * node-ABI 副本真库（graph-db-page.test.ts 探测先例），SQL 全部真实
 * 执行——断言落在真库结构上而非 mock 调用记录上。v0.1.0 快照 fixture
 * 预建旧结构（打包态 app 分组），复现升级现场。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// 数据根直控（优先级最高，压过 tests/setup.ts 的全局隔离根）：须在
// prisma-client 顶层副作用（连库路径计算）之前定值
const dataRoot = path.join(os.tmpdir(), `tianshu-upgrade-${process.pid}`);
process.env.TIANSHU_DATA_ROOT = dataRoot;

// 打包态（app 分组）= 事故现场；getPath 仅满足顶层副作用对 app 的引用
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => dataRoot),
    getAppPath: vi.fn(() => dataRoot),
    isPackaged: true,
  },
}));

// 副作用导入会 require 原生 better-sqlite3，测试环境替换为空模块解除依赖
vi.mock("../../electron/commons/sqlite-stmt-cache", () => ({}));

// adapter 仅被构造不真正连库：raw 语句经下方 mock 转发真库
vi.mock("@prisma/adapter-better-sqlite3", () => ({
  PrismaBetterSqlite3: class MockPrismaBetterSqlite3 {
    constructor(public url: string) {}
  },
}));

// better-sqlite3 探测（graph-db-page.test.ts 先例）：动态 import 经
// vitest alias 命中 .native-node 的 node-ABI 副本；缺失/坏时跳过不误报
let Database: typeof import("better-sqlite3").default;
try {
  const mod = await import("better-sqlite3");
  Database = ((mod as { default?: unknown }).default ??
    mod) as typeof import("better-sqlite3").default;
  const probe = new Database(":memory:");
  probe.close();
} catch {
  Database = undefined as unknown as typeof import("better-sqlite3").default;
}

// 真库连接：mock PrismaClient 的 raw 面绑定于此（vi.hoisted 先于工厂创建）
const realDb = vi.hoisted(() => ({
  current: null as unknown as import("better-sqlite3").Database,
}));

vi.mock("../../electron/generated/prisma/client", () => ({
  PrismaClient: class MockPrismaClient {
    $queryRawUnsafe = vi.fn(async (sql: string) =>
      realDb.current.prepare(sql).all(),
    );
    $executeRawUnsafe = vi.fn(async (sql: string) => {
      realDb.current.prepare(sql).run();
      return 0;
    });
    // 顶层 WAL/NORMAL PRAGMA 已由 raw 面覆盖；模型面本测试不经 Prisma 使用
  },
}));

// 动态 import（静态会被提升到 env 赋值前触发 prisma-client 顶层连库副作用）
const { ensureRunSessionColumns } =
  await import("../../electron/commons/prisma-client");

const dbFile = path.join(dataRoot, "app", "database", "local.db");
const fixtureSqlPath = path.join(
  __dirname,
  "../fixtures/schema-v0.1.0-upgrade-table.sql",
);

/** 列存在性（真库 pragma） */
const columnNames = (table: string): string[] =>
  realDb.current
    .prepare(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((row) => (row as { name: string }).name);

const indexNames = (table: string): string[] =>
  realDb.current
    .prepare(`SELECT name FROM pragma_index_list('${table}')`)
    .all()
    .map((row) => (row as { name: string }).name);

/** Prisma findMany 行为等价物：SELECT 显式列清单（0.1.1 事故的炸点形态） */
const selectColumns = (table: string, columns: string[]): unknown[] =>
  realDb.current
    .prepare(`SELECT ${columns.join(", ")} FROM ${table} LIMIT 1`)
    .all();

describe.skipIf(!Database)("ensureRunSessionColumns（v0.1.0 旧库升级）", () => {
  beforeAll(async () => {
    // 预建 0.1.0 结构旧库：v1 快照定版 SQL 原文 exec（--/p 等执行器指令
    // 为 -- 注释，SQLite 原生可吞）
    await fs.mkdir(path.dirname(dbFile), { recursive: true });
    realDb.current = new Database(dbFile);
    realDb.current.exec(await fs.readFile(fixtureSqlPath, "utf8"));
  });

  it("旧库前置自检：三表均无 v0.1.1 新列", () => {
    expect(columnNames("session")).not.toContain("automationTaskId");
    expect(columnNames("graphDefinition")).not.toContain("aiSessionId");
    expect(columnNames("automationRun")).not.toContain("workspaceId");
  });

  it("补列后新列与索引齐备，显式列清单查询恢复可用", async () => {
    await ensureRunSessionColumns();

    expect(columnNames("session")).toEqual(
      expect.arrayContaining(["automationTaskId", "runGraphId"]),
    );
    expect(columnNames("graphDefinition")).toContain("aiSessionId");
    expect(columnNames("automationRun")).toContain("workspaceId");
    expect(indexNames("session")).toEqual(
      expect.arrayContaining([
        "session_automationTaskId_idx",
        "session_runGraphId_idx",
      ]),
    );
    expect(indexNames("automationRun")).toContain(
      "automationRun_sessionId_key",
    );

    // 用户症状终验：Prisma 风格 SELECT 显式列清单不再抛 no such column
    expect(() =>
      selectColumns("session", [
        "id",
        "appId",
        "automationTaskId",
        "runGraphId",
      ]),
    ).not.toThrow();
    expect(() =>
      selectColumns("graphDefinition", ["id", "aiSessionId"]),
    ).not.toThrow();
    expect(() =>
      selectColumns("automationRun", ["id", "sessionId", "workspaceId"]),
    ).not.toThrow();
  });

  it("幂等：二跑零异常、结构不变", async () => {
    await ensureRunSessionColumns();
    const before = columnNames("session");
    await expect(ensureRunSessionColumns()).resolves.toBeUndefined();
    expect(columnNames("session")).toEqual(before);
  });

  it("automationRun 多 run 共享 sessionId 时查重保留最新、其余置 null", async () => {
    // 手工拆除前序用例已建的唯一索引，构造「未查重」初始态（须先于
    // INSERT——多 run 共享会话在唯一约束下插不进去）
    realDb.current.exec("DROP INDEX IF EXISTS automationRun_sessionId_key");
    // 旧模型存量数据形态：两个 run 链接同一会话（prompt 型，graphId null，
    // 不属 cleanupGraphRunSessions 清理范围）
    realDb.current
      .prepare(
        `INSERT INTO session (id, workspaceId, title, createdAt, updatedAt)
         VALUES (101, 1, '共享会话', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      )
      .run();
    realDb.current
      .prepare(
        `INSERT INTO automationRun (id, taskId, sessionId, graphId, triggerType, status, startedAt)
         VALUES
          (1, NULL, 101, NULL, 'manual', 'success', '2026-01-01 00:00:00'),
          (2, NULL, 101, NULL, 'manual', 'success', '2026-06-01 00:00:00')`,
      )
      .run();

    await ensureRunSessionColumns();

    const links = realDb.current
      .prepare(
        "SELECT id, sessionId FROM automationRun WHERE id IN (1, 2) ORDER BY id",
      )
      .all() as Array<{ id: number; sessionId: number | null }>;
    expect(links).toEqual([
      { id: 1, sessionId: null },
      { id: 2, sessionId: 101 },
    ]);
    expect(indexNames("automationRun")).toContain(
      "automationRun_sessionId_key",
    );
  });
});
