// keyword null 标题防御（终审备案项 A）：schema title 列 NOT NULL，但
// 外部写入/旧库残留可能带 null——query 的内存过滤不应抛 TypeError。
// stub PrismaService 绕过列约束直注 null 行（e2e 层造不出该数据，仓储
// 单元层钉住过滤语义即可）。
import { SessionRepository } from 'src/modules/session/session.repository';
import { PrismaService } from 'src/commons/database/prisma.service';

describe('SessionRepository.query keyword null 标题防御', () => {
  it('null 标题行：不抛 TypeError 且不命中 keyword（同页正常行照常命中）', async () => {
    const rows = [
      { id: 1, title: null },
      { id: 2, title: 'alpha test log' },
    ];
    // P1 未读角标批：enrich 恒定两条 messageRecord 聚合——stub 返空
    // （groupBy [] → 无末条/无未读），钉住 keyword 过滤语义不受 enrich 干扰
    const prisma = {
      sessionRecord: { findMany: async () => rows },
      messageRecord: {
        groupBy: async () => [],
        findMany: async () => [],
      },
    } as unknown as PrismaService;
    const repo = new SessionRepository(prisma);

    const result = await repo.query(
      { page: 1, pageSize: 10, keyword: 'test' },
      1,
    );

    expect(result.total).toBe(1);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].title).toBe('alpha test log');
  });
});

describe('SessionRepository.query page<=0 收敛', () => {
  it('page:0 不产生负 skip（Prisma 拒负值即 500），回传 page 归一为 1', async () => {
    // 客户端错参直发场景（mobile 组懒加载曾发 page:0）：graph.repository
    // 同款钳制——skip 恒非负，分页基准归一
    const findManyCalls: Array<{ skip?: number; take?: number }> = [];
    const prisma = {
      sessionRecord: {
        findMany: async (args?: { skip?: number; take?: number }) => {
          findManyCalls.push(args ?? {});
          return [{ id: 2, title: 'ok' }];
        },
        count: async () => 1,
      },
      messageRecord: {
        groupBy: async () => [],
        findMany: async () => [],
      },
    } as unknown as PrismaService;
    const repo = new SessionRepository(prisma);

    const result = await repo.query({ page: 0, pageSize: 10 }, 1);

    expect(findManyCalls[0]?.skip).toBe(0);
    expect(findManyCalls[0]?.take).toBe(10);
    expect(result.page).toBe(1);
    expect(result.records).toHaveLength(1);
  });
});
