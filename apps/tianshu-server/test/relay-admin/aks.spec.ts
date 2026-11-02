// relay-admin aks API e2e（Task 11）：签发（secret hash 落库、明文仅一次）/
// isAkUsable 四失败 reason + 成功 quota / disable→disabled / rotate 双向 /
// 过期 expired / 禁用用户拒签 / extend 只能延后——对 RaAppModule 整树起
// Test 模块，真实 RA Prisma 临时库 + 真实守卫/拦截器/过滤器链。
//
// 环境装配（fs mock + 临时库 + seed）已收编 helpers/（Task 12）；
// isAkUsable 是 Task 12 token 端点的服务面入口，测试经 app.get(AksService)
// 直调（Task 12 token.spec 再经 HTTP 面复验）；audit 断言用字面量 action 名
// （不用实现侧常量自比——跨段终验清单教训）；期望 sha256 由测试侧
// node:crypto 独立计算（不引实现函数）。
import './helpers/ra-fs-mock';
import {
  createRaTestApp,
  createUserViaApi,
  destroyRaTestApp,
  issueAkViaApi,
  RaTestApp,
} from './helpers/ra-test-app';

import * as http from 'node:http';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { AksService } from 'src/relay-admin/aks/aks.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 测试侧独立计算 sha256 hex（不引实现函数——期望值不与实现自比） */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

