import WebSocket from 'ws';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELAY_CLOSE_CODES } from '@tianshu/protocol';
import { RelayRegistry } from 'src/relay/registry';
import {
  generateEd25519KeyPems,
  signAccessJwt,
  type AccessClaims,
  type AccessQuota,
} from 'src/relay/jwt-eddsa';
import { startRelay, type RelayHandle } from 'src/relay/relay-main';

/**
 * relay 租户三校验单测（多租户批 Task 4）：
 * - registry 单元级（假 socket）：顶号 id-conflict / attach 授权
 *   forbidden / 租户连接计数（配额闸数据面）与各断开路径的回落平衡；
 * - relay-main 接线（jwt 模式真实 ws）：4005 配额 / 4006 顶号 / 4007
 *   跨租户 attach，与防御性闸门（quota 畸形载荷 → 4001，签发面失守
 *   不放大成运行时崩溃）。
 * static 模式（tenantId 缺省）的端到端回归由 relay.spec.ts 既有套件
 * 守护；本文件以单元级断言钉死旁路语义。
 */

/** 永不回调的假 socket（与 relay.spec.ts 同型的测试局部替身） */
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

describe('RelayRegistry 租户三校验（单元级）', () => {
  it('异租户注册已占 id → id-conflict（relay 映射 4006）：现有注册与计数不受扰动', () => {
    const registry = new RelayRegistry();
    const owner = new FakeSocket();
    const intruder = new FakeSocket();
    expect(registry.registerServer('s1', owner, 'tenant-a')).toBe('ok');
    expect(registry.registerServer('s1', intruder, 'tenant-b')).toBe(
      'id-conflict',
    );
    expect(RELAY_CLOSE_CODES.ID_CONFLICT).toBe(4006); // wire 值钉死
    // 顶号防护：原连接不被顶掉、闯入者不动台账
    expect(owner.closeCode).toBeUndefined();
    expect(intruder.closeCode).toBeUndefined();
    expect(registry.hasServer('s1')).toBe(true);
    expect(registry.tenantConnCount('tenant-a', 'server')).toBe(1);
    expect(registry.tenantConnCount('tenant-b', 'server')).toBe(0);
  });

  it('同租户重注册 → ok 且顶掉旧连接（现状行为保留），顶号不涨计数', () => {
    const registry = new RelayRegistry();
    const first = new FakeSocket();
    const second = new FakeSocket();
    expect(registry.registerServer('s1', first, 'tenant-a')).toBe('ok');
    expect(registry.registerServer('s1', second, 'tenant-a')).toBe('ok');
    expect(first.closeCode).toBe(4000);
    expect(registry.hasServer('s1')).toBe(true);
    expect(registry.tenantConnCount('tenant-a', 'server')).toBe(1);
  });

  it('attachClient：异租户 forbidden（4007）/ 目标不存在 not-found（现状 4004）/ 同租户 ok', () => {
    const registry = new RelayRegistry();
    const server = new FakeSocket();
    const client = new FakeSocket();
    registry.registerServer('s1', server, 'tenant-a');
    expect(registry.attachClient('s1', client, 'tenant-b')).toBe('forbidden');
    expect(RELAY_CLOSE_CODES.TENANT_FORBIDDEN).toBe(4007); // wire 值钉死
    expect(registry.attachClient('ghost', client, 'tenant-a')).toBe(
      'not-found',
    );
    expect(registry.attachClient('s1', client, 'tenant-a')).toBe('ok');
    expect(registry.tenantConnCount('tenant-a', 'client')).toBe(1);
    expect(registry.tenantConnCount('tenant-b', 'client')).toBe(0);
  });

  it('server 计数：2 连接后 ===2；dropServer 回落；顶号与迟到 close 均不破坏平衡', () => {
    const registry = new RelayRegistry();
    const s1 = new FakeSocket();
    const s2 = new FakeSocket();
    registry.registerServer('id-1', s1, 'tenant-a');
    registry.registerServer('id-2', s2, 'tenant-a');
    expect(registry.tenantConnCount('tenant-a', 'server')).toBe(2);
    expect(registry.tenantConnCount('tenant-b', 'server')).toBe(0);
    // server 真断开（身份守卫通过）→ 回落
    registry.dropServer('id-2', s2, 'server-gone');
    expect(registry.tenantConnCount('tenant-a', 'server')).toBe(1);
    // 顶号重注册：旧连接 close 事件被身份守卫拦截，回落由 registerServer 承担
    const replacement = new FakeSocket();
    expect(registry.registerServer('id-1', replacement, 'tenant-a')).toBe('ok');
    expect(s1.closeCode).toBe(4000);
    registry.dropServer('id-1', s1, 'server-gone'); // 旧连接迟到 close：不得多扣
    expect(registry.tenantConnCount('tenant-a', 'server')).toBe(1);
    registry.dropServer('id-1', replacement, 'server-gone');
    expect(registry.tenantConnCount('tenant-a', 'server')).toBe(0);
  });

  it('client 计数：attach 增、notifyClose 回落；server 掉线连带释放被拆 client', () => {
    const registry = new RelayRegistry();
    const server = new FakeSocket();
    const client = new FakeSocket();
    registry.registerServer('id-1', server, 'tenant-a');
    registry.attachClient('id-1', client, 'tenant-a');
    expect(registry.tenantConnCount('tenant-a', 'client')).toBe(1);
    // client 主动拆配对（F2 close 帧 / ws 断开走 notifyClose）→ 回落
    registry.notifyClose('id-1', client, {
      kind: 'close',
      connectionId: 'id-1',
      reason: 'client-gone',
    });
    expect(registry.tenantConnCount('tenant-a', 'client')).toBe(0);
    // server 掉线连带 4003 拆 client——client 后续 close 事件查不到配对集，回落在此承担
    registry.attachClient('id-1', client, 'tenant-a');
    registry.dropServer('id-1', server, 'server-gone');
    expect(client.closeCode).toBe(4003);
    expect(registry.tenantConnCount('tenant-a', 'client')).toBe(0);
    expect(registry.tenantConnCount('tenant-a', 'server')).toBe(0);
  });

  it('tenantId 缺省（static 模式）：三校验全旁路，行为与现状一致', () => {
    const registry = new RelayRegistry();
    const first = new FakeSocket();
    const second = new FakeSocket();
    const client = new FakeSocket();
    expect(registry.registerServer('s1', first)).toBe('ok');
    expect(registry.registerServer('s1', second)).toBe('ok'); // 无租户即无顶号闸
    expect(first.closeCode).toBe(4000);
    expect(registry.attachClient('s1', client)).toBe('ok');
    expect(registry.attachClient('ghost', new FakeSocket())).toBe('not-found');
    // static 无租户记账：任意租户计数恒 0（配额闸不参与判定）
    expect(registry.tenantConnCount('any-tenant', 'server')).toBe(0);
  });

  it('单侧租户缺省不构成异租户：互替 → ok（旁路语义），台账随替换回落', () => {
    const registry = new RelayRegistry();
    const a = new FakeSocket();
    const b = new FakeSocket();
    const c = new FakeSocket();
    registry.registerServer('s1', a, 'tenant-a');
    expect(registry.registerServer('s1', b)).toBe('ok'); // 无租户连接顶替租户注册
    expect(a.closeCode).toBe(4000);
    expect(registry.tenantConnCount('tenant-a', 'server')).toBe(0);
    expect(registry.registerServer('s1', c, 'tenant-b')).toBe('ok'); // 租户连接顶替无租户注册
    expect(b.closeCode).toBe(4000);
    expect(registry.tenantConnCount('tenant-b', 'server')).toBe(1);
  });
});

