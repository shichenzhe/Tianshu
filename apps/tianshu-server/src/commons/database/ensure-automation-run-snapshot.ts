import { engineOf, overriddenDbUrl, type DbEngine } from './db-url';

/**
 * automationRun 快照列启动幂等补列（批1C 改进项 3，先例
 * ensureGraphRunNodeTable）：SQLite 存量升级库走快路径不跑 migrate
 * deploy（ensureDatabase 就绪即跳过），graphJsonSnapshot 缺列时图运行
 * createRun 100% 失败（run 行建不出）——启动探测补列承担存量库路径。
 * 新库/PG 不经此处：0_init + 1_ 增量迁移建列（PG 每 boot migrate
 * deploy 幂等增量）。须在 ensureDatabase 之后、首个图运行前调用
 * （PrismaService.onModuleInit）。
 */
/** 结构最小面：仅需执行原生 DDL/探测（PrismaService / 测试桩同构满足） */
interface RawExecutor {
  $executeRawUnsafe(sql: string): Promise<number>;
  $queryRawUnsafe(sql: string): Promise<unknown>;
}

export async function ensureAutomationRunGraphSnapshotColumn(
  db: RawExecutor,
  engine: DbEngine = engineOf(overriddenDbUrl()),
): Promise<void> {
  // PG 无存量快路径缺口（每 boot migrate deploy 跑 1_ 增量），且
  // pragma_table_info 是 SQLite 方言——postgres 态跳过
  if (engine === 'postgres') {
    return;
  }
  const columns = (await db.$queryRawUnsafe(
    "SELECT name FROM pragma_table_info('automationRun')",
  )) as Array<{ name: string }>;
  if (columns.some((column) => column.name === 'graphJsonSnapshot')) {
    return;
  }
  await db.$executeRawUnsafe(
    'ALTER TABLE "automationRun" ADD COLUMN "graphJsonSnapshot" TEXT',
  );
}
