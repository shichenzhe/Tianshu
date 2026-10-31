/**
 * PG schema 派生（主库双引擎 spec 2026-10-31）：主 schema 单源真相，
 * 仅替换 datasource 头（provider postgresql / url env 化）并注入独立
 * generator output——表体逐字节不变，双 schema 漂移归零。锚点未命中即
 * 抛错（对齐 db-url rewriteSchemaUrlEnv 的 no-op 防线惯例）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'schema.prisma'), 'utf8');

let derived = source.replace(
  /(datasource\s+db\s*\{[\s\S]*?\})/,
  (block) =>
    block
      .replace('provider = "sqlite"', 'provider = "postgresql"')
      .replace(/url\s*=\s*"file:\.\/local\.db"/, 'url = env("DATABASE_URL")'),
);
if (derived === source || !derived.includes('provider = "postgresql"')) {
  throw new Error(
    'datasource 改写未命中（provider/url 锚点漂移）——拒绝静默产出错误变体，请同步 derive-pg.mjs',
  );
}
derived = derived.replace(
  /(generator client \{\r?\n\s*provider = "prisma-client-js"\r?\n)/,
  '$1  output   = "../../src/generated/prisma-pg"\n',
);
if (!derived.includes('../../src/generated/prisma-pg')) {
  throw new Error('generator output 注入未命中——prisma-client-js 锚点漂移，请同步 derive-pg.mjs');
}
// 变体迁 prisma/pg/ 子目录（prisma-migrate 批 Task 1）：migrations 目录跟随
// schema 位置且不可自定义，腾出 prisma/migrations 归 SQLite、pg/migrations 归 PG
mkdirSync(join(here, 'pg'), { recursive: true });
writeFileSync(join(here, 'pg', 'schema.prisma'), derived);
console.log('derived: prisma/pg/schema.prisma（表体逐字节同主 schema）');
