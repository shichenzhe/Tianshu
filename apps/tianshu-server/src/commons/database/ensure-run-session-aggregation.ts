import { engineOf, overriddenDbUrl, type DbEngine } from './db-url';

interface RawExecutor {
  $executeRawUnsafe(sql: string): Promise<number>;
  $queryRawUnsafe(sql: string): Promise<unknown>;
}

const DEDUPE_SQL = `
UPDATE "automationRun" SET "sessionId" = NULL
WHERE "sessionId" IS NOT NULL AND "id" NOT IN (
  SELECT MIN("id") FROM "automationRun"
  WHERE "sessionId" IS NOT NULL GROUP BY "sessionId"
)`;

const BACKFILL_SQL = `
UPDATE "session"
SET "automationTaskId" = (
  SELECT "automationRun"."taskId" FROM "automationRun"
  WHERE "automationRun"."sessionId" = "session"."id"
    AND "automationRun"."taskId" IS NOT NULL
    AND "automationRun"."graphId" IS NULL
  ORDER BY "automationRun"."id" LIMIT 1
)
WHERE EXISTS (
  SELECT 1 FROM "automationRun"
  WHERE "automationRun"."sessionId" = "session"."id"
    AND "automationRun"."taskId" IS NOT NULL
    AND "automationRun"."graphId" IS NULL
)`;

const INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS "session_automationTaskId_idx" ON "session"("automationTaskId")',
  'CREATE INDEX IF NOT EXISTS "session_runGraphId_idx" ON "session"("runGraphId")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "automationRun_sessionId_key" ON "automationRun"("sessionId")',
];

async function columnNames(
  db: RawExecutor,
  table: 'session' | 'automationRun',
): Promise<Set<string>> {
  const rows = (await db.$queryRawUnsafe(
    `SELECT name FROM pragma_table_info('${table}')`,
  )) as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

async function addMissingColumns(
  db: RawExecutor,
  table: 'session' | 'automationRun',
  existing: Set<string>,
  columns: string[],
): Promise<void> {
  for (const column of columns) {
    if (!existing.has(column)) {
      await db.$executeRawUnsafe(
        `ALTER TABLE "${table}" ADD COLUMN "${column}" INTEGER`,
      );
    }
  }
}

/** SQLite 存量快路径的幂等升级；PG 由 migration 5 每 boot deploy。 */
export async function ensureRunSessionAggregation(
  db: RawExecutor,
  engine: DbEngine = engineOf(overriddenDbUrl()),
): Promise<void> {
  if (engine === 'postgres') return;
  const [sessionColumns, runColumns] = await Promise.all([
    columnNames(db, 'session'),
    columnNames(db, 'automationRun'),
  ]);
  await addMissingColumns(db, 'session', sessionColumns, [
    'automationTaskId',
    'runGraphId',
  ]);
  await addMissingColumns(db, 'automationRun', runColumns, ['workspaceId']);
  await db.$executeRawUnsafe(BACKFILL_SQL);
  await db.$executeRawUnsafe(DEDUPE_SQL);
  for (const sql of INDEX_SQL) {
    await db.$executeRawUnsafe(sql);
  }
}
