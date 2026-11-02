import {
  generateKeyPairSync,
  sign as eddsaSign,
  verify as eddsaVerify,
} from 'node:crypto';

/**
 * EdDSA access JWT 签发/验签（多租户批 Task 2）——relay 多租户的
 * 加密地基：relay-admin（Task 12）持私钥签发，relay（Task 3）持公钥
 * 验签。node:crypto 原生 Ed25519 + base64url，零第三方依赖（中继
 * 公网暴露面最小化，不引 jose/jsonwebtoken）。
 *
 * 凭证模型：共享 token 是「知道即通过」的对称凭证，泄露即全量失守；
 * access JWT 为非对称凭证——租户只拿短期 token，私钥不出 relay-admin，
 * 且 exp/jti/quota 让限流与吊销（Task 3 连接注册表配合）成为可能。
 */

/** 租户配额：relay 侧按连接角色限流（server/client 分计数） */
export interface AccessQuota {
  maxServers: number;
  maxClients: number;
}

/** access JWT 载荷契约（三端单源；tid = 租户 id，ak = access key id） */
export interface AccessClaims {
  iss: 'tianshu-relay';
  sub: string;
  tid: string;
  role: 'server' | 'client';
  ak: string;
  quota: AccessQuota;
  iat: number;
  exp: number;
  jti: string;
  kid?: string;
}

/** 签发方标识单源——verify 侧 iss 校验与此处同源 */
const EXPECTED_ISS = 'tianshu-relay';

interface JwtHeader {
  alg: 'EdDSA';
  typ: 'JWT';
  /** 密钥 id：多公钥轮换期 relay 据此选钥（JWT 惯例放 header） */
  kid?: string;
}

/**
 * 生成 Ed25519 密钥对（PEM：公 spki / 私 pkcs8）。
 * 租户入驻与密钥轮换时调用；私钥仅存 relay-admin。
 */
export function generateEd25519KeyPems(): {
  publicKeyPem: string;
  privateKeyPem: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
  };
}

/**
 * 签发 access JWT：三段式 `header.payload.signature`，签名覆盖
 * `header.payload` 原文（Ed25519，算法参数 null 为 EdDSA 必填形态）。
 * kid 只入 header（密钥轮换选钥用），不重复入载荷——verify 侧从
 * header 还原，保证签发→验签 claims 完整往返。
 */
export function signAccessJwt(
  claims: AccessClaims,
  privateKeyPem: string,
): string {
  const header: JwtHeader = { alg: 'EdDSA', typ: 'JWT' };
  if (claims.kid !== undefined) header.kid = claims.kid;
  const payload = { ...claims };
  delete payload.kid;
  const encodedHeader = encodeSegment(header);
  const encodedPayload = encodeSegment(payload);
  const signature = eddsaSign(
    null,
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    privateKeyPem,
  );
  return `${encodedHeader}.${encodedPayload}.${signature.toString('base64url')}`;
}

/**
 * 验签并还原 claims；过期/错签/结构坏/iss 不符一律 null（不区分原因，
 * 调用方只做放行判定——时序与报文细节不外泄给探测方）。
 */
export function verifyAccessJwt(
  token: string,
  publicKeyPem: string,
): AccessClaims | null {
  const segments = token.split('.');
  if (segments.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  let header: unknown;
  let payload: unknown;
  try {
    header = decodeSegment(encodedHeader);
    payload = decodeSegment(encodedPayload);
    const signature = Buffer.from(encodedSignature, 'base64url');
    if (
      !eddsaVerify(
        null,
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        publicKeyPem,
        signature,
      )
    )
      return null;
  } catch {
    // 非 base64url / 非 JSON / 公钥 PEM 不合法——同归结构坏
    return null;
  }
  // 结构门：alg 必须仍是 EdDSA（防算法混淆——签名虽已过 Ed25519 验证，
  // header 声明仍需与实际验签算法一致）；两段必须解出 JSON 对象
  if (!isPlainObject(header) || !isPlainObject(payload)) return null;
  if (header.alg !== 'EdDSA') return null;
  // 语义门：签发方不符 / exp 非数或已过（exp 秒级；== now 视为过期）
  if (
    payload.iss !== EXPECTED_ISS ||
    typeof payload.exp !== 'number' ||
    payload.exp <= Date.now() / 1000
  )
    return null;
  // 签名 + iss + exp 三门已过，载荷出自持私钥的签发方——字段形状由
  // 签发侧契约保证，此处仅还原类型
  const restored = { ...payload } as unknown as AccessClaims;
  if (typeof header.kid === 'string') restored.kid = header.kid;
  return restored;
}

/** JSON 对象 → base64url 段（node 原生 base64url：字母表 -_，无 = 填充） */
function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** base64url 段 → JSON 对象（坏输入抛错由调用方归一为 null） */
function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
