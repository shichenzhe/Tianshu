import WebSocket from 'ws';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createJwtAuthenticator,
  createStaticAuthenticator,
} from 'src/relay/auth';
import {
  generateEd25519KeyPems,
  signAccessJwt,
  type AccessClaims,
} from 'src/relay/jwt-eddsa';
import {
  parseCliArgs,
  startRelay,
  type RelayHandle,
} from 'src/relay/relay-main';

/**
 * relay 鉴权策略单测（多租户批 Task 3）：Authenticator 抽象双实现的行为面。
 * - static：原 admitConnection 内联校验的现状平移——裁决值（4001/
 *   4000、reason、校验次序）逐字节对齐，防平移漂移；
 * - jwt：EdDSA 验签 + 吊销回调 + 角色以（已签名的）claims 为准；
 * - relay-main 接线：模式推断（公钥在场即 jwt）、CLI 新旗标、
 *   jwt 模式真实 ws 接入与业务透传。
 */
const TOKEN = 'relay-secret';
const nowSec = () => Math.floor(Date.now() / 1000);

describe('static 鉴权器（现状平移）', () => {
  const auth = createStaticAuthenticator(TOKEN);

  it('正确 token + role=server → ok，不带租户维度（Task 4 三校验旁路依据）', () => {
    const decision = auth.admit({
      token: TOKEN,
      role: 'server',
      connectionId: 's1',
    });
    expect(decision).toEqual({ ok: true, role: 'server' });
    if (decision.ok) {
      expect(decision.tenantId).toBeUndefined();
      expect(decision.quota).toBeUndefined();
      expect(decision.ak).toBeUndefined();
    }
  });

  it('正确 token + role=client → ok（connectionId 空串同样放行——missing-connection-id 属 handleServerSocket 后置校验）', () => {
    expect(
      auth.admit({ token: TOKEN, role: 'client', connectionId: '' }),
    ).toEqual({ ok: true, role: 'client' });
  });

  it('错 token → 4001 invalid-token', () => {
    expect(auth.admit({ token: 'WRONG', role: 'client', connectionId: '' })).toEqual(
      { ok: false, closeCode: 4001, reason: 'invalid-token' },
    );
  });

  it('非法 role → 4000 invalid-role', () => {
    expect(
      auth.admit({ token: TOKEN, role: 'attacker', connectionId: '' }),
    ).toEqual({ ok: false, closeCode: 4000, reason: 'invalid-role' });
  });

  it('错 token 且非法 role → 4001（token 先于 role，与原内联校验次序一致）', () => {
    expect(
      auth.admit({ token: 'WRONG', role: 'attacker', connectionId: '' }),
    ).toEqual({ ok: false, closeCode: 4001, reason: 'invalid-token' });
  });
});

