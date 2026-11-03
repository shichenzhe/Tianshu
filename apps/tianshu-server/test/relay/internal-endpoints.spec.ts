import WebSocket from 'ws';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayRegistry, type PeerSocket } from 'src/relay/registry';
import {
  generateEd25519KeyPems,
  signAccessJwt,
  type AccessClaims,
  type AccessQuota,
} from 'src/relay/jwt-eddsa';
import { startRelay, type RelayHandle } from 'src/relay/relay-main';

/**
 * relay 内部端点单测（多租户批 Task 5）：
 * - registry 单元级（假 socket）：kickTenant 按租户/ak 反查拆除——簿记
 *   经正常断开同路径回落（计数零泄漏）、连带拆除语义与 kicked 计数；
 *   tenantStats 聚合快照的计数/排序/回落；
 * - 真实 http+ws：/internal/kick、/internal/stats 的 Bearer internalSecret
 *   鉴权（未配置 secret → 404 不暴露存在性 / 错凭证 401）与端到端
 *   拆除、聚合计数。
 * Ruling P5（同租户重连配额豁免）的接线回归在 registry.spec.ts。
 */

/** 永不回调的假 socket（与 registry.spec.ts 同型的测试局部替身） */
class FakeSocket {
  sent: string[] = [];
  closeCode: number | undefined;
  send(data: string, cb?: (err?: Error) => void): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closeCode = code;
  }
}

/** kick sendClose 回调替身：记录被拆除的 socket（不真正断） */
function collectTerminated(): { list: PeerSocket[]; sendClose: (ws: PeerSocket) => void } {
  const list: PeerSocket[] = [];
  return { list, sendClose: (ws) => list.push(ws) };
}

describe('RelayRegistry kickTenant / tenantStats（单元级）', () => {
  it('kick 按租户：该租户 server+client 同拆（close 帧达对端 + sendClose 拆socket），他租户不动，计数归零', () => {
    const registry = new RelayRegistry();
    const serverA = new FakeSocket();
    const clientA = new FakeSocket();
    const serverB = new FakeSocket();
    registry.registerServer('a-1', serverA, 'tenant-a', 'ak-server-a');
    registry.attachClient('a-1', clientA, 'tenant-a', 'ak-client-a');
    registry.registerServer('b-1', serverB, 'tenant-b', 'ak-server-b');
    const { list: terminated, sendClose } = collectTerminated();
    expect(registry.kickTenant({ tenantId: 'tenant-a' }, sendClose)).toBe(2);
    expect(terminated).toContain(serverA);
    expect(terminated).toContain(clientA);
    expect(terminated).not.toContain(serverB);
    // client 拆除经 notifyClose 同路径：server 先收 close 帧，再随注册拆除
    expect(serverA.sent).toContain(
      JSON.stringify({ kind: 'close', connectionId: 'a-1', reason: 'kicked' }),
    );
    expect(registry.hasServer('a-1')).toBe(false);
    expect(registry.hasServer('b-1')).toBe(true);
    expect(serverB.closeCode).toBeUndefined(); // 他租户连接不被扰动
    // 计数零泄漏：tenant-a 两角色归零（空条目摘除），tenant-b 原样
    expect(registry.tenantConnCount('tenant-a', 'server')).toBe(0);
    expect(registry.tenantConnCount('tenant-a', 'client')).toBe(0);
    expect(registry.tenantConnCount('tenant-b', 'server')).toBe(1);
  });

  it('kick 按 ak：仅拆该 ak 凭证的连接，同租户其他 ak 连接保留', () => {
    const registry = new RelayRegistry();
    const server = new FakeSocket();
    const client1 = new FakeSocket();
    const client2 = new FakeSocket();
    registry.registerServer('s-1', server, 'tenant-a', 'ak-server');
    registry.attachClient('s-1', client1, 'tenant-a', 'ak-one');
    registry.attachClient('s-1', client2, 'tenant-a', 'ak-two');
    const { list: terminated, sendClose } = collectTerminated();
    expect(registry.kickTenant({ ak: 'ak-two' }, sendClose)).toBe(1);
    expect(terminated).toEqual([client2]);
    expect(server.sent).toContain(
      JSON.stringify({ kind: 'close', connectionId: 's-1', reason: 'kicked' }),
    );
    expect(registry.tenantConnCount('tenant-a', 'client')).toBe(1);
    expect(registry.tenantConnCount('tenant-a', 'server')).toBe(1);
  });

  it('kick 双维度缺省（空目标）：不匹配任何连接，返回 0 不误伤全量', () => {
    const registry = new RelayRegistry();
    const server = new FakeSocket();
    const client = new FakeSocket();
    registry.registerServer('s-1', server, 'tenant-a', 'ak-server');
    registry.attachClient('s-1', client, 'tenant-a', 'ak-client');
    const { list: terminated, sendClose } = collectTerminated();
    expect(registry.kickTenant({}, sendClose)).toBe(0);
    expect(terminated).toEqual([]);
    expect(registry.tenantConnCount('tenant-a', 'server')).toBe(1);
    expect(registry.tenantConnCount('tenant-a', 'client')).toBe(1);
  });

  it('kick 仅命中 server：配对 client 经 dropServer 连带 4003 拆除且计数回落（连带不计入 kicked）', () => {
    const registry = new RelayRegistry();
    const server = new FakeSocket();
    const client = new FakeSocket();
    registry.registerServer('c-1', server, 'tenant-a', 'ak-server');
    registry.attachClient('c-1', client, 'tenant-a', 'ak-client');
    const { list: terminated, sendClose } = collectTerminated();
    expect(registry.kickTenant({ ak: 'ak-server' }, sendClose)).toBe(1);
    expect(terminated).toEqual([server]); // client 非目标匹配，不经 sendClose
    expect(client.closeCode).toBe(4003); // 连带拆除走 server-gone 同路径
    expect(client.sent).toContain(
      JSON.stringify({ kind: 'close', connectionId: 'c-1', reason: 'kicked' }),
    );
    expect(registry.tenantConnCount('tenant-a', 'server')).toBe(0);
    expect(registry.tenantConnCount('tenant-a', 'client')).toBe(0);
  });

  it('tenantStats：多租户聚合计数、按 tenantId 排序、断开后回落摘除', () => {
    const registry = new RelayRegistry();
    const serverB = new FakeSocket();
    registry.registerServer('b-1', serverB, 'tenant-b'); // 先建 tenant-b：排序不得是插入序
    const serverA = new FakeSocket();
    const clientA = new FakeSocket();
    registry.registerServer('a-1', serverA, 'tenant-a');
    registry.attachClient('a-1', clientA, 'tenant-a');
    expect(registry.tenantStats()).toEqual([
      { tenantId: 'tenant-a', servers: 1, clients: 1 },
      { tenantId: 'tenant-b', servers: 1, clients: 0 },
    ]);
    registry.dropServer('b-1', serverB, 'server-gone');
    expect(registry.tenantStats()).toEqual([
      { tenantId: 'tenant-a', servers: 1, clients: 1 },
    ]);
  });
});

