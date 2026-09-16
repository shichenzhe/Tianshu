import { describe, expect, it } from "vitest";
import {
  LOOPBACK_DOMAINS,
  buildExemptDomains,
  domainMatches,
  hostFromUrl,
  judgeDomain,
  normalizeDomain,
  type NetworkPolicyState,
} from "../../electron/domains/security/domain-policy";

const basePolicy: NetworkPolicyState = {
  exemptDomains: ["api.openai.com", ...LOOPBACK_DOMAINS],
  domainAllow: [],
  domainDeny: [],
  blockAllNetwork: false,
  maliciousDomainProtection: false,
};
/** 内置恶意清单在 judgeDomain 内部消费（Task 2 注入前先以常量形态存在）——
 * Task 1 阶段恶意分支用 maliciousDomainProtection=true + policy.maliciousDomains 测 */
const withMalicious = (hosts: string[]): NetworkPolicyState => ({
  ...basePolicy,
  maliciousDomainProtection: true,
  ...({ maliciousDomains: hosts } as Partial<NetworkPolicyState>),
});

describe("normalizeDomain", () => {
  it("小写化与去尾点", () => {
    expect(normalizeDomain("Example.COM.")).toBe("example.com");
  });
  it("IPv4 与 IPv6 字面量", () => {
    expect(normalizeDomain("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeDomain("[::1]")).toBe("::1");
  });
  it("空白与空串返回空串", () => {
    expect(normalizeDomain("  ")).toBe("");
    expect(normalizeDomain("")).toBe("");
  });
});

describe("domainMatches", () => {
  it("精确域仅匹配自身", () => {
    expect(domainMatches("example.com", "example.com")).toBe(true);
    expect(domainMatches("example.com", "www.example.com")).toBe(false);
  });
  it("*.example.com 匹配任意深度子域不含 apex", () => {
    expect(domainMatches("*.example.com", "a.example.com")).toBe(true);
    expect(domainMatches("*.example.com", "a.b.example.com")).toBe(true);
    expect(domainMatches("*.example.com", "example.com")).toBe(false);
    expect(domainMatches("*.example.com", "aexample.com")).toBe(false);
  });
  it("裸 * 全匹配；点间不跨段", () => {
    expect(domainMatches("*", "anything.evil.com")).toBe(true);
    expect(domainMatches("example.*", "example.org")).toBe(true);
    expect(domainMatches("example.*", "example.evil.com")).toBe(false);
  });
  it("段内 * 为字面量（ReDoS 防回退）", () => {
    expect(domainMatches("a*a*b", "aaaaaab")).toBe(false);
    expect(domainMatches("a*a*b", "a*a*b")).toBe(true);
  });
});

describe("hostFromUrl", () => {
  it("取 hostname（去端口）", () => {
    expect(hostFromUrl("https://api.example.com:8443/v1")).toBe(
      "api.example.com",
    );
  });
  it("非法 URL 返回 null", () => {
    expect(hostFromUrl("not a url")).toBeNull();
  });
});

describe("judgeDomain 判定序", () => {
  it("豁免面压过 deny（裁定 2）", () => {
    const p = { ...basePolicy, domainDeny: ["api.openai.com"] };
    expect(judgeDomain("api.openai.com", p)).toEqual({ ok: true });
  });
  it("deny 压过 allow 与断网与恶意", () => {
    const p = {
      ...withMalicious(["evil.com"]),
      domainAllow: ["evil.com"],
      domainDeny: ["evil.com"],
      blockAllNetwork: true,
    };
    expect(judgeDomain("evil.com", p)).toEqual({
      ok: false,
      host: "evil.com",
      rule: "deny",
    });
  });
  it("allow 压过断网与恶意（用户主权）", () => {
    const p = {
      ...withMalicious(["evil.com"]),
      domainAllow: ["evil.com"],
      blockAllNetwork: true,
    };
    expect(judgeDomain("evil.com", p)).toEqual({ ok: true });
  });
  it("断网模式：名单外全拒（offline）", () => {
    const p = { ...basePolicy, blockAllNetwork: true };
    expect(judgeDomain("unknown.com", p)).toEqual({
      ok: false,
      host: "unknown.com",
      rule: "offline",
    });
  });
  it("恶意清单命中拒绝；开关关时不判恶意", () => {
    const on = withMalicious(["evil.com"]);
    expect(judgeDomain("evil.com", on)).toEqual({
      ok: false,
      host: "evil.com",
      rule: "malicious",
    });
    const off: NetworkPolicyState = { ...on, maliciousDomainProtection: false };
    expect(judgeDomain("evil.com", off)).toEqual({ ok: true });
  });
  it("缺省放行", () => {
    expect(judgeDomain("neutral.com", basePolicy)).toEqual({ ok: true });
  });
});

describe("buildExemptDomains", () => {
  it("provider 域归一化 + loopback + 升级域；空升级域忽略", () => {
    const out = buildExemptDomains(
      ["https://Api.OpenAI.com/v1", "http://localhost:11434"],
      "https://update.example.com/feed",
    );
    expect(out).toContain("api.openai.com");
    expect(out).toContain(LOOPBACK_DOMAINS[0]);
    expect(out).toContain("update.example.com");
    expect(buildExemptDomains([], "")).toEqual(LOOPBACK_DOMAINS);
  });
});
