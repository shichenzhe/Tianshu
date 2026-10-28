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
