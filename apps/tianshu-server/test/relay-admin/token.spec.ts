// relay-admin token 换发 + revocations 名单 e2e（Task 12）：合法 Basic →
// 三段式 access（verifyAccessJwt 用 Task 2 单份实现还原 claims——tid/role/
// quota/exp≈30d）；错 secret/禁用/过期/幽灵 → 401 各 reason；属主禁用
// （直插库绕过级联）→ 401 disabled（T11 复审带进的纵深）；密钥落盘
// 0600；revocations 名单（禁 AK → akId、禁用户 → tenantId）+ epoch 递增
// + internal secret 鉴权（错 401 / 未配置 503 fail-closed）。
//
// 环境装配（fs mock + 临时库 + seed）收编 helpers/（Task 12）；RA_DATA_DIR
// 指向临时目录（密钥落盘不污染仓库）；期望 sha256 由测试侧 node:crypto
// 独立计算（不引实现函数——跨段终验清单教训）。
import './helpers/ra-fs-mock';
import {
  createRaTestApp,
  createUserViaApi,
  destroyRaTestApp,
  issueAkViaApi,
  RaTestApp,
} from './helpers/ra-test-app';

import * as http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { verifyAccessJwt } from 'src/relay/jwt-eddsa';
import { KeypairService } from 'src/relay-admin/keys/keypair.service';

const INTERNAL_SECRET = 'ra-token-test-internal-secret';
const DAY_MS = 24 * 60 * 60 * 1000;
const ACCESS_TTL_SEC = 30 * 24 * 60 * 60; // 2592000（spec §5.3 30d）

/** Basic 凭证头（akId 作用户名、akSecret 作密码——spec §5.2） */
function basic(akId: string, akSecret: string): string {
  return `Basic ${Buffer.from(`${akId}:${akSecret}`).toString('base64')}`;
}

/** 测试侧独立计算 sha256 hex（不引实现函数——期望值不与实现自比） */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

