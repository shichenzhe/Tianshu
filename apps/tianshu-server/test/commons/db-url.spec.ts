// PK-T3：DB 落点 env 覆盖（src/commons/database/db-url.ts）单测——env 读取/
// 归一/options 构造/schema 改写纯函数直测；ensureDatabase 首启建库分支
// （dev 态缺库/空壳自愈、dev 态就绪跳过、注入态三分支）经 fs/spawn 桩验证。
// 真机全链（独立部署首启建库）经 TIANSHU_DB_URL 指临时库实测。
const mockExists = jest.fn();
const mockStat = jest.fn();
const mockMkdir = jest.fn();
const mockRead = jest.fn();
const mockWrite = jest.fn();
const mockRm = jest.fn();
const mockSpawn = jest.fn();

jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: (path: unknown): boolean => Boolean(mockExists(path)),
    statSync: (path: unknown): { size: number } => mockStat(path),
    mkdirSync: mockMkdir,
    readFileSync: mockRead,
    writeFileSync: mockWrite,
    rmSync: mockRm,
  };
});

jest.mock('node:child_process', () => {
  const actual =
    jest.requireActual<typeof import('child_process')>('child_process');
  return { ...actual, spawnSync: mockSpawn };
});

import {
  DB_URL_ENV,
  dbUrlOptions,
  ensureDatabase,
  findSchemaRoot,
  normalizeDbUrl,
  overriddenDbUrl,
  rewriteSchemaUrlEnv,
} from 'src/commons/database/db-url';

const SCHEMA = [
  'datasource db {',
  '  provider = "sqlite"',
  '  url      = "file:./local.db"',
  '}',
].join('\n');

describe('overriddenDbUrl / dbUrlOptions（env 读取与 options 构造）', () => {
  const original = process.env[DB_URL_ENV];

  afterEach(() => {
    if (original === undefined) delete process.env[DB_URL_ENV];
    else process.env[DB_URL_ENV] = original;
  });

  it('未注入（dev 态）→ undefined / options undefined（schema 默认零改动）', () => {
    delete process.env[DB_URL_ENV];
    expect(overriddenDbUrl()).toBeUndefined();
    expect(dbUrlOptions()).toBeUndefined();
  });

  it('空白值视为未注入', () => {
    process.env[DB_URL_ENV] = '   ';
    expect(overriddenDbUrl()).toBeUndefined();
  });

  it('注入裸路径 → options 归一为 file: URL', () => {
    process.env[DB_URL_ENV] = '/home/u/.tianshu-server/database/local.db';
    expect(dbUrlOptions()).toEqual({
      datasources: {
        db: { url: 'file:/home/u/.tianshu-server/database/local.db' },
      },
    });
  });

  it('注入 file: URL → 原样透传（trim 生效）', () => {
    process.env[DB_URL_ENV] = ' file:/x/y.db ';
    expect(dbUrlOptions()).toEqual({
      datasources: { db: { url: 'file:/x/y.db' } },
    });
  });
});

describe('normalizeDbUrl / rewriteSchemaUrlEnv（纯函数）', () => {
  it('file: 前缀原样，裸路径补前缀', () => {
    expect(normalizeDbUrl('file:/a.db')).toBe('file:/a.db');
    expect(normalizeDbUrl('/a.db')).toBe('file:/a.db');
  });

  it('schema 字面量 url 改写为 env 引用（字面量对 env 不生效）', () => {
    expect(rewriteSchemaUrlEnv(SCHEMA)).toContain(`url = env("${DB_URL_ENV}")`);
    expect(rewriteSchemaUrlEnv(SCHEMA)).not.toContain('file:./local.db');
  });

  it('无字面量 url 的 schema → 抛错（F5：防静默 no-op 建错库）', () => {
    const other = 'datasource db {\n  url = env("OTHER")\n}';
    expect(() => rewriteSchemaUrlEnv(other)).toThrow('改写未命中');
  });
});

describe('findSchemaRoot（向上寻根）', () => {
  it('向上逐级找到 prisma/schema.prisma 所在根', () => {
    mockExists.mockImplementation(
      (path: unknown) => path === '/proj/prisma/schema.prisma',
    );
    expect(findSchemaRoot('/proj/dist/src/commons/database')).toBe('/proj');
  });

  it('寻不到 → 抛错（防静默错根）', () => {
    mockExists.mockReturnValue(false);
    expect(() => findSchemaRoot('/proj/src')).toThrow('寻根失败');
  });
});

