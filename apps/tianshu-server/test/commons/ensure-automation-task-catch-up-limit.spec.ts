// 批3A：automationTask 补跑上限列存量库幂等补列——
// ensureAutomationTaskCatchUpLimitColumn（先例 ensure-automation-run-
// snapshot.spec.ts：mock $queryRawUnsafe/$executeRawUnsafe 直证探测-补列
// 两段语义；SQLite 存量升级库快路径不跑 migrate deploy，缺列时保存端点
// 写 catchUpLimit 即失败——新库/PG 走 2_ 增量迁移）。
import { ensureAutomationTaskCatchUpLimitColumn } from 'src/commons/database/ensure-automation-task-catch-up-limit';

const executeRawCalls: string[] = [];
let columns: Array<{ name: string }>;
const db = {
  $executeRawUnsafe: jest.fn(async (sql: string) => {
    executeRawCalls.push(sql);
    return 0;
  }),
  $queryRawUnsafe: jest.fn(async () => columns),
};

beforeEach(() => {
  executeRawCalls.length = 0;
  jest.clearAllMocks();
});

describe('ensureAutomationTaskCatchUpLimitColumn', () => {
  it('缺列：探测 pragma 后发 ALTER 补列；已列：二次执行零 ALTER（幂等）', async () => {
    columns = [
      { name: 'id' },
      { name: 'missedPolicy' },
      { name: 'accessMode' },
    ];
    await expect(
      ensureAutomationTaskCatchUpLimitColumn(db),
    ).resolves.toBeUndefined();
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("pragma_table_info('automationTask')"),
    );
    expect(executeRawCalls).toHaveLength(1);
    expect(executeRawCalls[0]).toContain(
      'ALTER TABLE "automationTask" ADD COLUMN "catchUpLimit" INTEGER NOT NULL DEFAULT 1',
    );

    columns = [...columns, { name: 'catchUpLimit' }];
    await expect(
      ensureAutomationTaskCatchUpLimitColumn(db),
    ).resolves.toBeUndefined();
    expect(executeRawCalls).toHaveLength(1);
  });

  it('PG 主库引擎早退：不发任何 raw 调用（列由 2_ 增量迁移覆盖，每 boot migrate deploy）', async () => {
    await expect(
      ensureAutomationTaskCatchUpLimitColumn(db, 'postgres'),
    ).resolves.toBeUndefined();
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
