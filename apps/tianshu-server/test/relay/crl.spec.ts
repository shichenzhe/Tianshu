import WebSocket from 'ws';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCrlStore } from 'src/relay/crl';
import {
  generateEd25519KeyPems,
  signAccessJwt,
  type AccessClaims,
} from 'src/relay/jwt-eddsa';
import { parseCliArgs, startRelay } from 'src/relay/relay-main';

/**
 * CRL 吊销名单拉取单测（多租户批 Task 6，spec §4.4）：
 * - 单元级（stub 控制平面，node:http 零外部依赖）：名单双维命中
 *   （revokedAk/revokedTenant）、拉取失败 fail-static（名单维持）、
 *   failCloseAfter 连续失败阈值（触发后拒新态可查、名单仍维持）、
 *   成功拉取计数器复位（名单全量替换非合并）；
 * - relay-main 接线（jwt 模式真实 ws）：名单内 ak 新连接 4001、
 *   fail-close 只拒新不拆存量（契约 spec §5.3/§5.4）、static 模式
 *   CRL 配置不启用、CLI 旗标、坏配置（adminUrl 缺 internalSecret）
 *   拒绝启动。
 * 同步门技巧：拉取串行（in-flight 互斥）⇒ stub 收到第 N+1 次请求时，
 * 第 N 次响应已在 store 应用完毕——测试据此无竞态等待名单生效。
 */
jest.setTimeout(10_000);

const nowSec = () => Math.floor(Date.now() / 1000);

/** stub 控制平面：GET /relay-admin/revocations 的可控应答器 */
interface StubAdmin {
  url: string;
  readonly requests: number;
  readonly lastAuthorization: string | undefined;
  /** 切换 200 应答载荷（同时解除 fail 态——恢复语义） */
  respond(payload: unknown): void;
  fail(): void;
  stop(): Promise<void>;
}

