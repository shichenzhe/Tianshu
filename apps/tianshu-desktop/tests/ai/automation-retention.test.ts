// tests/ai/automation-retention.test.ts
// parseRunRetention 纯函数全边界 + trimAutomationRuns SQL 行为验证。
//
// 真库直连在 vitest 不可行：better-sqlite3 原生二进制按 Electron ABI 编译
// （NODE_MODULE_VERSION 149），vitest 跑在系统 Node（147）require 即崩
// （monitor-table.test.ts 因此 mock 掉 adapter，全仓无一真库单测先例）。
// 改用 node:sqlite（Node 内置零原生依赖）构建 RetentionDb 测试替身：
// $executeRawUnsafe 原样执行被测模块产出的 SQL——窗口函数、taskId NULL
// 分组、参数绑定均由真 SQLite 引擎验证；updateMany/deleteMany 按
// trimAutomationRuns 实际使用的 where 形状做参数化翻译。
import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  DEFAULT_RUN_RETENTION,
  parseRunRetention,
  trimAutomationRuns,
  TRIM_INTERVAL_MS,
  maybeTrimAutomationRuns,
  type RetentionDb,
} from "../../electron/domains/ai/automation/automation-retention";

describe("parseRunRetention", () => {
  it("null/undefined/空串 → 全默认", () => {
    expect(parseRunRetention(null)).toEqual(DEFAULT_RUN_RETENTION);
    expect(parseRunRetention(undefined)).toEqual(DEFAULT_RUN_RETENTION);
    expect(parseRunRetention("")).toEqual(DEFAULT_RUN_RETENTION);
  });

  it("非法 JSON → 全默认", () => {
    expect(parseRunRetention("{oops")).toEqual(DEFAULT_RUN_RETENTION);
    expect(parseRunRetention("42")).toEqual(DEFAULT_RUN_RETENTION);
  });

  it("部分字段缺省 → 缺的字段用默认值补齐", () => {
    const parsed = parseRunRetention(JSON.stringify({ successDays: 14 }));
    expect(parsed).toEqual({ ...DEFAULT_RUN_RETENTION, successDays: 14 });
  });

  it("越界 clamp：天数 <1 → 1，>3650 → 3650；条数 <1 → 1，>10000 → 10000", () => {
    const parsed = parseRunRetention(
      JSON.stringify({
        traceDays: 0,
        successDays: -5,
        failureDays: 99999,
        successKeep: 0,
        failureKeep: 99999,
      }),
    );
    expect(parsed).toEqual({
      enabled: true,
      traceDays: 1,
      successDays: 1,
      failureDays: 3650,
      successKeep: 1,
      failureKeep: 10000,
    });
  });

  it("enabled:false 显式保留", () => {
    expect(parseRunRetention(JSON.stringify({ enabled: false })).enabled).toBe(
      false,
    );
  });
});

// —— trimAutomationRuns SQL 行为验证（node:sqlite 测试替身，见文件头注释）——

const NOW = new Date(2026, 10, 22, 12, 0, 0);
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

/** automationRun 建表 DDL：与 v1 快照 upgrade-table.sql 逐列一致 */
const AUTOMATION_RUN_DDL = `
  CREATE TABLE IF NOT EXISTS automationRun (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    taskId INTEGER,
    sessionId INTEGER,
    attempt INTEGER NOT NULL DEFAULT 1,
    triggerType TEXT NOT NULL,
    status TEXT NOT NULL,
    durationMs INTEGER,
    promptTokens INTEGER,
    completionTokens INTEGER,
    graphId INTEGER,
    graphTrace TEXT,
    error TEXT,
    startedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finishedAt DATETIME
  )
`;

/** graphRunNode 建表 DDL：本测仅涉 runId/nodeId 两列（级联删验证），
 * 全列形状见 prisma/schema.prisma */
