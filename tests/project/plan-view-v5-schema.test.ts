// tests/project/plan-view-v5-schema.test.ts
// @vitest-environment node
/** v5 增量脚本测试（沿用 tests/ai/v1-fullschema.test.ts 的 node:sqlite 模式）：
 * 依赖 v4 建 planItem，故按序执行 v4+v5；断言新列、建表幂等、部分唯一索引（空名播种豁免）、source 默认值 */
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
  for (const version of ["4", "5"]) {
    applyStatements(db, statements(readFileSync(scriptDir(version), "utf8")));
  }
  return db;
}

describe("v5 增量脚本（planItem 排期/来源列 + planView 视图表）", () => {
  it("planItem 新增 startDate/dueDate/source 列，source 默认 manual", () => {
    const db = createDb();
    const columns = (
      db.prepare("PRAGMA table_info(planItem)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toEqual(
      expect.arrayContaining(["startDate", "dueDate", "source"]),
    );
    db.exec(
      `INSERT INTO planItem (title, createdById, updatedAt)
       VALUES ('t', 1, '2026-09-14 00:00:00')`,
    );
    const row = db
      .prepare("SELECT source, startDate, dueDate FROM planItem WHERE id = 1")
      .get() as { source: string; startDate: unknown; dueDate: unknown };
    expect(row.source).toBe("manual");
    expect(row.startDate).toBeNull();
    expect(row.dueDate).toBeNull();
  });

  it("重复执行 v5 幂等（IF NOT EXISTS；ALTER 报重复列说明已建）", () => {
    const db = createDb();
    expect(() =>
      applyStatements(db, statements(readFileSync(scriptDir("5"), "utf8"))),
    ).not.toThrow();
  });

  it("planView 部分唯一索引：空名可多条（播种），非空名 (projectId, name) 冲突抛错", () => {
    const db = createDb();
    const insert = (name: string, sortOrder: number) =>
      db.exec(
        `INSERT INTO planView (projectId, name, type, filterJson, sortJson, sortOrder, createdAt, updatedAt)
         VALUES (1, '${name}', 'table', '{}', '[]', ${sortOrder}, '2026-09-14 00:00:00', '2026-09-14 00:00:00')`,
      );
    // 空串名 = 播种默认视图语义，同项目两条不冲突（部分索引 WHERE name != '' 不覆盖）
    expect(() => insert("", 0)).not.toThrow();
    expect(() => insert("", 1)).not.toThrow();
    // 非空名同项目冲突 → 抛错
    insert("我的看板", 2);
    expect(() => insert("我的看板", 3)).toThrow();
  });
});
