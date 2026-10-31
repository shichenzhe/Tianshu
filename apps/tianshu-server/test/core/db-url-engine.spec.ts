// apps/tianshu-server/test/core/db-url-engine.spec.ts
/**
 * 引擎判定（scheme 分发/非法 scheme 人话报错）与 dbUrlOptions 的
 * postgres 透传（不补 file: 前缀）；ensureDatabasePg 连接类失败有界
 * 重试（终审 F2——spawnSync 桩化，backoffMs=1 保测试即时；migrate 契约
 * 下重试单位是整条「探测 → resolve? → deploy」序列）。
 */
import {
  engineOf,
  dbUrlOptions,
  containsFilter,
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

describe('containsFilter（contains 大小写双引擎统一）', () => {
  const OLD = process.env.TIANSHU_DB_URL;
  afterEach(() => {
    if (OLD === undefined) {
      delete process.env.TIANSHU_DB_URL;
    } else {
      process.env.TIANSHU_DB_URL = OLD;
    }
  });

  it('显式引擎：postgres → contains + mode insensitive；sqlite → 仅 contains（mode 在 SQLite 是 Prisma ValidationError，绝不能带）', () => {
    expect(containsFilter('Admin', 'postgres')).toStrictEqual({
      contains: 'Admin',
      mode: 'insensitive',
    });
    expect(containsFilter('Admin', 'sqlite')).toStrictEqual({
      contains: 'Admin',
    });
  });

  it('缺省引擎随 env：postgres:// → insensitive；file:/未注入 → 仅 contains', () => {
    process.env.TIANSHU_DB_URL = 'postgres://u:p@h:5432/d';
    expect(containsFilter('kw')).toStrictEqual({
      contains: 'kw',
      mode: 'insensitive',
    });
    process.env.TIANSHU_DB_URL = 'file:/tmp/x.db';
    expect(containsFilter('kw')).toStrictEqual({ contains: 'kw' });
    delete process.env.TIANSHU_DB_URL;
    expect(containsFilter('kw')).toStrictEqual({ contains: 'kw' });
  });
});

describe('ensureDatabasePg 连接类失败有界重试（终审 F2，migrate 契约）', () => {
  const OLD = process.env.TIANSHU_DB_URL;
  const spawnSync = require('node:child_process')
    .spawnSync as jest.Mock;
  const RETRY_FAST = { attempts: 3, backoffMs: 1 };
  const refused = (status: 1 | null = 1) => ({
    status,
    stdout: '',
    stderr: 'Error: P1001: Can\'t reach database server … connect ECONNREFUSED 127.0.0.1:5432',
  });
  const ok = { status: 0, stdout: '', stderr: '' };

  afterEach(() => {
    if (OLD === undefined) {
      delete process.env.TIANSHU_DB_URL;
    } else {
      process.env.TIANSHU_DB_URL = OLD;
    }
    spawnSync.mockReset();
  });

  it('连接类失败重试至成功不抛（探测连拒 ×2 轮 → 第 3 轮探测×2+deploy 全过）', () => {
    process.env.TIANSHU_DB_URL = 'postgres://u:p@127.0.0.1:5432/d';
    spawnSync
      .mockReturnValueOnce(refused()) // 第 1 轮：表探测连拒
      .mockReturnValueOnce(refused()) // 第 2 轮：表探测连拒
      .mockReturnValueOnce(ok) // 第 3 轮：表探测过
      .mockReturnValueOnce(ok) // 第 3 轮：journal 探测过（无 resolve）
      .mockReturnValue({ status: 0, stdout: 'migrate deploy ok', stderr: '' });
    expect(() => ensureDatabasePg(__dirname, RETRY_FAST)).not.toThrow();
    expect(spawnSync).toHaveBeenCalledTimes(5);
  });
  it('确定性失败（探测阶段 P3006 类）不重试直接抛', () => {
    process.env.TIANSHU_DB_URL = 'postgres://u:p@127.0.0.1:5432/d';
    spawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'Error: P3006: migration failed to apply',
    });
    expect(() => ensureDatabasePg(__dirname, RETRY_FAST)).toThrow(
      /迁移前探测失败.*P3006/s,
    );
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });
  it('确定性失败（deploy 阶段）不重试直接抛（探测全过后止步 deploy）', () => {
    process.env.TIANSHU_DB_URL = 'postgres://u:p@127.0.0.1:5432/d';
    spawnSync
      .mockReturnValueOnce(ok) // 表探测过
      .mockReturnValueOnce(ok) // journal 探测过（journal 齐 → 无 resolve）
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'Error: P3006: migration failed to apply',
      });
    expect(() => ensureDatabasePg(__dirname, RETRY_FAST)).toThrow(
      /PG 首启迁移失败（prisma migrate deploy 退出码 1）.*P3006/s,
    );
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });
  it('连接类失败重试耗尽仍失败 → 抛（attempts 轮后止步，每轮死于首个探测）', () => {
    process.env.TIANSHU_DB_URL = 'postgres://u:p@127.0.0.1:5432/d';
    spawnSync.mockReturnValue(refused());
    expect(() => ensureDatabasePg(__dirname, RETRY_FAST)).toThrow(
      /ECONNREFUSED/,
    );
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });
});
