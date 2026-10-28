// BackupRegistry 单测：注册表/邀请码 option 表读写 + claim 原子核销 + token 只存 hash。
// prisma stub 用内存 Map 模拟 option 表 upsert/findUnique（type+name 复合键）。
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { BackupRegistry } from 'src/modules/backup/backup-registry';

const optionRows = new Map<string, string>(); // key: `${type}/${name}` → value(JSON 字符串)
const prismaStub = {
  option: {
    // where 兼收 prisma 复合键 type_name 与扁平形（upsert 同款复合键）
    findUnique: jest.fn(async ({ where }: any) => {
      const w = where.type_name ?? where;
      const v = optionRows.get(`${w.type}/${w.name}`);
      return v === undefined ? null : { type: w.type, name: w.name, value: v };
    }),
    upsert: jest.fn(async ({ where, update, create }: any) => {
      const key = `${where.type_name.type}/${where.type_name.name}`;
      optionRows.set(key, (update ?? create).value);
      return { type: where.type_name.type, name: where.type_name.name };
    }),
  },
};
jest.mock('src/commons/database/prisma.service', () => ({
  PrismaService: jest.fn(() => prismaStub),
}));

const registry = () => new BackupRegistry(prismaStub as never);
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

describe('BackupRegistry', () => {
  beforeEach(() => {
    optionRows.clear();
  });

  it('createInvites：TS- 前缀 8 位防混淆字符集，note 透传', async () => {
    const r = await registry().createInvites(3, '团队发放');
    expect(r.invites).toHaveLength(3);
    for (const inv of r.invites) {
      expect(inv.code).toMatch(/^TS-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
      expect(inv.note).toBe('团队发放');
    }
  });

  it('claim：核销邀请码 + 注册设备 + token 明文仅此一次 + 落库仅 hash', async () => {
    const reg = registry();
    const [{ code }] = (await reg.createInvites(1)).invites;
    const claimed = await reg.claimInvite(code, 'zhangsan-imac');
    expect(claimed.clientId).toBe('zhangsan-imac');
    expect(claimed.clientToken).toMatch(/^[0-9a-f]{32}$/);
    // findClientByToken 能认；落库行不含明文
    const stored = await reg.findClientByToken(claimed.clientToken);
    expect(stored?.clientId).toBe('zhangsan-imac');
    expect(JSON.stringify([...optionRows.values()])).not.toContain(
      claimed.clientToken,
    );
    expect(stored?.tokenHash).toBe(sha256(claimed.clientToken));
  });

  it('claim：同码二次核销拒绝 BACKUP_INVITE_INVALID', async () => {
    const reg = registry();
    const [{ code }] = (await reg.createInvites(1)).invites;
    await reg.claimInvite(code, 'a-imac');
    await expect(reg.claimInvite(code, 'b-imac')).rejects.toMatchObject({
      code: 'BACKUP_INVITE_INVALID',
    });
  });

  it('claim：并发同码仅一次成功（原子核销）', async () => {
    const reg = registry();
    const [{ code }] = (await reg.createInvites(1)).invites;
    const results = await Promise.allSettled([
      reg.claimInvite(code, 'c1'),
      reg.claimInvite(code, 'c2'),
      reg.claimInvite(code, 'c3'),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(2);
    for (const r of bad)
      expect((r as PromiseRejectedResult).reason.code).toBe(
        'BACKUP_INVITE_INVALID',
      );
  });

  it('claim：设备名已注册拒绝 BACKUP_CLIENT_NAME_TAKEN', async () => {
    const reg = registry();
    const [i1, i2] = (await reg.createInvites(2)).invites;
    await reg.claimInvite(i1.code, 'dup-imac');
    await expect(reg.claimInvite(i2.code, 'dup-imac')).rejects.toMatchObject({
      code: 'BACKUP_CLIENT_NAME_TAKEN',
    });
  });

  it('removeClient 后设备名可重新申领 + findClientByToken 失效', async () => {
    const reg = registry();
    const [i1, i2] = (await reg.createInvites(2)).invites;
    const first = await reg.claimInvite(i1.code, 're-imac');
    await reg.removeClient('re-imac');
    expect(await reg.findClientByToken(first.clientToken)).toBeUndefined();
    const second = await reg.claimInvite(i2.code, 're-imac');
    expect(second.clientToken).not.toBe(first.clientToken);
  });

  it('listClients/listInvites：不含敏感字段；remove 不存在抛 BACKUP_NOT_FOUND', async () => {
    const reg = registry();
    const [{ code }] = (await reg.createInvites(1)).invites;
    await reg.claimInvite(code, 'vis-imac');
    expect(await reg.listClients()).toEqual([
      expect.objectContaining({ clientId: 'vis-imac' }),
    ]);
    expect(JSON.stringify(await reg.listClients())).not.toContain('tokenHash');
    await expect(reg.removeClient('ghost')).rejects.toMatchObject({
      code: 'BACKUP_NOT_FOUND',
    });
    await expect(reg.removeInvite('TS-XXXXXXXX')).rejects.toMatchObject({
      code: 'BACKUP_NOT_FOUND',
    });
  });

  it('坏档容错留痕（终审 M4）：坏 JSON/非数组 warn 后回落空数组，无行不告警', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      // 非 JSON → 空数组 + warn（防下次写回静默清账无痕可追）
      optionRows.set('app/backupClients', '{"broken":');
      expect(await registry().listClients()).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      // 合法 JSON 但非数组 → 同款 warn
      optionRows.set('app/backupClients', '{"kind":"not-array"}');
      expect(await registry().listClients()).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      // 无行=新装空账，非异常不告警
      optionRows.clear();
      expect(await registry().listClients()).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
