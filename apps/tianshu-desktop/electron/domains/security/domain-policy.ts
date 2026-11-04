/**
 * 网络域名判定纯函数（SP5 spec §3）：判定序单源——
 * 豁免面 > deny > allow > blockAllNetwork > 内置恶意清单 > 缺省放行。
 * 零 I/O、零 electron import，三个拦截层（dispatcher/session/proxy）共享。
 */
import { BUILTIN_MALICIOUS_DOMAINS } from "./defaults";

export interface NetworkPolicyState {
  exemptDomains: string[];
  domainAllow: string[];
  domainDeny: string[];
  blockAllNetwork: boolean;
  maliciousDomainProtection: boolean;
  /** 测试注入面：生产走缺省（BUILTIN_MALICIOUS_DOMAINS） */
  maliciousDomains?: string[];
}

export type NetworkVerdict =
  | { ok: true }
  | { ok: false; host: string; rule: "deny" | "offline" | "malicious" };

export const LOOPBACK_DOMAINS = ["localhost", "127.0.0.1", "::1"];

/** 归一化：去空白、小写、去尾点、IPv6 括号展开；空态返回空串 */
export function normalizeDomain(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return "";
  const bare = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  if (bare.startsWith("[") && bare.endsWith("]")) return bare.slice(1, -1);
  return bare;
}

/** 通配段转正则源：* → [^.]+（点间不跨段），其余字符转义 */
function wildcardToRegExpSource(pattern: string): string {
  return pattern
    .split(".")
    .map((seg) =>
      seg === "*" ? "[^.]+" : seg.replace(/[.+*?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("\\.");
}

/** 匹配：精确段或点间通配（*.example.com 匹配子域不含 apex——apex 需另列精确条目） */
export function domainMatches(pattern: string, host: string): boolean {
  const p = normalizeDomain(pattern);
  const h = normalizeDomain(host);
  if (!p || !h) return false;
  if (p === "*") return true; // 裸 * 全匹配
  if (p.startsWith("*.")) {
    // 前置通配：匹配任意深度子域、不含 apex；其余段内 * 不跨点
    const rest = wildcardToRegExpSource(p.slice(2));
    return new RegExp(`^(?:[^.]+\\.)+${rest}$`).test(h);
  }
  return new RegExp(`^${wildcardToRegExpSource(p)}$`).test(h);
}

/** URL → hostname（去端口）；解析失败 null */
export function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

/** 任一名单命中 */
function matchesAny(host: string, patterns: string[]): boolean {
  return patterns.some((p) => domainMatches(p, host));
}

/** 判定序单入口（spec §2 裁定 1/2） */
export function judgeDomain(
  host: string,
  policy: NetworkPolicyState,
): NetworkVerdict {
  const h = normalizeDomain(host);
  if (h && matchesAny(h, policy.exemptDomains)) return { ok: true };
  if (h && matchesAny(h, policy.domainDeny)) {
    return { ok: false, host: h, rule: "deny" };
  }
  if (h && matchesAny(h, policy.domainAllow)) return { ok: true };
  if (policy.blockAllNetwork) {
    return { ok: false, host: h, rule: "offline" };
  }
  const list = policy.maliciousDomains ?? BUILTIN_MALICIOUS_DOMAINS;
  if (h && policy.maliciousDomainProtection && matchesAny(h, list)) {
    return { ok: false, host: h, rule: "malicious" };
  }
  return { ok: true };
}

/** 豁免域集合：loopback + provider baseUrl 域 + 升级域（空串忽略） */
export function buildExemptDomains(
  providerBaseUrls: string[],
  upgradeUrl: string,
): string[] {
  const out = new Set<string>(LOOPBACK_DOMAINS);
  for (const raw of [...providerBaseUrls, upgradeUrl]) {
    const host = hostFromUrl(raw);
    const norm = host ? normalizeDomain(host) : normalizeDomain(raw);
    if (norm) out.add(norm);
  }
  return [...out];
}
