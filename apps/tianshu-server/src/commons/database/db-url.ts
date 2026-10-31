// DB 落点 env 覆盖（PK-T3 实测修复）：schema datasource url 是字面量
// `file:./local.db`——烘焙进生成 client 的相对路径，不受 HOME/cwd/env 影响；
// 打包内嵌态由此落在 .app 包体（随更新整包替换丢数据 + DMG 直跑只读炸库）。
// 桌面端（mirror connections.ts 打包态 spawn）注入 TIANSHU_DB_URL 绝对路径，
// server 侧经 PrismaClient `datasources` 运行时覆盖消费（test/support/test-db.ts
// 同机制）；dev 态不注入——datasources 走 schema 字面量（仓内 prisma/local.db），
// 缺库/空壳时由 ensureDatabase 自愈建库（见下方）。
//
// 命名偏离 ruling 记录：ruling 原文用 DATABASE_URL，但 configuration.ts 顶层
// 会用 config.yml 的 database.url 无条件覆写 process.env.DATABASE_URL（注入值
// 会在 Prisma 取用前被冲掉），故用独立命名 TIANSHU_DB_URL（与 TIANSHU_TOKEN/
// TIANSHU_DATA_ROOT 同族）。
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** 打包态 DB 落点 env 名（桌面端 connections.ts 注入） */
export const DB_URL_ENV = 'TIANSHU_DB_URL';

/** schema 字面量 url 改写为 env 引用（字面量对 env 不生效，test-db 同法）；
 * 未命中即抛错（PK 终审 F5）——防 schema url 演化后静默 no-op 建错库 */
export function rewriteSchemaUrlEnv(schema: string): string {
  const rewritten = schema.replace(
    /url\s*=\s*"file:\.\/local\.db"/,
    `url = env("${DB_URL_ENV}")`,
  );
  if (rewritten === schema) {
    throw new Error(
      `schema 改写未命中（datasource url 非 file:./local.db 字面量）——` +
        `schema url 可能已演化，拒绝静默 no-op 建错库，请同步更新改写规则`,
    );
  }
  return rewritten;
}

/** 归一为 prisma 认的 file: URL（裸路径补前缀；已是 file: 原样） */
export function normalizeDbUrl(url: string): string {
  return url.startsWith('file:') ? url : `file:${url}`;
}

/** 主库引擎（双引擎 spec）：未设/file:/裸路径 → sqlite；postgres 系 →
 * postgres；其他 scheme 显式抛错（防静默建错库） */
export type DbEngine = 'sqlite' | 'postgres';

export function engineOf(url: string | undefined): DbEngine {
  if (!url) {
    return 'sqlite';
  }
  if (/^postgres(ql)?:\/\//.test(url)) {
    return 'postgres';
  }
  if (url.startsWith('file:') || !url.includes('://')) {
    return 'sqlite';
  }
  throw new Error(
    `TIANSHU_DB_URL 不支持的 scheme（仅 file: 路径或 postgres:// 连接串）: ${url}`,
  );
}

/** 读取注入的 DB 落点（空/未设 → undefined，dev 态即此） */
export function overriddenDbUrl(): string | undefined {
  const url = process.env[DB_URL_ENV]?.trim();
  return url || undefined;
}

/** PrismaClient 构造 options（仅 env 注入态；dev 态 undefined 走 schema 默认） */
export function dbUrlOptions():
  { datasources: { db: { url: string } } } | undefined {
  const url = overriddenDbUrl();
  if (!url) {
    return undefined;
  }
  // postgres 连接串原样透传（normalizeDbUrl 会错补 file: 前缀）
  const normalized = engineOf(url) === 'postgres' ? url : normalizeDbUrl(url);
  return { datasources: { db: { url: normalized } } };
}

/** contains 大小写双引擎统一（主库双引擎批 follow-up）：SQLite LIKE 天生
 * ASCII 大小写不敏感、PG LIKE 区分大小写——PG 分支补 mode: 'insensitive'
 * （ILIKE，Unicode 级不敏感，覆盖面较 SQLite 只多不少）对齐；SQLite 分支
 * 绝不能带 mode（Prisma 对 SQLite 上的 mode 直接 ValidationError），故必须
 * 引擎感知构造而非无脑透传。引擎取 env（ensureGraphRunNodeTable /
 * trimKeepSql 同款默认参手法；两引擎形状由 db-url-engine.spec 钉死）。 */
export function containsFilter(
  value: string,
  engine: DbEngine = engineOf(overriddenDbUrl()),
): { contains: string; mode?: 'insensitive' } {
  return engine === 'postgres'
    ? { contains: value, mode: 'insensitive' }
    : { contains: value };
}

