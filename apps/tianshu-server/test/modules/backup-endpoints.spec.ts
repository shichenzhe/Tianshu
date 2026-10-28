// 备份多用户批（spec 2026-10-28）Task 5：claim/invites/clients 六端点
// controller 面直测——registry 全方法 stub + identity 经 req.backupIdentity
// 字面注入（guard 不在此层，直测门禁与透传）；service 面与本批端点无涉，
// 构造注入空占位。HTTP 管道（ValidationPipe 触发 DTO）由 starter 保障，
// DTO 装饰器经 class-validator validate() 直验存在（防装饰器被顺手抹掉）。
import { validate } from 'class-validator';
import {
  BackupController,
  ClaimDto,
  CreateInvitesDto,
} from 'src/modules/backup/backup.controller';

const registryStub = {
  claimInvite: jest.fn(),
  createInvites: jest.fn(),
  listInvites: jest.fn(),
  removeInvite: jest.fn(),
  listClients: jest.fn(),
  removeClient: jest.fn(),
};
const controller = new BackupController({} as never, registryStub as never);

const ADMIN_REQ = { backupIdentity: { kind: 'admin' } } as const;
const CLIENT_REQ = {
  backupIdentity: { kind: 'client', clientId: 'imac-1' },
} as const;

describe('BackupController claim/invites/clients（多用户批）', () => {
  beforeEach(() => {
    for (const fn of Object.values(registryStub)) fn.mockReset();
  });

  it('claim：同参直透 registry.claimInvite、结果直返（无 identity 要求）', async () => {
    registryStub.claimInvite.mockResolvedValue({
      clientId: 'imac-1',
      clientToken: 'tok-hex32',
    });
    const res = await controller.claim({
      inviteCode: 'TS-ABCDEFGH',
      deviceName: 'imac-1',
    });
    expect(registryStub.claimInvite).toHaveBeenCalledWith(
      'TS-ABCDEFGH',
      'imac-1',
    );
    expect(res).toEqual({ clientId: 'imac-1', clientToken: 'tok-hex32' });
  });

  it('invites/create：admin 透传 count+note；count 缺省 1（spec §2）', async () => {
    registryStub.createInvites.mockResolvedValue({ invites: [] });
    await controller.createInvites(ADMIN_REQ, { count: 3, note: '团队发放' });
    expect(registryStub.createInvites).toHaveBeenCalledWith(3, '团队发放');
    await controller.createInvites(ADMIN_REQ, {});
    expect(registryStub.createInvites).toHaveBeenCalledWith(1, undefined);
  });

  it('invites/create：client 拒 BACKUP_ADMIN_ONLY（门禁先于 registry）', async () => {
    await expect(
      controller.createInvites(CLIENT_REQ, { count: 1 }),
    ).rejects.toMatchObject({ code: 'BACKUP_ADMIN_ONLY' });
    expect(registryStub.createInvites).not.toHaveBeenCalled();
  });

  it('invites/list：admin 返回 {invites} 包装；client 拒 BACKUP_ADMIN_ONLY', async () => {
    registryStub.listInvites.mockResolvedValue([{ code: 'TS-ABCDEFGH' }]);
    const res = await controller.listInvites(ADMIN_REQ);
    expect(res).toEqual({ invites: [{ code: 'TS-ABCDEFGH' }] });
    await expect(controller.listInvites(CLIENT_REQ)).rejects.toMatchObject({
      code: 'BACKUP_ADMIN_ONLY',
    });
  });

  it('invites/:code/delete：admin 同参透传；client 拒 BACKUP_ADMIN_ONLY', async () => {
    registryStub.removeInvite.mockResolvedValue({ removed: true });
    await expect(
      controller.deleteInvite(ADMIN_REQ, 'TS-ABCDEFGH'),
    ).resolves.toEqual({ removed: true });
    expect(registryStub.removeInvite).toHaveBeenCalledWith('TS-ABCDEFGH');
    await expect(
      controller.deleteInvite(CLIENT_REQ, 'TS-ABCDEFGH'),
    ).rejects.toMatchObject({ code: 'BACKUP_ADMIN_ONLY' });
  });

  it('clients/list：admin 返回 {clients} 包装；client 拒 BACKUP_ADMIN_ONLY', async () => {
    registryStub.listClients.mockResolvedValue([{ clientId: 'imac-1' }]);
    const res = await controller.listClients(ADMIN_REQ);
    expect(res).toEqual({ clients: [{ clientId: 'imac-1' }] });
    await expect(controller.listClients(CLIENT_REQ)).rejects.toMatchObject({
      code: 'BACKUP_ADMIN_ONLY',
    });
  });

  it('clients/:clientId/delete：admin 同参透传；client 拒 BACKUP_ADMIN_ONLY', async () => {
    registryStub.removeClient.mockResolvedValue({ removed: true });
    await expect(controller.deleteClient(ADMIN_REQ, 'imac-1')).resolves.toEqual(
      { removed: true },
    );
    expect(registryStub.removeClient).toHaveBeenCalledWith('imac-1');
    await expect(
      controller.deleteClient(CLIENT_REQ, 'imac-1'),
    ).rejects.toMatchObject({ code: 'BACKUP_ADMIN_ONLY' });
  });

  it('BACKUP_ADMIN_ONLY 错码语义：消息「仅管理员可操作」', async () => {
    await expect(controller.listClients(CLIENT_REQ)).rejects.toMatchObject({
      code: 'BACKUP_ADMIN_ONLY',
      message: '仅管理员可操作',
    });
  });
});

