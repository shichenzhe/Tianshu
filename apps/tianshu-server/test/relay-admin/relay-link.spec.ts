// relay-admin 吊销 kick 即时联动 + 在线视图聚合 e2e（Task 13）：
// 本地起真 stub relay HTTP 端点（node:http，/internal/kick + /internal/stats
// 录请求回 JSON），RA_RELAY_BASE_URL/RA_INTERNAL_SECRET 指过去，经管理面
// HTTP 路径触发 disable/rotate/user-disable，断言 kick 载荷按维度命中
// （{ak} / {tenantId}）+ Bearer internalSecret；500/挂起（3s 超时）→ 禁用
// 仍成功（降级 warn，DB 状态不变——CRL 补偿兜底语义）；stats/online 端点
// 透传 relay 聚合 + unreachable 降级形状；未配置 relayBaseUrl → 联动关闭
// （零 kick 请求，禁用照常）。
//
// kick 计数口径（Task 5 已裁定）：kicked 只计目标匹配连接——server 拆除
// 时被配对 4003 连带拆除的 client 不计入；本套件断言的是「relay 收到的
// 请求载荷」，不伪造连接，不涉该口径。
import './helpers/ra-fs-mock';
import {
  createRaTestApp,
  createUserViaApi,
  destroyRaTestApp,
  issueAkViaApi,
  RaTestApp,
} from './helpers/ra-test-app';

import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { AksService } from 'src/relay-admin/aks/aks.service';
import { RelayLinkService } from 'src/relay-admin/relay-link.service';

/** stub relay 与 relay-admin 共享的测试 internal secret（kick/stats 鉴权面） */
const TEST_INTERNAL_SECRET = 'ra-link-test-internal-secret';

/** stub relay 录得的 kick 请求（auth 头 + 解析后 body） */
interface RecordedKick {
  auth: string | undefined;
  body: { tenantId?: string; ak?: string };
}

/** stub relay 故障开关：ok 正常回 JSON；fail500 回 500；hang 收请求不响应
 *  （打 fetch 的 AbortSignal.timeout(3000) 路径——真 3s 等待，用例单独
 *  放宽 jest 超时） */
type StubMode = 'ok' | 'fail500' | 'hang';

/** 测试内嵌 stub relay：/internal/kick（POST，录 body 回 {kicked}）+
 *  /internal/stats（GET，回可配置 payload） */