/** 向上寻 prisma/schema.prisma 所在根（src/jest 与 dist 两态深度不同） */
export function findSchemaRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'prisma', 'schema.prisma'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error('未找到 prisma/schema.prisma（向上寻根失败）');
    }
    dir = parent;
  }
}

/** SQLite 落点绝对路径（注入态 env 归一；dev 态 schema 字面量
 * `file:./local.db` 落点 = <root>/prisma/local.db） */
function sqliteDbPath(startDir: string): string {
  const url = overriddenDbUrl();
  return url
    ? normalizeDbUrl(url).replace(/^file:/, '')
    : join(findSchemaRoot(startDir), 'prisma', 'local.db');
}

/** prisma CLI 绝对路径（prod 树 peer 先例：prune 后仍在，打包态可用；
 * 进程用 process.execPath——打包态=Electron 二进制 node 模式，机器无需装
 * node/npx） */
function prismaCli(root: string): string {
  return join(root, 'node_modules', 'prisma', 'build', 'index.js');
}

/** spawn prisma CLI 同步子进程（探测/resolve/deploy 共用形态）；
 * encoding utf8 → stdout/stderr 恒 string */
function spawnPrisma(
  args: string[],
  options: { env?: Record<string, string>; input?: string } = {},
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    ...(options.env ? { env: options.env } : {}),
    ...(options.input ? { input: options.input } : {}),
  });
}

/** stdout/stderr 合串尾段（失败报错携带有用上下文，500 字截断） */
function outputTail(result: { stdout?: string; stderr?: string }): string {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(-500);
}

/** 基线迁移名（双端 `0_init`，migrate 体系批 T2 产出）：存量库 baseline
 *  resolve 目标——journal 无此行且库已有表时标记已应用（不重放全量 DDL） */
const BASELINE_MIGRATION = '0_init';

/** 迁移前探测 SQL（`prisma db execute --url --stdin`）：db execute 实测
 * 不回显查询结果（仅 "Script executed successfully."），布尔答案经退出码
 * 编码——肯定 → 正常执行退出 0；否定 → 制造确定性运行期报错退出 1
 * （SQLite 除零不报错得 NULL，改用 json_extract 喂非法 JSON 制错；PG 除零
 * 即报错。双端 LIKE 均显式 `\_` 转义防 `_` 单字符通配符误伤业务表计数——
 * PG 默认转义符即反斜杠，SQLite 无默认须 ESCAPE 子句显式声明）。双端
 * query 形态按 brief：sqlite_master / information_schema.tables（public
 * 业务表）。 */
const TABLES_EXIST_PROBE: Record<DbEngine, string> = {
  sqlite:
    "SELECT json_extract(CASE WHEN (SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_prisma%' ESCAPE '\\') > 0 THEN '{\"ok\":1}' ELSE 'oops' END, '$.ok');",
  postgres:
    "SELECT 1 / count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT LIKE '\\_prisma%';",
};
const BASELINE_IN_JOURNAL_PROBE: Record<DbEngine, string> = {
  sqlite: `SELECT json_extract(CASE WHEN (SELECT count(*) FROM _prisma_migrations WHERE migration_name = '${BASELINE_MIGRATION}') > 0 THEN '{"ok":1}' ELSE 'oops' END, '$.ok');`,
  postgres: `SELECT 1 / count(*) FROM _prisma_migrations WHERE migration_name = '${BASELINE_MIGRATION}';`,
};

/** 探测否定答案特征（stdout/stderr 合串判读）：malformed JSON（SQLite
 * json 探针）/ no such table / does not exist（journal 表未建）/ division
 * by zero（PG 除零探针）——命中即「假」；未命中视为探测自身故障（连接类
 * 交上层有界重试，其余响亮抛错，绝不能把故障误读成「空库」走从零 deploy） */
const PROBE_NEGATIVE_RE =
  /malformed JSON|no such table|does not exist|division by zero/i;

