// apps/tianshu-server/test/core/graph-search-pg.spec.ts
/**
 * search-pg 纯函数层：FTS 查询串（OR 连接 + metachar 全串白名单过滤——
 * tokenize 白名单是包含性测试，混合语法字符词元仍可能混入）、向量字面量、
 * DDL/SQL 生成（collection 可选段与占位序号正确性）。
 */
import {
  PG_DDL,
  buildFtsQuery,
  buildFtsSql,
  buildVectorSql,
  buildVectorLiteral,
  buildUpsertInsertSql,
} from '../../src/core/graph/search-pg';

describe('buildFtsQuery', () => {
  it('词元 OR 连接（to_tsquery 形态）', () => {
    expect(buildFtsQuery(['容', '错', '设计'])).toBe('容 | 错 | 设计');
  });
  it('空词元产出空串（调用侧短路前置防御）', () => {
    expect(buildFtsQuery([])).toBe('');
  });
  it('含 tsquery 语法字符的混合词元被剔除（防御 simple config 语法错误）', () => {
    expect(buildFtsQuery(['容', 'a&b', '设计'])).toBe('容 | 设计');
    expect(buildFtsQuery(['x|y'])).toBe('');
  });
});

describe('buildVectorLiteral', () => {
  it('JSON 数组字面量（pgvector 输入形态）', () => {
    expect(buildVectorLiteral([0.1, -0.2, 0.3])).toBe('[0.1,-0.2,0.3]');
  });
});

describe('SQL 生成（占位序号随 collection 段偏移）', () => {
  it('FTS：无 collection 段 $1=匹配串 $2=userId $3=limit', () => {
    const { sql } = buildFtsSql(false);
    expect(sql).toContain("to_tsquery('simple', $1)");
    expect(sql).toContain('user_id = $2');
    expect(sql).toContain('LIMIT $3');
    expect(sql).not.toContain('collection = ');
  });
  it('FTS：有 collection 段占位顺延', () => {
    const { sql } = buildFtsSql(true);
    expect(sql).toContain('user_id = $2');
    expect(sql).toContain('collection = $3');
    expect(sql).toContain('LIMIT $4');
  });
  it('向量：无 collection 段 $1=向量 $2=model $3=userId $4=limit，余弦距离排序 + score 取 1-距离', () => {
    const { sql } = buildVectorSql(false);
    expect(sql).toContain('$1::vector');
    expect(sql).toContain('model = $2');
    expect(sql).toContain('user_id = $3');
    expect(sql).toContain('ORDER BY vector <=> $1::vector');
    expect(sql).toContain('1 - (vector <=> $1::vector) AS score');
    expect(sql).toContain('LIMIT $4');
    expect(sql).toContain('vector IS NOT NULL');
  });
  it('向量：有 collection 段占位顺延', () => {
    const { sql } = buildVectorSql(true);
    expect(sql).toContain('collection = $4');
    expect(sql).toContain('LIMIT $5');
  });
});

describe('PG_DDL 与 upsert 语句', () => {
  it('DDL 含扩展/表/GIN/复合索引且全部 IF NOT EXISTS 幂等', () => {
    expect(PG_DDL.join('\n')).toContain(
      'CREATE EXTENSION IF NOT EXISTS vector',
    );
    expect(PG_DDL.join('\n')).toContain(
      'CREATE TABLE IF NOT EXISTS vector_chunk',
    );
    expect(PG_DDL.join('\n')).toContain('USING gin(text_tsv)');
    expect(PG_DDL.join('\n')).toContain('(user_id, collection)');
    expect(PG_DDL.join('\n')).toContain('text_tsv tsvector NOT NULL');
    expect(PG_DDL.join('\n')).toContain('vector vector');
  });
  it('upsert INSERT：multi-VALUES 含 to_tsvector(simple) 与 ::vector 转换', () => {
    const sql = buildUpsertInsertSql(2);
    expect(sql).toContain("to_tsvector('simple', $6)"); // 每块 8 参：user/coll/source/seq/text/分词/向量/model
    expect(sql).toContain('$7::vector');
    expect(sql).toMatch(/VALUES \(.+\), \(.+\)/); // 两行 VALUES
    expect(sql).toContain('INSERT INTO vector_chunk');
  });
});