async function startStubAdmin(initialPayload: unknown): Promise<StubAdmin> {
  let payload = initialPayload;
  let failing = false;
  let requests = 0;
  let lastAuthorization: string | undefined;
  const server = createServer((req, res) => {
    if ((req.url ?? '').split('?')[0] !== '/relay-admin/revocations') {
      res.writeHead(404).end();
      return;
    }
    requests += 1;
    lastAuthorization = req.headers.authorization;
    // connection: close——响应即断 socket，防 undici 连接池复用让
    // 「停掉 stub」后仍有活连接假成功
    if (failing) {
      res.writeHead(500, { connection: 'close' }).end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      connection: 'close',
    });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    get requests() {
      return requests;
    },
    get lastAuthorization() {
      return lastAuthorization;
    },
    respond(next: unknown) {
      payload = next;
      failing = false;
    },
    fail() {
      failing = true;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询等待条件成立（真实定时器，10ms 步进） */
async function waitFor(probe: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时：条件未满足');
    await sleep(10);
  }
}

describe('CrlStore（stub 控制平面）', () => {
  const LIST = { epoch: 1, revokedAk: ['ak1'], revokedTenant: ['t9'] };

  it('名单命中：revokedAk/revokedTenant 双维命中 true、未命中 false；Bearer 凭证随行；stop 后不再拉取', async () => {
    const stub = await startStubAdmin(LIST);
    const store = createCrlStore({
      adminUrl: stub.url,
      internalSecret: 'crl-secret',
      intervalMs: 40,
    });
    try {
      store.start();
      // 第二次请求到达 ⇒ 首份名单已应用（拉取串行互斥）
      await waitFor(() => stub.requests >= 2);
      expect(store.isRevoked({ ak: 'ak1' })).toBe(true);
      expect(store.isRevoked({ tid: 't9' })).toBe(true);
      expect(store.isRevoked({ ak: 'ak2', tid: 't8' })).toBe(false);
      expect(store.isRevoked({})).toBe(false);
      expect(stub.lastAuthorization).toBe('Bearer crl-secret');
      store.stop();
      const frozen = stub.requests;
      await sleep(120);
      expect(stub.requests).toBe(frozen);
    } finally {
      store.stop();
      await stub.stop();
    }
  });

  it('冷启动零数据不拒：控制平面停机期离线验签重连的设计语义（spec §5.3 停机矩阵）', () => {
    const store = createCrlStore({
      adminUrl: 'http://127.0.0.1:1',
      internalSecret: 's',
    });
    expect(store.isRevoked({ ak: 'ak1', tid: 't9' })).toBe(false);
    expect(store.isNewConnDenied()).toBe(false);
  });

  it('拉取失败 fail-static：stub 停掉 → 名单维持；缺省（failCloseAfter=0）永不拒新', async () => {
    const stub = await startStubAdmin(LIST);
    const store = createCrlStore({
      adminUrl: stub.url,
      internalSecret: 's',
      intervalMs: 30,
    });
    try {
      store.start();
      await waitFor(() => stub.requests >= 2);
      await stub.stop();
      await sleep(120); // ≥2 个失败周期过去（连接拒绝即时失败）
      expect(store.isRevoked({ ak: 'ak1' })).toBe(true);
      expect(store.isRevoked({ tid: 't9' })).toBe(true);
      expect(store.isNewConnDenied()).toBe(false);
    } finally {
      store.stop();
      await stub.stop();
    }
  });

  it('failCloseAfter=2：连续 2 败后 isNewConnDenied()===true，名单仍维持', async () => {
    const stub = await startStubAdmin(LIST);
    const store = createCrlStore({
      adminUrl: stub.url,
      internalSecret: 's',
      intervalMs: 30,
      failCloseAfter: 2,
    });
    try {
      store.start();
      await waitFor(() => stub.requests >= 2);
      await stub.stop();
      await waitFor(() => store.isNewConnDenied());
      expect(store.isRevoked({ ak: 'ak1' })).toBe(true);
      expect(store.isRevoked({ tid: 't9' })).toBe(true);
    } finally {
      store.stop();
      await stub.stop();
    }
  });

  it('成功拉取复位计数器：500 两败触发后恢复 200 → 拒新态回落、名单全量替换', async () => {
    const stub = await startStubAdmin(LIST);
    const store = createCrlStore({
      adminUrl: stub.url,
      internalSecret: 's',
      intervalMs: 30,
      failCloseAfter: 2,
    });
    try {
      store.start();
      await waitFor(() => stub.requests >= 2);
      stub.fail(); // 500 应答=拉取失败（连接层完好也计败）
      await waitFor(() => store.isNewConnDenied());
      stub.respond({ epoch: 2, revokedAk: ['ak2'], revokedTenant: [] });
      await waitFor(() => !store.isNewConnDenied());
      // 全量替换非合并：ak1 出名单，ak2 入名单
      expect(store.isRevoked({ ak: 'ak1' })).toBe(false);
      expect(store.isRevoked({ ak: 'ak2' })).toBe(true);
    } finally {
      store.stop();
      await stub.stop();
    }
  });
});

describe('relay-main CRL 接线（jwt 模式真实 ws）', () => {
  const keys = generateEd25519KeyPems();
  const claimsFor = (
    role: 'server' | 'client',
    ak: string,
    jti: string,
  ): AccessClaims => ({
    iss: 'tianshu-relay',
    sub: `conn-${jti}`,
    tid: 'tenant-alpha',
    role,
    ak,
    quota: { maxServers: 3, maxClients: 10 },
    iat: nowSec(),
    exp: nowSec() + 600,
    jti,
  });
  const sign = (claims: AccessClaims): string =>
    signAccessJwt(claims, keys.privateKeyPem);

  const openSocketOn = (port: number): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });

  const sendAuth = (
    ws: WebSocket,
    token: string,
    over: Record<string, unknown> = {},
  ): void => {
    ws.send(JSON.stringify({ kind: 'auth', token, ...over }));
  };

  const closeCodeOf = (ws: WebSocket): Promise<number> =>
    new Promise((resolve) => ws.on('close', (code) => resolve(code)));

  const writePubkeyFile = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-crl-'));
    const file = join(dir, 'relay-pub.pem');
    writeFileSync(file, keys.publicKeyPem);
    return file;
  };

  it('jwt+crl：名单内 ak 的新连接被拒 4001，名单外 ak 正常接入', async () => {
    const stub = await startStubAdmin({
      epoch: 1,
      revokedAk: ['ak1'],
      revokedTenant: [],
    });
    const relay = await startRelay({
      port: 0,
      token: '',
      authPubkeyFile: writePubkeyFile(),
      internalSecret: 'crl-secret',
      crlAdminUrl: stub.url,
      crlIntervalMs: 40,
      authWindowMs: 150,
    });
    let relayClosed = false;
    try {
      await waitFor(() => stub.requests >= 2); // 首份名单已应用
      // 名单外 ak：放行
      const good = await openSocketOn(relay.port);
      sendAuth(good, sign(claimsFor('client', 'ak-ok', 'jti-ok')), {
        role: 'client',
      });
      await sleep(80);
      expect(good.readyState).toBe(WebSocket.OPEN);
      good.terminate();
      // 名单内 ak：admit 时即拒 4001（与验签失败同归因，不外泄细节）
      const bad = await openSocketOn(relay.port);
      sendAuth(bad, sign(claimsFor('client', 'ak1', 'jti-bad')), {
        role: 'client',
      });
      expect(await closeCodeOf(bad)).toBe(4001);
      // relay close → store stop：关闭后不再拉取
      const frozen = stub.requests;
      await relay.close();
      await sleep(120);
      expect(stub.requests).toBe(frozen);
      relayClosed = true;
    } finally {
      if (!relayClosed) await relay.close();
      await stub.stop();
    }
  });

  it('fail-close 只拒新不拆存量：触发后新连接 4001，存量配对仍可转发', async () => {
    const stub = await startStubAdmin({
      epoch: 1,
      revokedAk: [],
      revokedTenant: [],
    });
    const relay = await startRelay({
      port: 0,
      token: '',
      authPubkeyFile: writePubkeyFile(),
      internalSecret: 'crl-secret',
      crlAdminUrl: stub.url,
      crlFailCloseAfter: 2,
      crlIntervalMs: 40,
      authWindowMs: 150,
    });
    try {
      await waitFor(() => stub.requests >= 2);
      // 存量：server+client 配对并转发两帧
      const server = await openSocketOn(relay.port);
      sendAuth(server, sign(claimsFor('server', 'ak-server', 'jti-s')), {
        role: 'server',
        connectionId: 's1',
      });
      await sleep(80);
      expect(server.readyState).toBe(WebSocket.OPEN);
      const client = await openSocketOn(relay.port);
      sendAuth(client, sign(claimsFor('client', 'ak-client', 'jti-c')), {
        role: 'client',
      });
      await sleep(80);
      expect(client.readyState).toBe(WebSocket.OPEN);
      const received: unknown[] = [];
      server.on('message', (raw) =>
        received.push(JSON.parse((raw as Buffer).toString())),
      );
      client.send(JSON.stringify({ kind: 'open', connectionId: 's1' }));
      client.send(JSON.stringify({ kind: 'req', id: 1, method: 'info' }));
      await waitFor(() => received.length >= 2);
      // 触发 fail-close：连续 2 次拉取失败（500 应答）
      stub.fail();
      const baseline = stub.requests;
      await waitFor(() => stub.requests >= baseline + 2);
      // 新连接全拒 4001（fail-close，与凭证好坏无关）
      const fresh = await openSocketOn(relay.port);
      sendAuth(fresh, sign(claimsFor('client', 'ak-client', 'jti-f')), {
        role: 'client',
      });
      expect(await closeCodeOf(fresh)).toBe(4001);
      // 存量不受扰：配对链路仍转发（契约：永不拆存量）
      client.send(JSON.stringify({ kind: 'req', id: 2, method: 'info' }));
      await waitFor(() => received.length >= 3);
      expect(received[2]).toEqual({ kind: 'req', id: 2, method: 'info' });
      expect(server.readyState).toBe(WebSocket.OPEN);
      client.terminate();
      server.terminate();
    } finally {
      await relay.close();
      await stub.stop();
    }
  });

  it('static 模式：CRL 配置在场也不启用（stub 零请求），token 鉴权行为不变', async () => {
    const stub = await startStubAdmin({
      epoch: 1,
      revokedAk: [],
      revokedTenant: [],
    });
    const relay = await startRelay({
      port: 0,
      token: 'static-token',
      authMode: 'static',
      crlAdminUrl: stub.url,
      internalSecret: 's',
      authWindowMs: 150,
    });
    try {
      const good = await openSocketOn(relay.port);
      sendAuth(good, 'static-token', { role: 'client' });
      await sleep(80);
      expect(good.readyState).toBe(WebSocket.OPEN);
      good.terminate();
      await sleep(120);
      expect(stub.requests).toBe(0);
    } finally {
      await relay.close();
      await stub.stop();
    }
  });

  it('jwt+crl：配了 crlAdminUrl 缺 internalSecret → 拒绝启动（吊销面不得静默失效）', async () => {
    const stub = await startStubAdmin({
      epoch: 1,
      revokedAk: [],
      revokedTenant: [],
    });
    await expect(
      startRelay({
        port: 0,
        token: '',
        authPubkeyFile: writePubkeyFile(),
        crlAdminUrl: stub.url,
      }),
    ).rejects.toThrow('internal-secret');
    expect(stub.requests).toBe(0);
    await stub.stop();
  });

  it('parseCliArgs：--crl-admin-url/--crl-fail-close 两种形式；缺省不设', () => {
    const opts = parseCliArgs([
      '--auth-pubkey',
      '/keys/relay-pub.pem',
      '--internal-secret',
      'is',
      '--crl-admin-url',
      'http://ctrl:3000',
      '--crl-fail-close=3',
    ]);
    expect(opts.crlAdminUrl).toBe('http://ctrl:3000');
    expect(opts.crlFailCloseAfter).toBe(3);
    const plain = parseCliArgs(['--token', 't']);
    expect(plain.crlAdminUrl).toBeUndefined();
    expect(plain.crlFailCloseAfter).toBeUndefined();
    expect(plain.crlIntervalMs).toBeUndefined();
  });
});