const GRAPH_RUN_NODE_DDL = `
  CREATE TABLE IF NOT EXISTS graphRunNode (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    runId INTEGER NOT NULL,
    nodeId TEXT NOT NULL
  )
`;

/** node:sqlite 版 RetentionDb 替身：每用例独立内存库，用例间零污染 */
function makeRetentionDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(AUTOMATION_RUN_DDL);
  db.exec(GRAPH_RUN_NODE_DDL);
  const insert = db.prepare(
    "INSERT INTO automationRun (taskId, triggerType, status, startedAt, graphTrace) VALUES (?, 'test', ?, ?, ?)",
  );
  const seedRun = (over: {
    taskId?: number | null;
    status: string;
    startedAt: Date;
    graphTrace?: string | null;
  }) => {
    const r = insert.run(
      over.taskId ?? null,
      over.status,
      over.startedAt.toISOString(),
      over.graphTrace ?? null,
    );
    return { id: Number(r.lastInsertRowid) };
  };
  const seedNode = (runId: number, nodeId: string) => {
    db.prepare("INSERT INTO graphRunNode (runId, nodeId) VALUES (?, ?)").run(
      runId,
      nodeId,
    );
  };
  /** status/startedAt where 形状 → SQL 片段（findMany/deleteMany 共用翻译） */
  const translateWhere = (where: {
    status?: string | { notIn: string[] };
    startedAt?: { lt: Date };
  }) => {
    const conds: string[] = [];
    const params: (string | number)[] = [];
    if (where.startedAt) {
      conds.push("startedAt < ?");
      params.push(where.startedAt.lt.toISOString());
    }
    if (typeof where.status === "string") {
      conds.push("status = ?");
      params.push(where.status);
    } else if (where.status) {
      conds.push(
        `status NOT IN (${where.status.notIn.map(() => "?").join(", ")})`,
      );
      params.push(...where.status.notIn);
    }
    return {
      clause: conds.length ? ` WHERE ${conds.join(" AND ")}` : "",
      params,
    };
  };
  const prisma: RetentionDb = {
    automationRun: {
      // 翻译 trimAutomationRuns 实际使用的 where 形状（startedAt lt /
      // graphTrace not null），参数化防注入
      async updateMany({ where, data }) {
        if (data.graphTrace !== null) {
          throw new Error("替身仅支持 graphTrace 置空");
        }
        const conds: string[] = [];
        const params: string[] = [];
        if (where.startedAt) {
          conds.push("startedAt < ?");
          params.push(where.startedAt.lt.toISOString());
        }
        if (where.graphTrace?.not === null) {
          conds.push("graphTrace IS NOT NULL");
        }
        const r = db
          .prepare(
            `UPDATE automationRun SET graphTrace = NULL${
              conds.length ? ` WHERE ${conds.join(" AND ")}` : ""
            }`,
          )
          .run(...params);
        return { count: Number(r.changes) };
      },
      // 级联取 run id 集合（去会话化 2026-10-28）
      async findMany({ where }) {
        const { clause, params } = translateWhere(where);
        const rows = db
          .prepare(`SELECT id FROM automationRun${clause}`)
          .all(...params) as Array<{ id: number }>;
        return rows;
      },
      // status 两种形状：notIn 数组（成功档）/ 字符串精确匹配（失败档）
      async deleteMany({ where }) {
        const { clause, params } = translateWhere(where);
        const r = db
          .prepare(`DELETE FROM automationRun${clause}`)
          .run(...params);
        return { count: Number(r.changes) };
      },
    },
    graphRunNode: {
      async deleteMany({ where }) {
        const r = db
          .prepare(
            `DELETE FROM graphRunNode WHERE runId IN (${where.runId.in
              .map(() => "?")
              .join(", ")})`,
          )
          .run(...where.runId.in);
        return { count: Number(r.changes) };
      },
    },
    option: { findFirst: async () => null },
    async $executeRawUnsafe(sql: string, ...values: number[]) {
      // 被测 SQL 原样交真 SQLite 引擎执行（窗口函数/NULL 分组/参数绑定）
      return Number(db.prepare(sql).run(...values).changes);
    },
  };
  const getRow = (id: number) =>
    db.prepare("SELECT * FROM automationRun WHERE id = ?").get(id) ?? null;
  const countRuns = (where?: { taskId?: number | null }): number => {
    if (where && "taskId" in where) {
      if (where.taskId === null) {
        return Number(
          db
            .prepare(
              "SELECT COUNT(*) AS c FROM automationRun WHERE taskId IS NULL",
            )
            .get()!.c,
        );
      }
      return Number(
        db
          .prepare("SELECT COUNT(*) AS c FROM automationRun WHERE taskId = ?")
          .get(where.taskId)!.c,
      );
    }
    return Number(
      db.prepare("SELECT COUNT(*) AS c FROM automationRun").get()!.c,
    );
  };
  const countNodes = (): number =>
    Number(db.prepare("SELECT COUNT(*) AS c FROM graphRunNode").get()!.c);
  const nodesOf = (): Array<{ runId: number; nodeId: string }> =>
    db
      .prepare("SELECT runId, nodeId FROM graphRunNode ORDER BY id")
      .all() as Array<{ runId: number; nodeId: string }>;
  return { prisma, seedRun, seedNode, getRow, countRuns, countNodes, nodesOf };
}

