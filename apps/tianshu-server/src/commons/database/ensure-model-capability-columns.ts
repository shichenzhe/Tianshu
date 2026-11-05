import { engineOf, overriddenDbUrl, type DbEngine } from './db-url';

/**
 * model 表能力矩阵四列启动幂等补列（批5 provider-model §6 项 5，先例
 * ensureAutomationRunGraphSnapshotColumn）：capabilities / priceIn·
 * OutPerMTokens / fallbackModelId。SQLite 存量升级库走快路径不跑
 * migrate deploy（ensureDatabase 就绪即跳过），缺列时模型 save 读取即
 * 失败——启动探测补列承担存量库路径。新库/PG 不经此处：0_init + 3_
 * 增量迁移建列（PG 每 boot migrate deploy 幂等增量）。须在
 * ensureDatabase 之后、首个模型保存前调用（PrismaService.onModuleInit）。
 */
/** 结构最小面：仅需执行原生 DDL/探测（PrismaService / 测试桩同构满足） */
interface RawExecutor {
  $executeRawUnsafe(sql: string): Promise<number>;
  $queryRawUnsafe(sql: string): Promise<unknown>;
}

/** 逐列 DDL（列名 → SQLite 方言 ADD COLUMN 语句） */
const MODEL_CAPABILITY_DDL: Array<{ column: string; sql: string }> = [
  {
    column: 'capabilities',
    sql: 'ALTER TABLE "model" ADD COLUMN "capabilities" TEXT',
  },
  {
    column: 'priceInPerMTokens',
    sql: 'ALTER TABLE "model" ADD COLUMN "priceInPerMTokens" REAL',
  },
  {
    column: 'priceOutPerMTokens',
    sql: 'ALTER TABLE "model" ADD COLUMN "priceOutPerMTokens" REAL',
  },
  {
    column: 'fallbackModelId',
    sql: 'ALTER TABLE "model" ADD COLUMN "fallbackModelId" INTEGER',
  },
];

export async function ensureModelCapabilityColumns(
  db: RawExecutor,
  engine: DbEngine = engineOf(overriddenDbUrl()),
): Promise<void> {
  // PG 无存量快路径缺口（每 boot migrate deploy 跑 3_ 增量），且
  // pragma_table_info 是 SQLite 方言——postgres 态跳过
  if (engine === 'postgres') {
    return;
  }
  const columns = (await db.$queryRawUnsafe(
    "SELECT name FROM pragma_table_info('model')",
  )) as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));
  for (const { column, sql } of MODEL_CAPABILITY_DDL) {
    if (!existing.has(column)) {
      await db.$executeRawUnsafe(sql);
    }
  }
}