describe('relay-admin aks API（Task 11）', () => {
  let ra: RaTestApp;
  let server: http.Server;
  let adminToken: string;
  let aksService: AksService;

  beforeAll(async () => {
    ra = await createRaTestApp({ tmpPrefix: 'relay-admin-aks-' });
    server = ra.server;
    adminToken = ra.adminToken;
    aksService = ra.app.get(AksService);
  });

  afterAll(async () => {
    await destroyRaTestApp(ra);
  });

  it('POST /relay-admin/aks → akId/akSecret；库中 secretHash===sha256(明文)；expireAt 缺省 365d；audit ak.create', async () => {
    const user = await createUserViaApi(server, adminToken, 'ak-owner');

    const issued = await issueAkViaApi(server, adminToken, user.userId);
    // akId 为 UUID、akSecret 为 32B hex（64 字符）——spec §5.2
    expect(issued.akId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(issued.akSecret).toMatch(/^[0-9a-f]{64}$/);

    // 库中只存 sha256(明文)：期望值由测试侧独立计算
    const row = await ra.raPrisma.raAccessKey.findUniqueOrThrow({
      where: { id: issued.akId },
    });
    expect(row.secretHash).toBe(sha256Hex(issued.akSecret));
    expect(row.secretHash).not.toBe(issued.akSecret);
    expect(row.role).toBe('server');
    expect(row.userId).toBe(user.userId);
    expect(row.status).toBe('active');
    expect(row.creator).toBe('admin');

    // expireAt 缺省 now+365d（容差 ±1d）
    expect(row.expireAt.getTime()).toBeGreaterThan(
      Date.now() + 364 * DAY_MS,
    );
    expect(row.expireAt.getTime()).toBeLessThan(Date.now() + 366 * DAY_MS);

    // audit：ak.create 一行（operator 管理员、target akId）
    const createAudit = await ra.raPrisma.raAuditLog.findFirst({
      where: { action: 'ak.create', operator: 'admin', target: issued.akId },
    });
    expect(createAudit).not.toBeNull();
  });

  it('isAkUsable 成功路径 → ok:true、userId/role 回带、quota 为所属用户 plan（beta）配额', async () => {
    const user = await createUserViaApi(server, adminToken, 'quota-owner');
    const issued = await issueAkViaApi(server, adminToken, user.userId, {
      role: 'client',
    });

    const result = await aksService.isAkUsable(issued.akId, issued.akSecret);
    expect(result).toEqual({
      ok: true,
      userId: user.userId,
      role: 'client',
      quota: { maxServers: 5, maxClients: 10 },
    });
  });

  it('isAkUsable 四种失败 reason：not-found / bad-secret / disabled / expired', async () => {
    // not-found：幽灵 akId
    const ghost = await aksService.isAkUsable(
      '00000000-0000-4000-8000-000000000000',
      'whatever-secret',
    );
    expect(ghost).toEqual({ ok: false, reason: 'not-found' });

    // bad-secret：合法 AK + 错误 secret
    const user = await createUserViaApi(server, adminToken, 'bad-secret-owner');
    const issued = await issueAkViaApi(server, adminToken, user.userId);
    const wrongSecret = await aksService.isAkUsable(issued.akId, 'f'.repeat(64));
    expect(wrongSecret).toEqual({ ok: false, reason: 'bad-secret' });

    // disabled：禁用后正确 secret 也不可用
    const disabledUser = await createUserViaApi(
      server,
      adminToken,
      'disabled-ak-owner',
    );
    const disabledAk = await issueAkViaApi(
      server,
      adminToken,
      disabledUser.userId,
    );
    await request(server)
      .post(`/relay-admin/aks/${disabledAk.akId}/disable`)
      .set('Authorization', `Bearer ${adminToken}`);
    const disabledResult = await aksService.isAkUsable(
      disabledAk.akId,
      disabledAk.akSecret,
    );
    expect(disabledResult).toEqual({ ok: false, reason: 'disabled' });

    // expired：过期后正确 secret 也不可用（种子行 expireAt 置过去）
    const expiredUser = await createUserViaApi(
      server,
      adminToken,
      'expired-ak-owner',
    );
    const expiredSecret = 'e'.repeat(64);
    const expiredAk = await ra.raPrisma.raAccessKey.create({
      data: {
        secretHash: sha256Hex(expiredSecret),
        role: 'server',
        userId: expiredUser.userId,
        status: 'active',
        expireAt: new Date(Date.now() - DAY_MS),
      },
    });
    const expiredResult = await aksService.isAkUsable(
      expiredAk.id,
      expiredSecret,
    );
    expect(expiredResult).toEqual({ ok: false, reason: 'expired' });
  });

  it('isAkUsable 纵深（Task 12）：属主用户被禁用而 AK 仍 active（直插库绕过级联）→ disabled', async () => {
    // 正常路径 users.disable 已级联禁用 AK；本用例直插库只禁用用户，
    // 证明 isAkUsable 对属主状态的独立闸（旁路写入/级联中断的第二道防线）
    const user = await createUserViaApi(server, adminToken, 'depth-owner');
    const issued = await issueAkViaApi(server, adminToken, user.userId);
    await ra.raPrisma.raUser.update({
      where: { id: user.userId },
      data: { status: 'disabled' },
    });
    const akRow = await ra.raPrisma.raAccessKey.findUniqueOrThrow({
      where: { id: issued.akId },
    });
    expect(akRow.status).toBe('active'); // AK 本身仍 active（未走级联）

    expect(
      await aksService.isAkUsable(issued.akId, issued.akSecret),
    ).toEqual({ ok: false, reason: 'disabled' });
  });

  it('disable/enable 端点 → 状态翻转 + isAkUsable 随动 + audit ak.disable/ak.enable', async () => {
    const user = await createUserViaApi(server, adminToken, 'flip-owner');
    const issued = await issueAkViaApi(server, adminToken, user.userId);

    const disable = await request(server)
      .post(`/relay-admin/aks/${issued.akId}/disable`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(disable.status).toBe(200);
    expect(disable.body.code).toBe('2000');
    expect(
      await aksService.isAkUsable(issued.akId, issued.akSecret),
    ).toEqual({ ok: false, reason: 'disabled' });
    expect(
      await ra.raPrisma.raAuditLog.findFirst({
        where: { action: 'ak.disable', operator: 'admin', target: issued.akId },
      }),
    ).not.toBeNull();

    const enable = await request(server)
      .post(`/relay-admin/aks/${issued.akId}/enable`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(enable.status).toBe(200);
    expect(enable.body.code).toBe('2000');
    expect(
      await aksService.isAkUsable(issued.akId, issued.akSecret),
    ).toEqual({ ok: true, userId: user.userId, role: 'server', quota: { maxServers: 5, maxClients: 10 } });
    expect(
      await ra.raPrisma.raAuditLog.findFirst({
        where: { action: 'ak.enable', operator: 'admin', target: issued.akId },
      }),
    ).not.toBeNull();
  });

  it('rotate-secret → 新明文 ok、旧明文 bad-secret；库 hash 替换；audit ak.rotate-secret', async () => {
    const user = await createUserViaApi(server, adminToken, 'rotate-owner');
    const first = await issueAkViaApi(server, adminToken, user.userId);

    const rotate = await request(server)
      .post(`/relay-admin/aks/${first.akId}/rotate-secret`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(rotate.status).toBe(200);
    expect(rotate.body.code).toBe('2000');
    const second = rotate.body.data as { akId: string; akSecret: string };
    expect(second.akId).toBe(first.akId);
    expect(second.akSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(second.akSecret).not.toBe(first.akSecret);

    // 旧 secret 即刻失效、新 secret 可用
    expect(await aksService.isAkUsable(first.akId, first.akSecret)).toEqual({
      ok: false,
      reason: 'bad-secret',
    });
    expect(await aksService.isAkUsable(first.akId, second.akSecret)).toEqual({
      ok: true,
      userId: user.userId,
      role: 'server',
      quota: { maxServers: 5, maxClients: 10 },
    });

    // 库中 hash 已替换为新明文的摘要
    const row = await ra.raPrisma.raAccessKey.findUniqueOrThrow({
      where: { id: first.akId },
    });
    expect(row.secretHash).toBe(sha256Hex(second.akSecret));

    expect(
      await ra.raPrisma.raAuditLog.findFirst({
        where: {
          action: 'ak.rotate-secret',
          operator: 'admin',
          target: first.akId,
        },
      }),
    ).not.toBeNull();
  });

  it('extend → expireAt 延后成功 + audit ak.extend；提前（早于现有 expireAt）→ BusinessException 拒绝', async () => {
    const user = await createUserViaApi(server, adminToken, 'extend-owner');
    const issued = await issueAkViaApi(server, adminToken, user.userId, {
      expireAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    });
    const initial = await ra.raPrisma.raAccessKey.findUniqueOrThrow({
      where: { id: issued.akId },
    });
    expect(initial.expireAt.getTime()).toBeGreaterThan(
      Date.now() + 29 * DAY_MS,
    );

    // 延后：+30d → +60d
    const laterIso = new Date(Date.now() + 60 * DAY_MS).toISOString();
    const extend = await request(server)
      .post(`/relay-admin/aks/${issued.akId}/extend`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ expireAt: laterIso });
    expect(extend.status).toBe(200);
    expect(extend.body.code).toBe('2000');
    const extended = await ra.raPrisma.raAccessKey.findUniqueOrThrow({
      where: { id: issued.akId },
    });
    expect(extended.expireAt.getTime()).toBeGreaterThan(
      Date.now() + 59 * DAY_MS,
    );
    expect(
      await ra.raPrisma.raAuditLog.findFirst({
        where: { action: 'ak.extend', operator: 'admin', target: issued.akId },
      }),
    ).not.toBeNull();

    // 提前：现 +60d → 尝试 +10d，拒绝且库值不变
    const earlierIso = new Date(Date.now() + 10 * DAY_MS).toISOString();
    const reject = await request(server)
      .post(`/relay-admin/aks/${issued.akId}/extend`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ expireAt: earlierIso });
    expect(reject.status).toBe(200); // BusinessException 风格：HTTP 200 + success:false
    expect(reject.body.success).toBe(false);
    expect(reject.body.data).toBeNull();
    expect(reject.body.message).toContain('只能延后');
    const afterReject = await ra.raPrisma.raAccessKey.findUniqueOrThrow({
      where: { id: issued.akId },
    });
    expect(afterReject.expireAt.getTime()).toBe(extended.expireAt.getTime());
  });

  it('对不存在/已禁用用户签发 AK → BusinessException 拒绝', async () => {
    const ghost = await request(server)
      .post('/relay-admin/aks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: '00000000-0000-4000-8000-000000000000', role: 'server' });
    expect(ghost.status).toBe(200);
    expect(ghost.body.code).toBe('4040');
    expect(ghost.body.success).toBe(false);
    expect(ghost.body.data).toBeNull();
    expect(ghost.body.message).toBe('用户不存在');

    const user = await createUserViaApi(server, adminToken, 'frozen-owner');
    await request(server)
      .post(`/relay-admin/users/${user.userId}/disable`)
      .set('Authorization', `Bearer ${adminToken}`);
    const frozen = await request(server)
      .post('/relay-admin/aks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: user.userId, role: 'client' });
    expect(frozen.status).toBe(200);
    expect(frozen.body.success).toBe(false);
    expect(frozen.body.data).toBeNull();
    expect(frozen.body.message).toContain('禁用');

    // 库中无 AK 落行（拒绝路径零写入）
    expect(
      await ra.raPrisma.raAccessKey.count({ where: { userId: user.userId } }),
    ).toBe(0);
  });

  it('GET /relay-admin/aks?userId= → 该用户 AK 列表（akId/role/status/expireAt、无 secret 泄露面）；不混入他人 AK', async () => {
    const owner = await createUserViaApi(server, adminToken, 'list-owner');
    const other = await createUserViaApi(server, adminToken, 'list-bystander');
    const serverAk = await issueAkViaApi(server, adminToken, owner.userId, {
      role: 'server',
    });
    await issueAkViaApi(server, adminToken, owner.userId, { role: 'client' });
    await issueAkViaApi(server, adminToken, other.userId, { role: 'server' });

    const response = await request(server)
      .get(`/relay-admin/aks?userId=${owner.userId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(response.status).toBe(200);
    expect(response.body.code).toBe('2000');
    const list = response.body.data as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    const ids = list.map((item) => item.akId);
    expect(ids).toContain(serverAk.akId);
    expect(list.every((item) => item.userId === owner.userId)).toBe(true);

    const item = list.find((row) => row.akId === serverAk.akId);
    expect(item).toEqual(
      expect.objectContaining({
        akId: serverAk.akId,
        role: 'server',
        userId: owner.userId,
        status: 'active',
      }),
    );
    // 列表不透出 secretHash/明文（字段白名单式 DTO）
    expect(item).not.toHaveProperty('secretHash');
    expect(item).not.toHaveProperty('akSecret');

    // userId 查询参数缺省 → 校验失败信封
    const missing = await request(server)
      .get('/relay-admin/aks')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(missing.body.success).toBe(false);
  });

  it('DTO 校验：非法 role / 非法 expireAt → 校验失败信封（success:false）', async () => {
    const user = await createUserViaApi(server, adminToken, 'dto-owner');

    const badRole = await request(server)
      .post('/relay-admin/aks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: user.userId, role: 'admin' });
    expect(badRole.body.success).toBe(false);
    expect(badRole.body.message).toContain('角色必须是 server/client 之一');

    const badExpire = await request(server)
      .post('/relay-admin/aks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        userId: user.userId,
        role: 'server',
        expireAt: 'not-a-date',
      });
    expect(badExpire.body.success).toBe(false);
    expect(badExpire.body.message).toContain('合法日期');
  });

  it('disable/enable/rotate/extend 幽灵 akId → BusinessException（code 4040）', async () => {
    const ghostId = '00000000-0000-4000-8000-000000000000';
    for (const action of [
      'disable',
      'enable',
      'rotate-secret',
      'extend',
    ] as const) {
      const response = await request(server)
        .post(`/relay-admin/aks/${ghostId}/${action}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(action === 'extend' ? { expireAt: new Date().toISOString() } : {});
      expect(response.status).toBe(200);
      expect(response.body.code).toBe('4040');
      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('AK 不存在');
    }
  });

  it('未鉴权访问 aks 路由 → 401', async () => {
    const list = await request(server).get('/relay-admin/aks?userId=any');
    expect(list.status).toBe(401);

    const create = await request(server)
      .post('/relay-admin/aks')
      .send({ userId: 'any', role: 'server' });
    expect(create.status).toBe(401);

    const disable = await request(server).post(
      '/relay-admin/aks/00000000-0000-4000-8000-000000000000/disable',
    );
    expect(disable.status).toBe(401);
  });
});