/** 单条探测：退出 0 → true；否定特征报错 → false；其余 → 抛错 */
function probeBoolean(cli: string, url: string, sql: string): boolean {
  const result = spawnPrisma([cli, 'db', 'execute', '--url', url, '--stdin'], {
    input: sql,
  });
  if (result.status === 0) {
    return true;
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (PROBE_NEGATIVE_RE.test(output)) {
    return false;
  }
  throw new Error(
    `迁移前探测失败（prisma db execute 退出码 ${result.status}）：` +
      outputTail(result),
  );
}

/** baseline 探测（migrate 体系批 T3 契约）：库已有业务表但
 * `_prisma_migrations` journal 无 0_init → true（deploy 前先
 * `migrate resolve --applied 0_init`——存量部署库标记基线已应用）；
 * 空库（deploy 从零全量建表）/ journal 齐 → false。幂等：resolve 后
 * journal 非空，次轮探测恒 false。 */
export function needsBaselineResolve(
  engine: DbEngine = engineOf(overriddenDbUrl()),
  startDir = __dirname,
): boolean {
  const url =
    engine === 'postgres'
      ? overriddenDbUrl()!
      : normalizeDbUrl(sqliteDbPath(startDir));
  const cli = prismaCli(findSchemaRoot(startDir));
  if (!probeBoolean(cli, url, TABLES_EXIST_PROBE[engine])) {
    return false;
  }
  return !probeBoolean(cli, url, BASELINE_IN_JOURNAL_PROBE[engine]);
}

/** spawn prisma migrate 子命令，非零退出码抛错（携输出尾段）；
 * args 不含 CLI 路径（此处补齐），报错名取「migrate deploy/resolve」段 */
function runMigrateChecked(
  cli: string,
  args: string[],
  env: Record<string, string>,
  failureContext: string,
): void {
  const result = spawnPrisma([cli, ...args], { env });
  if (result.status !== 0) {
    throw new Error(
      `${failureContext}（prisma ${args.slice(0, 2).join(' ')} 退出码 ` +
        `${result.status}）：${outputTail(result)}`,
    );
  }
}

/**
 * 首启建库（env 注入态 + dev 态，须先于 $connect；migrate 体系批 T3 起
 * 以 `prisma migrate deploy` 替代 db push——版本化 journal，加法增量）：
 * - 落点：注入态取 env 绝对路径；dev 态取 schema 字面量 `file:./local.db`
 *   落点（相对 prisma/ 目录 = <root>/prisma/local.db）——local.db 在
 *   .gitignore，新 clone / 库被清理后 dev 首启若无自愈必然空壳炸表缺失
 *   （2026-10-18 启动报错 P2021 的根因）；
 * - 目录确保（mkdirSync recursive 兜底）；
 * - 库文件就绪（存在且非 0 字节）→ 直接返回（每次启动快路径）；0 字节
 *   空壳视同缺库——PrismaClient $connect 打开缺失文件会创建空文件但不
 *   建表；
 * - 缺库 → 临时 migrate 工作区（改写 env url 的 schema 副本 + migrations
 *   整目录随行——prisma 按 schema 同级目录解析 migrations，实测缺兄弟
 *   目录即 "No migration found" 空跑）跑 `migrate deploy` 建表；存量表
 *   且 journal 空时先 `migrate resolve --applied 0_init`（探测恒否定于
 *   本分支——缺库/空壳 ⇒ 无表——探测保留为双端统一契约面）。DDL 单一事
 *   实源始终是 prisma/schema.prisma + migrations，不手写建表 SQL。
 */
/** 库文件就绪判定：存在且非 0 字节空壳（$connect 产物只有文件没有表） */
function isDatabaseReady(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  try {
    return statSync(dbPath).size > 0;
  } catch {
    return false;
  }
}

export function ensureDatabase(startDir = __dirname): void {
  // postgres 主库走 PG 分支（目录确保/文件就绪判定为 SQLite 落点专属）
  if (engineOf(overriddenDbUrl()) === 'postgres') {
    ensureDatabasePg(startDir);
    return;
  }
  const dbPath = sqliteDbPath(startDir);
  mkdirSync(dirname(dbPath), { recursive: true });
  if (isDatabaseReady(dbPath)) return;
  const root = findSchemaRoot(startDir);
  const cli = prismaCli(root);
  // 临时 migrate 工作区：schema url 字面量改写 env（db push 先例——Prisma 6
  // 字面量 url 对 env 不生效，E2 实测恒落 schema 字面量路径）
  const tmpDir = join(tmpdir(), `tianshu-migrate-${process.pid}`);
  const tmpSchema = join(tmpDir, 'schema.prisma');
  const env = { ...process.env, [DB_URL_ENV]: normalizeDbUrl(dbPath) };
  try {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      tmpSchema,
      rewriteSchemaUrlEnv(
        readFileSync(join(root, 'prisma', 'schema.prisma'), 'utf8'),
      ),
    );
    cpSync(join(root, 'prisma', 'migrations'), join(tmpDir, 'migrations'), {
      recursive: true,
    });
    if (needsBaselineResolve('sqlite', startDir)) {
      runMigrateChecked(
        cli,
        ['migrate', 'resolve', '--applied', BASELINE_MIGRATION, '--schema', tmpSchema],
        env,
        '首启建库失败',
      );
    }
    runMigrateChecked(
      cli,
      ['migrate', 'deploy', '--schema', tmpSchema],
      env,
      '首启建库失败',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * PG 首启迁移（engine postgres 态，须先于 $connect；T3 起每 boot 跑
 * `prisma migrate deploy` 替代 db push——journal 幂等，无变更秒级）：
 * 派生 schema `prisma/pg/schema.prisma`（migrations 目录 `prisma/pg/
 * migrations` 按约定位于 schema 同级），其 datasource url 即
 * env("DATABASE_URL")（派生脚本产物，无需临时改写）。DATABASE_URL 经
 * spawn env 显式注入：绕开 configuration.ts 顶层对 process.env.
 * DATABASE_URL 的无条件覆写（见文件头命名偏离记录）。schema 定位复用
 * findSchemaRoot 向上寻根（src/jest 与 dist 两态深度不同），进程/CLI
 * 形态同上方 SQLite 先例（execPath + prisma prod 树 CLI，机器无需装
 * node/npx）。无 SQLite 落点的目录确保/空壳判定——就绪与否由 deploy
 * journal 幂等保证。存量库（db push 时代部署，有表无 journal）首启经
 * needsBaselineResolve 探测 → `migrate resolve --applied 0_init` 标记
 * 基线后正常增量；`tianshu_search` 检索 schema 与 migrate 完全正交
 * （migrate 只管 public 业务表，互不感知）。
 *
 * 连接类失败有界重试（终审 F2）：compose 起栈竞态下 migrate 可能先于
 * main-pg 就绪（initdb/监听未起 → ECONNREFUSED）。profile 门控不宜为
 * main-pg 加 depends_on（缺省 SQLite 栈会被连带拉起 PG），竞态由两侧
 * 兜底——compose server 服务 restart: unless-stopped + 本进程内最多
 * 3 轮、间隔 2s 的短退避重试（重试单位是整条「探测 → resolve? → deploy」
 * 序列）；确定性失败（schema 漂移/鉴权拒绝等）重试无意义，不重试直接抛。
 * 导出 + retry 参数注入供单测（默认参数即生产行为）。
 */
export const PG_MIGRATE_RETRY_DEFAULTS = { attempts: 3, backoffMs: 2000 };

/** 连接类失败特征（错误消息判读，终审收尾实测修正）：prisma CLI 对拒连
 * PG 端口的真实输出是 `P1001 … Can't reach database server at \`host:port\``
 * ——不含 connect/ECONNREFUSED 字样（原注释断言有误，P1001/P1002 码与
 * can't reach/unreachable 文本须显式入列）；传输层失败（pg 驱动部分路径）
 * 另有 `connect ECONNREFUSED` 形态，ENOTFOUND 与超时特征一并覆盖 */
const PG_CONNECT_FAILURE_RE =
  /ECONNREFUSED|ENOTFOUND|connect|timed?\s*out|timeout|P1001|P1002|can'?t reach|unreachable/i;

export function ensureDatabasePg(
  startDir: string,
  retry: { attempts: number; backoffMs: number } = PG_MIGRATE_RETRY_DEFAULTS,
): void {
  const url = overriddenDbUrl()!;
  const root = findSchemaRoot(startDir);
  const cli = prismaCli(root);
  const schema = join(root, 'prisma', 'pg', 'schema.prisma');
  const env = { ...process.env, DATABASE_URL: url };
  const migrateOnce = (): void => {
    if (needsBaselineResolve('postgres', startDir)) {
      runMigrateChecked(
        cli,
        ['migrate', 'resolve', '--applied', BASELINE_MIGRATION, '--schema', schema],
        env,
        'PG 首启迁移失败',
      );
    }
    runMigrateChecked(
      cli,
      ['migrate', 'deploy', '--schema', schema],
      env,
      'PG 首启迁移失败',
    );
  };
  for (let attempt = 1; ; attempt++) {
    try {
      migrateOnce();
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 非连接类失败（schema 漂移/鉴权/CLI 缺失等）重试无意义，直接抛
      if (attempt >= retry.attempts || !PG_CONNECT_FAILURE_RE.test(message)) {
        throw error;
      }
      // 同步短退避（ensureDatabase 全链同步，无异步 sleep 可用）：
      // Atomics.wait 是 Node 主/工作线程均合法的同步等待原语
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retry.backoffMs);
    }
  }
}