describe('relay-admin token + revocations（Task 12）', () => {
  let ra: RaTestApp;
  let server: http.Server;
  let adminToken: string;
  let keypair: KeypairService;

  beforeAll(async () => {
    ra = await createRaTestApp({
      tmpPrefix: 'relay-admin-token-',
      extraEnv: (tmpRoot) => ({
        RA_DATA_DIR: tmpRoot,
        RA_INTERNAL_SECRET: INTERNAL_SECRET,
      }),
    });
    server = ra.server;
    adminToken = ra.adminToken;
    keypair = ra.app.get(KeypairService);
  });

  afterAll(async () => {
    await destroyRaTestApp(ra);
  });

  it('合法 Basic → {accessToken, expiresAt(ms), maxAgeSec:2592000}；三段式 token 经 verifyAccessJwt 还原全部 claims', async () => {
    const user = await createUserViaApi(server, adminToken, 'token-owner');
    const issued = await issueAkViaApi(server, adminToken, user.userId, {
      role: 'server',
    });

    const response = await request(server)
      .post('/relay-admin/token')
      .set('Authorization', basic(issued.akId, issued.akSecret));
    expect(response.status).toBe(200);
    expect(response.body.code).toBe('2000');
    expect(response.body.success).toBe(true);
    const data = response.body.data as {
      accessToken: string;
      expiresAt: number;
      maxAgeSec: number;
    };
    expect(data.accessToken.split('.')).toHaveLength(3);
    expect(data.maxAgeSec).toBe(2592000);
    expect(typeof data.expiresAt).toBe('number');

    // 验签用 Task 2 单份实现 + 服务侧公钥（与私钥同对）
    const claims = verifyAccessJwt(data.accessToken, keypair.getPublicKeyPem());
    expect(claims).not.toBeNull();
    expect(claims!.iss).toBe('tianshu-relay');
    expect(claims!.sub).toBe(user.userId);
    expect(claims!.tid).toBe(user.tenantId);
    expect(claims!.role).toBe('server');
    expect(claims!.ak).toBe(issued.akId);
    expect(claims!.quota).toEqual({ maxServers: 5, maxClients: 10 });
    expect(claims!.exp - claims!.iat).toBe(ACCESS_TTL_SEC);
    expect(claims!.exp).toBeGreaterThan(
      Math.floor(Date.now() / 1000) + 29 * 24 * 60 * 60,
    );
    expect(claims!.exp).toBeLessThan(
      Math.floor(Date.now() / 1000) + 31 * 24 * 60 * 60,
    );
    expect(claims!.jti).toEqual(expect.any(String));
    expect(typeof claims!.kid).toBe('string');
    // expiresAt 即 exp 的 ms 形态
    expect(data.expiresAt).toBe(claims!.exp * 1000);

    // 密钥首启落盘：{RA_DATA_DIR}/keys/relay-access.pem 0600 + 公钥伴随
    const keyPath = join(ra.tmpRoot, 'keys', 'relay-access.pem');
    expect(existsSync(keyPath)).toBe(true);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(
      existsSync(join(ra.tmpRoot, 'keys', 'relay-access.pub.pem')),
    ).toBe(true);
    // 落盘私钥与内存同一把（此后走加载路径，不重生）
    expect(readFileSync(keyPath, 'utf8')).toBe(keypair.getPrivateKeyPem());
  });

  it('client 角色 AK → 换得 client role 的 access（role 分离，同一公钥可验）', async () => {
    const user = await createUserViaApi(server, adminToken, 'client-role-owner');
    const issued = await issueAkViaApi(server, adminToken, user.userId, {
      role: 'client',
    });

    const response = await request(server)
      .post('/relay-admin/token')
      .set('Authorization', basic(issued.akId, issued.akSecret));
    expect(response.status).toBe(200);
    const claims = verifyAccessJwt(
      response.body.data.accessToken,
      keypair.getPublicKeyPem(),
    );
    expect(claims!.role).toBe('client');
    expect(claims!.tid).toBe(user.tenantId);
  });

  it('错 secret / 幽灵 akId / 禁用 AK / 过期 AK → 401 各 reason（data.reason 机器可读）', async () => {
    const user = await createUserViaApi(server, adminToken, 'fail-owner');
    const issued = await issueAkViaApi(server, adminToken, user.userId);

    // bad-secret：合法 akId + 错 secret
    const wrongSecret = await request(server)
      .post('/relay-admin/token')
      .set('Authorization', basic(issued.akId, 'f'.repeat(64)));
    expect(wrongSecret.status).toBe(401);
    expect(wrongSecret.body.code).toBe('4010');
    expect(wrongSecret.body.success).toBe(false);
    expect(wrongSecret.body.data).toEqual({ reason: 'bad-secret' });
    expect(wrongSecret.body.message).toEqual(expect.any(String));

    // not-found：幽灵 akId
    const ghost = await request(server)
      .post('/relay-admin/token')
      .set('Authorization', basic('00000000-0000-4000-8000-000000000000', 'x'));
    expect(ghost.status).toBe(401);
    expect(ghost.body.data).toEqual({ reason: 'not-found' });

    // disabled：禁用后正确 secret 也不可用
    await request(server)
      .post(`/relay-admin/aks/${issued.akId}/disable`)
      .set('Authorization', `Bearer ${adminToken}`);
    const disabled = await request(server)
      .post('/relay-admin/token')
      .set('Authorization', basic(issued.akId, issued.akSecret));
    expect(disabled.status).toBe(401);
    expect(disabled.body.data).toEqual({ reason: 'disabled' });

    // expired：种子过期行 + 正确 secret
    const expiredSecret = 'e'.repeat(64);
    const expiredAk = await ra.raPrisma.raAccessKey.create({
      data: {
        secretHash: sha256Hex(expiredSecret),
        role: 'server',
        userId: user.userId,
        status: 'active',
        expireAt: new Date(Date.now() - DAY_MS),
      },
    });
    const expired = await request(server)
      .post('/relay-admin/token')
      .set('Authorization', basic(expiredAk.id, expiredSecret));
    expect(expired.status).toBe(401);
    expect(expired.body.data).toEqual({ reason: 'expired' });
  });

  it('属主用户被禁用而 AK 仍 active（直插库绕过级联）→ 401 disabled（纵深）', async () => {
    const user = await createUserViaApi(server, adminToken, 'depth-token-owner');
    const issued = await issueAkViaApi(server, adminToken, user.userId);
    await ra.raPrisma.raUser.update({
      where: { id: user.userId },
      data: { status: 'disabled' },
    });
    const akRow = await ra.raPrisma.raAccessKey.findUniqueOrThrow({
      where: { id: issued.akId },
    });
    expect(akRow.status).toBe('active'); // AK 本身仍 active

    const response = await request(server)
      .post('/relay-admin/token')
      .set('Authorization', basic(issued.akId, issued.akSecret));
    expect(response.status).toBe(401);
    expect(response.body.data).toEqual({ reason: 'disabled' });
  });

  it('Basic 头缺失/非 Basic/无冒号 → 401（不进入凭证判定）', async () => {
    const missing = await request(server).post('/relay-admin/token');
    expect(missing.status).toBe(401);

    const notBasic = await request(server)
      .post('/relay-admin/token')
      .set('Authorization', 'Bearer some-token');
    expect(notBasic.status).toBe(401);

    const noColon = await request(server)
      .post('/relay-admin/token')
      .set(
        'Authorization',
        `Basic ${Buffer.from('no-separator-here').toString('base64')}`,
      );
    expect(noColon.status).toBe(401);
    expect(noColon.body.data).toEqual({ reason: 'bad-secret' });
  });

  it('换 token 不落审计（renew 高频不记——spec §6）', async () => {
    const user = await createUserViaApi(server, adminToken, 'no-audit-owner');
    const issued = await issueAkViaApi(server, adminToken, user.userId);

    const before = await ra.raPrisma.raAuditLog.count();
    const ok = await request(server)
      .post('/relay-admin/token')
      .set('Authorization', basic(issued.akId, issued.akSecret));
    expect(ok.status).toBe(200);
    const fail = await request(server)
      .post('/relay-admin/token')
      .set('Authorization', basic(issued.akId, 'wrong'));
    expect(fail.status).toBe(401);
    expect(await ra.raPrisma.raAuditLog.count()).toBe(before);
  });

  it('revocations：禁用一个 AK → 名单含其 akId（不含未涉租户）；禁用用户 → tenantId 入名单；epoch 严格递增', async () => {
    // AK 维度：禁用一把 AK 不牵连租户
    const akUser = await createUserViaApi(server, adminToken, 'crl-ak-user');
    const issued = await issueAkViaApi(server, adminToken, akUser.userId);

    const before = await request(server)
      .get('/relay-admin/revocations')
      .set('Authorization', `Bearer ${INTERNAL_SECRET}`);
    expect(before.status).toBe(200);
    expect(typeof before.body.epoch).toBe('number');
    expect(before.body.revokedAk).not.toContain(issued.akId);
    expect(before.body.revokedTenant).not.toContain(akUser.tenantId);

    await request(server)
      .post(`/relay-admin/aks/${issued.akId}/disable`)
      .set('Authorization', `Bearer ${adminToken}`);

    const after = await request(server)
      .get('/relay-admin/revocations')
      .set('Authorization', `Bearer ${INTERNAL_SECRET}`);
    expect(after.status).toBe(200);
    expect(after.body.revokedAk).toContain(issued.akId);
    expect(after.body.epoch).toBeGreaterThan(before.body.epoch);
    // 仅禁 AK：租户不入名单（用户仍 active）
    expect(after.body.revokedTenant).not.toContain(akUser.tenantId);

    // 租户维度：禁用用户（级联 AK）→ tenantId 与级联 AK 双入名单
    const tenantUser = await createUserViaApi(
      server,
      adminToken,
      'crl-tenant-user',
    );
    const tenantAk = await issueAkViaApi(server, adminToken, tenantUser.userId);
    await request(server)
      .post(`/relay-admin/users/${tenantUser.userId}/disable`)
      .set('Authorization', `Bearer ${adminToken}`);
    const afterUser = await request(server)
      .get('/relay-admin/revocations')
      .set('Authorization', `Bearer ${INTERNAL_SECRET}`);
    expect(afterUser.body.revokedTenant).toContain(tenantUser.tenantId);
    expect(afterUser.body.revokedAk).toContain(tenantAk.akId);
    expect(afterUser.body.epoch).toBeGreaterThan(after.body.epoch);
  });

  it('revocations 鉴权：internal secret 错/缺/管理员 JWT 均不通行 → 401；未配置 RA_INTERNAL_SECRET → 503 fail-closed', async () => {
    const wrong = await request(server)
      .get('/relay-admin/revocations')
      .set('Authorization', 'Bearer wrong-internal-secret');
    expect(wrong.status).toBe(401);

    const missing = await request(server).get('/relay-admin/revocations');
    expect(missing.status).toBe(401);

    // 管理员 JWT 不是本端点的凭证（分域：internal secret 保护控制信道）
    const adminJwt = await request(server)
      .get('/relay-admin/revocations')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminJwt.status).toBe(401);

    // 未配置（env 置空删除，yml 段亦无）→ fail-closed 503，不给名单
    const saved = process.env.RA_INTERNAL_SECRET;
    delete process.env.RA_INTERNAL_SECRET;
    try {
      const unconfigured = await request(server)
        .get('/relay-admin/revocations')
        .set('Authorization', `Bearer ${INTERNAL_SECRET}`);
      expect(unconfigured.status).toBe(503);
      expect(unconfigured.body.message).toContain('RA_INTERNAL_SECRET');
      expect(unconfigured.body.data).toBeNull();
    } finally {
      process.env.RA_INTERNAL_SECRET = saved;
    }
  });
});
