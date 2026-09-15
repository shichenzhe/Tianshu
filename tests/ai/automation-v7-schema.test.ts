// tests/ai/automation-v7-schema.test.ts
// @vitest-environment node
/** v7 增量脚本测试（v1 建 automationTask 基础上执行 v7，helper 同 v6 测试的
 * node:sqlite + --/ignore 语义）：projectId 列存在且 NULL 默认；索引存在；
 * v7 重放幂等（ALTER 重复列被 ignore） */
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const scriptDir = (version: string) =>
  path.resolve(
    __dirname,
    `../../electron/infrastructure/script/v${version}/upgrade-table.sql`,
  );

/** 去注释行后按分号拆分（模拟 sql-file-executor 最小语义：
 * --/p 描述行、--/ignore 标记下一条语句失败可忽略，跨行语句累积到分号） */
function statements(sql: string): Array<{ sql: string; ignoreError: boolean }> {
  const result: Array<{ sql: string; ignoreError: boolean }> = [];
  let current = "";
  let ignoreError = false;
  for (const rawLine of sql.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("--/ignore")) {
      ignoreError = true;
      continue;
    }
    if (line.startsWith("--")) continue;
    current += " " + line;
    if (line.endsWith(";")) {
      result.push({ sql: current.trim(), ignoreError });
      current = "";
      ignoreError = false;
    }
  }
  if (current.trim()) result.push({ sql: current.trim(), ignoreError });
  return result;
}

/** 按执行器语义执行：ignoreError 语句失败仅忽略（如重复列），其余失败向上抛 */
function applyStatements(
  db: DatabaseSync,
  stmts: Array<{ sql: string; ignoreError: boolean }>,
): void {
  for (const stmt of stmts) {
    try {
      db.exec(stmt.sql);
    } catch (error) {
      if (!stmt.ignoreError) throw error;
    }
  }
}

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  // automationTask 在 v1 建表，v1+v7 即覆盖列/索引断言（中间版本不涉及该表）
  for (const version of ["1", "7"]) {
    applyStatements(db, statements(readFileSync(scriptDir(version), "utf8")));
  }
  return db;
}

describe("v7 增量脚本（automationTask.projectId）", () => {
  it("projectId 列存在且默认 NULL；automation_task_projectId_index 索引存在", () => {
    const db = createDb();
    const columns = (
      db.prepare("PRAGMA table_info(automationTask)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(columns).toContain("projectId");
    const indexes = (
      db.prepare("PRAGMA index_list(automationTask)").all() as Array<{
        name: string;
      }>
    ).map((i) => i.name);
    expect(indexes).toContain("automation_task_projectId_index");
    db.exec(
      "INSERT INTO automationTask (name, prompt, workspaceId, modelId, scheduleJson, scheduleText, updatedAt) VALUES ('t', 'p', 1, 1, '{}', 's', '2026-09-15 00:00:00')",
    );
    expect(
      db.prepare("SELECT projectId FROM automationTask WHERE id = 1").get(),
    ).toEqual({ projectId: null });
  });

  it("v7 重放幂等（ALTER 重复列被 ignore）", () => {
    const db = createDb();
    expect(() =>
      applyStatements(db, statements(readFileSync(scriptDir("7"), "utf8"))),
    ).not.toThrow();
  });
});
