// 批1C：automationRun 快照列存量库幂等补列——ensureAutomationRunGraphSnapshotColumn。
// SQLite 存量升级库快路径不跑 migrate deploy（db-url.ts ensureDatabase 就绪
// 即跳过），graphJsonSnapshot 缺列时图运行 createRun 100% 失败；启动探测
// 补列承担存量库路径（新库/PG 走 1_ 增量迁移 + 每 boot migrate deploy）。
// mock $queryRawUnsafe/$executeRawUnsafe 直证探测-补列两段语义（先例
// ensure-graph-run-node-table.spec.ts）。
import { ensureAutomationRunGraphSnapshotColumn } from 'src/commons/database/ensure-automation-run-snapshot';

const executeRawCalls: string[] = [];
let columns: Array<{ name: string }>;
const db = {
  $executeRawUnsafe: jest.fn(async (sql: string) => {
    executeRawCalls.push(sql);
    return 0;
  }),
  $queryRawUnsafe: jest.fn(async () => columns),
};

describe('ensureAutomationRunGraphSnapshotColumn（存量库幂等补列）', () => {
  beforeEach(() => {
    executeRawCalls.length = 0;
    db.$executeRawUnsafe.mockClear();
    db.$queryRawUnsafe.mockClear();
  });

  it('缺列：探测 pragma 后发 ALTER 补列；已列：二次执行零 ALTER（幂等）', async () => {
    // 存量库形态：automationRun 无快照列
    columns = [
      { name: 'id' },
      { name: 'taskId' },
      { name: 'graphId' },
      { name: 'graphTrace' },
    ];
    await expect(
      ensureAutomationRunGraphSnapshotColumn(db),
    ).resolves.toBeUndefined();
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("pragma_table_info('automationRun')"),
    );
    expect(executeRawCalls).toHaveLength(1);
    expect(executeRawCalls[0]).toContain(
      'ALTER TABLE "automationRun" ADD COLUMN "graphJsonSnapshot" TEXT',
    );

    // 补列后再跑：探测已见列，零 ALTER
    columns = [...columns, { name: 'graphJsonSnapshot' }];
    await expect(
      ensureAutomationRunGraphSnapshotColumn(db),
    ).resolves.toBeUndefined();
    expect(executeRawCalls).toHaveLength(1);
  });

  it('PG 主库引擎早退：不发任何 raw 调用（列由 1_ 增量迁移覆盖，每 boot migrate deploy）', async () => {
    await expect(
      ensureAutomationRunGraphSnapshotColumn(db, 'postgres'),
    ).resolves.toBeUndefined();
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
