// 批5（provider-model §6 项 5）：model 表能力矩阵四列存量库幂等补列——
// ensureModelCapabilityColumns。SQLite 存量升级库快路径不跑 migrate
// deploy（db-url.ts ensureDatabase 就绪即跳过），capabilities/priceIn·
// Out/fallbackModelId 缺列时模型保存/读取即失败；启动探测补列承担存量库
// 路径（新库/PG 走 3_ 增量迁移 + 每 boot migrate deploy）。mock
// $queryRawUnsafe/$executeRawUnsafe 直证探测-补列两段语义
// （ensure-automation-run-snapshot.spec.ts 先例）。
import { ensureModelCapabilityColumns } from 'src/commons/database/ensure-model-capability-columns';

const executeRawCalls: string[] = [];
let columns: Array<{ name: string }>;
const db = {
  $executeRawUnsafe: jest.fn(async (sql: string) => {
    executeRawCalls.push(sql);
    return 0;
  }),
  $queryRawUnsafe: jest.fn(async () => columns),
};

describe('ensureModelCapabilityColumns（存量库幂等补列）', () => {
  beforeEach(() => {
    executeRawCalls.length = 0;
    db.$executeRawUnsafe.mockClear();
    db.$queryRawUnsafe.mockClear();
  });

  it('缺列：探测 pragma 后逐列 ALTER；全列在场：二次执行零 ALTER（幂等）', async () => {
    // 存量库形态：model 表无能力矩阵列
    columns = [
      { name: 'id' },
      { name: 'providerId' },
      { name: 'modelId' },
      { name: 'contextWindow' },
    ];
    await expect(ensureModelCapabilityColumns(db)).resolves.toBeUndefined();
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("pragma_table_info('model')"),
    );
    expect(executeRawCalls).toHaveLength(4);
    expect(executeRawCalls[0]).toContain(
      'ALTER TABLE "model" ADD COLUMN "capabilities" TEXT',
    );
    expect(executeRawCalls[1]).toContain(
      'ALTER TABLE "model" ADD COLUMN "priceInPerMTokens" REAL',
    );
    expect(executeRawCalls[2]).toContain(
      'ALTER TABLE "model" ADD COLUMN "priceOutPerMTokens" REAL',
    );
    expect(executeRawCalls[3]).toContain(
      'ALTER TABLE "model" ADD COLUMN "fallbackModelId" INTEGER',
    );

    // 补列后再跑：探测已见全列，零 ALTER
    columns = [
      ...columns,
      { name: 'capabilities' },
      { name: 'priceInPerMTokens' },
      { name: 'priceOutPerMTokens' },
      { name: 'fallbackModelId' },
    ];
    await expect(ensureModelCapabilityColumns(db)).resolves.toBeUndefined();
    expect(executeRawCalls).toHaveLength(4);
  });

  it('部分列在场：仅补缺席列（半升级态自愈）', async () => {
    columns = [
      { name: 'id' },
      { name: 'capabilities' },
    ];
    await expect(ensureModelCapabilityColumns(db)).resolves.toBeUndefined();
    expect(executeRawCalls).toHaveLength(3);
    expect(executeRawCalls.join('\n')).not.toContain('"capabilities"');
  });

  it('PG 主库引擎早退：不发任何 raw 调用（列由 3_ 增量迁移覆盖，每 boot migrate deploy）', async () => {
    await expect(
      ensureModelCapabilityColumns(db, 'postgres'),
    ).resolves.toBeUndefined();
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