describe('relay 内部端点 /internal/kick + /internal/stats（真实 http + ws）', () => {
  const INTERNAL_SECRET = 'internal-s3cret';
  const keys = generateEd25519KeyPems();
  const nowSec = () => Math.floor(Date.now() / 1000);
  let jtiSeq = 0;

  /** 租户 token 签发：quota 缺省 {maxServers:2, maxClients:2}；ak 缺省自增 */
  const signTenantToken = (over: {
    tid?: string;
    role: 'server' | 'client';
    ak?: string;
    quota?: AccessQuota;
  }): string =>
    signAccessJwt(
      {
        iss: 'tianshu-relay',
        sub: `sub-${++jtiSeq}`,
        ak: `ak-${jtiSeq}`,
        quota: { maxServers: 2, maxClients: 2 },
        iat: nowSec(),
        exp: nowSec() + 600,
        jti: `jti-${jtiSeq}`,
        ...over,
      } as AccessClaims,
      keys.privateKeyPem,
    );

  let relay: RelayHandle;
  let openedSockets: WebSocket[];

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-internal-'));
    const pubkeyFile = join(dir, 'relay-pub.pem');
    writeFileSync(pubkeyFile, keys.publicKeyPem);
    relay = await startRelay({
      port: 0,
      token: '',
      authPubkeyFile: pubkeyFile,
      authWindowMs: 150,
      internalSecret: INTERNAL_SECRET,
    });
    openedSockets = [];
  });

  afterEach(async () => {
    for (const ws of openedSockets) ws.terminate();
    await relay.close();
  });

  const openSocket = (): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/ws`);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });

  const sendAuth = (ws: WebSocket, token: string, over: Record<string, unknown> = {}): void => {
    ws.send(JSON.stringify({ kind: 'auth', token, ...over }));
  };

  const closeCodeOf = (ws: WebSocket): Promise<number> =>
    new Promise((resolve) => ws.on('close', (code) => resolve(code)));

  /** 首帧 auth 后等裁决落定：放行则保持 OPEN */
  async function authedSocket(
    token: string,
    over: Record<string, unknown> = {},
  ): Promise<WebSocket> {
    const ws = await openSocket();
    sendAuth(ws, token, over);
    await new Promise((r) => setTimeout(r, 80));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    return ws;
  }

  const authedInternal = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`http://127.0.0.1:${relay.port}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${INTERNAL_SECRET}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    });

  it('未配置 internalSecret：两端点 404（携正确凭证也 404——不暴露存在性）', async () => {
    const bare = await startRelay({ port: 0, token: 'relay-token' });
    try {
      const kick = await fetch(`http://127.0.0.1:${bare.port}/internal/kick`, {
        method: 'POST',
        headers: { authorization: `Bearer ${INTERNAL_SECRET}` },
        body: JSON.stringify({ tenantId: 'tenant-a' }),
      });
      expect(kick.status).toBe(404);
      const stats = await fetch(`http://127.0.0.1:${bare.port}/internal/stats`, {
        headers: { authorization: `Bearer ${INTERNAL_SECRET}` },
      });
      expect(stats.status).toBe(404);
      const health = await fetch(`http://127.0.0.1:${bare.port}/health`);
      expect(health.status).toBe(200); // 内部端点关闭不影响基础面
    } finally {
      await bare.close();
    }
  });

  it('错 Bearer / 缺 Authorization → 401（两端点）', async () => {
    const kick = await fetch(`http://127.0.0.1:${relay.port}/internal/kick`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-secret' },
      body: '{}',
    });
    expect(kick.status).toBe(401);
    const stats = await fetch(`http://127.0.0.1:${relay.port}/internal/stats`, {
      headers: { authorization: 'Bearer wrong-secret' },
    });
    expect(stats.status).toBe(401);
    const noHeader = await fetch(`http://127.0.0.1:${relay.port}/internal/stats`);
    expect(noHeader.status).toBe(401);
  });

  it('kick tenantId：拆除该租户在线 server/client（kicked 计数），他租户不受影响', async () => {
    const serverToken = signTenantToken({ tid: 'tenant-a', role: 'server', ak: 'ak-server-a' });
    const clientToken = signTenantToken({ tid: 'tenant-a', role: 'client', ak: 'ak-client-a' });
    const otherToken = signTenantToken({ tid: 'tenant-b', role: 'server', ak: 'ak-server-b' });
    const serverA = await authedSocket(serverToken, {
      role: 'server',
      connectionId: 'ep-1',
    });
    openedSockets.push(serverA);
    const clientA = await authedSocket(clientToken, { role: 'client' });
    openedSockets.push(clientA);
    clientA.send(JSON.stringify({ kind: 'open', connectionId: 'ep-1' }));
    const serverB = await authedSocket(otherToken, {
      role: 'server',
      connectionId: 'ep-2',
    });
    openedSockets.push(serverB);
    await new Promise((r) => setTimeout(r, 80)); // 等 attach 记账落定
    const statsBefore = await authedInternal('/internal/stats');
    await expect(statsBefore.json()).resolves.toEqual({
      tenants: [
        { tenantId: 'tenant-a', servers: 1, clients: 1 },
        { tenantId: 'tenant-b', servers: 1, clients: 0 },
      ],
    });
    // close 监听先于 kick 挂上（terminate 后事件即发，事后挂会永久悬空）
    const serverAClosed = closeCodeOf(serverA);
    const clientAClosed = closeCodeOf(clientA);
    const kick = await authedInternal('/internal/kick', {
      method: 'POST',
      body: JSON.stringify({ tenantId: 'tenant-a' }),
    });
    expect(kick.status).toBe(200);
    await expect(kick.json()).resolves.toEqual({ kicked: 2 });
    await serverAClosed;
    await clientAClosed;
    await new Promise((r) => setTimeout(r, 150)); // 等 close 事件簿记回落
    expect(serverB.readyState).toBe(WebSocket.OPEN);
    const statsAfter = await authedInternal('/internal/stats');
    await expect(statsAfter.json()).resolves.toEqual({
      tenants: [{ tenantId: 'tenant-b', servers: 1, clients: 0 }],
    });
  });

  it('kick ak：按凭证维度拆除（body 字段接线——命中该 ak 的 client，server 保留）', async () => {
    const serverToken = signTenantToken({ tid: 'tenant-a', role: 'server', ak: 'ak-server' });
    const clientToken = signTenantToken({ tid: 'tenant-a', role: 'client', ak: 'ak-client' });
    const server = await authedSocket(serverToken, {
      role: 'server',
      connectionId: 'ep-3',
    });
    openedSockets.push(server);
    const client = await authedSocket(clientToken, { role: 'client' });
    openedSockets.push(client);
    client.send(JSON.stringify({ kind: 'open', connectionId: 'ep-3' }));
    await new Promise((r) => setTimeout(r, 80));
    const clientClosed = closeCodeOf(client); // 先挂监听再 kick（同前）
    const kick = await authedInternal('/internal/kick', {
      method: 'POST',
      body: JSON.stringify({ ak: 'ak-client' }),
    });
    expect(kick.status).toBe(200);
    await expect(kick.json()).resolves.toEqual({ kicked: 1 });
    await clientClosed;
    await new Promise((r) => setTimeout(r, 150));
    expect(server.readyState).toBe(WebSocket.OPEN);
    const stats = await authedInternal('/internal/stats');
    await expect(stats.json()).resolves.toEqual({
      tenants: [{ tenantId: 'tenant-a', servers: 1, clients: 0 }],
    });
  });

  it('kick 空维度 body / 非 JSON body → 400（不误伤任何连接）', async () => {
    const serverToken = signTenantToken({ tid: 'tenant-a', role: 'server' });
    const server = await authedSocket(serverToken, {
      role: 'server',
      connectionId: 'ep-4',
    });
    openedSockets.push(server);
    const emptyTarget = await authedInternal('/internal/kick', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(emptyTarget.status).toBe(400);
    const badJson = await authedInternal('/internal/kick', {
      method: 'POST',
      body: 'not-json',
    });
    expect(badJson.status).toBe(400);
    await new Promise((r) => setTimeout(r, 80));
    expect(server.readyState).toBe(WebSocket.OPEN);
  });
});