// ---- 追加：运行时层（mock pg 模块）----
import { VectorStoreError } from '../../src/core/graph/vector-store';

jest.mock('pg', () => {
  const query = jest.fn();
  const release = jest.fn();
  const connect = jest.fn(async () => ({ query, release }));
  return {
    Pool: jest.fn(() => ({ query, connect, end: jest.fn() })),
    __query: query,
    __connect: connect,
    __release: release,
  };
});

describe('searchDbTarget（env 读取与协议校验）', () => {
  const OLD = process.env.SEARCH_DB_URL;
  afterEach(() => {
    process.env.SEARCH_DB_URL = OLD;
  });

  it('未设/空串返回 null；postgres/postgresql 串透传', async () => {
    const { searchDbTarget } = await import('../../src/core/graph/search-pg');
    delete process.env.SEARCH_DB_URL;
    expect(searchDbTarget()).toBeNull();
    process.env.SEARCH_DB_URL = 'postgres://u:p@h:5432/d';
    expect(searchDbTarget()).toBe('postgres://u:p@h:5432/d');
    process.env.SEARCH_DB_URL = 'postgresql://u:p@h:5432/d';
    expect(searchDbTarget()).toBe('postgresql://u:p@h:5432/d');
  });
  it('非 postgres scheme 抛 search_pg_unsupported_url', async () => {
    const { searchDbTarget } = await import('../../src/core/graph/search-pg');
    process.env.SEARCH_DB_URL = 'mysql://u:p@h/d';
    expect(() => searchDbTarget()).toThrow(VectorStoreError);
    expect(() => searchDbTarget()).toThrow(/postgres/);
  });
});

