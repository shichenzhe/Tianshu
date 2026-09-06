import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const V10_SQL = readFileSync(
  path.resolve(
    __dirname,
    "../../electron/infrastructure/script/v10/upgrade-table.sql",
  ),
  "utf8",
);

/** 去注释行后按分号拆分(模拟 sql-file-executor 最小语义,同 v7 测试) */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("v10 迁移:自动化任务三表", () => {
  it("三表建表成功且任务行可插入必填列", () => {
    const db = new DatabaseSync(":memory:");
    for (const stmt of statements(V10_SQL)) {
      db.exec(stmt);
    }
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
    expect(
      db.prepare("SELECT attempt FROM automationRun WHERE taskId = 1").get(),
    ).toEqual({ attempt: 1 });
  });

  it("重复执行幂等(IF NOT EXISTS)", () => {
    const db = new DatabaseSync(":memory:");
    for (let i = 0; i < 2; i += 1) {
      for (const stmt of statements(V10_SQL)) {
        db.exec(stmt);
      }
    }
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('automationTask','automationRun','automationStat')",
        )
        .get(),
    ).toEqual({ n: 3 });
  });
});
