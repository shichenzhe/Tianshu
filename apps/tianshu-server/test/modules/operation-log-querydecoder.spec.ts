// contains 大小写双引擎统一（主库双引擎批 follow-up）：操作日志关键词检索
// where（operation/ipAddress 两处 contains）经 containsFilter 引擎感知构造
// ——PG 分支补 mode: 'insensitive' 对齐 SQLite LIKE 的 ASCII 大小写不敏感；
// SQLite 分支不带 mode（Prisma 对 SQLite 上的 mode 直接 ValidationError）。
// mock 级钉 where 形状；引擎分支语义由 test/core/db-url-engine.spec.ts 的
// containsFilter 用例守护。
import { OperationLogQueryDecoder } from 'src/modules/operationlog/operation-log.querydecoder';
import { OperationLogQueryFilter } from 'src/modules/operationlog/dto/operation-log-query-filter.dto';

describe('OperationLogQueryDecoder condition（contains 双引擎形状）', () => {
  const OLD = process.env.TIANSHU_DB_URL;
  const decoder = OperationLogQueryDecoder.getInstance();

  afterEach(() => {
    if (OLD === undefined) {
      delete process.env.TIANSHU_DB_URL;
    } else {
      process.env.TIANSHU_DB_URL = OLD;
    }
  });

  it('SQLite 引擎（默认 dev 态）：operation/ipAddress contains 均不带 mode（零行为变化）', () => {
    delete process.env.TIANSHU_DB_URL;
    const where = decoder.condition({
      operation: 'login',
      ipAddress: '10.0',
    } as OperationLogQueryFilter) as Record<string, unknown>;
    expect(where.operation).toStrictEqual({ contains: 'login' });
    expect(where.ipAddress).toStrictEqual({ contains: '10.0' });
  });

  it('PG 引擎：operation/ipAddress contains 补 mode insensitive', () => {
    process.env.TIANSHU_DB_URL = 'postgres://u:p@h:5432/d';
    const where = decoder.condition({
      operation: 'login',
      ipAddress: '10.0',
    } as OperationLogQueryFilter) as Record<string, unknown>;
    expect(where.operation).toStrictEqual({
      contains: 'login',
      mode: 'insensitive',
    });
    expect(where.ipAddress).toStrictEqual({
      contains: '10.0',
      mode: 'insensitive',
    });
  });
});
