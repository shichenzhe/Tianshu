// apps/tianshu-server/test/core/db-url-migrate.spec.ts
/**
 * 运行时契约替换（migrate deploy 替代 db push，T3）三分支钉形 + 探测/
 * 部署 spawn 形态：
 * - 空库 → deploy 直接跑（无 resolve，从零全量建表）；
 * - 存量表 + journal 空 → 先 `migrate resolve --applied 0_init` 再 deploy
 *   （存量部署库标记基线已应用，不重放全量 DDL）；
 * - journal 齐 → 仅 deploy（增量幂等 no-op）。
 * 探测经 `prisma db execute --url --stdin`（实测不回显查询结果——布尔答案
 * 经「条件性运行期错误 → 退出码」编码：division by zero / malformed JSON /
 * no such table / does not exist = 否定答案，其余失败视为探测自身故障）。
 * spawnSync 桩化；fs 走真值（worktree 真 schema/migrations 可读，临时
 * migrate 工作区内容与清理经 spy/事后断言钉死）。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  spawnSync: jest.fn(),
}));

import {
  DB_URL_ENV,
  ensureDatabase,
  ensureDatabasePg,
  needsBaselineResolve,
} from '../../src/commons/database/db-url';

const spawnSync = require('node:child_process').spawnSync as jest.Mock;
const PG_URL = 'postgres://u:p@127.0.0.1:5432/d';
/** spec 相对真仓根（apps/tianshu-server）——真 schema/CLI 落点断言用 */
const ROOT = join(__dirname, '..', '..');
const CLI = join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const PG_SCHEMA = join(ROOT, 'prisma', 'pg', 'schema.prisma');

/** spawn 第 i 次调用的 (args, options) 视图 */
function callAt(index: number): [
  string[],
  {
    env?: Record<string, string>;
    input?: string;
  },
] {
  const [, args, options] = spawnSync.mock.calls[index] as [
    string,
    string[],
    { env?: Record<string, string>; input?: string },
  ];
  return [args, options];
}

const ok = { status: 0, stdout: '', stderr: '' };

function restoreEnv(original: string | undefined): void {
  if (original === undefined) {
    delete process.env[DB_URL_ENV];
  } else {
    process.env[DB_URL_ENV] = original;
  }
}