describe('ensureDatabase（首启建库）', () => {
  const original = process.env[DB_URL_ENV];
  const startDir = '/proj/dist/src/commons/database';

  beforeEach(() => {
    mockExists.mockReset();
    mockStat.mockReset();
    mockMkdir.mockReset();
    mockRead.mockReset();
    mockWrite.mockReset();
    mockRm.mockReset();
    mockSpawn.mockReset();
  });

  afterEach(() => {
    if (original === undefined) delete process.env[DB_URL_ENV];
    else process.env[DB_URL_ENV] = original;
  });

  it('dev 态缺库（未注入 env，新 clone 首启）→ 对 schema 字面量落点 db push 自愈', () => {
    delete process.env[DB_URL_ENV];
    // schema.prisma 在（寻根桩）、仓内 local.db 不在
    mockExists.mockImplementation(
      (path: unknown) => path === '/proj/prisma/schema.prisma',
    );
    mockRead.mockReturnValue(SCHEMA);
    mockSpawn.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    ensureDatabase(startDir);

    expect(mockMkdir).toHaveBeenCalledWith('/proj/prisma', {
      recursive: true,
    });
    const [, args, options] = mockSpawn.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(args[0]).toBe('/proj/node_modules/prisma/build/index.js');
    // dev 态建库目标 = schema 字面量落点（<root>/prisma/local.db 绝对路径）
    expect(options.env[DB_URL_ENV]).toBe('file:/proj/prisma/local.db');
  });

  it('dev 态 0 字节空壳（$connect 已创建但未建表）→ 视同缺库重建', () => {
    delete process.env[DB_URL_ENV];
    mockExists.mockImplementation(
      (path: unknown) =>
        path === '/proj/prisma/schema.prisma' ||
        path === '/proj/prisma/local.db',
    );
    mockStat.mockReturnValue({ size: 0 });
    mockRead.mockReturnValue(SCHEMA);
    mockSpawn.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    ensureDatabase(startDir);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [, , options] = mockSpawn.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(options.env[DB_URL_ENV]).toBe('file:/proj/prisma/local.db');
  });

  it('dev 态库就绪（存在且非空）→ 不跑 db push（每次启动快路径）', () => {
    delete process.env[DB_URL_ENV];
    mockExists.mockReturnValue(true);
    mockStat.mockReturnValue({ size: 4096 });
    ensureDatabase(startDir);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('注入态库文件就绪 → 仅确保目录，不跑 db push（非首启快路径）', () => {
    process.env[DB_URL_ENV] = '/data/db/local.db';
    mockExists.mockReturnValue(true);
    mockStat.mockReturnValue({ size: 4096 });
    ensureDatabase(startDir);
    expect(mockMkdir).toHaveBeenCalledWith('/data/db', { recursive: true });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('注入态 0 字节空壳 → 同样重建（空壳在任何落点都不算已建库）', () => {
    process.env[DB_URL_ENV] = '/data/db/local.db';
    mockExists.mockImplementation(
      (path: unknown) =>
        path === '/proj/prisma/schema.prisma' ||
        path === '/data/db/local.db',
    );
    mockStat.mockReturnValue({ size: 0 });
    mockRead.mockReturnValue(SCHEMA);
    mockSpawn.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    ensureDatabase(startDir);
    const [, , options] = mockSpawn.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(options.env[DB_URL_ENV]).toBe('file:/data/db/local.db');
  });

  it('注入态首启缺库 → 临时 schema 改写 env 后 db push（execPath + CLI + 归一 URL 注入）', () => {
    process.env[DB_URL_ENV] = '/data/db/local.db';
    mockExists.mockImplementation(
      (path: unknown) => path === '/proj/prisma/schema.prisma',
    );
    mockRead.mockReturnValue(SCHEMA);
    mockSpawn.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    ensureDatabase(startDir);

    expect(mockMkdir).toHaveBeenCalledWith('/data/db', { recursive: true });
    // 临时 schema 内容 = 字面量改写为 env 引用
    const [, written] = mockWrite.mock.calls[0] as [string, string];
    expect(written).toContain(`url = env("${DB_URL_ENV}")`);
    expect(written).not.toContain('file:./local.db');
    // db push：process.execPath + <root>/node_modules/prisma/build/index.js
    const [cmd, args, options] = mockSpawn.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(cmd).toBe(process.execPath);
    expect(args[0]).toBe('/proj/node_modules/prisma/build/index.js');
    expect(args[1]).toBe('db');
    expect(args[2]).toBe('push');
    expect(args[3]).toBe('--skip-generate');
    expect(args[4]).toBe('--schema');
    expect(args[5]).toMatch(/tianshu-schema-\d+\.prisma$/);
    expect(options.env[DB_URL_ENV]).toBe('file:/data/db/local.db');
    // 临时 schema 清理
    expect(mockRm).toHaveBeenCalledWith(args[5], { force: true });
  });

  it('db push 失败 → 抛错带退出码与输出尾段（建库失败必须响亮）', () => {
    process.env[DB_URL_ENV] = 'file:/data/db/local.db';
    mockExists.mockImplementation(
      (path: unknown) => path === '/proj/prisma/schema.prisma',
    );
    mockRead.mockReturnValue(SCHEMA);
    mockSpawn.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'Error: schema engine boom',
    });
    expect(() => ensureDatabase(startDir)).toThrow(
      /退出码 1.*schema engine boom/s,
    );
  });
});
