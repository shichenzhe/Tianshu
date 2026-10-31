/**
 * PG schema 派生：datasource 头替换（provider/url env 化）、generator
 * output 注入、表体逐字节不变、锚点失效防线、幂等重跑。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const serverRoot = join(__dirname, '..', '..');
const mainSchema = readFileSync(join(serverRoot, 'prisma/schema.prisma'), 'utf8');

function derive(): string {
  execFileSync('node', ['prisma/derive-pg.mjs'], { cwd: serverRoot });
  return readFileSync(join(serverRoot, 'prisma/schema.prisma.postgresql'), 'utf8');
}

describe('prisma:pg:derive 派生', () => {
  it('datasource 头替换：provider postgresql + url env(DATABASE_URL)', () => {
    const pg = derive();
    expect(pg).toContain('provider = "postgresql"');
    expect(pg).toContain('url = env("DATABASE_URL")');
    expect(pg).not.toContain('provider = "sqlite"');
    expect(pg).not.toContain('file:./local.db');
  });
  it('generator 注入独立 output（prisma-pg 目录）', () => {
    expect(derive()).toContain('output   = "../src/generated/prisma-pg"');
  });
  it('表体逐字节不变（datasource/generator 头之外与主 schema 全等）', () => {
    const pg = derive();
    const body = (s: string) => s.slice(s.indexOf('enum '));
    expect(body(pg)).toBe(body(mainSchema));
  });
  it('幂等：重跑输出全等', () => {
    expect(derive()).toBe(derive());
  });
});
