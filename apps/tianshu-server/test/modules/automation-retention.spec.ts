// test/modules/automation-retention.spec.ts
// parseRunRetention 纯函数全边界 + trimAutomationRuns SQL 行为验证。
//
// 真库直连沿用 automation-scheduler.spec.ts 先例（support/test-db：临时
// schema 副本经 prisma db push 建表 + PrismaService datasources 运行时
// 覆盖指向临时库）——server 的 jest 跑在系统 Node 上，Prisma 自带查询
// 引擎无 better-sqlite3 ABI 问题（mirror 侧因此改用 node:sqlite 替身），
// 故此处真 prisma 直连即被测 SQL 的更强验证：窗口函数、taskId NULL
// 分组、参数绑定全走真引擎。用例与 mirror tests/ai/automation-retention.
// test.ts 一一对应（describe/it 名不变，造数断言同款翻译）；库为单份
// 临时库，beforeEach 清空 automationRun 达成 mirror「每用例独立内存库」
// 的零污染语义。6h 节流用例不触库，最小假 option 面计数即可。
import {
  DEFAULT_RUN_RETENTION,
  parseRunRetention,
  trimAutomationRuns,
  TRIM_INTERVAL_MS,
  maybeTrimAutomationRuns,
} from 'src/modules/automation/automation-retention';
import { createTestDb, type TestDb } from '../support/test-db';

jest.setTimeout(120_000);

describe('parseRunRetention', () => {
  it('null/undefined/空串 → 全默认', () => {
    expect(parseRunRetention(null)).toEqual(DEFAULT_RUN_RETENTION);
    expect(parseRunRetention(undefined)).toEqual(DEFAULT_RUN_RETENTION);
    expect(parseRunRetention('')).toEqual(DEFAULT_RUN_RETENTION);
  });

  it('非法 JSON → 全默认', () => {
    expect(parseRunRetention('{oops')).toEqual(DEFAULT_RUN_RETENTION);
    expect(parseRunRetention('42')).toEqual(DEFAULT_RUN_RETENTION);
  });

  it('部分字段缺省 → 缺的字段用默认值补齐', () => {
    const parsed = parseRunRetention(JSON.stringify({ successDays: 14 }));
    expect(parsed).toEqual({ ...DEFAULT_RUN_RETENTION, successDays: 14 });
  });

  it('越界 clamp：天数 <1 → 1，>3650 → 3650；条数 <1 → 1，>10000 → 10000', () => {
    const parsed = parseRunRetention(
      JSON.stringify({
        traceDays: 0,
        successDays: -5,
        failureDays: 99999,
        successKeep: 0,
        failureKeep: 99999,
      }),
    );
    expect(parsed).toEqual({
      enabled: true,
      traceDays: 1,
      successDays: 1,
      failureDays: 3650,
      successKeep: 1,
      failureKeep: 10000,
    });
  });

  it('enabled:false 显式保留', () => {
    expect(parseRunRetention(JSON.stringify({ enabled: false })).enabled).toBe(
      false,
    );
  });
});

// —— trimAutomationRuns SQL 行为验证（真 prisma + 临时库，见文件头注释）——

