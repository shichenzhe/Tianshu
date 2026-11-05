import { engineOf, overriddenDbUrl, type DbEngine } from './db-url';

/**
 * toolPermission 参数级审批两列启动幂等补列（批7 security P1-3，先例
 * ensureModelCapabilityColumns）：pattern（参数级记忆——bash 前缀 `git *` /
 * 路径 glob `src/**`，NULL = 整工具旧全等语义）+ lastUsedAt（命中
 * fire-and-forget 回写）。SQLite 存量升级库走快路径不跑 migrate deploy，
 * 缺列时记忆查表（findMany select pattern）即失败——启动探测补列承担
 * 存量库路径；旧两列唯一索引同步替换为三列形态（同 pattern 拒重、跨
 * pattern 共存）。新库/PG 不经此处：0_init + 4_ 增量迁移建列（PG 每
 * boot migrate deploy 幂等增量）。须在 ensureDatabase 之后调用
 * （PrismaService.onModuleInit）。
 */
/** 结构最小面：仅需执行原生 DDL/探测（PrismaService / 测试桩同构满足） */
interface RawExecutor {
  $executeRawUnsafe(sql: string): Promise<number>;
  $queryRawUnsafe(sql: string): Promise<unknown>;
}

export async function ensurePermissionPatternColumns(
  db: RawExecutor,
  engine: DbEngine = engineOf(overriddenDbUrl()),
): Promise<void> {
  // PG 无存量快路径缺口（每 boot migrate deploy 跑 4_ 增量），且
  // pragma_table_info 是 SQLite 方言——postgres 态跳过
  if (engine === 'postgres') {
    return;
  }
  const columns = (await db.$queryRawUnsafe(
    "SELECT name FROM pragma_table_info('toolPermission')",
  )) as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));
  if (!existing.has('pattern')) {
    await db.$executeRawUnsafe(
      'ALTER TABLE "toolPermission" ADD COLUMN "pattern" TEXT',
    );
  }
  if (!existing.has('lastUsedAt')) {
    await db.$executeRawUnsafe(
      'ALTER TABLE "toolPermission" ADD COLUMN "lastUsedAt" DATETIME',
    );
  }
  // 旧两列唯一索引替换（幂等：新库/已替换库重建为同义 no-op）
  await db.$executeRawUnsafe(
    'DROP INDEX IF EXISTS "idx_tool_permission_ws_tool"',
  );
  await db.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "idx_tool_permission_ws_tool_pattern" ON "toolPermission" (workspaceId, toolName, pattern)',
  );
}