describe('jwt 鉴权器', () => {
  const keys = generateEd25519KeyPems();
  const neverRevoked = () => false;

  const baseClaims: AccessClaims = {
    iss: 'tianshu-relay',
    sub: 'conn-server-1',
    tid: 'tenant-alpha',
    role: 'server',
    ak: 'ak_live_000123',
    quota: { maxServers: 3, maxClients: 10 },
    iat: nowSec(),
    exp: nowSec() + 600,
    jti: 'jti-0001',
  };
  const sign = (claims: AccessClaims): string =>
    signAccessJwt(claims, keys.privateKeyPem);

  it('合法 token → ok 且带 tenantId/role/quota/ak', () => {
    const auth = createJwtAuthenticator(keys.publicKeyPem, neverRevoked);
    expect(auth.admit({ token: sign(baseClaims), role: '', connectionId: '' })).toEqual(
      {
        ok: true,
        role: 'server',
        tenantId: 'tenant-alpha',
        quota: { maxServers: 3, maxClients: 10 },
        ak: 'ak_live_000123',
      },
    );
  });

  it('角色以（已签名的）claims 为准，不理首帧自报 role', () => {
    const auth = createJwtAuthenticator(keys.publicKeyPem, neverRevoked);
    // 帧自报 client，token 载荷签的是 server——凭证本体是 token
    const decision = auth.admit({
      token: sign(baseClaims),
      role: 'client',
      connectionId: '',
    });
    expect(decision).toEqual({
      ok: true,
      role: 'server',
      tenantId: 'tenant-alpha',
      quota: { maxServers: 3, maxClients: 10 },
      ak: 'ak_live_000123',
    });
  });

  it('过期 token → 4001 invalid-token', () => {
    const auth = createJwtAuthenticator(keys.publicKeyPem, neverRevoked);
    const expired = sign({ ...baseClaims, exp: nowSec() - 1 });
    expect(auth.admit({ token: expired, role: 'client', connectionId: '' })).toEqual(
      { ok: false, closeCode: 4001, reason: 'invalid-token' },
    );
  });

  it('isRevoked 命中 tid → 4001（与验签失败同归因，不外泄细节）', () => {
    const auth = createJwtAuthenticator(
      keys.publicKeyPem,
      (t) => t.tid === 'tenant-alpha',
    );
    expect(
      auth.admit({ token: sign(baseClaims), role: 'client', connectionId: '' }),
    ).toEqual({ ok: false, closeCode: 4001, reason: 'invalid-token' });
  });

  it('isRevoked 命中 ak → 4001', () => {
    const auth = createJwtAuthenticator(
      keys.publicKeyPem,
      (t) => t.ak === 'ak_live_000123',
    );
    expect(
      auth.admit({ token: sign(baseClaims), role: 'client', connectionId: '' }),
    ).toEqual({ ok: false, closeCode: 4001, reason: 'invalid-token' });
  });

  it('畸形 token → 4001（空串/非 JWT/两段/四段/乱码）', () => {
    const auth = createJwtAuthenticator(keys.publicKeyPem, neverRevoked);
    const valid = sign(baseClaims);
    for (const token of [
      '',
      'not-a-jwt',
      'only.two',
      `${valid}.extra`,
      '###.???.~~~',
    ])
      expect(auth.admit({ token, role: 'client', connectionId: '' })).toEqual({
        ok: false,
        closeCode: 4001,
        reason: 'invalid-token',
      });
  });

  it('错私钥签发（公钥不配对）→ 4001', () => {
    const auth = createJwtAuthenticator(
      generateEd25519KeyPems().publicKeyPem,
      neverRevoked,
    );
    expect(
      auth.admit({ token: sign(baseClaims), role: 'client', connectionId: '' }),
    ).toEqual({ ok: false, closeCode: 4001, reason: 'invalid-token' });
  });

  it('claims.role 非法（签发面失守防御）→ 4000 invalid-role', () => {
    const auth = createJwtAuthenticator(keys.publicKeyPem, neverRevoked);
    // 签发侧类型收窄不等于 wire 保证：verify 还原后仍需角色白名单兜底
    const forged = {
      ...baseClaims,
      role: 'admin' as AccessClaims['role'],
    };
    expect(
      auth.admit({ token: sign(forged), role: 'client', connectionId: '' }),
    ).toEqual({ ok: false, closeCode: 4000, reason: 'invalid-role' });
  });
});

