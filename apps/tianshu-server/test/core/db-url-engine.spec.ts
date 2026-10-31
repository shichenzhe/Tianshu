// apps/tianshu-server/test/core/db-url-engine.spec.ts
/**
 * 引擎判定（scheme 分发/非法 scheme 人话报错）与 dbUrlOptions 的
 * postgres 透传（不补 file: 前缀）。
 */
import { engineOf, dbUrlOptions } from '../../src/commons/database/db-url';

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
