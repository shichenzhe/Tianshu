/**
 * 图编排 HTTP 节点 URL 守卫（安全审查 2026-11-02 S5 + 尾批 F1 DNS 解析级；
 * 逃生口 2026-11-04）：协议白名单（http/https）+ 字面 IP 分类拦截
 * （环回/链路本地/私网/CGNAT/保留段 + 云 metadata 主机名 + 十进制/十六
 * 进制 IP 编码形态）。
 *
 * 背景：HTTP 节点 URL 可被 webhook 输入与 LLM 节点输出模板化
 * （`{{input.x}}`），且响应体可经 responseTemplate 回显——不设守卫即
 * 完整 SSRF read-back；agent fetch 工具的 SSRF 清单曾被图节点整面旁路。
 *
 * 逃生口（2026-11-04 用户裁定）：桌面端=用户本人机器，内网全权，
 * 执行器传 allowPrivateNetwork: true；server 部署态缺省严拦，经
 * config.yml tianshu.graph 段显式登记 allowlist / 放开。不随 policy
 * 变化的硬边界（白名单也不豁免）：协议白名单、metadata 三元组、
 * 链路本地段（IPv4 169.254/16 与 IPv6 fe8-eb——metadata 所在段，
 * 防云桌面场景偷凭证）。
 *
 * metadata 三元组与 electron/domains/security/ssrf-hosts.ts 及
 * tianshu-server src/core/tools/ssrf-hosts.ts 的清单保持同步（core 包
 * 不反向依赖 electron，注释锚定）。
 */
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.azure.com",
]);

/**
 * 守卫逃生口策略（2026-11-04 裁定）：
 * - allowPrivateNetwork：放行环回/localhost/私网/CGNAT/保留段/编码内网
 *   形态 + IPv6 ULA/环回/v4 映射，DNS 解析级内网判定同步放行（链路本地
 *   段除外——硬边界）。桌面端执行器恒传 true。
 * - allowlist：显式放行清单，条目为精确 IP / 精确域名 / IPv4 CIDR
 *   （如 192.168.1.0/24）；命中即跳过字面内网判定，域名条目免 DNS 级
 *   判定，CIDR 同时匹配字面 IP 与解析结果。编码 IP 形态不做 CIDR
 *   匹配（数字串非 isIP，部署方用真 IP 登记即可）。
 * 两通道叠加语义：任一放行即放行；均不能豁免硬边界。
 */
export interface GraphHttpUrlPolicy {
  allowPrivateNetwork?: boolean;
  allowlist?: string[];
}

/** IPv4 字面量分类：link-local=硬边界段；private=随 policy 放行段 */
function classifyIpv4(host: string): "link-local" | "private" | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  const [a, b] = octets;
  if (a === 169 && b === 254) return "link-local"; // 链路本地（含 metadata 段）
  if (a === 127 || a === 0 || a === 10) return "private"; // 环回/本网/私网 A
  if (a === 172 && b >= 16 && b <= 31) return "private"; // 私网 B
  if (a === 192 && b === 168) return "private"; // 私网 C
  if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT
  if (a === 192 && b === 0) return "private"; // 192.0.0.0/24 与 192.0.2.0/24
  return null;
}

/** IPv6 字面量分类：link-local=硬边界；private=随 policy 放行（环回/
 * 唯一本地/v4 映射内嵌段；十六进制映射形态无法可靠分类一律归 private） */
function classifyIpv6(host: string): "link-local" | "private" | null {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::" || h === "::1") return "private";
  // ::ffff:a.b.c.d / ::ffff:hex 形式的 v4 映射：解析内嵌地址复判
  const mapped = h.match(/^::ffff:(.+)$/);
  if (mapped) {
    const inner = mapped[1]!;
    if (isIP(inner) === 4) return classifyIpv4(inner);
    return "private"; // 十六进制映射形态一律收死（无法可靠分类）
  }
  // 前缀分类：fc/fd（唯一本地）、fe8-eb（链路本地）
  const first = h.split(":")[0] ?? "";
  if (first.startsWith("fc") || first.startsWith("fd")) {
    return "private";
  }
  if (/^fe[89ab]/.test(first)) return "link-local";
  return null;
}

/** 非点分十进制的数字 IP 编码（http://2130706433 = 127.0.0.1、0x 形态） */
function classifyEncodedIp(host: string): "link-local" | "private" | null {
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    return n > 0 && n < 2 ** 32 ? classifyIpv4(ipv4OfLong(n)) : null;
  }
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const n = parseInt(host, 16);
    return n < 2 ** 32 ? classifyIpv4(ipv4OfLong(n)) : null;
  }
  return null;
}

