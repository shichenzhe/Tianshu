// .env 密钥写入（spec §13 项 6）：upsertEnvSecret 幂等——新键追加、
// 已有键原位替换、其余行保留。
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { upsertEnvSecret } from '../../scripts/lib/env-file.js';

describe('upsertEnvSecret（.env JWT_SECRET 写入）', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ts-env-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('.env 不存在：创建并写入单行', async () => {
    const envPath = await upsertEnvSecret(dir, 'abc123');
    expect(envPath).toBe(join(dir, '.env'));
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe(
      'JWT_SECRET=abc123\n',
    );
  });

  it('已有 JWT_SECRET 行：原位替换（其余行保留）', async () => {
    await writeFile(
      join(dir, '.env'),
      'DATABASE_URL=postgresql://x\nJWT_SECRET=old-value\nTIANSHU_TOKEN=t\n',
    );
    await upsertEnvSecret(dir, 'new-value');
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe(
      'DATABASE_URL=postgresql://x\nJWT_SECRET=new-value\nTIANSHU_TOKEN=t\n',
    );
  });

  it('前缀同名键不误吞（F6）：JWT_SECRET_EXTRA= 行原样保留，仅正键被替换', async () => {
    await writeFile(
      join(dir, '.env'),
      'JWT_SECRET_EXTRA=keep-me\nJWT_SECRET=old-value\n',
    );
    await upsertEnvSecret(dir, 'new-value');
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe(
      'JWT_SECRET_EXTRA=keep-me\nJWT_SECRET=new-value\n',
    );
  });

  it('幂等：连续两次同值写入结果一致', async () => {
    await upsertEnvSecret(dir, 'stable');
    await upsertEnvSecret(dir, 'stable');
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe(
      'JWT_SECRET=stable\n',
    );
  });
});
