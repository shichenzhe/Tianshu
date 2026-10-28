// 默认工作空间并发安全（spec §13 项 5）：getOrCreateDefaultWorkspace 的
// findFirst→create 空窗在并发下由 workspace (userId, name) 唯一索引兜底
// ——败者 create 抛 P2002 后重查取胜者行，收敛单空间；已有空间未绑定目录
// 时回填不覆盖显式配置。
import { SessionRepository } from 'src/modules/session/session.repository';
import { createTestDb, type TestDb } from '../support/test-db';

describe('默认工作空间并发安全（getOrCreateDefaultWorkspace）', () => {
  let db: TestDb;
  let repo: SessionRepository;

  beforeAll(async () => {
    db = await createTestDb();
    repo = new SessionRepository(db.prisma);
  }, 120_000);

  afterAll(async () => {
    await db.cleanup();
  });

  it('空库并发三路 getOrCreate：全部收敛同一行（单空间落库）', async () => {
    const directoryPath = '/tmp/tianshu-ws-race';
    const results = await Promise.all([
      repo.getOrCreateDefaultWorkspace(1, directoryPath),
      repo.getOrCreateDefaultWorkspace(1, directoryPath),
      repo.getOrCreateDefaultWorkspace(1, directoryPath),
    ]);

    // 并发 findFirst 空窗：无唯一索引时会产生多行/多 id——胜者唯一
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await db.prisma.workspace.count({ where: { userId: 1 } })).toBe(1);
    expect(results[0]).toMatchObject({
      name: 'default',
      directoryPath,
      userId: 1,
    });
  });

  it('已有空间：不重复建；未绑定目录回填、显式配置不覆盖', async () => {
    // userId=2 预置一个未绑定目录的空间（模拟手工建库）
    const pre = await db.prisma.workspace.create({
      data: { name: 'manual', userId: 2 },
    });
    const got = await repo.getOrCreateDefaultWorkspace(2, '/tmp/ws-fill');
    expect(got.id).toBe(pre.id);
    expect(got.directoryPath).toBe('/tmp/ws-fill');

    // 显式绑定过目录再调：保持原值
    const bound = await db.prisma.workspace.create({
      data: { name: 'bound', directoryPath: '/tmp/ws-explicit', userId: 3 },
    });
    const kept = await repo.getOrCreateDefaultWorkspace(3, '/tmp/ws-other');
    expect(kept.id).toBe(bound.id);
    expect(kept.directoryPath).toBe('/tmp/ws-explicit');
  });

  it('竞态后的后续调用：常规路径命中既有行（不再走 create）', async () => {
    const first = await repo.getOrCreateDefaultWorkspace(4, '/tmp/ws-4');
    const second = await repo.getOrCreateDefaultWorkspace(4, '/tmp/ws-4');
    expect(second.id).toBe(first.id);
    expect(await db.prisma.workspace.count({ where: { userId: 4 } })).toBe(1);
  });
});
