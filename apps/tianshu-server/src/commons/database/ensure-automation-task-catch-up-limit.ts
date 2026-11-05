import { engineOf, overriddenDbUrl, type DbEngine } from './db-url';

/**
 * automationTask 补跑上限列启动幂等补列（批3A，先例
 * ensureAutomationRunGraphSnapshotColumn）：SQLite 存量升级库走快路径
 * 不跑 migrate deploy（ensureDatabase 就绪即跳过），catchUpLimit 缺列时
 * 保存端点写该列即失败——启动探测补列承担存量库路径。新库/PG 不经此处：
 * 0_init/2_ 增量迁移建列（PG 每 boot migrate deploy 幂等增量）。须在
 * ensureDatabase 之后调用（PrismaService.onModuleInit）。
 */
/** 结构最小面：仅需执行原生 DDL/探测（PrismaService / 测试桩同构满足） */
interface RawExecutor {
  $executeRawUnsafe(sql: string): Promise<number>;
  $queryRawUnsafe(sql: string): Promise<unknown>;
}

export async function ensureAutomationTaskCatchUpLimitColumn(
  db: RawExecutor,
  engine: DbEngine = engineOf(overriddenDbUrl()),
): Promise<void> {
  // PG 无存量快路径缺口（每 boot migrate deploy 跑增量），且
  // pragma_table_info 是 SQLite 方言——postgres 态跳过
  if (engine === 'postgres') {
    return;
  }
  const columns = (await db.$queryRawUnsafe(
    "SELECT name FROM pragma_table_info('automationTask')",
  )) as Array<{ name: string }>;
  if (columns.some((column) => column.name === 'catchUpLimit')) {
    return;
  }
  await db.$executeRawUnsafe(
    'ALTER TABLE "automationTask" ADD COLUMN "catchUpLimit" INTEGER NOT NULL DEFAULT 1',
  );
}
