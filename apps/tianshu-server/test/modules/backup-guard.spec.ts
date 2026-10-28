// BackupGuard 双身份单测（spec 2026-10-28）：识别序——claim 路径豁免（不注入
// identity）→ 注册表客户端 → admin（BACKUP_TOKEN ?? TIANSHU_TOKEN）→ 401；
// 未设任何 token 且未带凭据（本地开发）回落 admin 放行。
// registry 替身与 backup-registry.spec 的 prisma stub 同款（惰性闭包，不实例化）。
// ctx 内 request 对象只建一次（getRequest 稳定返回）——guard 的 identity 注入
// 才能被 identityOf 回读（逐调用新建字面量则永远读到 undefined）。
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { BackupGuard } from 'src/modules/backup/backup.guard';

const registryStub = { findClientByToken: jest.fn() };
jest.mock('src/modules/backup/backup-registry', () => ({
  BackupRegistry: jest.fn(() => registryStub),
}));

const ctx = (authorization?: string, url = '/api/backup/list') => {
  const request = { headers: { authorization }, url };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
};
const identityOf = (c: ExecutionContext) =>
  (c.switchToHttp().getRequest() as { backupIdentity?: unknown })
    .backupIdentity;

describe('BackupGuard 双身份', () => {
  const ORIG_BACKUP = process.env.TIANSHU_BACKUP_TOKEN;
  const ORIG_TOKEN = process.env.TIANSHU_TOKEN;
  afterEach(() => {
    if (ORIG_BACKUP === undefined) delete process.env.TIANSHU_BACKUP_TOKEN;
    else process.env.TIANSHU_BACKUP_TOKEN = ORIG_BACKUP;
    // TIANSHU_TOKEN 同步恢复——用例 3 会设它，漏恢复会泄漏到后续用例
    if (ORIG_TOKEN === undefined) delete process.env.TIANSHU_TOKEN;
    else process.env.TIANSHU_TOKEN = ORIG_TOKEN;
    registryStub.findClientByToken.mockReset();
  });

  it('客户端 token 命中注册表 → identity client + clientId 注入', async () => {
    delete process.env.TIANSHU_BACKUP_TOKEN;
    registryStub.findClientByToken.mockResolvedValue({
      clientId: 'imac-1',
      tokenHash: 'h',
    });
    const c = ctx('Bearer client-token');
    await expect(
      new BackupGuard(registryStub as never).canActivate(c),
    ).resolves.toBe(true);
    expect(identityOf(c)).toEqual({ kind: 'client', clientId: 'imac-1' });
  });
  it('客户端 token 未命中 → 401（即便它等于 TIANSHU_TOKEN 也先按注册表查、未命中回落 admin 判定）', async () => {
    delete process.env.TIANSHU_BACKUP_TOKEN;
    registryStub.findClientByToken.mockResolvedValue(undefined);
    await expect(
      new BackupGuard(registryStub as never).canActivate(ctx('Bearer nope')),
    ).rejects.toThrow(UnauthorizedException);
  });
  it('admin：TIANSHU_TOKEN 匹配（未设 BACKUP_TOKEN）→ identity admin', async () => {
    delete process.env.TIANSHU_BACKUP_TOKEN;
    process.env.TIANSHU_TOKEN = 'global-tok';
    registryStub.findClientByToken.mockResolvedValue(undefined);
    const c = ctx('Bearer global-tok');
    await expect(
      new BackupGuard(registryStub as never).canActivate(c),
    ).resolves.toBe(true);
    expect(identityOf(c)).toEqual({ kind: 'admin' });
  });
  it('admin：BACKUP_TOKEN 设置时只认它（TIANSHU_TOKEN 被拒——现状语义不变）', async () => {
    process.env.TIANSHU_BACKUP_TOKEN = 'sekrit';
    registryStub.findClientByToken.mockResolvedValue(undefined);
    const c = ctx('Bearer sekrit');
    await expect(
      new BackupGuard(registryStub as never).canActivate(c),
    ).resolves.toBe(true);
    expect(identityOf(c)).toEqual({ kind: 'admin' });
    await expect(
      new BackupGuard(registryStub as never).canActivate(
        ctx('Bearer global-tok'),
      ),
    ).rejects.toThrow(UnauthorizedException);
  });
  it('设 BACKUP_TOKEN 时无 Authorization header → 401（收紧面不留匿名口）', async () => {
    process.env.TIANSHU_BACKUP_TOKEN = 'sekrit';
    registryStub.findClientByToken.mockResolvedValue(undefined);
    await expect(
      new BackupGuard(registryStub as never).canActivate(ctx(undefined)),
    ).rejects.toThrow(UnauthorizedException);
  });
  it('claim 路径豁免（不设 identity——单要素一次性邀请码自鉴权，不持二层 token）', async () => {
    registryStub.findClientByToken.mockResolvedValue(undefined);
    const c = ctx(undefined, '/api/backup/claim');
    expect(new BackupGuard(registryStub as never).canActivate(c)).toBe(true);
    expect(identityOf(c)).toBeUndefined();
  });
  it('未设任何 token（本地开发）→ admin identity 放行（现状回落）', async () => {
    delete process.env.TIANSHU_BACKUP_TOKEN;
    delete process.env.TIANSHU_TOKEN;
    registryStub.findClientByToken.mockResolvedValue(undefined);
    const c = ctx(undefined);
    await expect(
      new BackupGuard(registryStub as never).canActivate(c),
    ).resolves.toBe(true);
    expect(identityOf(c)).toEqual({ kind: 'admin' });
  });
});