const NOW = new Date(2026, 10, 22, 12, 0, 0);
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe('trimAutomationRuns（真库）', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  }, 120_000);

  afterAll(async () => {
    await db.cleanup();
  });

  beforeEach(async () => {
    // mirror 每用例独立内存库；真库单份，行级清空达成同款零污染
    await db.prisma.graphRunNode.deleteMany({});
    await db.prisma.automationRun.deleteMany({});
  });

  /** run 行工厂（automationRun 表形状；triggerType 固定 test，其余按用例覆写） */
  const seedRun = (over: {
    taskId?: number | null;
    status: string;
    startedAt: Date;
    graphTrace?: string | null;
  }) =>
    db.prisma.automationRun.create({
      data: {
        taskId: over.taskId ?? null,
        triggerType: 'test',
        status: over.status,
        startedAt: over.startedAt,
        graphTrace: over.graphTrace ?? null,
      },
    });

  /** 节点详情行工厂（去会话化 2026-10-28：run 删除级联验证面） */
  const seedNode = (runId: number, nodeId = 'n1') =>
    db.prisma.graphRunNode.create({
      data: {
        runId,
        nodeId,
        status: 'success',
        input: 'x',
        output: 'y',
        durationMs: 1,
        startedAt: new Date().toISOString(),
      },
    });

  const getRow = (id: number) =>
    db.prisma.automationRun.findUnique({ where: { id } });

  const countRuns = (where?: { taskId?: number | null }): Promise<number> => {
    if (where && 'taskId' in where) {
      return db.prisma.automationRun.count({ where: { taskId: where.taskId } });
    }
    return db.prisma.automationRun.count();
  };

  it('graphTrace 降级：3 天前置空但行保留', async () => {
    // 4 天前：超 traceDays(3) 置空轨迹，但在 successDays(7) 窗口内保行
    const row = await seedRun({
      status: 'success',
      startedAt: daysAgo(4),
      graphTrace: JSON.stringify({ nodes: [] }),
    });
    const result = await trimAutomationRuns(
      db.prisma,
      DEFAULT_RUN_RETENTION,
      NOW,
    );
    expect(result.tracedRuns).toBeGreaterThanOrEqual(1);
    const kept = await getRow(row.id);
    expect(kept).not.toBeNull();
    expect(kept?.graphTrace).toBeNull();
  });

  it('成功态超 7 天删行（节点行级联）、失败态 30 天内保留、running 永不裁剪', async () => {
    const oldSuccess = await seedRun({
      status: 'success',
      startedAt: daysAgo(10),
    });
    const recentSuccess = await seedRun({
      status: 'success',
      startedAt: daysAgo(1),
    });
    const failed = await seedRun({
      status: 'failed',
      startedAt: daysAgo(10),
    });
    const running = await seedRun({
      status: 'running',
      startedAt: daysAgo(40),
    });
    // 去会话化 2026-10-28（spec §3.1）：run 删除前级联删其节点行——被删
    // run 的节点行连带清、保留 run 的节点行不动
    const oldSuccessNode = await seedNode(oldSuccess.id);
    const failedNode = await seedNode(failed.id);
    await trimAutomationRuns(db.prisma, DEFAULT_RUN_RETENTION, NOW);
    expect(await getRow(oldSuccess.id)).toBeNull();
    expect(await getRow(recentSuccess.id)).not.toBeNull();
    expect(await getRow(failed.id)).not.toBeNull();
    expect(await getRow(running.id)).not.toBeNull();
    expect(
      await db.prisma.graphRunNode.findUnique({
        where: { id: oldSuccessNode.id },
      }),
    ).toBeNull();
    expect(
      await db.prisma.graphRunNode.findUnique({
        where: { id: failedNode.id },
      }),
    ).not.toBeNull();
  });

  it('失败态超 30 天删行', async () => {
    const oldFailed = await seedRun({
      status: 'failed',
      startedAt: daysAgo(40),
    });
    await trimAutomationRuns(db.prisma, DEFAULT_RUN_RETENTION, NOW);
    expect(await getRow(oldFailed.id)).toBeNull();
  });

  it('成功态条数窗：同任务 250 条只留最新 200；taskId NULL（图试运行）自成一组；节点行同窗级联', async () => {
    for (let i = 0; i < 250; i++) {
      const run = await seedRun({
        taskId: 9901,
        status: 'success',
        startedAt: daysAgo(0.01),
      });
      await seedNode(run.id);
    }
    for (let i = 0; i < 250; i++) {
      await seedRun({
        taskId: null,
        status: 'success',
        startedAt: daysAgo(0.01),
      });
    }
    const result = await trimAutomationRuns(
      db.prisma,
      DEFAULT_RUN_RETENTION,
      NOW,
    );
    expect(result.successKeepDeleted).toBe(100);
    expect(await countRuns({ taskId: 9901 })).toBe(200);
    expect(await countRuns({ taskId: null })).toBe(200);
    // 去会话化 2026-10-28（spec §3.1）：同窗子查询先行删节点行——存留
    // 节点行恰为存留 run 的 200 行，窗外的 50 行连带清（无孤儿）
    const keptRuns = await db.prisma.automationRun.findMany({
      where: { taskId: 9901 },
      select: { id: true },
    });
    expect(await db.prisma.graphRunNode.count()).toBe(200);
    expect(
      await db.prisma.graphRunNode.count({
        where: { runId: { in: keptRuns.map((r) => r.id) } },
      }),
    ).toBe(200);
  });

  it('enabled:false 零动作', async () => {
    await seedRun({ status: 'success', startedAt: daysAgo(40) });
    const result = await trimAutomationRuns(
      db.prisma,
      { ...DEFAULT_RUN_RETENTION, enabled: false },
      NOW,
    );
    expect(result).toEqual({
      tracedRuns: 0,
      successDaysDeleted: 0,
      failureDaysDeleted: 0,
      successKeepDeleted: 0,
      failureKeepDeleted: 0,
    });
    expect(await countRuns()).toBe(1);
  });
});

describe('maybeTrimAutomationRuns 节流', () => {
  it('6h 内第二次调用不再触达 DB', async () => {
    let touches = 0;
    const countingDb = {
      option: {
        // 返回 { value } 行形状（生产读 option?.value）；enabled:false 使 trim 零动作
        findFirst: () => {
          touches++;
          return Promise.resolve({ value: JSON.stringify({ enabled: false }) });
        },
      },
    } as unknown as Parameters<typeof maybeTrimAutomationRuns>[0];
    const t0 = 1_000_000_000_000;
    await maybeTrimAutomationRuns(countingDb, t0);
    await maybeTrimAutomationRuns(countingDb, t0 + 1000);
    expect(touches).toBe(1); // 第二次被节流挡下
    // 恰值 TRIM_INTERVAL_MS：守卫为 <，恰满不挡（钉住 < 边界）——触达并刷新节流基点
    await maybeTrimAutomationRuns(countingDb, t0 + TRIM_INTERVAL_MS);
    expect(touches).toBe(2);
    // 恰值已刷新基点，+1 落回新窗口内 → 仍被挡
    await maybeTrimAutomationRuns(countingDb, t0 + TRIM_INTERVAL_MS + 1);
    expect(touches).toBe(2);
  });
});

