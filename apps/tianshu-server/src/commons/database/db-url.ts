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
import { spawnSync } from 'node:child_process';
import {
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

/** 读取注入的 DB 落点（空/未设 → undefined，dev 态即此） */
export function overriddenDbUrl(): string | undefined {
  const url = process.env[DB_URL_ENV]?.trim();
  return url || undefined;
}

/** PrismaClient 构造 options（仅 env 注入态；dev 态 undefined 走 schema 默认） */
export function dbUrlOptions():
  { datasources: { db: { url: string } } } | undefined {
  const url = overriddenDbUrl();
  return url
    ? { datasources: { db: { url: normalizeDbUrl(url) } } }
    : undefined;
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

/**
 * 首启建库（env 注入态 + dev 态，须先于 $connect）：
 * - 落点：注入态取 env 绝对路径；dev 态取 schema 字面量 `file:./local.db`
 *   落点（相对 prisma/ 目录 = <root>/prisma/local.db）——local.db 在
 *   .gitignore，新 clone / 库被清理后 dev 首启若无自愈必然空壳炸表缺失
 *   （2026-10-18 启动报错 P2021 的根因）；
 * - 目录确保（mkdirSync recursive 兜底）；
 * - 库文件就绪（存在且非 0 字节）→ 直接返回；0 字节空壳视同缺库——
 *   PrismaClient $connect 打开缺失文件会创建空文件但不建表；
 * - 缺库 → `prisma db push --skip-generate` 建表（临时 schema 改写 env
 *   url——DDL 单一事实源始终是 prisma/schema.prisma，不手写建表 SQL；prisma
 *   CLI 系 @prisma/client prod 树 peer，prune 后仍在，打包态可用）。
 * 进程用 process.execPath（打包态=Electron 二进制 node 模式，机器无需装 node）。
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
  const url = overriddenDbUrl();
  const dbPath = url
    ? normalizeDbUrl(url).replace(/^file:/, '')
    : join(findSchemaRoot(startDir), 'prisma', 'local.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  if (isDatabaseReady(dbPath)) return;
  const root = findSchemaRoot(startDir);
  const tmpSchema = join(tmpdir(), `tianshu-schema-${process.pid}.prisma`);
  try {
    writeFileSync(
      tmpSchema,
      rewriteSchemaUrlEnv(
        readFileSync(join(root, 'prisma', 'schema.prisma'), 'utf8'),
      ),
    );
    const cli = join(root, 'node_modules', 'prisma', 'build', 'index.js');
    const result = spawnSync(
      process.execPath,
      [cli, 'db', 'push', '--skip-generate', '--schema', tmpSchema],
      {
        env: { ...process.env, [DB_URL_ENV]: normalizeDbUrl(dbPath) },
        encoding: 'utf8',
      },
    );
    if (result.status !== 0) {
      const tail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
        .trim()
        .slice(-500);
      throw new Error(
        `首启建库失败（prisma db push 退出码 ${result.status}）：${tail}`,
      );
    }
  } finally {
    rmSync(tmpSchema, { force: true });
  }
}
