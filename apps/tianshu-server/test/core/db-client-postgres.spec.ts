// apps/tianshu-server/test/core/db-client-postgres.spec.ts
/**
 * db-client postgres 引擎单语句路径回归：mock 'pg' Client 形态
 * （db-client 用 new Client + connect/query/end），钉连接配置透传
 * （pgConfig）、(sql, params) 原样透传、SELECT/写操作 rows-rowCount
 * 两路、错误包装码（connect 类 db_connect_failed vs query 类
 * db_query_failed）。ctx 仅 SQLite 引擎消费（openSqlite 越界检查），
 * postgres 路径最小桩即可。
 */
import type { NodeContext } from '../../src/core/graph/graph-executor';
import {
  DbError,
  runDatabaseQuery,
  type DbQueryParams,
} from '../../src/core/graph/db-client';

jest.mock('pg', () => {
  const query = jest.fn();
  const connect = jest.fn();
  const end = jest.fn(async () => {});
  const Client = jest.fn(() => ({ connect, query, end }));
  return { Client, __query: query, __connect: connect, __end: end };
});

interface PgMock {
  Client: jest.Mock;
  __query: jest.Mock;
  __connect: jest.Mock;
  __end: jest.Mock;
}

/** 最小 ctx 桩：postgres 引擎不触 workspacePath（SQLite 越界检查专属） */
const ctxStub = {
  runId: null,
  abort: new AbortController().signal,
} as unknown as NodeContext;

function pgParams(overrides: Partial<DbQueryParams> = {}): DbQueryParams {
  return {
    engine: 'postgres',
    sqlitePath: '',
    host: 'db.example.com',
    port: 5432,
    database: 'app',
    username: 'u',
    password: 'p',
    sql: 'SELECT id FROM t WHERE id = $1',
    params: ['7'],
    maxRows: 100,
    batchRows: null,
    ctx: ctxStub,
    ...overrides,
  };
}

describe('runDatabaseQuery postgres 引擎', () => {
  let pg: PgMock;
  beforeEach(() => {
    pg = require('pg') as PgMock;
    pg.__connect.mockReset().mockResolvedValue(undefined);
    pg.__query
      .mockReset()
      .mockResolvedValue({ command: 'SELECT', rows: [], rowCount: 0 });
    pg.__end.mockReset().mockResolvedValue(undefined);
    pg.Client.mockClear();
  });

  it('new Client 收齐 pgConfig：host/port/database/user/password + 双超时', async () => {
    await runDatabaseQuery(pgParams());
    expect(pg.Client).toHaveBeenCalledWith({
      host: 'db.example.com',
      port: 5432,
      database: 'app',
      user: 'u',
      password: 'p',
      connectionTimeoutMillis: 15000,
      query_timeout: 120000,
    });
  });

  it('(sql, params) 原样透传；SELECT 回 rows（空行集仍走 rows 路）；end 关连接', async () => {
    pg.__query
      .mockReset()
      .mockResolvedValue({ command: 'SELECT', rows: [{ id: 7 }], rowCount: 1 });
    const result = await runDatabaseQuery(pgParams());
    expect(pg.__query).toHaveBeenCalledTimes(1);
    expect(pg.__query).toHaveBeenCalledWith('SELECT id FROM t WHERE id = $1', [
      '7',
    ]);
    expect(result).toEqual({ rows: [{ id: 7 }] });
    expect(pg.__end).toHaveBeenCalledTimes(1);
    // command=SELECT 且零命中：仍按 rows 路返回空行集（不误判写操作）
    pg.__query
      .mockReset()
      .mockResolvedValue({ command: 'SELECT', rows: [], rowCount: 0 });
    expect(await runDatabaseQuery(pgParams())).toEqual({ rows: [] });
  });

  it('写操作（非 SELECT 且空行集）回 rowCount', async () => {
    pg.__query
      .mockReset()
      .mockResolvedValue({ command: 'UPDATE', rows: [], rowCount: 3 });
    const result = await runDatabaseQuery(
      pgParams({ sql: 'UPDATE t SET x = $1', params: ['y'] }),
    );
    expect(result).toEqual({ rowCount: 3 });
  });

  it('connect 失败包装 db_connect_failed（不触 query）', async () => {
    pg.__connect
      .mockReset()
      .mockRejectedValue(
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
          code: 'ECONNREFUSED',
        }),
      );
    // connect 在 try 外——失败不进 finally，query 不被触
    await expect(runDatabaseQuery(pgParams())).rejects.toMatchObject({
      name: 'DbError',
      code: 'db_connect_failed',
      message: /ECONNREFUSED/,
    });
    expect(pg.__query).not.toHaveBeenCalled();
  });

  it('query 失败包装 db_query_failed；finally 仍 end 关连接', async () => {
    pg.__query
      .mockReset()
      .mockRejectedValue(new Error('syntax error at or near "FORM"'));
    await expect(runDatabaseQuery(pgParams())).rejects.toBeInstanceOf(DbError);
    await expect(runDatabaseQuery(pgParams())).rejects.toMatchObject({
      name: 'DbError',
      code: 'db_query_failed',
      message: /syntax error/,
    });
    expect(pg.__end).toHaveBeenCalledTimes(2);
  });
});
