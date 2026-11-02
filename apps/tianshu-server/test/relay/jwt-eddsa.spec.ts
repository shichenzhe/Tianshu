import {
  generateEd25519KeyPems,
  signAccessJwt,
  verifyAccessJwt,
  type AccessClaims,
} from 'src/relay/jwt-eddsa';

/**
 * jwt-eddsa 单测（多租户批 Task 2）：EdDSA access JWT 签发/验签的
 * 纯 crypto 行为面——往返还原、错签/过期/篡改/坏结构拒收、
 * base64url 编码洁净（无 +/=）。relay 侧消费（Task 3）与
 * relay-admin 签发（Task 12）共同依赖此契约。
 */
describe('relay/jwt-eddsa', () => {
  const keys = generateEd25519KeyPems();
  const nowSec = () => Math.floor(Date.now() / 1000);

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
    kid: 'kid-2026a',
  };

  it('generateEd25519KeyPems 导出 spki/pkcs8 PEM 且可完成签发验签', () => {
    expect(keys.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(keys.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    const token = signAccessJwt(baseClaims, keys.privateKeyPem);
    expect(verifyAccessJwt(token, keys.publicKeyPem)).not.toBeNull();
  });

  it('往返：签发→验签还原全部 claims（含 kid 经 header 还原）', () => {
    const token = signAccessJwt(baseClaims, keys.privateKeyPem);
    expect(verifyAccessJwt(token, keys.publicKeyPem)).toEqual(baseClaims);
  });

  it('往返（无 kid）：还原结果不带 kid', () => {
    const claims = { ...baseClaims };
    delete claims.kid;
    const token = signAccessJwt(claims, keys.privateKeyPem);
    expect(verifyAccessJwt(token, keys.publicKeyPem)).toEqual(claims);
  });

  it('错公钥验签 → null', () => {
    const token = signAccessJwt(baseClaims, keys.privateKeyPem);
    const otherKeys = generateEd25519KeyPems();
    expect(verifyAccessJwt(token, otherKeys.publicKeyPem)).toBeNull();
  });

  it('exp 已过 → null', () => {
    const expired = { ...baseClaims, exp: nowSec() - 1 };
    const token = signAccessJwt(expired, keys.privateKeyPem);
    expect(verifyAccessJwt(token, keys.publicKeyPem)).toBeNull();
  });

  it('iss 不符 → null', () => {
    const forged = { ...baseClaims, iss: 'evil-relay' as AccessClaims['iss'] };
    const token = signAccessJwt(forged, keys.privateKeyPem);
    expect(verifyAccessJwt(token, keys.publicKeyPem)).toBeNull();
  });

  it('篡改 payload → null（签名覆盖 header.payload 两段）', () => {
    const token = signAccessJwt(baseClaims, keys.privateKeyPem);
    const [header, payload, signature] = token.split('.');
    // 换 tid 重编码载荷——b64url 合法但签名不再覆盖新内容
    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    decoded.tid = 'tenant-evil';
    const tampered = [
      header,
      Buffer.from(JSON.stringify(decoded)).toString('base64url'),
      signature,
    ].join('.');
    expect(verifyAccessJwt(tampered, keys.publicKeyPem)).toBeNull();
  });

  it('坏结构 → null', () => {
    const token = signAccessJwt(baseClaims, keys.privateKeyPem);
    const bogus = [
      '',
      'not-a-jwt',
      'only.two',
      `${token}.extra`,
      '###.???.~~~',
    ];
    for (const input of bogus)
      expect(verifyAccessJwt(input, keys.publicKeyPem)).toBeNull();
  });

  it('b64url 编码：三段均无 +/= 字符（对照同载荷标准 base64 确有）', () => {
    // iat/exp 取常量保证字节布局确定，jti 选型让标准 base64 必然产出
    // + / = 三字符——对照断言证明本用例有检出力（若实现误用标准
    // base64，主断言必失败）
    const claims: AccessClaims = {
      ...baseClaims,
      iat: 1_760_000_000,
      exp: 1_760_003_600,
      jti: '?>?>?>>??',
    };
    const token = signAccessJwt(claims, keys.privateKeyPem);
    const segments = token.split('.');
    expect(segments).toHaveLength(3);
    for (const segment of segments) expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);
    const payloadJson = Buffer.from(segments[1], 'base64url').toString('utf8');
    expect(Buffer.from(payloadJson).toString('base64')).toMatch(/[+/=]/);
  });
});