describe("trimAutomationRuns（SQL 行为）", () => {
  it("graphTrace 降级：3 天前置空但行保留", async () => {
    const { prisma, seedRun, getRow } = makeRetentionDb();
    // 4 天前：超 traceDays(3) 置空轨迹，但在 successDays(7) 窗口内保行
    const row = await seedRun({
      status: "success",
      startedAt: daysAgo(4),
      graphTrace: JSON.stringify({ nodes: [] }),
    });
    const result = await trimAutomationRuns(prisma, DEFAULT_RUN_RETENTION, NOW);
    expect(result.tracedRuns).toBeGreaterThanOrEqual(1);
    const kept = getRow(row.id);
    expect(kept).not.toBeNull();
    expect(kept?.graphTrace).toBeNull();
  });

  it("成功态超 7 天删行、失败态 30 天内保留、running 永不裁剪", async () => {
    const { prisma, seedRun, getRow } = makeRetentionDb();
    const oldSuccess = await seedRun({
      status: "success",
      startedAt: daysAgo(10),
    });
    const recentSuccess = await seedRun({
      status: "success",
      startedAt: daysAgo(1),
    });
    const failed = await seedRun({
      status: "failed",
      startedAt: daysAgo(10),
    });
    const running = await seedRun({
      status: "running",
      startedAt: daysAgo(40),
    });
    await trimAutomationRuns(prisma, DEFAULT_RUN_RETENTION, NOW);
    expect(getRow(oldSuccess.id)).toBeNull();
    expect(getRow(recentSuccess.id)).not.toBeNull();
    expect(getRow(failed.id)).not.toBeNull();
    expect(getRow(running.id)).not.toBeNull();
  });

  it("失败态超 30 天删行", async () => {
    const { prisma, seedRun, getRow } = makeRetentionDb();
    const oldFailed = await seedRun({
      status: "failed",
      startedAt: daysAgo(40),
    });
    await trimAutomationRuns(prisma, DEFAULT_RUN_RETENTION, NOW);
    expect(getRow(oldFailed.id)).toBeNull();
  });

  it("成功态条数窗：同任务 250 条只留最新 200；taskId NULL（图试运行）自成一组", async () => {
    const { prisma, seedRun, countRuns } = makeRetentionDb();
    for (let i = 0; i < 250; i++) {
      await seedRun({
        taskId: 9901,
        status: "success",
        startedAt: daysAgo(0.01),
      });
    }
    for (let i = 0; i < 250; i++) {
      await seedRun({
        taskId: null,
        status: "success",
        startedAt: daysAgo(0.01),
      });
    }
    const result = await trimAutomationRuns(prisma, DEFAULT_RUN_RETENTION, NOW);
    expect(result.successKeepDeleted).toBe(100);
    expect(countRuns({ taskId: 9901 })).toBe(200);
    expect(countRuns({ taskId: null })).toBe(200);
  });

  // —— graphRunNode 级联（去会话化 2026-10-28，spec §3.1：删 run 连带删节点行）——

  it("按天档删 run 前级联删其节点行；保留 run 的节点行不动", async () => {
    const { prisma, seedRun, seedNode, getRow, countNodes, nodesOf } =
      makeRetentionDb();
    const doomed = await seedRun({ status: "success", startedAt: daysAgo(10) });
    seedNode(doomed.id, "collect");
    seedNode(doomed.id, "report");
    const kept = await seedRun({ status: "success", startedAt: daysAgo(1) });
    seedNode(kept.id, "collect");
    await trimAutomationRuns(prisma, DEFAULT_RUN_RETENTION, NOW);
    expect(getRow(doomed.id)).toBeNull();
    // 被删 run 的节点行连带清空，保留 run 的节点行原样
    expect(countNodes()).toBe(1);
    expect(nodesOf().map((row) => row.runId)).toEqual([kept.id]);
  });

  it("条数窗删 run 前级联删其节点行（同窗子查询 SQL 先行执行）", async () => {
    const { prisma, seedRun, seedNode, countNodes } = makeRetentionDb();
    // 同任务 3 条只留最新 1 条（successKeep 压到 1）；每 run 各带一节点行
    for (let i = 0; i < 3; i++) {
      const run = await seedRun({
        taskId: 7701,
        status: "success",
        startedAt: daysAgo(0.01),
      });
      seedNode(run.id, `node-${i}`);
    }
    await trimAutomationRuns(
      prisma,
      { ...DEFAULT_RUN_RETENTION, successKeep: 1 },
      NOW,
    );
    // 窗口删 2 run → 其节点行连带删 2，仅最新 run 的节点行保留
    expect(countNodes()).toBe(1);
  });

  it("enabled:false 零动作", async () => {
    const { prisma, seedRun, countRuns } = makeRetentionDb();
    await seedRun({ status: "success", startedAt: daysAgo(40) });
    const result = await trimAutomationRuns(
      prisma,
      { ...DEFAULT_RUN_RETENTION, enabled: false },
      NOW,
    );
    expect(result).toEqual({
      tracedRuns: 0,
      successDaysDeleted: 0,
      failureDaysDeleted: 0,
      successKeepDeleted: 0,
      failureKeepDeleted: 0,
    });
    expect(countRuns()).toBe(1);
  });
});

describe("maybeTrimAutomationRuns 节流", () => {
  it("6h 内第二次调用不再触达 DB", async () => {
    let touches = 0;
    const countingDb = {
      option: {
        // 返回 { value } 行形状（生产读 option?.value）；enabled:false 使 trim 零动作
        findFirst: async () => {
          touches++;
          return { value: JSON.stringify({ enabled: false }) };
        },
      },
    } as unknown as Parameters<typeof maybeTrimAutomationRuns>[0];
    const t0 = 1_000_000_000_000;
    await maybeTrimAutomationRuns(countingDb, t0);
    await maybeTrimAutomationRuns(countingDb, t0 + 1000);
    expect(touches).toBe(1); // 第二次被节流挡下
    // 恰值 TRIM_INTERVAL_MS：守卫为 <，恰满不挡（钉住 < 边界）——触达并刷新节流基点
    await maybeTrimAutomationRuns(countingDb, t0 + TRIM_INTERVAL_MS);
    expect(touches).toBe(2);
    // 恰值已刷新基点，+1 落回新窗口内 → 仍被挡
    await maybeTrimAutomationRuns(countingDb, t0 + TRIM_INTERVAL_MS + 1);
    expect(touches).toBe(2);
  });
});