describe('ensureDatabasePg 三分支（migrate deploy 契约）', () => {
  const OLD = process.env[DB_URL_ENV];
  const RETRY_FAST = { attempts: 3, backoffMs: 1 };

  afterEach(() => {
    restoreEnv(OLD);
    spawnSync.mockReset();
  });

  it('空库：表探测否定（division by zero）→ deploy 直接跑，无 resolve', () => {
    process.env[DB_URL_ENV] = PG_URL;
    spawnSync
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'Error: ERROR: division by zero',
      })
      .mockReturnValue(ok);
    expect(() => ensureDatabasePg(__dirname, RETRY_FAST)).not.toThrow();
    expect(spawnSync).toHaveBeenCalledTimes(2);

    const [probeArgs, probeOptions] = callAt(0);
    expect(probeArgs).toEqual([
      CLI,
      'db',
      'execute',
      '--url',
      PG_URL,
      '--stdin',
    ]);
    expect(probeOptions.input).toContain('information_schema.tables');
    expect(probeOptions.input).toContain("table_schema = 'public'");

    const [deployArgs, deployOptions] = callAt(1);
    expect(deployArgs).toEqual([
      CLI,
      'migrate',
      'deploy',
      '--schema',
      PG_SCHEMA,
    ]);
    expect(deployOptions.env?.DATABASE_URL).toBe(PG_URL);
    for (const [args] of spawnSync.mock.calls as [string, string[]][]) {
      expect(args).not.toContain('resolve');
    }
  });

  it('存量表 + journal 空：表探测过 → journal 探测否定 → resolve 0_init → deploy', () => {
    process.env[DB_URL_ENV] = PG_URL;
    spawnSync
      .mockReturnValueOnce(ok) // 表探测：有业务表
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'Error: P1014 … does not exist',
      }) // journal 探测：无 0_init
      .mockReturnValue(ok); // resolve + deploy
    expect(() => ensureDatabasePg(__dirname, RETRY_FAST)).not.toThrow();
    expect(spawnSync).toHaveBeenCalledTimes(4);

    const [, journalProbe] = callAt(1);
    expect(journalProbe.input).toContain('_prisma_migrations');
    expect(journalProbe.input).toContain("'0_init'");

    const [resolveArgs, resolveOptions] = callAt(2);
    expect(resolveArgs).toEqual([
      CLI,
      'migrate',
      'resolve',
      '--applied',
      '0_init',
      '--schema',
      PG_SCHEMA,
    ]);
    expect(resolveOptions.env?.DATABASE_URL).toBe(PG_URL);

    const [deployArgs] = callAt(3);
    expect(deployArgs[1]).toBe('migrate');
    expect(deployArgs[2]).toBe('deploy');
  });

  it('journal 齐：两探测过 → 仅 deploy，无 resolve（增量幂等 no-op）', () => {
    process.env[DB_URL_ENV] = PG_URL;
    spawnSync.mockReturnValue(ok);
    expect(() => ensureDatabasePg(__dirname, RETRY_FAST)).not.toThrow();
    expect(spawnSync).toHaveBeenCalledTimes(3);
    const [deployArgs] = callAt(2);
    expect(deployArgs).toEqual([
      CLI,
      'migrate',
      'deploy',
      '--schema',
      PG_SCHEMA,
    ]);
    for (const [args] of spawnSync.mock.calls as [string, string[]][]) {
      expect(args).not.toContain('resolve');
    }
  });
});

describe('needsBaselineResolve（探测布尔契约，sqlite 直测）', () => {
  const OLD = process.env[DB_URL_ENV];

  afterEach(() => {
    restoreEnv(OLD);
    spawnSync.mockReset();
  });

  it('空库（表探测 malformed JSON）→ false', () => {
    delete process.env[DB_URL_ENV];
    spawnSync.mockReturnValueOnce({
      status: 1,
      stdout: '',
      stderr: 'Error: SQLite database error\nmalformed JSON',
    });
    expect(needsBaselineResolve('sqlite', __dirname)).toBe(false);
    const [args, options] = callAt(0);
    // 探测 --url 直连（无需 schema）；dev 态落点 = <root>/prisma/local.db
    expect(args).toEqual([
      CLI,
      'db',
      'execute',
      '--url',
      `file:${join(ROOT, 'prisma', 'local.db')}`,
      '--stdin',
    ]);
    expect(options.input).toContain('sqlite_master');
    expect(options.input).toContain("name NOT LIKE '\\_prisma%' ESCAPE '\\'");
  });

  it('存量表 + journal 空（no such table）→ true', () => {
    delete process.env[DB_URL_ENV];
    spawnSync
      .mockReturnValueOnce(ok) // 表探测：有表
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr:
          'Error: SQLite database error\nno such table: _prisma_migrations',
      });
    expect(needsBaselineResolve('sqlite', __dirname)).toBe(true);
    const [, journalProbe] = callAt(1);
    expect(journalProbe.input).toContain('_prisma_migrations');
    expect(journalProbe.input).toContain("'0_init'");
  });

  it('journal 齐 → false；探测自身故障（非否定特征）→ 响亮抛错', () => {
    delete process.env[DB_URL_ENV];
    spawnSync.mockReturnValueOnce(ok).mockReturnValueOnce(ok); // journal 有 0_init
    expect(needsBaselineResolve('sqlite', __dirname)).toBe(false);

    spawnSync.mockReset();
    spawnSync.mockReturnValueOnce({
      status: 1,
      stdout: '',
      stderr: 'Error: file is not a database',
    });
    expect(() => needsBaselineResolve('sqlite', __dirname)).toThrow(
      /迁移前探测失败.*file is not a database/s,
    );
  });
});

