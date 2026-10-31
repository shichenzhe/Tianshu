#!/usr/bin/env node
/**
 * 双端迁移成对性门禁——SQLite `prisma/migrations/` 与 PG `prisma/pg/migrations/`
 * 须成对演进（README「schema 变更工作流」③：双端各生成迁移、同 commit）。此处
 * 比对两目录的迁移名集：只看子目录名（migration_lock.toml 为文件不入配对；
 * SQL 内容按方言各异，设计上不同、不比对），基线 `0_init` 须双端俱在；任一端
 * 存在未配对迁移名即 exit 1——防「只跑了一端 prisma:migrate 就提交」的静默漂移。
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const engineDirs = {
  SQLite: join(rootDir, 'prisma', 'migrations'),
  PostgreSQL: join(rootDir, 'prisma', 'pg', 'migrations'),
};

const migrationNames = (dir) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

const namesOf = {};
for (const [engine, dir] of Object.entries(engineDirs)) {
  if (!existsSync(dir)) {
    console.error(`[check:migrations] ${engine} 迁移目录缺失：${dir}`);
    process.exit(1);
  }
  namesOf[engine] = migrationNames(dir);
}

const onlyIn = (from, other) => from.filter((name) => !other.includes(name));
let unpaired = false;
for (const [engine, lonely] of [
  ['SQLite', onlyIn(namesOf.SQLite, namesOf.PostgreSQL)],
  ['PostgreSQL', onlyIn(namesOf.PostgreSQL, namesOf.SQLite)],
]) {
  if (lonely.length > 0) {
    console.error(`[check:migrations] 未配对迁移（仅 ${engine} 有）：${lonely.join('、')}`);
    unpaired = true;
  }
}
if (!namesOf.SQLite.includes('0_init') || !namesOf.PostgreSQL.includes('0_init')) {
  console.error('[check:migrations] 基线迁移 0_init 须双端俱在');
  unpaired = true;
}
if (unpaired) {
  console.error(
    '[check:migrations] 双端迁移须成对生成：npm run prisma:migrate 与 prisma:migrate:pg 各跑一次后同 commit',
  );
  process.exit(1);
}
