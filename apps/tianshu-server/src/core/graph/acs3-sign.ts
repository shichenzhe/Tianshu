// electron/domains/ai/orchestration/acs3-sign.ts
/**
 * 自 mirror electron/domains/ai/orchestration/acs3-sign.ts 直摘（GA-T4 闭包
 * 随行件——executor http 节点 acs3 鉴权动态引用；spec §3.4 原列「按需后续」
 * 排除，因 executor 引用无法缺席而随行，纯 node:crypto 零外部依赖）。
 * 零逻辑改动。
 */
/**
 * 阿里云 ACS3-HMAC-SHA256 签名（OpenAPI V3 / API 网关）：按官方规范拼
 * CanonicalRequest（方法/URI/排序查询串/小写头/签名头清单/payload sha256）
 * → StringToSign → HMAC-SHA256(secret) → Authorization 头。时间与 nonce
 * 支持注入（测试向量可复现）。headerPrefix 可配置（默认 x-acs-）——
 * 用 ACS3 算法对接头名不同的其他网关时改前缀，date/signature-nonce/
 * content-sha256 三头按前缀注入，签名头集合随之匹配。
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';

export const DEFAULT_ACS3_HEADER_PREFIX = 'x-acs-';
export const DEFAULT_ACS3_ALGORITHM = 'ACS3-HMAC-SHA256';

/** RFC3986 percent-encode（encodeURIComponent 不编码 ! ' ( ) *，需补） */
export function percentEncode(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** 规范查询串：key/value 各自 RFC3986 编码后按 key 排序（同 key 按值） */
export function canonicalQueryString(query: Array<[string, string]>): string {
  return [...query]
    .map(([key, value]) => [percentEncode(key), percentEncode(value)])
    .sort((a, b) =>
      a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

/** 参与签名的头集合：host + content-type（如有）+ 全部 {prefix}* 头；
 * 头名小写、值 trim，按头名排序后逐行 `name:value\n` */
function signedHeadersOf(
  url: URL,
  headers: Record<string, string>,
  prefix: string,
): { canonicalHeaders: string; signedHeaderNames: string[] } {
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    lower[name.toLowerCase()] = value.trim();
  }
  lower['host'] = url.host;
  const names = Object.keys(lower)
    .filter(
      (name) =>
        name === 'host' || name === 'content-type' || name.startsWith(prefix),
    )
    .sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${lower[name]}\n`)
    .join('');
  return { canonicalHeaders, signedHeaderNames: names };
}

export interface Acs3SignInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | Uint8Array;
  accessKeyId: string;
  accessKeySecret: string;
  /** 参与签名的自定义头前缀（默认 x-acs-，可改写以对接其他网关） */
  headerPrefix?: string;
  /** 签名算法标识（默认 ACS3-HMAC-SHA256，可按目标网关改写） */
  algorithm?: string;
  /** 测试注入：固定时间/随机数（缺省取当前时间与随机 UUID） */
  now?: Date;
  nonce?: string;
}

/** 计算签名并返回待注入的头（调用方写回 headers 后再发请求） */
export function signAcs3(input: Acs3SignInput): {
  headers: Record<string, string>;
  authorization: string;
} {
  const now = input.now ?? new Date();
  const nonce = input.nonce ?? randomUUID();
  const prefix = (input.headerPrefix ?? DEFAULT_ACS3_HEADER_PREFIX)
    .trim()
    .toLowerCase();
  const algorithm = input.algorithm ?? DEFAULT_ACS3_ALGORITHM;
  const pad = (n: number) => String(n).padStart(2, '0');
  const xAcsDate = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}T${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}Z`;
  const payloadHash = createHash('sha256').update(input.body).digest('hex');

  // 参与签名的头集合 + 按前缀自动注入 date/nonce/content-sha256
  const headers = { ...input.headers };
  headers[`${prefix}date`] = xAcsDate;
  headers[`${prefix}signature-nonce`] = nonce;
  headers[`${prefix}content-sha256`] = payloadHash;
  const { canonicalHeaders, signedHeaderNames } = signedHeadersOf(
    input.url,
    headers,
    prefix,
  );

  // CanonicalURI：URL.pathname 规范为以 / 开头（空路径补 /）
  const pathname = input.url.pathname === '' ? '/' : input.url.pathname;
  const canonicalRequest = [
    input.method.toUpperCase(),
    pathname,
    canonicalQueryString([...input.url.searchParams.entries()] as Array<
      [string, string]
    >),
    canonicalHeaders,
    signedHeaderNames.join(';'),
    payloadHash,
  ].join('\n');

  const stringToSign = `${algorithm}\n${createHash('sha256')
    .update(canonicalRequest, 'utf-8')
    .digest('hex')}`;
  const signature = createHmac('sha256', input.accessKeySecret)
    .update(stringToSign, 'utf-8')
    .digest('hex');
  const authorization =
    `${algorithm} Credential=${input.accessKeyId},` +
    `SignedHeaders=${signedHeaderNames.join(';')},Signature=${signature}`;

  return {
    headers: {
      ...headers,
      Authorization: authorization,
    },
    authorization,
  };
}
