/**
 * 审计导出（SP1 spec §6.2）：JSON 形状 {"entries":[…]}；CSV 逐列转义。
 * 分批（500 条/批）流式追加写，避免大日志一次性驻留内存。
 */
import fs from "node:fs/promises";
import type { AuditPrismaLike } from "./audit-log.service";

const EXPORT_BATCH = 500;
const CSV_COLUMNS = [
  "id",
  "sequence",
  "category",
  "eventType",
  "decision",
  "detail",
  "commandPreview",
  "commandHash",
  "sessionId",
  "prevHash",
  "hash",
  "createdAt",
] as const;

/** CSV 字段转义：含引号/逗号/换行时引号包裹，内部引号翻倍 */
export function csvEscape(v: string | number | null): string {
  const s = v === null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 按 sequence 升序游标取下一批（after = 上一批最后 sequence） */
async function fetchBatch(
  db: AuditPrismaLike,
  after: string | null,
): Promise<Array<Record<string, unknown>>> {
  return db.findMany({
    orderBy: [{ sequence: "asc" }],
    take: EXPORT_BATCH,
    ...(after ? { where: { sequence: { gt: Number(after) } } } : {}),
  });
}

function entryRow(entry: Record<string, unknown>): string {
  return CSV_COLUMNS.map((col) =>
    csvEscape(entry[col] as string | number | null),
  ).join(",");
}

export async function writeAuditExport(
  db: AuditPrismaLike,
  format: "json" | "csv",
  filePath: string,
): Promise<void> {
  if (format === "csv") {
    await writeCsv(db, filePath);
  } else {
    await writeJson(db, filePath);
  }
}

async function writeJson(db: AuditPrismaLike, filePath: string): Promise<void> {
  await fs.writeFile(filePath, '{"entries":[');
  let first = true;
  let after: string | null = null;
  for (;;) {
    const rows = await fetchBatch(db, after);
    if (rows.length === 0) break;
    for (const row of rows) {
      await fs.appendFile(filePath, (first ? "" : ",") + JSON.stringify(row));
      first = false;
      after = String(row.sequence);
    }
  }
  await fs.appendFile(filePath, "]}");
}

async function writeCsv(db: AuditPrismaLike, filePath: string): Promise<void> {
  await fs.writeFile(filePath, CSV_COLUMNS.join(",") + "\n");
  let after: string | null = null;
  for (;;) {
    const rows = await fetchBatch(db, after);
    if (rows.length === 0) break;
    for (const row of rows) {
      await fs.appendFile(filePath, entryRow(row) + "\n");
      after = String(row.sequence);
    }
  }
}