// —— trimKeep SQL 双引擎方言（主库双引擎批终审追加）——
// trimKeepSql/trimKeepNodesSql 按引擎分流：PG 引号 camelCase 标识符 +
// $1 占位符；SQLite 与既有串逐字节一致（零行为变化）。真 PG 执行归
// e2e live 段，单测钉 SQL 形状——maybeTrim 吞错下方言错即裁剪静默永败。
describe('trimKeep SQL 双引擎方言', () => {
  const OLD_MAIN = process.env.TIANSHU_DB_URL;
  // 原值未设时须 delete 复原（env.X = undefined 落字符串 "undefined"，
  // jest worker 内跨 spec 文件共享 process.env——engine.spec 同款纪律）
  afterEach(() => {
    if (OLD_MAIN === undefined) {
      delete process.env.TIANSHU_DB_URL;
    } else {
      process.env.TIANSHU_DB_URL = OLD_MAIN;
    }
  });

  /** 最小 RetentionDb 桩：捕获 $executeRawUnsafe 的 SQL（方言断言面）；
   * 其余面零结果（前置步骤不触真实库） */
  const captureDb = (sqls: string[]) =>
    ({
      automationRun: {
        updateMany: () => Promise.resolve({ count: 0 }),
        findMany: () => Promise.resolve([]),
        deleteMany: () => Promise.resolve({ count: 0 }),
      },
      graphRunNode: {
        deleteMany: () => Promise.resolve({ count: 0 }),
      },
      option: {
        findFirst: () => Promise.resolve(null),
      },
      $executeRawUnsafe: (sql: string) => {
        sqls.push(sql);
        return Promise.resolve(0);
      },
    }) as unknown as Parameters<typeof trimAutomationRuns>[0];

  it('PG 引擎：标识符引号 camelCase + $1 占位符（且无裸 ?）', async () => {
    process.env.TIANSHU_DB_URL = 'postgres://u:p@h:5432/main';
    const sqls: string[] = [];
    await trimAutomationRuns(captureDb(sqls), DEFAULT_RUN_RETENTION, NOW);
    // 4 发：成功档 nodes/run + 失败档 nodes/run
    expect(sqls).toHaveLength(4);
    for (const sql of sqls) {
      expect(sql).not.toContain('?');
      expect(sql).toContain('WHERE rn > $1');
    }
    // nodes 语句（第 1/3 发）：级联面 graphRunNode."runId" + 同窗 automationRun
    for (const nodesSql of [sqls[0], sqls[2]]) {
      expect(nodesSql).toContain('DELETE FROM "graphRunNode" WHERE "runId" IN');
      expect(nodesSql).toContain('PARTITION BY "taskId"');
      expect(nodesSql).toContain('FROM "automationRun" WHERE');
    }
    // run 语句（第 2/4 发）：automationRun 直删 + taskId 分区引号
    for (const runSql of [sqls[1], sqls[3]]) {
      expect(runSql).toContain('DELETE FROM "automationRun" WHERE id IN');
      expect(runSql).toContain('PARTITION BY "taskId"');
    }
  });

  it('SQLite 引擎：与既有 SQL 逐字节一致（零行为变化）', async () => {
    delete process.env.TIANSHU_DB_URL;
    const sqls: string[] = [];
    await trimAutomationRuns(captureDb(sqls), DEFAULT_RUN_RETENTION, NOW);
    expect(sqls).toHaveLength(4);
    const sqliteNodes = (statusWhere: string) => `
  DELETE FROM graphRunNode WHERE runId IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY taskId ORDER BY id DESC) AS rn
      FROM automationRun WHERE ${statusWhere}
    ) WHERE rn > ?
  )
`;
    const sqliteRuns = (statusWhere: string) => `
  DELETE FROM automationRun WHERE id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY taskId ORDER BY id DESC) AS rn
      FROM automationRun WHERE ${statusWhere}
    ) WHERE rn > ?
  )
`;
    expect(sqls[0]).toBe(sqliteNodes("status NOT IN ('failed', 'running')"));
    expect(sqls[1]).toBe(sqliteRuns("status NOT IN ('failed', 'running')"));
    expect(sqls[2]).toBe(sqliteNodes("status = 'failed'"));
    expect(sqls[3]).toBe(sqliteRuns("status = 'failed'"));
  });
});