describe('ensureDatabase（sqlite 缺库自愈 → migrate deploy）', () => {
  const OLD = process.env[DB_URL_ENV];
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'tianshu-migrate-spec-'));
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });
  afterEach(() => {
    restoreEnv(OLD);
    spawnSync.mockReset();
  });

  it('注入态缺库：db execute 探测（空库否定）→ migrate deploy（临时 schema 改写 env url + migrations 整目录随行 + 工作区清理）', () => {
    const dbPath = join(dataDir, 'local.db');
    process.env[DB_URL_ENV] = dbPath;
    spawnSync
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'Error: SQLite database error\nmalformed JSON',
      })
      .mockReturnValue(ok);
    const fs = require('node:fs');
    const writeSpy = jest.spyOn(fs, 'writeFileSync');
    const cpSpy = jest.spyOn(fs, 'cpSync');
    try {
      expect(() => ensureDatabase(__dirname)).not.toThrow();
      expect(spawnSync).toHaveBeenCalledTimes(2);

      const [probeArgs, probeOptions] = callAt(0);
      expect(probeArgs).toEqual([
        CLI,
        'db',
        'execute',
        '--url',
        `file:${dbPath}`,
        '--stdin',
      ]);
      expect(probeOptions.input).toContain('sqlite_master');

      const [deployArgs, deployOptions] = callAt(1);
      expect(deployArgs.slice(0, 4)).toEqual([
        CLI,
        'migrate',
        'deploy',
        '--schema',
      ]);
      expect(deployArgs[4]).toMatch(/tianshu-migrate-\d+[/\\]schema\.prisma$/);
      expect(deployOptions.env?.[DB_URL_ENV]).toBe(`file:${dbPath}`);

      // 临时 schema 内容 = 字面量改写 env 引用（Prisma 6 字面量 url 对 env 不生效）
      const schemaWrite = writeSpy.mock.calls.find(([path]: [string]) =>
        /schema\.prisma$/.test(path),
      ) as [string, string];
      expect(schemaWrite[1]).toContain(`url = env("${DB_URL_ENV}")`);
      expect(schemaWrite[1]).not.toContain('file:./local.db');
      // migrations 目录随行复制到临时 schema 同级（prisma 按 schema 同级解析）
      const [cpSrc, cpDest] = cpSpy.mock.calls[0] as [string, string];
      expect(cpSrc).toBe(join(ROOT, 'prisma', 'migrations'));
      expect(cpDest).toBe(join(dirname(deployArgs[4]), 'migrations'));
      // finally 清理：临时工作区已拆除
      expect(existsSync(dirname(deployArgs[4]))).toBe(false);
      for (const [args] of spawnSync.mock.calls as [string, string[]][]) {
        expect(args).not.toContain('resolve');
      }
    } finally {
      writeSpy.mockRestore();
      cpSpy.mockRestore();
    }
  });

  it('注入态库就绪：快路径零 spawn（行为保留——migrate deploy 仅缺库/空壳触发）', () => {
    const dbPath = join(dataDir, 'ready.db');
    writeFileSync(dbPath, 'ready');
    process.env[DB_URL_ENV] = dbPath;
    ensureDatabase(__dirname);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('缺库自愈 deploy 失败 → 抛错带退出码与输出尾段（建库失败必须响亮）', () => {
    const dbPath = join(dataDir, 'fail.db');
    process.env[DB_URL_ENV] = dbPath;
    spawnSync
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'Error: SQLite database error\nmalformed JSON',
      })
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'Error: schema engine boom',
      });
    expect(() => ensureDatabase(__dirname)).toThrow(
      /首启建库失败（prisma migrate deploy 退出码 1）.*schema engine boom/s,
    );
  });
});
