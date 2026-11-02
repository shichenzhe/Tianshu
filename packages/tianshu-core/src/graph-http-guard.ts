/**
 * 图编排 HTTP 节点 URL 守卫（安全审查 2026-11-02 S5 + 尾批 F1 DNS 解析级）：
 * 协议白名单（http/https）+ 字面 IP 分类拦截（环回/链路本地/私网/
 * CGNAT/保留段 + 云 metadata 主机名 + 十进制/十六进制 IP 编码形态）。
 *
 * 背景：HTTP 节点 URL 可被 webhook 输入与 LLM 节点输出模板化
 * （`{{input.x}}`），且响应体可经 responseTemplate 回显——不设守卫即
 * 完整 SSRF read-back；agent fetch 工具的 SSRF 清单曾被图节点整面旁路。
 * 字面 IP 判定不做 DNS 解析（解析级分类防 DNS rebinding 属后续深度），
 * 域名形态放行、IP 字面量收死。
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

/** IPv4 字面量分类：环回/链路本地/私网/CGNAT/保留段 → true（禁止） */
function isBlockedIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = octets;
  if (a === 127 || a === 0 || a === 10) return true; // 环回/本网/私网 A
  if (a === 169 && b === 254) return true; // 链路本地（含 metadata 段）
  if (a === 172 && b >= 16 && b <= 31) return true; // 私网 B
  if (a === 192 && b === 168) return true; // 私网 C
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 与 192.0.2.0/24
  return false;
}

/** IPv6 字面量分类：环回/唯一本地/链路本地/IPv4 映射 → true（禁止） */
function isBlockedIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::" || h === "::1") return true;
  // ::ffff:a.b.c.d / ::ffff:hex 形式的 v4 映射：解析内嵌地址复判
  const mapped = h.match(/^::ffff:(.+)$/);
  if (mapped) {
    const inner = mapped[1]!;
    if (isIP(inner) === 4) return isBlockedIpv4(inner);
    return true; // 十六进制映射形态一律收死（无法可靠分类）
  }
  // 前缀分类：fc/fd（唯一本地）、fe8-eb（链路本地）
  const first = h.split(":")[0] ?? "";
  if (first === "fc" || first === "fd" || first.startsWith("fc") || first.startsWith("fd")) {
    return true;
  }
  if (/^fe[89ab]/.test(first)) return true;
  return false;
}

/** 非点分十进制的数字 IP 编码（http://2130706433 = 127.0.0.1、0x 形态） */
function isBlockedEncodedIp(host: string): boolean {
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    return n > 0 && n < 2 ** 32 && isBlockedIpv4(ipv4OfLong(n));
  }
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const n = parseInt(host, 16);
    return n < 2 ** 32 && isBlockedIpv4(ipv4OfLong(n));
  }
  return false;
}

function ipv4OfLong(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/**
 * 图 HTTP 节点 URL 判定：返回 null = 放行；返回错误消息 = 拒绝
 * （执行器转为节点失败，消息进失败详情供图作者排障）
 */
export function graphHttpUrlError(rawUrl: string): string | null {
  return literalGraphHttpUrlError(rawUrl);
}

/**
 * 字面判定（同步）：协议白名单 + metadata 主机 + localhost + 字面/编码
 * IP 分类——域名形态返回 null（交由 DNS 级判定收口）。签名与行为同
 * S5 批原函数（存量调用方零改动）。
 */
function literalGraphHttpUrlError(rawUrl: string): string | null {
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
    return "环回地址禁止访问";
  }
  const family = isIP(host);
  if (family === 4 && isBlockedIpv4(host)) {
    return "环回/私网/链路本地地址禁止访问";
  }
  if (family === 6 && isBlockedIpv6(host)) {
    return "环回/私网/链路本地地址禁止访问";
  }
  if (isBlockedEncodedIp(host)) {
    return "数字编码 IP（环回/私网段）禁止访问";
  }
  return null;
}

/**
 * DNS 解析级判定（安全批 F1）：域名解析到环回/私网/链路本地 IP 即拒
 * ——防「解析到内网的域名」绕过字面清单（internal.corp → 10.0.0.5、
 * DNS rebinding 基础面）。解析失败放行（功能可用优先——可达性属运行
 * 时关注面）；多记录任一命中即拒。
 */
export async function graphHttpUrlErrorDns(
  rawUrl: string,
): Promise<string | null> {
  const literal = literalGraphHttpUrlError(rawUrl);
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
      const blocked =
        (family === 4 && isBlockedIpv4(address)) ||
        (family === 6 && isBlockedIpv6(address));
      if (blocked) {
        return `域名解析到内网/环回地址（${host} → ${address}）禁止访问`;
      }
    }
  } catch {
    // 解析失败（NXDOMAIN/超时）——放行，fetch 自身会失败并如实报错
  }
  return null;
}
