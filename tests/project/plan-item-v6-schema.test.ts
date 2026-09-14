// tests/project/plan-item-v6-schema.test.ts
// @vitest-environment node
/** v6 增量脚本测试（沿用 v5 测试的 node:sqlite + --/ignore 语义 helper）：
 * description 列存在且 NULL 默认；planItemAttachment 建表幂等 + planItemId 索引 */
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
  for (const version of ["4", "5", "6"]) {
    applyStatements(db, statements(readFileSync(scriptDir(version), "utf8")));
  }
  return db;
}

describe("v6 增量脚本（description 列 + planItemAttachment 表）", () => {
  it("planItem 新增 description 列，默认 NULL", () => {
    const db = createDb();
    const columns = (
      db.prepare("PRAGMA table_info(planItem)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toContain("description");
    db.exec(
      "INSERT INTO planItem (title, createdById, updatedAt) VALUES ('t', 1, '2026-09-14 00:00:00')",
    );
    expect(
      db.prepare("SELECT description FROM planItem WHERE id = 1").get(),
    ).toEqual({ description: null });
  });

  it("planItemAttachment 建表幂等 + planItemId 索引存在", () => {
    const db = createDb();
    db.exec(
      `INSERT INTO planItemAttachment (planItemId, fileName, assetPath, createdAt)
       VALUES (1, 'a.pdf', 'attachments/a.pdf', '2026-09-14 00:00:00')`,
    );
    const indexes = (
      db.prepare("PRAGMA index_list(planItemAttachment)").all() as Array<{
        name: string;
      }>
    ).map((i) => i.name);
    expect(indexes).toContain("plan_item_attachment_planItemId_index");
    expect(() =>
      applyStatements(db, statements(readFileSync(scriptDir("6"), "utf8"))),
    ).not.toThrow();
  });
});
