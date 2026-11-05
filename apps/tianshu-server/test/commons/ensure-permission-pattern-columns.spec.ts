// 批7（security P1-3）：toolPermission 参数级审批两列存量库幂等补列——
// ensurePermissionPatternColumns。SQLite 存量升级库快路径不跑 migrate
// deploy，pattern/lastUsedAt 缺列时记忆查表（findMany select pattern）
// 即失败；启动探测补列 + 旧两列唯一索引替换为三列形态承担存量库路径
// （新库/PG 走 4_ 增量迁移 + 每 boot migrate deploy）。mock
// $queryRawUnsafe/$executeRawUnsafe 直证探测-补列-索引三段语义
// （ensure-model-capability-columns.spec.ts 先例）。
import { ensurePermissionPatternColumns } from 'src/commons/database/ensure-permission-pattern-columns';

const executeRawCalls: string[] = [];
let columns: Array<{ name: string }>;
const db = {
  $executeRawUnsafe: jest.fn(async (sql: string) => {
    executeRawCalls.push(sql);
    return 0;
  }),
  $queryRawUnsafe: jest.fn(async () => columns),
};

describe('ensurePermissionPatternColumns（存量库幂等补列 + 索引替换）', () => {
  beforeEach(() => {
    executeRawCalls.length = 0;
    db.$executeRawUnsafe.mockClear();
    db.$queryRawUnsafe.mockClear();
  });

  it('缺列：探测 pragma 后逐列 ALTER + 旧唯一索引替换为三列形态', async () => {
    // 存量库形态：toolPermission 无参数级审批两列
    columns = [
      { name: 'id' },
      { name: 'workspaceId' },
      { name: 'toolName' },
      { name: 'createdAt' },
    ];
    await expect(ensurePermissionPatternColumns(db)).resolves.toBeUndefined();
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("pragma_table_info('toolPermission')"),
    );
    expect(executeRawCalls).toHaveLength(4);
    expect(executeRawCalls[0]).toContain(
      'ALTER TABLE "toolPermission" ADD COLUMN "pattern" TEXT',
    );
    expect(executeRawCalls[1]).toContain(
      'ALTER TABLE "toolPermission" ADD COLUMN "lastUsedAt" DATETIME',
    );
    expect(executeRawCalls[2]).toContain(
      'DROP INDEX IF EXISTS "idx_tool_permission_ws_tool"',
    );
    expect(executeRawCalls[3]).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "idx_tool_permission_ws_tool_pattern"',
    );

    // 补列后再跑：零 ALTER，索引两段幂等重放（no-op）
    columns = [...columns, { name: 'pattern' }, { name: 'lastUsedAt' }];
    await expect(ensurePermissionPatternColumns(db)).resolves.toBeUndefined();
    expect(executeRawCalls).toHaveLength(6);
    expect(executeRawCalls.slice(4).join('\n')).not.toContain('ADD COLUMN');
  });

  it('半升级态（仅 pattern 在场）：只补 lastUsedAt，索引替换照常', async () => {
    columns = [{ name: 'id' }, { name: 'pattern' }];
    await expect(ensurePermissionPatternColumns(db)).resolves.toBeUndefined();
    expect(executeRawCalls).toHaveLength(3);
    expect(executeRawCalls.join('\n')).not.toContain('"pattern" TEXT');
    expect(executeRawCalls[0]).toContain('"lastUsedAt" DATETIME');
  });

  it('PG 主库引擎早退：不发任何 raw 调用（列由 4_ 增量迁移覆盖，每 boot migrate deploy）', async () => {
    await expect(
      ensurePermissionPatternColumns(db, 'postgres'),
    ).resolves.toBeUndefined();
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
