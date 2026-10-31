// apps/tianshu-server/test/core/db-url-engine.spec.ts
/**
 * 引擎判定（scheme 分发/非法 scheme 人话报错）与 dbUrlOptions 的
 * postgres 透传（不补 file: 前缀）；ensureDatabasePg 连接类失败有界
 * 重试（终审 F2——spawnSync 桩化，backoffMs=1 保测试即时）。
 */
import {
  engineOf,
  dbUrlOptions,
  ensureDatabasePg,
} from '../../src/commons/database/db-url';

jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  spawnSync: jest.fn(),
}));

describe('engineOf', () => {
  it('未设/file:/裸路径 → sqlite；postgres 系 → postgres', () => {
    expect(engineOf(undefined)).toBe('sqlite');
    expect(engineOf('file:/tmp/x.db')).toBe('sqlite');
    expect(engineOf('/tmp/x.db')).toBe('sqlite');
    expect(engineOf('postgres://u:p@h:5432/d')).toBe('postgres');
    expect(engineOf('postgresql://u:p@h/d')).toBe('postgres');
  });
  it('其他 scheme 抛人话错', () => {
    expect(() => engineOf('mysql://h/d')).toThrow(/TIANSHU_DB_URL/);
  });
});

describe('dbUrlOptions postgres 透传', () => {
  const OLD = process.env.TIANSHU_DB_URL;
  afterEach(() => {
    process.env.TIANSHU_DB_URL = OLD;
  });

  it('postgres url 原样透传（不补 file: 前缀）', () => {
    process.env.TIANSHU_DB_URL = 'postgres://u:p@h:5432/d';
    expect(dbUrlOptions()).toEqual({
      datasources: { db: { url: 'postgres://u:p@h:5432/d' } },
    });
  });
  it('file url 维持 normalize 现状', () => {
    process.env.TIANSHU_DB_URL = '/tmp/x.db';
    expect(dbUrlOptions()?.datasources.db.url).toBe('file:/tmp/x.db');
  });
});

describe('ensureDatabasePg 连接类失败有界重试（终审 F2）', () => {
  const OLD = process.env.TIANSHU_DB_URL;
  const spawnSync = require('node:child_process')
    .spawnSync as jest.Mock;
  const RETRY_FAST = { attempts: 3, backoffMs: 1 };
  const refused = (status: 1 | null = 1) => ({
    status,
    stdout: '',
    stderr: 'Error: P1001: Can\'t reach database server … connect ECONNREFUSED 127.0.0.1:5432',
  });

  afterEach(() => {
    if (OLD === undefined) {
      delete process.env.TIANSHU_DB_URL;
    } else {
      process.env.TIANSHU_DB_URL = OLD;
    }
    spawnSync.mockReset();
  });

  it('连接类失败重试至成功不抛（spawn 计数=失败次数+1）', () => {
    process.env.TIANSHU_DB_URL = 'postgres://u:p@127.0.0.1:5432/d';
    spawnSync
      .mockReturnValueOnce(refused())
      .mockReturnValueOnce(refused())
      .mockReturnValue({ status: 0, stdout: 'db push ok', stderr: '' });
    expect(() => ensureDatabasePg(__dirname, RETRY_FAST)).not.toThrow();
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });
  it('确定性失败（schema 漂移类）不重试直接抛', () => {
    process.env.TIANSHU_DB_URL = 'postgres://u:p@127.0.0.1:5432/d';
    spawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'Error: P3006: MySQL migration failed to apply',
    });
    expect(() => ensureDatabasePg(__dirname, RETRY_FAST)).toThrow(
      /PG 首启建库失败/,
    );
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });
  it('连接类失败重试耗尽仍失败 → 抛（attempts 次后止步）', () => {
    process.env.TIANSHU_DB_URL = 'postgres://u:p@127.0.0.1:5432/d';
    spawnSync.mockReturnValue(refused());
    expect(() => ensureDatabasePg(__dirname, RETRY_FAST)).toThrow(
      /ECONNREFUSED/,
    );
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });
});
