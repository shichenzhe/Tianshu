import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const V1_SQL = readFileSync(
  path.resolve(
    __dirname,
    "../../electron/infrastructure/script/v1/upgrade-table.sql",
  ),
  "utf8",
);

/** 去注释行后按分号拆分(模拟 sql-file-executor 最小语义) */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 全部 14 张表(含 db_version 由代码建,此处为脚本建的 13 张) */
const TABLES = [
  "user",
  "option",
  "provider",
  "model",
  "assistant",
  "workspace",
  "session",
  "message",
  "mcpServer",
  "toolPermission",
  "skillRecord",
  "skillStat",
  "automationTask",
  "automationRun",
  "automationStat",
];

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const stmt of statements(V1_SQL)) {
    db.exec(stmt);
  }
  return db;
}

function columnsOf(db: DatabaseSync, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((c) => c.name);
}

describe("v1 全量建表脚本(合并 v2-v10 后的最终结构)", () => {
  it("重复执行两次幂等(IF NOT EXISTS)", () => {
    const db = new DatabaseSync(":memory:");
    for (let i = 0; i < 2; i += 1) {
      for (const stmt of statements(V1_SQL)) {
        db.exec(stmt);
      }
    }
    const placeholders = TABLES.map(() => "?").join(",");
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
        )
        .get(...TABLES),
    ).toEqual({ n: TABLES.length });
  });

  it("原 v2-v10 增量列已并入对应表", () => {
    const db = createDb();
    expect(columnsOf(db, "workspace")).toContain("writeApprovedAt");
    expect(columnsOf(db, "session")).toEqual(
      expect.arrayContaining([
        "mode",
        "pinnedAt",
        "archivedAt",
        "summary",
        "compactedUpToId",
      ]),
    );
    expect(columnsOf(db, "message")).toContain("durationMs");
  });

  it("skillRecord name 唯一约束生效", () => {
    const db = createDb();
    db.exec(
      `INSERT INTO skillRecord (name, source, dir, installedAt, updatedAt)
       VALUES ('demo', 'market', '/tmp/demo', '2026-09-07 00:00:00', '2026-09-07 00:00:00')`,
    );
    expect(() =>
      db.exec(
        `INSERT INTO skillRecord (name, source, dir, installedAt, updatedAt)
         VALUES ('demo', 'user', '/tmp/demo2', '2026-09-07 00:00:00', '2026-09-07 00:00:00')`,
      ),
    ).toThrow();
  });

  it("skillStat 同名多事件共存(事件流,无唯一约束)", () => {
    const db = createDb();
    db.exec(
      `INSERT INTO skillStat (name, event, createdAt) VALUES
       ('demo', 'invoke', '2026-09-07 09:00:00'),
       ('demo', 'invoke', '2026-09-07 10:00:00')`,
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM skillStat").get()).toEqual({
      n: 2,
    });
  });

  it("自动化三表可插入必填列", () => {
    const db = createDb();
    db.exec(
      `INSERT INTO automationTask (name, prompt, workspaceId, modelId,
        temperature, scheduleJson, scheduleText, missedPolicy, enabled,
        status, createdAt, updatedAt)
       VALUES ('早报', '总结今日AI资讯', 1, 1, 0.7,
        '{"mode":"periodic","kind":"daily","time":"09:00"}',
        '每天 09:00', 'skip', 1, 'active', '2026-09-06 00:00:00',
        '2026-09-06 00:00:00')`,
    );
    db.exec(
      `INSERT INTO automationRun (taskId, sessionId, attempt, triggerType,
        status, startedAt)
       VALUES (1, 10, 1, 'schedule', 'success', '2026-09-06 09:00:05')`,
    );
    db.exec(
      `INSERT INTO automationStat (event, detail, createdAt)
       VALUES ('create', '{"mode":"periodic"}', '2026-09-06 09:00:05')`,
    );
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM automationTask").get(),
    ).toEqual({ n: 1 });
  });

  it("toolPermission 工作空间+工具唯一索引生效", () => {
    const db = createDb();
    db.exec(
      "INSERT INTO toolPermission (workspaceId, toolName) VALUES (1, 'write_file')",
    );
    expect(() =>
      db.exec(
        "INSERT INTO toolPermission (workspaceId, toolName) VALUES (1, 'write_file')",
      ),
    ).toThrow();
  });
});