describe('ClaimDto / CreateInvitesDto 校验存在（class-validator 直验）', () => {
  const badProps = async (dto: object) =>
    (await validate(dto)).map((e) => e.property);

  it('ClaimDto：inviteCode 合法基线零错（[A-Z2-9] 宽于生成字符集——伪码 registry 查无自拒）', async () => {
    expect(
      await badProps(
        Object.assign(new ClaimDto(), {
          inviteCode: 'TS-AB2XYZ9H',
          deviceName: 'imac_1-x',
        }),
      ),
    ).toEqual([]);
  });

  it('ClaimDto：inviteCode 非 TS- 前缀 8 位 [A-Z2-9] 各形态被拒', async () => {
    for (const inviteCode of [
      'XX-ABCDEFGH', // 前缀不符
      'ts-abcdefgh', // 小写
      'TS-ABCDEFG', // 7 位
      'TS-ABCDEFGHI', // 9 位
      'TS-AB1DEFGH', // 数字 1 不在字符集（防混淆剔除）
    ]) {
      expect(
        await badProps(
          Object.assign(new ClaimDto(), { inviteCode, deviceName: 'd' }),
        ),
      ).toEqual(['inviteCode']);
    }
  });

  it('ClaimDto：deviceName 空串/空白/超长/非白名单字符被拒', async () => {
    for (const deviceName of [
      '', // 空（MinLength(1)）
      'my imac', // 空白
      'a'.repeat(65), // 超长
      '设备-名', // 非 [a-zA-Z0-9_-]
    ]) {
      expect(
        await badProps(
          Object.assign(new ClaimDto(), {
            inviteCode: 'TS-ABCDEFGH',
            deviceName,
          }),
        ),
      ).toEqual(['deviceName']);
    }
  });

  it('CreateInvitesDto：count 1-50 整数（0/51/1.5 拒，1/50 过）；note ≤512', async () => {
    for (const count of [0, 51, 1.5]) {
      expect(
        await badProps(Object.assign(new CreateInvitesDto(), { count })),
      ).toEqual(['count']);
    }
    for (const count of [1, 50]) {
      expect(
        await badProps(Object.assign(new CreateInvitesDto(), { count })),
      ).toEqual([]);
    }
    expect(
      await badProps(
        Object.assign(new CreateInvitesDto(), { note: 'n'.repeat(513) }),
      ),
    ).toEqual(['note']);
    // count/note 均可缺省（IsOptional）
    expect(await badProps(new CreateInvitesDto())).toEqual([]);
  });
});
