import { execSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaService } from 'src/commons/database/prisma.service';

/** 测试库会话产物 */
export interface TestDb {
  /** 已指向临时库的 Prisma 实例（供 overrideProvider 注入与用例直接造数） */
  prisma: PrismaService;
  /** 临时数据根（TIANSHU_DATA_ROOT，测试库物理位置所在） */
  dataRoot: string;
  /** 断连并删除临时目录、还原环境变量 */
  cleanup: () => Promise<void>;
}

/**
 * 建临时测试库（starter test 无 DB 测试先例，本文件即先例）：
 *
 * - schema datasource url 是字面量 `file:./local.db`——DATABASE_URL 环境变量对字面量
 *   不生效（实测恒解析到 prisma/local.db），故生成临时 schema 副本改
 *   `env("DATABASE_URL")` 后用 `prisma db push` 建表，DDL 始终以
 *   prisma/schema.prisma 为单一事实源（不手写建表 SQL）；
 * - migrate 体系批（2026-10-31）起生产契约是 `prisma migrate deploy`（journal
 *   版本化增量）；本测试桩保留 db push 快速通道（临时库随建随弃、无 journal
 *   需求）——与生产契约有意分离（spec §影响面），勿据此回改生产面；
 * - 测试实例经 PrismaClient `datasources` 运行时覆盖指向临时库
 *   （绝对路径，规避 SQLite 相对路径解析歧义，生产代码零改动）；
 * - 库置于 TIANSHU_DATA_ROOT 临时目录下（mirror ~/.tianshu 的 database/local.db 同构布局）。
 */
export async function createTestDb(): Promise<TestDb> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'tianshu-server-test-'));
  const originalDataRoot = process.env.TIANSHU_DATA_ROOT;
  process.env.TIANSHU_DATA_ROOT = dataRoot;

  const dbDir = join(dataRoot, 'database');
  mkdirSync(dbDir, { recursive: true });
  const dbUrl = `file:${join(dbDir, 'local.db')}`;

  const projectRoot = join(__dirname, '..', '..');
  const schema = readFileSync(
    join(projectRoot, 'prisma', 'schema.prisma'),
    'utf8',
  ).replace(/url\s*=\s*"file:\.\/local\.db"/, 'url = env("DATABASE_URL")');
  const tmpSchema = join(dataRoot, 'schema.prisma');
  writeFileSync(tmpSchema, schema);

  execSync(
    `node ${join(
      projectRoot,
      'node_modules',
      'prisma',
      'build',
      'index.js',
    )} db push --skip-generate --schema ${tmpSchema}`,
    { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'pipe' },
  );

  const prisma = new PrismaService({
    datasources: { db: { url: dbUrl } },
  });
  await prisma.$connect();

  return {
    prisma,
    dataRoot,
    cleanup: async () => {
      await prisma.$disconnect();
      rmSync(dataRoot, { recursive: true, force: true });
      if (originalDataRoot === undefined) {
        delete process.env.TIANSHU_DATA_ROOT;
      } else {
        process.env.TIANSHU_DATA_ROOT = originalDataRoot;
      }
    },
  };
}