describe('relay-main 鉴权模式接线（真实 ws）', () => {
  const keys = generateEd25519KeyPems();

  const serverToken = signAccessJwt(
    {
      iss: 'tianshu-relay',
      sub: 'conn-server-1',
      tid: 'tenant-alpha',
      role: 'server',
      ak: 'ak_live_000123',
      quota: { maxServers: 3, maxClients: 10 },
      iat: nowSec(),
      exp: nowSec() + 600,
      jti: 'jti-0001',
    },
    keys.privateKeyPem,
  );
  const clientToken = signAccessJwt(
    {
      iss: 'tianshu-relay',
      sub: 'conn-client-1',
      tid: 'tenant-alpha',
      role: 'client',
      ak: 'ak_live_000456',
      quota: { maxServers: 3, maxClients: 10 },
      iat: nowSec(),
      exp: nowSec() + 600,
      jti: 'jti-0002',
    },
    keys.privateKeyPem,
  );

  let relay: RelayHandle;
  let pubkeyFile: string;
  let openedSockets: WebSocket[];

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-auth-'));
    pubkeyFile = join(dir, 'relay-pub.pem');
    writeFileSync(pubkeyFile, keys.publicKeyPem);
    // jwt 模式推断：authPubkeyFile 在场即 jwt——token 留空不再强制
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

  /** 首帧 auth 后等待裁决落定：放行则保持 OPEN（80ms 内无 4001/4000） */
  async function authedSocket(
    token: string,
    over: Record<string, unknown>,
  ): Promise<WebSocket> {
    const ws = await openSocketOn(relay.port);
    sendAuth(ws, token, over);
    await new Promise((r) => setTimeout(r, 80));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    return ws;
  }

  it('jwt 模式：合法 token 接入并业务透传（server/client 配对 + req 转发）', async () => {
    const server = await authedSocket(serverToken, {
      role: 'server',
      connectionId: 's1',
    });
    openedSockets.push(server);
    const client = await authedSocket(clientToken, { role: 'client' });
    openedSockets.push(client);
    client.send(JSON.stringify({ kind: 'open', connectionId: 's1' }));
    client.send(JSON.stringify({ kind: 'req', id: 1, method: 'info' }));
    const frames = await new Promise<unknown[]>((resolve) => {
      const received: unknown[] = [];
      server.on('message', (raw) => {
        received.push(JSON.parse((raw as Buffer).toString()));
        if (received.length >= 2) resolve(received);
      });
    });
    expect(frames).toEqual([
      { kind: 'open', connectionId: 's1' },
      { kind: 'req', id: 1, method: 'info' },
    ]);
  });

  it('jwt 模式：静态共享 token 不再受理 → 4001', async () => {
    const ws = await openSocketOn(relay.port);
    openedSockets.push(ws);
    sendAuth(ws, TOKEN, { role: 'client' });
    expect(await closeCodeOf(ws)).toBe(4001);
  });

  it('jwt 模式：过期 token → 4001', async () => {
    const expired = signAccessJwt(
      {
        iss: 'tianshu-relay',
        sub: 'conn-client-1',
        tid: 'tenant-alpha',
        role: 'client',
        ak: 'ak_live_000456',
        quota: { maxServers: 3, maxClients: 10 },
        iat: nowSec(),
        exp: nowSec() - 1,
        jti: 'jti-0003',
      },
      keys.privateKeyPem,
    );
    const ws = await openSocketOn(relay.port);
    openedSockets.push(ws);
    sendAuth(ws, expired, { role: 'client' });
    expect(await closeCodeOf(ws)).toBe(4001);
  });

  it('jwt 模式：token 不再是启动必要条件（token 留空可启动）', async () => {
    const own = await startRelay({ port: 0, token: '', authPubkeyFile: pubkeyFile });
    expect(own.port).toBeGreaterThan(0);
    await own.close();
  });

  it('显式 authMode=jwt 但缺公钥 → 拒绝启动', async () => {
    await expect(
      startRelay({ port: 0, token: '', authMode: 'jwt' }),
    ).rejects.toThrow('auth-pubkey');
  });

  it('token 与公钥两者皆缺 → 拒绝启动（现状保留）', async () => {
    await expect(startRelay({ port: 0, token: '' })).rejects.toThrow('token');
  });

  it('显式 authMode=static：行为不变（错 token 4001 / 对 token 放行）', async () => {
    const own = await startRelay({
      port: 0,
      token: TOKEN,
      authMode: 'static',
      authWindowMs: 150,
    });
    try {
      const bad = await openSocketOn(own.port);
      sendAuth(bad, 'WRONG', { role: 'client' });
      expect(await closeCodeOf(bad)).toBe(4001);
      const good = await openSocketOn(own.port);
      sendAuth(good, TOKEN, { role: 'client' });
      await new Promise((r) => setTimeout(r, 80));
      expect(good.readyState).toBe(WebSocket.OPEN);
      good.terminate();
    } finally {
      await own.close();
    }
  });

  it('parseCliArgs：--auth-pubkey/--internal-secret 两种形式；缺省不设', () => {
    const opts = parseCliArgs([
      '--token',
      't',
      '--auth-pubkey',
      '/keys/relay-pub.pem',
      '--internal-secret=internal-s1',
    ]);
    expect(opts.authPubkeyFile).toBe('/keys/relay-pub.pem');
    expect(opts.internalSecret).toBe('internal-s1');
    const plain = parseCliArgs(['--token', 't']);
    expect(plain.authPubkeyFile).toBeUndefined();
    expect(plain.internalSecret).toBeUndefined();
    expect(plain.authMode).toBeUndefined();
  });
});
