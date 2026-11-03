// relay-admin users API e2e（Task 10）：建户/列表/disable 级联/enable 不恢复
// AK/未鉴权 401/BusinessException 错误面——对 RaAppModule 整树起 Test 模块，
// 真实 RA Prisma 临时库 + 真实守卫/拦截器/过滤器链。
//
// 环境装配（fs mock + 临时库 + seed）已收编 helpers/（Task 12）；audit
// 断言用字面量 action 名（不用实现侧常量自比——跨段终验清单教训）。
import './helpers/ra-fs-mock';
import {
  createRaTestApp,
  createUserViaApi,
  destroyRaTestApp,
  RaTestApp,
} from './helpers/ra-test-app';

import * as http from 'node:http';
import request from 'supertest';

describe('relay-admin users API（Task 10）', () => {
  let ra: RaTestApp;

  /** 套件内便捷访问（装配产物解构） */
  let server: http.Server;
  let adminToken: string;

  beforeAll(async () => {
    ra = await createRaTestApp({ tmpPrefix: 'relay-admin-users-' });
    server = ra.server;
    adminToken = ra.adminToken;
  });

  afterAll(async () => {
    await destroyRaTestApp(ra);
  });

  it('POST /relay-admin/users → userId/tenantId 且落库；重复 name 允许、tenantId 唯一；audit user.create', async () => {
    const created = await createUserViaApi(server, adminToken, 'alice');
    expect(created.userId).toEqual(expect.any(String));
    expect(created.tenantId).toEqual(expect.any(String));

    // 落库核验：plan 缺省 beta、status active、creator 记管理员
    const row = await ra.raPrisma.raUser.findUniqueOrThrow({
      where: { id: created.userId },
    });
    expect(row.tenantId).toBe(created.tenantId);
    expect(row.name).toBe('alice');
    expect(row.plan).toBe('beta');
    expect(row.status).toBe('active');
    expect(row.creator).toBe('admin');

    // audit：user.create 一行，operator/target 落管理员/新户
    const createAudit = await ra.raPrisma.raAuditLog.findFirst({
      where: { action: 'user.create', operator: 'admin', target: created.userId },
    });
    expect(createAudit).not.toBeNull();

    // 重复 name 允许（tenantId 唯一即可——brief 规定）：两户并存、标识互异
    const duplicate = await createUserViaApi(server, adminToken, 'alice');
    expect(duplicate.userId).not.toBe(created.userId);
    expect(duplicate.tenantId).not.toBe(created.tenantId);
    const sameNameCount = await ra.raPrisma.raUser.count({
      where: { name: 'alice' },
    });
    expect(sameNameCount).toBe(2);
  });

  it('GET /relay-admin/users → 列表含已建用户（userId/tenantId/name/plan/status）', async () => {
    const created = await createUserViaApi(server, adminToken, 'carol');
    const response = await request(server)
      .get('/relay-admin/users')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(response.status).toBe(200);
    expect(response.body.code).toBe('2000');
    const list = response.body.data as Array<Record<string, unknown>>;
    const self = list.find((item) => item.userId === created.userId);
    expect(self).toEqual(
      expect.objectContaining({
        userId: created.userId,
        tenantId: created.tenantId,
        name: 'carol',
        plan: 'beta',
        status: 'active',
      }),
    );
  });

  it('disable → 用户 disabled + 该用户全部 AK 级联 disabled（不影响他人）+ audit 两行', async () => {
    const target = await createUserViaApi(server, adminToken, 'bob');
    const bystander = await createUserViaApi(server, adminToken, 'dave');

    // 种子 AK：目标用户 2 把（active + 已 disabled——级联必须覆盖全部），
    // 旁置用户 1 把（不受牵连）；secretHash/expireAt 为必填占位
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await ra.raPrisma.raAccessKey.create({
      data: {
        secretHash: 'a'.repeat(64),
        role: 'server',
        userId: target.userId,
        status: 'active',
        expireAt: tomorrow,
      },
    });
    await ra.raPrisma.raAccessKey.create({
      data: {
        secretHash: 'b'.repeat(64),
        role: 'client',
        userId: target.userId,
        status: 'disabled',
        expireAt: tomorrow,
      },
    });
    const bystanderAk = await ra.raPrisma.raAccessKey.create({
      data: {
        secretHash: 'c'.repeat(64),
        role: 'server',
        userId: bystander.userId,
        status: 'active',
        expireAt: tomorrow,
      },
    });

    const response = await request(server)
      .post(`/relay-admin/users/${target.userId}/disable`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(response.status).toBe(200);
    expect(response.body.code).toBe('2000');

    // 用户态 + 目标 AK 全部级联（含先前已 disabled 的）
    const userRow = await ra.raPrisma.raUser.findUniqueOrThrow({
      where: { id: target.userId },
    });
    expect(userRow.status).toBe('disabled');
    const targetAks = await ra.raPrisma.raAccessKey.findMany({
      where: { userId: target.userId },
    });
    expect(targetAks).toHaveLength(2);
    expect(targetAks.every((ak) => ak.status === 'disabled')).toBe(true);

    // 旁置用户 AK 不受牵连
    const bystanderAkRow = await ra.raPrisma.raAccessKey.findUniqueOrThrow({
      where: { id: bystanderAk.id },
    });
    expect(bystanderAkRow.status).toBe('active');

    // audit 两行：user.disable + ak 级联记录（operator 管理员、target 该用户）
    const audits = await ra.raPrisma.raAuditLog.findMany({
      where: { target: target.userId },
      orderBy: { createdAt: 'asc' },
    });
    const actions = audits.map((row) => row.action);
    expect(actions).toContain('user.disable');
    expect(actions).toContain('ak.cascade-disable');
    const disableAudit = audits.find((row) => row.action === 'user.disable');
    expect(disableAudit?.operator).toBe('admin');
  });

  it('enable → 用户恢复 active，AK 不自动恢复（保持 disabled）+ audit user.enable', async () => {
    // 独立造户：disable 后 enable，AK 种子一把 active
    const target = await createUserViaApi(server, adminToken, 'erin');
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await ra.raPrisma.raAccessKey.create({
      data: {
        secretHash: 'd'.repeat(64),
        role: 'server',
        userId: target.userId,
        status: 'active',
        expireAt: tomorrow,
      },
    });
    await request(server)
      .post(`/relay-admin/users/${target.userId}/disable`)
      .set('Authorization', `Bearer ${adminToken}`);
    const akAfterDisable = await ra.raPrisma.raAccessKey.findFirstOrThrow({
      where: { userId: target.userId },
    });
    expect(akAfterDisable.status).toBe('disabled');

    const response = await request(server)
      .post(`/relay-admin/users/${target.userId}/enable`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(response.status).toBe(200);
    expect(response.body.code).toBe('2000');

    const userRow = await ra.raPrisma.raUser.findUniqueOrThrow({
      where: { id: target.userId },
    });
    expect(userRow.status).toBe('active');

    // AK 不自动恢复：操作员须逐个 enable（Task 11 per-AK 端点）
    const akRow = await ra.raPrisma.raAccessKey.findFirstOrThrow({
      where: { userId: target.userId },
    });
    expect(akRow.status).toBe('disabled');

    const enableAudit = await ra.raPrisma.raAuditLog.findFirst({
      where: { action: 'user.enable', target: target.userId },
    });
    expect(enableAudit).not.toBeNull();
  });

  it('DTO 校验：缺 name / 非法 plan → 校验失败信封（success:false）', async () => {
    const missingName = await request(server)
      .post('/relay-admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plan: 'beta' });
    expect(missingName.body.success).toBe(false);
    expect(missingName.body.message).toContain('用户名不能为空');

    const badPlan = await request(server)
      .post('/relay-admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'frank', plan: 'pro' });
    expect(badPlan.body.success).toBe(false);
    expect(badPlan.body.message).toContain('套餐必须是 beta 之一');
  });

  it('disable/enable 不存在的用户 → BusinessException（code 4040）', async () => {
    const ghostId = '00000000-0000-4000-8000-000000000000';
    for (const action of ['disable', 'enable'] as const) {
      const response = await request(server)
        .post(`/relay-admin/users/${ghostId}/${action}`)
        .set('Authorization', `Bearer ${adminToken}`);
      // BusinessException 风格：HTTP 200 + {code:'4040',success:false,data:null}
      expect(response.status).toBe(200);
      expect(response.body.code).toBe('4040');
      expect(response.body.success).toBe(false);
      expect(response.body.data).toBeNull();
      expect(response.body.message).toBe('用户不存在');
    }
  });

  it('未鉴权访问 users 路由 → 401', async () => {
    const list = await request(server).get('/relay-admin/users');
    expect(list.status).toBe(401);

    const create = await request(server)
      .post('/relay-admin/users')
      .send({ name: 'noauth' });
    expect(create.status).toBe(401);

    const disable = await request(server).post(
      '/relay-admin/users/00000000-0000-4000-8000-000000000000/disable',
    );
    expect(disable.status).toBe(401);
  });
});
