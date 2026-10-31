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
  it('表体逐字节不变（显式剥离 datasource/generator 两个头块后与主 schema 全等）', () => {
    const pg = derive();
    // 显式剥离两个头块（generator + datasource——derive 唯一允许改写的
    // 面），余下表体逐字节比较；旧写法 slice(indexOf('enum ')) 起点在首个
    // enum，其前的全部 model 行根本没进比较面（终审 F6 盲区）
    const stripHeaderBlocks = (schema: string): string =>
      schema
        .replace(/^generator[^\n]*\{[^}]*\}\s*/m, '')
        .replace(/^datasource[^\n]*\{[^}]*\}\s*/m, '');
    const pgBody = stripHeaderBlocks(pg);
    const mainBody = stripHeaderBlocks(mainSchema);
    // 比较面真实存在（防两头都剥空后 ''==='' 假阳性全等）：表体从首个
    // model 起、覆盖全部 model/enum 行（当前 23 model + 1 enum，~475 行）
    expect(mainBody.startsWith('model ')).toBe(true);
    expect(mainBody).not.toContain('datasource');
    expect(mainBody).not.toContain('generator');
    expect((mainBody.match(/^model /gm) ?? []).length).toBeGreaterThanOrEqual(
      23,
    );
    expect(mainBody.split('\n').length).toBeGreaterThanOrEqual(400);
    expect(pgBody).toBe(mainBody);
  });
  it('幂等：重跑输出全等', () => {
    expect(derive()).toBe(derive());
  });
});