class StubRelay {
  readonly kicks: RecordedKick[] = [];
  statsRequests = 0;
  mode: StubMode = 'ok';
  statsPayload: { tenants: unknown[] } = { tenants: [] };
  private readonly server = http.createServer((req, res) => {
    const pathname = req.url?.split('?')[0];
    if (this.mode === 'hang') return; // 收下不回——超时路径专用
    if (pathname === '/internal/kick' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      req.on('end', () => {
        this.kicks.push({
          auth: req.headers.authorization,
          body: JSON.parse(raw) as RecordedKick['body'],
        });
        if (this.mode === 'fail500') return void res.writeHead(500).end();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ kicked: this.kicks.length }));
      });
      return;
    }
    if (pathname === '/internal/stats' && req.method === 'GET') {
      this.statsRequests += 1;
      if (this.mode === 'fail500') return void res.writeHead(500).end();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(this.statsPayload));
      return;
    }
    res.writeHead(404).end();
  });

  listen(): Promise<string> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const { port } = this.server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
  }

  close(): Promise<void> {
    this.server.closeAllConnections(); // hang 模式残留的未完成响应不阻关闭
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

describe('relay-admin 吊销 kick 联动 + 在线视图（Task 13）', () => {
  let stub: StubRelay;
  let ra: RaTestApp;
  let server: http.Server;
  let adminToken: string;

  beforeAll(async () => {
    stub = new StubRelay();
    const baseUrl = await stub.listen();
    ra = await createRaTestApp({
      tmpPrefix: 'relay-admin-link-',
      extraEnv: () => ({
        RA_RELAY_BASE_URL: baseUrl,
        RA_INTERNAL_SECRET: TEST_INTERNAL_SECRET,
      }),
    });
    server = ra.server;
    adminToken = ra.adminToken;
  });

  afterAll(async () => {
    await destroyRaTestApp(ra);
    await stub.close();
  });

  /** 每用例前复位故障开关（用例内自行改写） */
  beforeEach(() => {
    stub.mode = 'ok';
  });

  it('disable AK → kick 收到 {ak}（无 tenantId 维度）+ Bearer internalSecret；DB/audit 随动', async () => {
    const kicksBefore = stub.kicks.length;
    const user = await createUserViaApi(server, adminToken, 'kick-ak-owner');
    const issued = await issueAkViaApi(server, adminToken, user.userId);

    const disable = await request(server)
      .post(`/relay-admin/aks/${issued.akId}/disable`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(disable.status).toBe(200);
    expect(disable.body.code).toBe('2000');

    // relay 收到一次 kick，载荷恰为该 ak（tenantId 不串维度）
    const fresh = stub.kicks.slice(kicksBefore);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].body).toEqual({ ak: issued.akId });
    expect(fresh[0].auth).toBe(`Bearer ${TEST_INTERNAL_SECRET}`);

    // 禁用落库 + 审计行在（kick 联动不替代既有语义）
    const row = await ra.raPrisma.raAccessKey.findUniqueOrThrow({
      where: { id: issued.akId },
    });
    expect(row.status).toBe('disabled');
    expect(
      await ra.raPrisma.raAuditLog.findFirst({
        where: { action: 'ak.disable', operator: 'admin', target: issued.akId },
      }),
    ).not.toBeNull();

    // 服务直调面：kick 返回 relay 侧计数透传（stub 以累计请求数作 kicked）
    const relayLink = ra.app.get(RelayLinkService);
    const direct = await relayLink.kick({ ak: 'direct-probe-ak' });
    expect(direct).toEqual({ kicked: stub.kicks.length });
    expect(stub.kicks[stub.kicks.length - 1].body).toEqual({
      ak: 'direct-probe-ak',
    });
  });

  it('disable user → kick 收到 {tenantId}（单发租户维度，不逐 AK 重复 kick）；级联禁用不变', async () => {
    const kicksBefore = stub.kicks.length;
    const user = await createUserViaApi(
      server,
      adminToken,
      'kick-tenant-owner',
    );
    await issueAkViaApi(server, adminToken, user.userId);
    await issueAkViaApi(server, adminToken, user.userId, { role: 'client' });

    const disable = await request(server)
      .post(`/relay-admin/users/${user.userId}/disable`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(disable.status).toBe(200);
    expect(disable.body.code).toBe('2000');

    // 恰一次 kick，载荷为租户维度（tenantId 覆盖该租户全部连接，无需逐 AK）
    const fresh = stub.kicks.slice(kicksBefore);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].body).toEqual({ tenantId: user.tenantId });
    expect(fresh[0].auth).toBe(`Bearer ${TEST_INTERNAL_SECRET}`);

    // 级联禁用仍完整（用户 + 两把 AK 均 disabled）
    const userRow = await ra.raPrisma.raUser.findUniqueOrThrow({
      where: { id: user.userId },
    });
    expect(userRow.status).toBe('disabled');
    const akRows = await ra.raPrisma.raAccessKey.findMany({
      where: { userId: user.userId },
    });
    expect(akRows).toHaveLength(2);
    expect(akRows.every((row) => row.status === 'disabled')).toBe(true);
  });

  it('rotate-secret → kick 收到 {ak}（旧 secret 存量连接即时拆除）；轮换语义不变', async () => {
    const kicksBefore = stub.kicks.length;
    const user = await createUserViaApi(
      server,
      adminToken,
      'rotate-kick-owner',
    );
    const issued = await issueAkViaApi(server, adminToken, user.userId);

    const rotate = await request(server)
      .post(`/relay-admin/aks/${issued.akId}/rotate-secret`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(rotate.status).toBe(200);
    expect(rotate.body.code).toBe('2000');
    const second = rotate.body.data as { akId: string; akSecret: string };

    const fresh = stub.kicks.slice(kicksBefore);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].body).toEqual({ ak: issued.akId });

    // 轮换语义不因联动改变：新明文 ok、旧明文 bad-secret
    const aksService = ra.app.get(AksService);
    expect(second.akSecret).not.toBe(issued.akSecret);
    expect(await aksService.isAkUsable(issued.akId, second.akSecret)).toEqual(
      expect.objectContaining({ ok: true, userId: user.userId }),
    );
    expect(await aksService.isAkUsable(issued.akId, issued.akSecret)).toEqual({
      ok: false,
      reason: 'bad-secret',
    });
  });

  it('enable / extend 不 kick（无吊销语义）', async () => {
    const kicksBefore = stub.kicks.length;
    const user = await createUserViaApi(server, adminToken, 'no-kick-owner');
    const issued = await issueAkViaApi(server, adminToken, user.userId);

    // extend（active 态直接续期）→ 零 kick
    const extend = await request(server)
      .post(`/relay-admin/aks/${issued.akId}/extend`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        expireAt: new Date(
          Date.now() + 400 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      });
    expect(extend.body.code).toBe('2000');

    // disable → enable（恢复）→ 零增量 kick
    await request(server)
      .post(`/relay-admin/aks/${issued.akId}/disable`)
      .set('Authorization', `Bearer ${adminToken}`);
    const afterDisable = stub.kicks.length;
    expect(afterDisable).toBe(kicksBefore + 1); // disable 本身 kick 一次

    const enable = await request(server)
      .post(`/relay-admin/aks/${issued.akId}/enable`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(enable.body.code).toBe('2000');
    expect(stub.kicks.length).toBe(afterDisable); // enable 无 kick

    // users.enable 同样不 kick
    await request(server)
      .post(`/relay-admin/users/${user.userId}/enable`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(stub.kicks.length).toBe(afterDisable);
  });

  it('stub 500 → disable 仍成功（降级 warn，DB 状态不变）；kick/stats 直调返回 null', async () => {
    stub.mode = 'fail500';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const user = await createUserViaApi(server, adminToken, 'fail500-owner');
      const issued = await issueAkViaApi(server, adminToken, user.userId);

      const disable = await request(server)
        .post(`/relay-admin/aks/${issued.akId}/disable`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(disable.status).toBe(200);
      expect(disable.body.code).toBe('2000');

      // 禁用照常落库 + 审计行在（kick 失败不回滚）
      const row = await ra.raPrisma.raAccessKey.findUniqueOrThrow({
        where: { id: issued.akId },
      });
      expect(row.status).toBe('disabled');
      expect(
        await ra.raPrisma.raAuditLog.findFirst({
          where: { action: 'ak.disable', target: issued.akId },
        }),
      ).not.toBeNull();

      // 降级 warn：带 relay-link 前缀 + 状态摘要，不抛异常
      const warnText = warnSpy.mock.calls
        .map((args) => args.join(' '))
        .join('\n');
      expect(warnText).toContain('relay-link');
      expect(warnText).toContain('500');

      // 直调面同款降级：kick/stats 均 null（不抛）
      const relayLink = ra.app.get(RelayLinkService);
      await expect(relayLink.kick({ ak: issued.akId })).resolves.toBeNull();
      await expect(relayLink.stats()).resolves.toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  }, 10000);

  it('stub 挂起 → 3s 超时后 disable 仍成功（降级 warn，DB 状态不变）', async () => {
    stub.mode = 'hang';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const user = await createUserViaApi(server, adminToken, 'hang-owner');
      const issued = await issueAkViaApi(server, adminToken, user.userId);

      const startedAt = Date.now();
      const disable = await request(server)
        .post(`/relay-admin/aks/${issued.akId}/disable`)
        .set('Authorization', `Bearer ${adminToken}`);
      const elapsed = Date.now() - startedAt;

      expect(disable.status).toBe(200);
      expect(disable.body.code).toBe('2000');
      // 真走了超时路径（下界断言——只能更久不会更短）
      expect(elapsed).toBeGreaterThanOrEqual(2900);

      const row = await ra.raPrisma.raAccessKey.findUniqueOrThrow({
        where: { id: issued.akId },
      });
      expect(row.status).toBe('disabled');

      const warnText = warnSpy.mock.calls
        .map((args) => args.join(' '))
        .join('\n');
      expect(warnText).toContain('relay-link');
    } finally {
      warnSpy.mockRestore();
    }
  }, 15000);

  it('GET /relay-admin/stats/online → 透传 relay 聚合 + fetchedAt（ISO）；未鉴权 401', async () => {
    stub.statsPayload = {
      tenants: [
        { tenantId: 'tenant-alpha', servers: 2, clients: 3 },
        { tenantId: 'tenant-beta', servers: 1, clients: 0 },
      ],
    };
    const statsBefore = stub.statsRequests;

    const view = await request(server)
      .get('/relay-admin/stats/online')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(view.status).toBe(200);
    expect(view.body.code).toBe('2000');
    expect(stub.statsRequests).toBe(statsBefore + 1);
    expect(view.body.data.relayStats).toEqual(stub.statsPayload);
    // fetchedAt 是紧邻当前的合法 ISO 时间串
    const fetchedAt = Date.parse(view.body.data.fetchedAt as string);
    expect(Number.isNaN(fetchedAt)).toBe(false);
    expect(Math.abs(fetchedAt - Date.now())).toBeLessThan(60_000);

    const anonymous = await request(server).get('/relay-admin/stats/online');
    expect(anonymous.status).toBe(401);
  });

  it('relay 不可达（500）→ stats/online 降级形状 {relayStats:{error:"unreachable"}}', async () => {
    stub.mode = 'fail500';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const view = await request(server)
        .get('/relay-admin/stats/online')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(view.status).toBe(200); // 观测端点不因 relay 不可达而 5xx
      expect(view.body.code).toBe('2000');
      expect(view.body.data.relayStats).toEqual({ error: 'unreachable' });
      expect(typeof view.body.data.fetchedAt).toBe('string');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('未配置 relayBaseUrl → 联动关闭：禁用照常、零 kick 请求、stats 降级 unreachable', async () => {
    const kicksBefore = stub.kicks.length;
    const savedBase = process.env.RA_RELAY_BASE_URL;
    delete process.env.RA_RELAY_BASE_URL; // 逐请求解析——运行中摘除即联动关闭
    try {
      const user = await createUserViaApi(server, adminToken, 'unlinked-owner');
      const issued = await issueAkViaApi(server, adminToken, user.userId);

      const disable = await request(server)
        .post(`/relay-admin/aks/${issued.akId}/disable`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(disable.status).toBe(200);
      expect(disable.body.code).toBe('2000');
      const row = await ra.raPrisma.raAccessKey.findUniqueOrThrow({
        where: { id: issued.akId },
      });
      expect(row.status).toBe('disabled');

      // 零出站 kick（联动关闭，非失败重试）
      expect(stub.kicks.length).toBe(kicksBefore);

      const view = await request(server)
        .get('/relay-admin/stats/online')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(view.body.data.relayStats).toEqual({ error: 'unreachable' });
    } finally {
      if (savedBase === undefined) delete process.env.RA_RELAY_BASE_URL;
      else process.env.RA_RELAY_BASE_URL = savedBase;
    }
  });
});
