// contains 大小写双引擎统一（主库双引擎批 follow-up）：user 列表关键词
// 检索 where 经 containsFilter 引擎感知构造——PG 分支补 mode: 'insensitive'
// 对齐 SQLite LIKE 的 ASCII 大小写不敏感；SQLite 分支不带 mode（Prisma 对
// SQLite 上的 mode 直接 ValidationError）。此处 mock 级钉 where 形状（用户
// 可见检索面 8 处：username/name/email/phone 单字段 + keyword OR 四臂），
// 引擎分支语义由 test/core/db-url-engine.spec.ts 的 containsFilter 用例守护。
import { UserQueryDecoder } from 'src/modules/user/entity/user.querydecoder';
import { UserQueryFilter } from 'src/modules/user/entity/user.queryfilter';

describe('UserQueryDecoder condition（contains 双引擎形状）', () => {
  const OLD = process.env.TIANSHU_DB_URL;
  const decoder = UserQueryDecoder.getInstance();

  afterEach(() => {
    if (OLD === undefined) {
      delete process.env.TIANSHU_DB_URL;
    } else {
      process.env.TIANSHU_DB_URL = OLD;
    }
  });

  it('SQLite 引擎（默认 dev 态）：四个单字段 contains 均不带 mode（零行为变化）', () => {
    delete process.env.TIANSHU_DB_URL;
    const where = decoder.condition({
      username: 'admin',
      name: '张三',
      email: '@x.com',
      phone: '138',
    } as UserQueryFilter) as Record<string, unknown>;
    expect(where.username).toStrictEqual({ contains: 'admin' });
    expect(where.name).toStrictEqual({ contains: '张三' });
    expect(where.email).toStrictEqual({ contains: '@x.com' });
    expect(where.phone).toStrictEqual({ contains: '138' });
  });

  it('SQLite 引擎：keyword OR 四臂 contains 不带 mode', () => {
    delete process.env.TIANSHU_DB_URL;
    const where = decoder.condition({
      keyword: 'Li',
    } as UserQueryFilter) as { OR: Record<string, unknown>[] };
    expect(where.OR).toHaveLength(4);
    for (const arm of where.OR) {
      expect(Object.values(arm)[0]).toStrictEqual({ contains: 'Li' });
    }
  });

  it('PG 引擎：单字段与 keyword OR 四臂 contains 全部补 mode insensitive', () => {
    process.env.TIANSHU_DB_URL = 'postgres://u:p@h:5432/d';
    const where = decoder.condition({
      username: 'admin',
      name: '张三',
      email: '@x.com',
      phone: '138',
      keyword: 'Li',
    } as UserQueryFilter) as Record<string, unknown> & {
      OR: Record<string, unknown>[];
    };
    expect(where.username).toStrictEqual({
      contains: 'admin',
      mode: 'insensitive',
    });
    expect(where.name).toStrictEqual({
      contains: '张三',
      mode: 'insensitive',
    });
    expect(where.email).toStrictEqual({
      contains: '@x.com',
      mode: 'insensitive',
    });
    expect(where.phone).toStrictEqual({
      contains: '138',
      mode: 'insensitive',
    });
    expect(where.OR).toHaveLength(4);
    for (const arm of where.OR) {
      expect(Object.values(arm)[0]).toStrictEqual({
        contains: 'Li',
        mode: 'insensitive',
      });
    }
  });
});
