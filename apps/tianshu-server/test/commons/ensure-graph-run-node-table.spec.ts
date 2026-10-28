// C2（2026-10-28 终审）：存量部署升级库的 graphRunNode 建表路径——
// ensureGraphRunNodeTable 幂等 DDL。断言形态对齐 mirror tests/commons/
// ensure-graph-run-node.test.ts（真库在本机不可行的 Electron ABI 限制
// 不存在于 server 侧，但 mock $executeRawUnsafe 直证两跑 DDL 重放一致
// 即幂等语义由 IF NOT EXISTS 承担）；DDL 关键列与唯一约束须与 mirror
// 逐字同源（复合唯一键 (runId, nodeId) 是环图 upsert 聚合的前提）。
import { ensureGraphRunNodeTable } from 'src/commons/database/ensure-graph-run-node-table';

const executeRawCalls: string[] = [];
const db = {
  $executeRawUnsafe: jest.fn(async (sql: string) => {
    executeRawCalls.push(sql);
    return 0;
  }),
};

describe('ensureGraphRunNodeTable（存量库幂等补建）', () => {
  beforeEach(() => {
    executeRawCalls.length = 0;
    db.$executeRawUnsafe.mockClear();
  });

  it('两跑各发建表 + 建索引两条 IF NOT EXISTS DDL（幂等重放不抛）', async () => {
    await expect(ensureGraphRunNodeTable(db)).resolves.toBeUndefined();
    await expect(ensureGraphRunNodeTable(db)).resolves.toBeUndefined();

    const assertOneRunDdl = (sqls: string[]) => {
      const createTable = sqls.filter((s) =>
        s.includes('CREATE TABLE IF NOT EXISTS graphRunNode'),
      );
      expect(createTable).toHaveLength(1);
      // DDL 与 mirror electron/commons/prisma-client.ts 逐字同源（抽样
      // 关键列 + 复合唯一约束——环图重入 upsert 的 where 键）
      const ddl = createTable[0]!;
      for (const col of [
        'runId INTEGER NOT NULL',
        'nodeId TEXT NOT NULL',
        'status TEXT NOT NULL',
        'durationMs INTEGER NOT NULL',
        'startedAt TEXT NOT NULL',
        'errorJson TEXT',
        'fallbackJson TEXT',
        'CONSTRAINT graphRunNode_runId_nodeId_key UNIQUE (runId, nodeId)',
      ]) {
        expect(ddl).toContain(col);
      }
      expect(
        sqls.filter((s) =>
          s.includes(
            'CREATE INDEX IF NOT EXISTS graphRunNode_runId_idx ON graphRunNode (runId)',
          ),
        ),
      ).toHaveLength(1);
    };

    // 首跑两条 DDL
    assertOneRunDdl(executeRawCalls.slice(0, 2));
    // 次跑再发两条（幂等重放，无失败即不抛）
    assertOneRunDdl(executeRawCalls.slice(2));
    expect(executeRawCalls).toHaveLength(4);
  });
});