function ipv4OfLong(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** policy 通道放行：内网面整体放开，或该 host/IP 命中白名单 */
function releasedByPolicy(
  host: string,
  policy?: GraphHttpUrlPolicy,
): boolean {
  if (policy?.allowPrivateNetwork) return true;
  return allowlistMatches(host, policy?.allowlist);
}

/** 白名单匹配：条目精确等于 hostname（IP/域名），或 IPv4 CIDR 含字面 IP */
function allowlistMatches(host: string, allowlist?: string[]): boolean {
  if (!allowlist || allowlist.length === 0) return false;
  for (const raw of allowlist) {
    const entry = raw.toLowerCase().trim();
    if (entry === "") continue;
    if (entry === host) return true;
    const slash = entry.indexOf("/");
    if (slash > 0) {
      const net = entry.slice(0, slash);
      const bits = Number(entry.slice(slash + 1));
      if (
        isIP(host) === 4 &&
        isIP(net) === 4 &&
        Number.isInteger(bits) &&
        bits >= 0 &&
        bits <= 32 &&
        ipv4InCidr(host, net, bits)
      ) {
        return true;
      }
    }
  }
  return false;
}

function ipv4ToLong(host: string): number {
  const [a, b, c, d] = host.split(".").map(Number);
  return (((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
}

function ipv4InCidr(host: string, net: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipv4ToLong(host) ^ ipv4ToLong(net)) & mask) === 0;
}

/**
 * 图 HTTP 节点 URL 判定：返回 null = 放行；返回错误消息 = 拒绝
 * （执行器转为节点失败，消息进失败详情供图作者排障）
 */
export function graphHttpUrlError(
  rawUrl: string,
  policy?: GraphHttpUrlPolicy,
): string | null {
  return literalGraphHttpUrlError(rawUrl, policy);
}

/**
 * 字面判定（同步）：协议白名单 + metadata 主机 + localhost + 字面/编码
 * IP 分类——域名形态返回 null（交由 DNS 级判定收口）。缺省 policy 与
 * S5 批原行为逐字一致（存量调用方零改动）；逃生口语义见 policy 注释。
 */
function literalGraphHttpUrlError(
  rawUrl: string,
  policy?: GraphHttpUrlPolicy,
): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "非法 URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "仅支持 http(s) 协议";
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (METADATA_HOSTS.has(host)) {
    return "云 metadata 端点禁止访问";
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    if (releasedByPolicy(host, policy)) return null;
    return "环回地址禁止访问";
  }
  const family = isIP(host);
  if (family === 4 || family === 6) {
    const cls = family === 4 ? classifyIpv4(host) : classifyIpv6(host);
    if (cls === "link-local") {
      return "环回/私网/链路本地地址禁止访问";
    }
    if (cls === "private" && !releasedByPolicy(host, policy)) {
      return "环回/私网/链路本地地址禁止访问";
    }
  } else {
    const cls = classifyEncodedIp(host);
    if (cls === "link-local") {
      return "数字编码 IP（环回/私网段）禁止访问";
    }
    if (cls === "private" && !releasedByPolicy(host, policy)) {
      return "数字编码 IP（环回/私网段）禁止访问";
    }
  }
  return null;
}

/**
 * DNS 解析级判定（安全批 F1）：域名解析到环回/私网/链路本地 IP 即拒
 * ——防「解析到内网的域名」绕过字面清单（internal.corp → 10.0.0.5、
 * DNS rebinding 基础面）。解析失败放行（功能可用优先——可达性属运行
 * 时关注面）；多记录任一命中即拒。逃生口：allowPrivateNetwork 放行
 * private 类解析结果（链路本地段仍拒——硬边界延伸到解析面）；白名单
 * 命中域名或解析 IP（含 CIDR 落段）放行。
 */
export async function graphHttpUrlErrorDns(
  rawUrl: string,
  policy?: GraphHttpUrlPolicy,
): Promise<string | null> {
  const literal = literalGraphHttpUrlError(rawUrl, policy);
  if (literal !== null) return literal;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "非法 URL";
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) return null; // 字面 IP 已由字面层判定
  try {
    const records = await lookup(host, { all: true });
    for (const { address } of records) {
      const family = isIP(address);
      const cls =
        family === 4
          ? classifyIpv4(address)
          : family === 6
            ? classifyIpv6(address)
            : null;
      if (cls === "link-local") {
        return `域名解析到内网/环回地址（${host} → ${address}）禁止访问`;
      }
      if (
        cls === "private" &&
        !releasedByPolicy(host, policy) &&
        !releasedByPolicy(address, policy)
      ) {
        return `域名解析到内网/环回地址（${host} → ${address}）禁止访问`;
      }
    }
  } catch {
    // 解析失败（NXDOMAIN/超时）——放行，fetch 自身会失败并如实报错
  }
  return null;
}
