import WebSocket from 'ws';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
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

  it('tid 缺失/空串/非字符串 → 4001（畸形载荷 fail-closed：正常签发恒带 tid，缺失即畸形——终审 Minor #3 更新 T4 旁路 ruling）', () => {
    const auth = createJwtAuthenticator(keys.publicKeyPem, neverRevoked);
    const withoutTid: Partial<AccessClaims> = { ...baseClaims };
    delete withoutTid.tid;
    const malformed: AccessClaims[] = [
      withoutTid as AccessClaims,
      { ...baseClaims, tid: '' },
      { ...baseClaims, tid: 42 as unknown as string },
    ];
    for (const claims of malformed)
      expect(
        auth.admit({ token: sign(claims), role: 'client', connectionId: '' }),
      ).toEqual({ ok: false, closeCode: 4001, reason: 'invalid-token' });
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
  // A1（终审 Minor #3）：tid 缺失的畸形载荷（合法签名）——正常签发
  // （relay-admin token.service）恒带 tid，缺失即畸形 → 首帧 fail-closed
  const noTidClaims: Partial<AccessClaims> = {
    iss: 'tianshu-relay',
    sub: 'conn-client-no-tid',
    role: 'client',
    ak: 'ak_live_000456',
    quota: { maxServers: 3, maxClients: 10 },
    iat: nowSec(),
    exp: nowSec() + 600,
    jti: 'jti-0004',
  };
  const noTidToken = signAccessJwt(
    noTidClaims as AccessClaims,
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

  /** 有界等待 close：窗内未 close → null（畸形载荷被放行的 RED 形态下
   *  连接保持 OPEN——null 失败比挂死等 close 的超时更快更指向） */
  const closeCodeWithin = (ws: WebSocket, ms: number): Promise<number | null> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      ws.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

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

  it('jwt 模式：tid 缺失的合法签名 token → 4001（畸形载荷不得按 static 语义旁路租户闸——终审 Minor #3）', async () => {
    const ws = await openSocketOn(relay.port);
    openedSockets.push(ws);
    sendAuth(ws, noTidToken, { role: 'client' });
    expect(await closeCodeWithin(ws, 400)).toBe(4001);
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

  /** 启动期拒绝断言（A2 终审 Minor #8）：Error → 断言消息；句柄（RED
   *  漏监听形态）→ 关句柄再转失败，防泄漏监听挂住测试进程退出 */
  async function expectBootRefused(
    pubkeyContent: string,
    expectedMessage: string,
  ): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'relay-auth-'));
    const file = join(dir, 'relay-pub.pem');
    writeFileSync(file, pubkeyContent);
    const outcome = await startRelay({
      port: 0,
      token: '',
      authPubkeyFile: file,
    }).then(
      (h) => h,
      (e: Error) => e,
    );
    if (outcome instanceof Error) expect(outcome.message).toBe(expectedMessage);
    else {
      await outcome.close();
      throw new Error(`竟启动成功（期望：${expectedMessage}）`);
    }
  }

  it('jwt 模式：公钥文件存在但内容非法 → 拒绝启动（坏 PEM 不得漏到运行期伪装成 4001 invalid-token）', async () => {
    await expectBootRefused(
      'not a pem at all\n',
      'relay 拒绝启动：--auth-pubkey 不是合法公钥',
    );
  });

  it('jwt 模式：RSA 公钥 PEM → 拒绝启动（verifyAccessJwt 固定 EdDSA，非 Ed25519 公钥漏到运行期 = 全员 4001 伪装凭证失败）', async () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expectBootRefused(
      publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      'relay 拒绝启动：--auth-pubkey 不是 Ed25519 公钥（当前解析为 rsa）',
    );
  });

  it('jwt 模式：误传 Ed25519 私钥 PEM → 拒绝启动（createPublicKey 会从私钥提出 ed25519 公钥、类型检查拦不住——签发私钥不得落在 relay 侧）', async () => {
    await expectBootRefused(
      keys.privateKeyPem,
      'relay 拒绝启动：--auth-pubkey 是私钥 PEM——只接受 Ed25519 公钥（签发私钥不得落在 relay 侧）',
    );
  });

  it('jwt 模式：合法 Ed25519 公钥 → 启动正常（类型白名单不误伤正配）', async () => {
    const own = generateEd25519KeyPems();
    const dir = mkdtempSync(join(tmpdir(), 'relay-auth-'));
    const file = join(dir, 'relay-pub.pem');
    writeFileSync(file, own.publicKeyPem);
    const handle = await startRelay({
      port: 0,
      token: '',
      authPubkeyFile: file,
    });
    expect(handle.port).toBeGreaterThan(0);
    await handle.close();
  });

  it('token 与公钥两者皆缺 → 拒绝启动（现状保留）', async () => {
    await expect(startRelay({ port: 0, token: '' })).rejects.toThrow('token');
  });

  it('token 与 authPubkeyFile 同传 → 拒绝启动（spec §4.1 双模式严格互斥，不得静默选 jwt）', async () => {
    // 终审 fix：此前缺省推断 jwt 静默胜出、static token 被忽略——运营员
    // 从 static 迁移时 unit 文件残留 --token 会全员 4001 且无线索
    await expect(
      startRelay({ port: 0, token: TOKEN, authPubkeyFile: pubkeyFile }),
    ).rejects.toThrow(
      'relay 拒绝启动：--token 与 --auth-pubkey 互斥，请只保留一种鉴权方式',
    );
    // 显式 authMode 也不豁免（两凭证面在场即互斥事实，与模式声明无关）
    await expect(
      startRelay({
        port: 0,
        token: TOKEN,
        authPubkeyFile: pubkeyFile,
        authMode: 'static',
      }),
    ).rejects.toThrow('互斥');
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