describe('relay-main 租户三闸门接线（jwt 模式真实 ws）', () => {
  const keys = generateEd25519KeyPems();
  const nowSec = () => Math.floor(Date.now() / 1000);
  let jtiSeq = 0;

  /** 租户 token 签发：quota 缺省 {maxServers:2, maxClients:2}；显式传
   *  undefined 可构造「载荷无 quota」的畸形凭证（防御闸用例） */
  const signTenantToken = (over: {
    tid?: string;
    role: 'server' | 'client';
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
    const dir = mkdtempSync(join(tmpdir(), 'relay-tenant-'));
    const pubkeyFile = join(dir, 'relay-pub.pem');
    writeFileSync(pubkeyFile, keys.publicKeyPem);
    relay = await startRelay({
      port: 0,
      token: '',
      authPubkeyFile: pubkeyFile,
      authWindowMs: 150,
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

  const sendAuth = (
    ws: WebSocket,
    token: string,
    over: Record<string, unknown> = {},
  ): void => {
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

  it('jwt 防御闸：tid 在场而 quota 缺失 → 4001（畸形载荷不得进租户闸门）', async () => {
    const ws = await openSocket();
    openedSockets.push(ws);
    sendAuth(
      ws,
      signTenantToken({
        tid: 'tenant-a',
        role: 'server',
        quota: undefined,
      }),
      { role: 'server', connectionId: 'def-1' },
    );
    expect(await closeCodeOf(ws)).toBe(4001);
  });

  it('jwt 防御闸：quota 字段非正数（0）→ 4001', async () => {
    const ws = await openSocket();
    openedSockets.push(ws);
    sendAuth(
      ws,
      signTenantToken({
        tid: 'tenant-a',
        role: 'client',
        quota: { maxServers: 0, maxClients: 2 },
      }),
      { role: 'client' },
    );
    expect(await closeCodeOf(ws)).toBe(4001);
  });

  it('jwt tid 缺失 → 按 static 语义旁路（设计内行为，不因此拒绝）', async () => {
    const ws = await authedSocket(
      signTenantToken({ tid: undefined, role: 'client' }),
      { role: 'client' },
    );
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('配额闸（server）：租户 server 连接达 maxServers → 后续注册 close 4005', async () => {
    const token = signTenantToken({
      tid: 'tenant-a',
      role: 'server',
      quota: { maxServers: 1, maxClients: 2 },
    });
    const first = await authedSocket(token, {
      role: 'server',
      connectionId: 'q-1',
    });
    openedSockets.push(first);
    const second = await openSocket();
    openedSockets.push(second);
    sendAuth(second, token, { role: 'server', connectionId: 'q-2' });
    expect(await closeCodeOf(second)).toBe(RELAY_CLOSE_CODES.QUOTA_EXCEEDED);
    expect(first.readyState).toBe(WebSocket.OPEN); // 超限拒入不影响在册连接
  });

  it('配额闸（client）：租户 client 配对达 maxClients → open close 4005', async () => {
    const serverToken = signTenantToken({
      tid: 'tenant-a',
      role: 'server',
      quota: { maxServers: 1, maxClients: 1 },
    });
    const clientToken = signTenantToken({
      tid: 'tenant-a',
      role: 'client',
      quota: { maxServers: 1, maxClients: 1 },
    });
    const server = await authedSocket(serverToken, {
      role: 'server',
      connectionId: 'q-1',
    });
    openedSockets.push(server);
    const client1 = await authedSocket(clientToken, { role: 'client' });
    openedSockets.push(client1);
    client1.send(JSON.stringify({ kind: 'open', connectionId: 'q-1' }));
    await new Promise((r) => setTimeout(r, 80));
    expect(client1.readyState).toBe(WebSocket.OPEN);
    const client2 = await authedSocket(clientToken, { role: 'client' });
    openedSockets.push(client2);
    client2.send(JSON.stringify({ kind: 'open', connectionId: 'q-1' }));
    expect(await closeCodeOf(client2)).toBe(RELAY_CLOSE_CODES.QUOTA_EXCEEDED);
  });

  it('配额闸不误拒重开：已达 maxClients 的 client 重开同目标不 4005', async () => {
    const serverToken = signTenantToken({
      tid: 'tenant-a',
      role: 'server',
      quota: { maxServers: 1, maxClients: 1 },
    });
    const clientToken = signTenantToken({
      tid: 'tenant-a',
      role: 'client',
      quota: { maxServers: 1, maxClients: 1 },
    });
    const server = await authedSocket(serverToken, {
      role: 'server',
      connectionId: 'r-1',
    });
    openedSockets.push(server);
    const client = await authedSocket(clientToken, { role: 'client' });
    openedSockets.push(client);
    client.send(JSON.stringify({ kind: 'open', connectionId: 'r-1' }));
    await new Promise((r) => setTimeout(r, 80));
    client.send(JSON.stringify({ kind: 'open', connectionId: 'r-1' })); // 重开同目标
    await new Promise((r) => setTimeout(r, 150));
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it('配额回落：client 断开后租户额度释放，新 client 可接入（close 事件链不漏账）', async () => {
    const serverToken = signTenantToken({
      tid: 'tenant-a',
      role: 'server',
      quota: { maxServers: 1, maxClients: 1 },
    });
    const clientToken = signTenantToken({
      tid: 'tenant-a',
      role: 'client',
      quota: { maxServers: 1, maxClients: 1 },
    });
    const server = await authedSocket(serverToken, {
      role: 'server',
      connectionId: 'f-1',
    });
    openedSockets.push(server);
    const client1 = await authedSocket(clientToken, { role: 'client' });
    openedSockets.push(client1);
    client1.send(JSON.stringify({ kind: 'open', connectionId: 'f-1' }));
    await new Promise((r) => setTimeout(r, 80));
    expect(client1.readyState).toBe(WebSocket.OPEN);
    // 主动断开：relay 侧 close 事件链（forget → notifyClose）须回落计数
    client1.close();
    await closeCodeOf(client1);
    await new Promise((r) => setTimeout(r, 150)); // 等 relay 侧回落落定
    const client2 = await authedSocket(clientToken, { role: 'client' });
    openedSockets.push(client2);
    client2.send(JSON.stringify({ kind: 'open', connectionId: 'f-1' }));
    await new Promise((r) => setTimeout(r, 150));
    expect(client2.readyState).toBe(WebSocket.OPEN); // 漏账会误拆 4005
  });

  it('顶号闸：异租户注册已占 connectionId → close 4006，在册连接不受扰动', async () => {
    const tokenA = signTenantToken({ tid: 'tenant-a', role: 'server' });
    const tokenB = signTenantToken({ tid: 'tenant-b', role: 'server' });
    const owner = await authedSocket(tokenA, {
      role: 'server',
      connectionId: 'dup-1',
    });
    openedSockets.push(owner);
    const intruder = await openSocket();
    openedSockets.push(intruder);
    sendAuth(intruder, tokenB, { role: 'server', connectionId: 'dup-1' });
    expect(await closeCodeOf(intruder)).toBe(RELAY_CLOSE_CODES.ID_CONFLICT);
    await new Promise((r) => setTimeout(r, 80));
    expect(owner.readyState).toBe(WebSocket.OPEN);
  });

  it('同租户重注册同 id：顶掉旧连接 4000（现状行为在 jwt 模式保留）', async () => {
    const token = signTenantToken({ tid: 'tenant-a', role: 'server' });
    const first = await authedSocket(token, {
      role: 'server',
      connectionId: 'dup-2',
    });
    openedSockets.push(first);
    // 先挂 close 监听再触发重注册（authedSocket 含 80ms 等待，事后挂会错过事件）
    const firstClosed = closeCodeOf(first);
    const second = await authedSocket(token, {
      role: 'server',
      connectionId: 'dup-2',
    });
    openedSockets.push(second);
    expect(await firstClosed).toBe(4000);
    expect(second.readyState).toBe(WebSocket.OPEN);
  });

  it('attach 授权闸：异租户 client open → close 4007', async () => {
    const serverToken = signTenantToken({ tid: 'tenant-a', role: 'server' });
    const clientToken = signTenantToken({ tid: 'tenant-b', role: 'client' });
    const server = await authedSocket(serverToken, {
      role: 'server',
      connectionId: 's-x',
    });
    openedSockets.push(server);
    const client = await authedSocket(clientToken, { role: 'client' });
    openedSockets.push(client);
    client.send(JSON.stringify({ kind: 'open', connectionId: 's-x' }));
    expect(await closeCodeOf(client)).toBe(RELAY_CLOSE_CODES.TENANT_FORBIDDEN);
  });
});
