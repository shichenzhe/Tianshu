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

/** 全部 23 张表(含 db_version 由代码建,此处为脚本建的 22 张) */
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
  "libraryItem",
  "project",
  "projectMember",
  "projectBinding",
  "planItem",
  "planView",
  "planItemAttachment",
  "securityAuditLog",
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

function indexesOf(db: DatabaseSync, table: string): string[] {
  return (
    db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>
  ).map((i) => i.name);
}

describe("v1 全量建表脚本(合并 v2-v14 后的最终结构)", () => {
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

  it("v12 多用户隔离列与索引已并入(userId 归属)", () => {
    const db = createDb();
    for (const table of [
      "option",
      "provider",
      "assistant",
      "workspace",
      "session",
      "mcpServer",
      "automationTask",
      "libraryItem",
    ]) {
      expect(columnsOf(db, table)).toContain("userId");
    }
    // option 唯一索引扩含 userId(旧两列唯一索引已替换)
    expect(indexesOf(db, "option")).toContain("idx_option_type_name_user");
    expect(indexesOf(db, "option")).not.toContain("idx_option_type_name");
  });

  it("v11/v14 资料库条目表并入最终形态(含收藏与最近访问列)", () => {
    const db = createDb();
    expect(columnsOf(db, "libraryItem")).toEqual(
      expect.arrayContaining([
        "parentId",
        "kind",
        "fileType",
        "favorite",
        "lastViewedAt",
      ]),
    );
    db.exec(
      `INSERT INTO libraryItem (name, kind, createdAt, updatedAt)
       VALUES ('调研报告', 'file', '2026-09-21 00:00:00', '2026-09-21 00:00:00')`,
    );
    // favorite 默认 0(未收藏)、lastViewedAt 默认 NULL(NEW 判定依据)
    expect(
      db.prepare("SELECT favorite, lastViewedAt FROM libraryItem").get(),
    ).toEqual({ favorite: 0, lastViewedAt: null });
  });

  it("v13 性能索引已并入(消息创建时间/会话工作空间)", () => {
    const db = createDb();
    expect(indexesOf(db, "message")).toContain("message_createdAt_index");
    expect(indexesOf(db, "session")).toContain("session_workspaceId_index");
  });

  it("v2 project 域三表并入(owner+name 与成员唯一索引生效)", () => {
    const db = createDb();
    db.exec(
      `INSERT INTO project (name, ownerId, createdAt, updatedAt)
       VALUES ('官网改版', 1, '2026-09-01 00:00:00', '2026-09-01 00:00:00')`,
    );
    expect(() =>
      db.exec(
        `INSERT INTO project (name, ownerId, createdAt, updatedAt)
         VALUES ('官网改版', 1, '2026-09-02 00:00:00', '2026-09-02 00:00:00')`,
      ),
    ).toThrow();
    db.exec("INSERT INTO projectMember (projectId, userId) VALUES (1, 1)");
    expect(() =>
      db.exec("INSERT INTO projectMember (projectId, userId) VALUES (1, 1)"),
    ).toThrow();
  });

  it("v4-v8 planItem 排期/描述/AI 摘要列并入(默认值正确)", () => {
    const db = createDb();
    db.exec(
      `INSERT INTO planItem (title, createdById, createdAt, updatedAt)
       VALUES ('t', 1, '2026-09-14 00:00:00', '2026-09-14 00:00:00')`,
    );
    expect(
      db
        .prepare(
          "SELECT startDate, dueDate, source, description, aiSummary FROM planItem WHERE id = 1",
        )
        .get(),
    ).toEqual({
      startDate: null,
      dueDate: null,
      source: "manual",
      description: null,
      aiSummary: null,
    });
  });

  it("v5 planView 部分唯一索引(空名播种豁免,非空名冲突抛错)", () => {
    const db = createDb();
    const insert = (name: string, sortOrder: number) =>
      db.exec(
        `INSERT INTO planView (projectId, name, type, filterJson, sortJson, sortOrder, createdAt, updatedAt)
         VALUES (1, '${name}', 'table', '{}', '[]', ${sortOrder}, '2026-09-14 00:00:00', '2026-09-14 00:00:00')`,
      );
    expect(() => insert("", 0)).not.toThrow();
    expect(() => insert("", 1)).not.toThrow();
    insert("我的看板", 2);
    expect(() => insert("我的看板", 3)).toThrow();
  });

  it("v5 planView 存量库修复:旧全列唯一索引重放 v1 后替换为部分索引", () => {
    const db = createDb();
    // 模拟旧版迁移产物:换上旧全列唯一索引(空表,直接建不冲突)
    db.exec("DROP INDEX idx_plan_view_project_name");
    db.exec(
      "CREATE UNIQUE INDEX idx_plan_view_project_name ON planView (projectId, name)",
    );
    // 重放 v1 全量脚本:DROP 旧索引 + 重建部分索引
    for (const stmt of statements(V1_SQL)) {
      db.exec(stmt);
    }
    const insert = (name: string, sortOrder: number) =>
      db.exec(
        `INSERT INTO planView (projectId, name, type, filterJson, sortJson, sortOrder, createdAt, updatedAt)
         VALUES (1, '${name}', 'table', '{}', '[]', ${sortOrder}, '2026-09-14 00:00:00', '2026-09-14 00:00:00')`,
      );
    expect(() => insert("", 0)).not.toThrow();
    expect(() => insert("", 1)).not.toThrow();
  });

  it("v6/v9 planItemAttachment 与 securityAuditLog 并入(索引存在)", () => {
    const db = createDb();
    expect(indexesOf(db, "planItemAttachment")).toContain(
      "plan_item_attachment_planItemId_index",
    );
    expect(indexesOf(db, "securityAuditLog")).toEqual(
      expect.arrayContaining([
        "idx_audit_sequence",
        "idx_audit_createdAt",
        "idx_audit_category",
      ]),
    );
  });

  it("v2/v3/v7/v10 项目化与场景列并入对应表", () => {
    const db = createDb();
    expect(columnsOf(db, "session")).toEqual(
      expect.arrayContaining(["projectId", "scenario"]),
    );
    expect(columnsOf(db, "workspace")).toContain("projectId");
    expect(columnsOf(db, "automationTask")).toContain("projectId");
    expect(columnsOf(db, "skillRecord")).toContain("scenarios");
    expect(indexesOf(db, "automationTask")).toContain(
      "automation_task_projectId_index",
    );
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