describe('PG 运行时（mock pg.Pool.query）', () => {
  it('ensureSearchPg 顺序执行 DDL；扩展失败转 search_pg_no_vector_ext', async () => {
    const { ensureSearchPg, PG_DDL } =
      await import('../../src/core/graph/search-pg');
    const { __query } = require('pg') as { __query: jest.Mock };
    __query.mockReset().mockResolvedValue({ rows: [] });
    process.env.SEARCH_DB_URL = 'postgres://u:p@h:5432/d';
    await ensureSearchPg();
    expect(__query).toHaveBeenCalledTimes(PG_DDL.length);
    __query
      .mockReset()
      .mockRejectedValue(new Error('extension "vector" is not available'));
    await expect(ensureSearchPg()).rejects.toThrow(/pgvector/i);
  });

  it('searchFtsPg：空词元短路不发查询；命中行 map FusedHit（rank 从 1）', async () => {
    const { searchFtsPg } = await import('../../src/core/graph/search-pg');
    const { __query } = require('pg') as { __query: jest.Mock };
    __query.mockReset();
    expect(
      await searchFtsPg({
        userId: 1,
        collection: 'c',
        queryTokens: [],
        limit: 5,
      }),
    ).toEqual([]);
    expect(__query).not.toHaveBeenCalled();
    __query.mockResolvedValue({
      rows: [
        { id: 9, collection: 'c', source_name: 's', text: '原文', score: 0.8 },
      ],
    });
    const hits = await searchFtsPg({
      userId: 1,
      collection: 'c',
      queryTokens: ['容'],
      limit: 5,
    });
    expect(hits[0]).toMatchObject({
      chunkId: 9,
      sourceName: 's',
      text: '原文',
      rank: 1,
    });
    expect(__query).toHaveBeenCalledWith(
      expect.stringContaining('to_tsquery'),
      expect.arrayContaining(['容', 1, 'c', 5]),
    );
  });

  it('searchFtsPg：词元全被 metachar 过滤后短路不发查询（to_tsquery 空串非法）', async () => {
    const { searchFtsPg } = await import('../../src/core/graph/search-pg');
    const { __query } = require('pg') as { __query: jest.Mock };
    __query.mockReset();
    expect(
      await searchFtsPg({
        userId: 1,
        collection: 'c',
        queryTokens: ['x|y', 'a&b'],
        limit: 5,
      }),
    ).toEqual([]);
    expect(__query).not.toHaveBeenCalled();
  });

  it('upsertChunksPg：建库前置→先删后插、分词进 to_tsvector 参数、事务包裹', async () => {
    const { upsertChunksPg, PG_DDL } =
      await import('../../src/core/graph/search-pg');
    const pg = require('pg') as {
      __query: jest.Mock;
      __connect: jest.Mock;
      __release: jest.Mock;
    };
    // pool 与 client 共用同一 query 桩：DDL 与事务语句进同一调用日志，
    // 跨 pool/client 边界的执行顺序可断言（release 同理共用）
    pg.__query.mockReset();
    pg.__connect
      .mockReset()
      .mockResolvedValue({ query: pg.__query, release: pg.__release });
    await upsertChunksPg({
      userId: 1,
      collection: 'c',
      sourceName: 's',
      model: 'm',
      chunks: [{ seq: 0, text: '分布式系统的容错设计', vector: [0.1, 0.2] }],
    });
    const calls = pg.__query.mock.calls.map((c) => c[0]);
    // 前置幂等建库占前 PG_DDL.length 位，事务语句序号顺延
    const D = PG_DDL.length;
    expect(calls[D]).toContain('BEGIN');
    expect(calls[D + 1]).toContain('DELETE FROM vector_chunk');
    expect(calls[D + 2]).toContain('to_tsvector');
    // 分词参数：空格连接词元串（ICU 实际切分以 tokenize 运行时输出为准——
    // 「容」「错」「设计」等词元必然在列，精确整串不做脆弱断言）
    const tokensParam = String(pg.__query.mock.calls[D + 2][1][5]);
    expect(tokensParam).toContain('容');
    expect(tokensParam).toContain('设计');
    expect(tokensParam).toContain(' ');
    expect(calls.at(-1)).toContain('COMMIT');
    expect(pg.__release).toHaveBeenCalled();
  });

  it('upsertChunksPg：fresh-PG 首跑前置幂等建库——DDL 全部先于事务 BEGIN', async () => {
    const { upsertChunksPg, PG_DDL } =
      await import('../../src/core/graph/search-pg');
    const pg = require('pg') as {
      __query: jest.Mock;
      __connect: jest.Mock;
      __release: jest.Mock;
    };
    pg.__query.mockReset();
    pg.__connect
      .mockReset()
      .mockResolvedValue({ query: pg.__query, release: pg.__release });
    // 空块路径：建库 + BEGIN/DELETE/COMMIT（无 INSERT），序号最干净
    await upsertChunksPg({
      userId: 1,
      collection: 'c',
      sourceName: 's',
      model: 'm',
      chunks: [],
    });
    const calls = pg.__query.mock.calls.map((c) => c[0]);
    expect(calls.slice(0, PG_DDL.length)).toEqual(PG_DDL); // 建库语句逐条先行
    expect(calls[PG_DDL.length]).toContain('BEGIN'); // DDL 全部先于事务开启
    expect(calls).toHaveLength(PG_DDL.length + 3);
    expect(calls.at(-1)).toContain('COMMIT');
  });

  it('upsertChunksPg：事务失败 ROLLBACK 后 release(err) 废弃坏连接', async () => {
    const { upsertChunksPg } = await import('../../src/core/graph/search-pg');
    const pg = require('pg') as {
      __query: jest.Mock;
      __connect: jest.Mock;
      __release: jest.Mock;
    };
    // INSERT 失败触发事务 catch；DDL/BEGIN/DELETE/ROLLBACK 走成功桩
    pg.__query.mockReset().mockImplementation(async (sql: string) => {
      if (String(sql).includes('INSERT')) {
        throw new Error('duplicate key value violates unique constraint');
      }
      return { rows: [] };
    });
    pg.__release.mockReset();
    pg.__connect
      .mockReset()
      .mockResolvedValue({ query: pg.__query, release: pg.__release });
    await expect(
      upsertChunksPg({
        userId: 1,
        collection: 'c',
        sourceName: 's',
        model: 'm',
        chunks: [{ seq: 0, text: 'x', vector: [0.1] }],
      }),
    ).rejects.toThrow(/PG 检索库/);
    const calls = pg.__query.mock.calls.map((c) => String(c[0]));
    expect(calls.some((sql) => sql.includes('ROLLBACK'))).toBe(true);
    // pg 语义：release 收到 err 时池销毁该连接（不回池复用）——事务失败
    // 的连接可能处于 aborted 未知态，必须废弃
    expect(pg.__release).toHaveBeenCalledTimes(1);
    expect(pg.__release.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('upsertChunksPg：成功路径 release 不带 err（连接回池复用）', async () => {
    const { upsertChunksPg } = await import('../../src/core/graph/search-pg');
    const pg = require('pg') as {
      __query: jest.Mock;
      __connect: jest.Mock;
      __release: jest.Mock;
    };
    pg.__query.mockReset().mockResolvedValue({ rows: [] });
    pg.__release.mockReset();
    pg.__connect
      .mockReset()
      .mockResolvedValue({ query: pg.__query, release: pg.__release });
    await upsertChunksPg({
      userId: 1,
      collection: 'c',
      sourceName: 's',
      model: 'm',
      chunks: [{ seq: 0, text: 'x', vector: [0.1] }],
    });
    expect(pg.__release).toHaveBeenCalledTimes(1);
    expect(pg.__release.mock.calls[0][0]).toBeUndefined();
  });

  it('upsertChunksPg：connect 失败转 search_pg_unavailable 人话错误', async () => {
    const { upsertChunksPg } = await import('../../src/core/graph/search-pg');
    const { __connect } = require('pg') as { __connect: jest.Mock };
    __connect.mockReset().mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      }),
    );
    const params = {
      userId: 1,
      collection: 'c',
      sourceName: 's',
      model: 'm',
      chunks: [{ seq: 0, text: 'x', vector: [0.1] }],
    };
    await expect(upsertChunksPg(params)).rejects.toThrow(VectorStoreError);
    await expect(upsertChunksPg(params)).rejects.toThrow(/PG 检索库/);
  });

  it('连接失败转 search_pg_unavailable 人话错误', async () => {
    const { searchFtsPg } = await import('../../src/core/graph/search-pg');
    const { __query } = require('pg') as { __query: jest.Mock };
    __query.mockReset().mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      }),
    );
    await expect(
      searchFtsPg({ userId: 1, collection: '', queryTokens: ['x'], limit: 5 }),
    ).rejects.toThrow(/PG 检索库/);
  });
});

// ---- 追加：vector-store 路由分派 ----
describe('vector-store 检索路由', () => {
  const OLD = process.env.SEARCH_DB_URL;
  afterEach(() => {
    process.env.SEARCH_DB_URL = OLD;
  });

  it('SEARCH_DB_URL 空：searchFts 走本地（不触 pg Pool）', async () => {
    delete process.env.SEARCH_DB_URL;
    const { __query } = require('pg') as { __query: jest.Mock };
    __query.mockClear();
    // 本地路径依赖 graphExecutorRuntime——本用例仅断言未走 PG 分支：
    // 触发本地实现需 mock runtime，超出本任务面；用「未配置时 import 不炸 +
    // isPgSearchConfigured()===false」钉住分派前提
    const { isPgSearchConfigured } =
      await import('../../src/core/graph/search-pg');
    expect(isPgSearchConfigured()).toBe(false);
    expect(__query).not.toHaveBeenCalled();
  });

  it('SEARCH_DB_URL 非空：searchFts 分派到 PG 实现', async () => {
    process.env.SEARCH_DB_URL = 'postgres://u:p@h:5432/d';
    jest.resetModules();
    const { __query } = require('pg') as { __query: jest.Mock };
    __query.mockReset().mockResolvedValue({
      rows: [
        { id: 1, collection: 'c', source_name: 's', text: '原文', score: 0.5 },
      ],
    });
    const { searchFts } = await import('../../src/core/graph/vector-store');
    const hits = await searchFts({
      userId: 1,
      collection: 'c',
      queryTokens: ['容'],
      limit: 3,
    });
    expect(hits[0]).toMatchObject({ chunkId: 1, rank: 1 });
    expect(__query).toHaveBeenCalled();
  });

  it('SEARCH_DB_URL 非空：upsertChunks 分派到 PG 实现（本地 prisma 路径不触）', async () => {
    process.env.SEARCH_DB_URL = 'postgres://u:p@h:5432/d';
    jest.resetModules();
    const pg = require('pg') as {
      __query: jest.Mock;
      __connect: jest.Mock;
      __release: jest.Mock;
    };
    pg.__query.mockReset().mockResolvedValue({ rows: [] });
    pg.__release.mockReset();
    pg.__connect
      .mockReset()
      .mockResolvedValue({ query: pg.__query, release: pg.__release });
    const { upsertChunks } = await import('../../src/core/graph/vector-store');
    // 本地路径依赖 graphExecutorRuntime().db——未初始化即抛；本用例不
    // mock runtime，跑通即证明未走本地分支
    await upsertChunks({
      userId: 1,
      collection: 'c',
      sourceName: 's',
      model: 'm',
      chunks: [{ seq: 0, text: 'x', vector: [0.1] }],
    });
    const calls = pg.__query.mock.calls.map((c) => String(c[0]));
    expect(calls.some((sql) => sql.includes('INSERT INTO vector_chunk'))).toBe(
      true,
    );
    expect(pg.__release).toHaveBeenCalledTimes(1);
  });

  it('SEARCH_DB_URL 非空：searchChunks 分派到 PG 实现（余弦距离查询）', async () => {
    process.env.SEARCH_DB_URL = 'postgres://u:p@h:5432/d';
    jest.resetModules();
    const { __query } = require('pg') as { __query: jest.Mock };
    __query.mockReset().mockResolvedValue({
      rows: [
        { id: 5, collection: 'c', source_name: 's', text: '原文', score: 0.9 },
      ],
    });
    const { searchChunks } = await import(
      '../../src/core/graph/vector-store'
    );
    const hits = await searchChunks({
      userId: 1,
      collection: 'c',
      model: 'm',
      queryVector: [0.1],
      topK: 3,
    });
    expect(hits[0]).toMatchObject({ chunkId: 5, sourceName: 's', score: 0.9 });
    expect(__query).toHaveBeenCalledWith(
      expect.stringContaining('<=>'),
      expect.arrayContaining(['[0.1]', 'm', 1, 'c', 3]),
    );
  });

  it('SEARCH_DB_URL 非空：countCollection 分派到 PG 实现（COUNT 查询）', async () => {
    process.env.SEARCH_DB_URL = 'postgres://u:p@h:5432/d';
    jest.resetModules();
    const { __query } = require('pg') as { __query: jest.Mock };
    __query.mockReset().mockResolvedValue({ rows: [{ n: 7 }] });
    const { countCollection } = await import(
      '../../src/core/graph/vector-store'
    );
    await expect(countCollection(1, 'c')).resolves.toBe(7);
    expect(__query).toHaveBeenCalledWith(
      expect.stringContaining('COUNT(*)'),
      [1, 'c'],
    );
  });
});
