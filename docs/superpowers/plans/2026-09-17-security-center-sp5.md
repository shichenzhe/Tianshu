# 安全中心 SP5：网络安全执行层 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 网络安全四配置（domainAllow/domainDeny/blockAllNetwork/maliciousDomainProtection）的执行层——三层拦截（undici 策略 Dispatcher / Chromium session 与窗口 / 本地 CONNECT 代理 + env 注入）+ 网络安全二级页 + network.blocked 审计。

**Architecture:** 判定纯函数（domain-policy）单源 → 三个消费层（PolicyDispatcher 包全局 dispatcher、session/window 薄壳、LocalConnectProxy）共享同一判定；门以模块单例安装（照 installCommandGate 先例），command-tool/mcp-manager 经 import 取子进程 proxy env——chat.service/automation-runner 零改动（行为兼容最优解）。

**Tech Stack:** undici 8（既有依赖，Dispatcher 子类化）、Electron 44（session.webRequest/setWindowOpenHandler）、node:http + node:net（本地代理，零新依赖）、Vitest。

**Spec:** docs/superpowers/specs/2026-09-17-security-center-sp5-design.md

## Global Constraints

- **判定序（spec §2 裁定 1）**：豁免面 → domainDeny → domainAllow → blockAllNetwork → 内置恶意清单 → 缺省放行（deny 压 allow，allow 压断网与恶意）
- **豁免面绝对优先**（裁定 2）：provider baseUrl 域 + loopback + UPGRADE_URL 域
- **sandboxEnabled=false → 全门旁路**（裁定 3，族语义同 command-gate/file-gate）；setWindowOpenHandler 的"拒绝 Electron 内开窗"恒开
- **deny 可观测**（裁定 5）：拒绝文案含 host 与规则（`网络安全策略已拒绝 <host>（规则：<rule>）`）
- **fail-open**：策略层自身异常绝不制造断网（透传 + winston error）
- **chat.service.ts / automation-runner.ts 零改动**（子进程 env 经模块单例 import，非装配透传）
- i18n：zh-CN/en-US 同步逐 key、插值一致；eventType→key 全点换下划线（network.blocked → network_blocked）
- 生产代码禁 console（用 `import Log from "../../commons/Log"`，相对层级按文件位置）；禁 any（undici 子类化若类型窄化受限，用精确签名而非 any）
- Prettier v3（尾逗号 all）、函数 ≤20 行（prettier 拆签名可接受）、conventional 中文 commit、无 footer
- 测试基建：electron mock 照 `tests/security/delete-file-tool.test.ts:6` 先例；**worktree 需自装 node_modules**

---

### Task 1: domain-policy 纯函数层

**Files:**
- Create: `electron/domains/security/domain-policy.ts`
- Test: `tests/security/domain-policy.test.ts`

**Interfaces:**
- Consumes: 无（零依赖纯函数）
- Produces（Task 2-5 消费，签名逐字）:

```ts
export interface NetworkPolicyState {
  exemptDomains: string[];
  domainAllow: string[];
  domainDeny: string[];
  blockAllNetwork: boolean;
  maliciousDomainProtection: boolean;
}
export type NetworkVerdict =
  | { ok: true }
  | { ok: false; host: string; rule: "deny" | "offline" | "malicious" };
export function normalizeDomain(input: string): string;
export function domainMatches(pattern: string, host: string): boolean;
export function hostFromUrl(url: string): string | null;
export function judgeDomain(host: string, policy: NetworkPolicyState): NetworkVerdict;
export const LOOPBACK_DOMAINS: string[];
export function buildExemptDomains(
  providerBaseUrls: string[],
  upgradeUrl: string,
): string[];
```

- [ ] **Step 1: 写失败测试**（`tests/security/domain-policy.test.ts`）

```ts
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
});

describe("hostFromUrl", () => {
  it("取 hostname（去端口）", () => {
    expect(hostFromUrl("https://api.example.com:8443/v1")).toBe("api.example.com");
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
```

- [ ] **Step 2: 跑测试确认失败**：`npm run test -- tests/security/domain-policy.test.ts` → FAIL（模块不存在）

- [ ] **Step 3: 实现**（`electron/domains/security/domain-policy.ts`）

```ts
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
      seg === "*"
        ? "[^.]+"
        : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
    )
    .join("\\.");
}

/** 匹配：精确段或点间通配（*.example.com 匹配子域不含 apex——apex 需另列精确条目） */
export function domainMatches(pattern: string, host: string): boolean {
  const p = normalizeDomain(pattern);
  const h = normalizeDomain(host);
  if (!p || !h) return false;
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
```

同时 `defaults.ts` 末尾追加（**完整 114 条，Task 1 一并写入**；Task 2 只做接线）：

```ts
/** 内置恶意域清单（SP5 spec §7）：静态代码常量永不落盘，随版本更新。
 * 初版 114 条 = abuse.ch URLhaus + OpenPhish public feed 2026-09-16 快照，
 * 按域名频次聚合，剔除 IP 主机与合法大站/托管平台 apex（pic.li、
 * workers.dev、lovable.app、screenconnect.com 等）；未收录不代表安全，
 * 防护面 = 清单命中 + 用户 domainDeny。
 * 判定消费方 domain-policy.ts；展示消费方 SecurityService.getConfig defaults */
export const BUILTIN_MALICIOUS_DOMAINS = [
  "0akw8w.com",
  "198-macros.com",
  "22qq-client.com",
  "2bxvrc1.com",
  "acrobat.proposal.name.ng",
  "adobecloud.pro",
  "amaamn.com",
  "angefundsu.sbs",
  "apartament.biz",
  "awarenessexhibition.com",
  "bluehorizons.travel",
  "bookingdirect.paymentarrival.com",
  "botcheck-cf.top",
  "breezeclient.com",
  "cheetoclient.com",
  "cid.gov.so",
  "cloud-sharing.com",
  "conti.pk",
  "copiose.org",
  "daylian.com",
  "debloatex.com",
  "digitalisonesapps.com",
  "dnswwt.club",
  "docmntageant.com",
  "donutclients.net",
  "dulkir-mod.com",
  "executorhub.space",
  "familyaddons.com",
  "fingerprint-veri.info",
  "floppaclient.com",
  "fr-spotify.com",
  "funnymap.net",
  "gate-43985.com",
  "get.acitvated.win",
  "get.acivated.win",
  "get.acrivated.win",
  "get.activatedd.win",
  "get.actiavted.win",
  "get.actiated.win",
  "get.activaed.win",
  "get.activatd.win",
  "get.activatde.win",
  "get.activates.win",
  "get.activeted.win",
  "get.activtaed.win",
  "get.activted.win",
  "get.actrivated.win",
  "get.acttivated.win",
  "get.actvated.win",
  "get.atcivated.win",
  "get.ativated.win",
  "get.cativated.win",
  "get.ctivated.win",
  "get.sctivated.win",
  "ghostclient.net",
  "gpsmarocpro.com",
  "hashedsolver.icu",
  "images.fishing-tools.cyou",
  "invmove.com",
  "jokely.icu",
  "kammwv.cc",
  "kryptonclient-cracked.com",
  "luminexclient.com",
  "marlowclient.com",
  "massgravel.dev",
  "megainviteoffice.com",
  "meteorclientplus.com",
  "meteorclients.com",
  "meteorrejects.net",
  "minpop.com",
  "modhider.com",
  "msteamsinvitees.com",
  "ndigitals.in",
  "noamaddons.com",
  "nova-client.com",
  "odinclient.com",
  "onlocity.com",
  "oss.cop.lat",
  "phantom-client.com",
  "polarclient.net",
  "polinexclient.org",
  "portal.onepansol.site",
  "prestige-client.org",
  "rbcode.net",
  "roblox.com.hr",
  "roblox.com.ml",
  "roblox.ly",
  "robloxc.com.es",
  "rxder.com",
  "sigmaclient.net",
  "skyblock-addons.com",
  "skyblock-extras.org",
  "speddebug.com",
  "startvsgame.com",
  "surun.info",
  "talkandtypeapp.com",
  "tapped.top",
  "themaintechnician.us",
  "tinyurls.in",
  "tripfarely.com",
  "trouserstreak.net",
  "true-soft.su",
  "uno-play.xyz",
  "update-notif.com",
  "v7yp4wts.fourstarcampground.com",
  "westernreigns.com",
  "wielixclient.com",
  "windowsdiagnostics.st",
  "wir.consultingics.com",
  "workerstats.net",
  "www2-facebook.com",
  "wizzyaddon.com",
  "zenithclient.com",
  "zoomeventlive.com",
];
```

（原始采集快照留档于 `.superpowers/sp5-malicious-seed.txt`，git-ignored 不入库。）

- [ ] **Step 4: 跑测试确认通过**：`npm run test -- tests/security/domain-policy.test.ts` → PASS
- [ ] **Step 5: Commit**：`feat(安全中心): 网络域名判定纯函数——归一化/点间通配/判定序单源（豁免>deny>allow>断网>恶意）+ 内置恶意域常量`

---

### Task 2: 恶意清单接线与域名单写路径

**Files:**
- Modify: `electron/domains/security/config-store.ts`（FIELD_PARSERS + 新 pickDomainArray）
- Modify: `electron/domains/security/security.service.ts`（getConfig defaults 扩展）
- Modify: `src-react/domains/security/model/types.ts`（SecurityConfigState.defaults 扩展）
- Test: `tests/security/config-store.test.ts`（追加）、`tests/security/security-service.test.ts`（追加/更新）

**Interfaces:**
- Consumes: `normalizeDomain`（Task 1）；`BUILTIN_MALICIOUS_DOMAINS`（Task 1 已写入 defaults.ts）
- Produces: `pickDomainArray(raw: unknown): string[]`（config-store 导出）；`SecurityConfigState["defaults"]` 形状变为 `{ fileBlocklist: string[]; maliciousDomains: string[] }`（前端 Task 6 消费）

- [ ] **Step 1: 失败测试**——`tests/security/config-store.test.ts` 追加：

```ts
import { pickDomainArray } from "../../electron/domains/security/config-store";

describe("pickDomainArray（SP5 域名单写路径归一化）", () => {
  it("归一化 + 去重 + 去空", () => {
    expect(
      pickDomainArray(["Example.COM.", "example.com", "  ", "*.a.com", 1]),
    ).toEqual(["example.com", "*.a.com"]);
  });
});
```

`tests/security/security-service.test.ts` 追加（getConfig defaults 含内置恶意域；domainAllow 保存归一化）：

```ts
it("getConfig defaults 含内置恶意域清单（SP5）", async () => {
  const state = service.getConfig();
  expect(state.defaults.maliciousDomains.length).toBeGreaterThan(0);
  expect(state.defaults.maliciousDomains).toContain(
    BUILTIN_MALICIOUS_DOMAINS[0],
  );
});
it("setConfig domainAllow 归一化落库（SP5）", async () => {
  const saved = await service.setConfig("domainAllow", ["Evil.COM."]);
  expect(saved.domainAllow).toEqual(["evil.com"]);
});
```

（`BUILTIN_MALICIOUS_DOMAINS` 从 `electron/domains/security/defaults` import；照该文件既有 service 构造先例取 service 实例——若既有用例逐例 new，则同构。）

- [ ] **Step 2: 跑测试确认失败**（pickDomainArray 未导出 / defaults 形状缺 maliciousDomains → FAIL）

- [ ] **Step 3: 实现**

`config-store.ts`（FIELD_PARSERS 中 `domainAllow`/`domainDeny` 两行改为 pickDomainArray，并新增导出；文件头部 import 增加 domain-policy）：

```ts
import { normalizeDomain } from "./domain-policy";

/** 域名单清洗（SP5）：字符串数组逐条归一化，剔空去重（保序） */
export function pickDomainArray(raw: unknown): string[] {
  const seen = new Set<string>();
  for (const item of pickStringArray(raw)) {
    const norm = normalizeDomain(item);
    if (norm) seen.add(norm);
  }
  return [...seen];
}
```

FIELD_PARSERS 两行替换：

```ts
  domainAllow: (raw) => pickDomainArray(parseJsonArray(raw ?? "[]")),
  domainDeny: (raw) => pickDomainArray(parseJsonArray(raw ?? "[]")),
```

`security.service.ts`：NORMALIZERS 两行 `domainAllow: pickDomainArray, domainDeny: pickDomainArray`；getConfig defaults 扩展：

```ts
  getConfig(): SecurityConfigState {
    return {
      defaults: {
        fileBlocklist: [...this.builtinBlocklist],
        maliciousDomains: [...BUILTIN_MALICIOUS_DOMAINS],
      },
      config: copySecurityConfig(this.config),
    };
  }
```

（头部 import defaults 处追加 `BUILTIN_MALICIOUS_DOMAINS`。）

`types.ts` SecurityConfigState：

```ts
export type SecurityConfigState = {
  defaults: { fileBlocklist: string[]; maliciousDomains: string[] };
  config: SecurityConfig;
};
```

`BUILTIN_MALICIOUS_DOMAINS`（114 条完整数组）已由 Task 1 Step 3 写入 `defaults.ts`——本任务**只接线不重复定义**：security.service.ts 的 import 与 getConfig defaults 消费该常量（上文代码块即为全部改动）。

- [ ] **Step 4: 跑测试确认通过**：`npm run test -- tests/security/config-store.test.ts tests/security/security-service.test.ts` → PASS（注意 security-service.test 既有断言若因 defaults 形状变化受牵连，按新形状最小更新）
- [ ] **Step 5: Commit**：`feat(安全中心): 内置恶意域接线——getConfig defaults 暴露 + 域名单写路径归一化（pickDomainArray）`

---

### Task 3: NetworkGate 单例 + PolicyDispatcher + 代理槽组合

**Files:**
- Create: `electron/domains/security/network-gate.ts`
- Modify: `electron/domains/app-settings/proxy-dispatcher.ts`
- Modify: `electron/domains/security/security.service.ts`（onConfigChange 钩子，+6 行）
- Modify: `electron/Application.ts`（装配）
- Test: `tests/security/network-gate.test.ts`

**Interfaces:**
- Consumes: `judgeDomain`/`NetworkPolicyState`/`NetworkVerdict`/`buildExemptDomains`（Task 1）；`SecurityEventSink`（types）；`ProxyParams`（proxy-config）
- Produces（Task 4/5 消费）:

```ts
export type PolicyProvider = () => NetworkPolicyState | null; // null=旁路
export function installNetworkGate(opts: {
  policyProvider: PolicyProvider;
  audit: SecurityEventSink;
}): NetworkGate;
export function getNetworkGate(): NetworkGate | null;
export class NetworkGate {
  judgeHost(host: string): NetworkVerdict;
  judgeUrl(url: string): NetworkVerdict;
  /** 子进程 proxy env（门旁路或代理未启动时 undefined）——command-tool/mcp-manager 消费 */
  childProxyEnv(): Record<string, string> | undefined;
  setProxyUrl(url: string | undefined): void;
}
```

- [ ] **Step 1: 失败测试**（`tests/security/network-gate.test.ts`）

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalDispatcher, setGlobalDispatcher, Dispatcher, type DispatcherDispatchOptions, type DispatcherDispatchHandlers } from "undici";

/** 内层假 dispatcher：记录 dispatch 调用，可控放行 */
function fakeInner() {
  const calls: DispatcherDispatchOptions[] = [];
  const inner = {
    dispatch(opts: DispatcherDispatchOptions, handler: DispatcherDispatchHandlers) {
      handler.onConnect?.(() => {});
      return true;
    },
    calls,
    close: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  } as unknown as Dispatcher;
  return { inner, calls };
}

vi.mock("electron", () => ({ Log: {} })); // 如 network-gate 触及 Log 则按实际 mock

import { installNetworkGate, getNetworkGate, uninstallNetworkGateForTest } from "../../electron/domains/security/network-gate";

describe("NetworkGate", () => {
  beforeEach(() => uninstallNetworkGateForTest());

  it("install 后 judgeHost 走判定序；provider null 时旁路放行", () => {
    const gate = installNetworkGate({
      policyProvider: () => ({
        exemptDomains: [],
        domainAllow: [],
        domainDeny: ["evil.com"],
        blockAllNetwork: false,
        maliciousDomainProtection: false,
      }),
      audit: () => {},
    });
    expect(gate.judgeHost("evil.com")).toEqual({
      ok: false,
      host: "evil.com",
      rule: "deny",
    });
    expect(getNetworkGate()).toBe(gate);
  });

  it("judgeUrl 非法 URL 放行（fail-open）", () => {
    const gate = installNetworkGate({
      policyProvider: () => ({ domainDeny: ["evil.com"] } as never),
      audit: () => {},
    });
    expect(gate.judgeUrl("::bad::")).toEqual({ ok: true });
  });

  it("blockedAudit 走 audit sink（network.blocked）", () => {
    const audit = vi.fn();
    const gate = installNetworkGate({ policyProvider: () => null, audit });
    (gate as unknown as { blockedAudit: (h: string, r: string, s: string) => void }).blockedAudit(
      "evil.com", "deny", "fetch",
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "network.blocked",
        decision: "blocked",
        detail: { host: "evil.com", rule: "deny", source: "fetch" },
      }),
    );
  });

  it("childProxyEnv：代理未启动 undefined；setProxyUrl 后注入三变量 + NO_PROXY", () => {
    const gate = installNetworkGate({ policyProvider: () => null, audit: () => {} });
    expect(gate.childProxyEnv()).toBeUndefined();
    gate.setProxyUrl("http://127.0.0.1:3128");
    expect(gate.childProxyEnv()).toEqual({
      HTTPS_PROXY: "http://127.0.0.1:3128",
      HTTP_PROXY: "http://127.0.0.1:3128",
      ALL_PROXY: "http://127.0.0.1:3128",
      NO_PROXY: "localhost,127.0.0.1,::1",
    });
  });

  it("PolicyDispatcher：deny 时 onError 同步拒且不触 inner；放行透传", async () => {
    const { PolicyDispatcher } = await import("../../electron/domains/security/network-gate");
    const { inner } = fakeInner();
    const gate = installNetworkGate({
      policyProvider: () => ({ domainDeny: ["evil.com"] } as never),
      audit: () => {},
    });
    const pd = new PolicyDispatcher(inner, (h) => gate.judgeHost(h), () => {});
    const onError = vi.fn();
    const denied = pd.dispatch(
      { origin: "https://evil.com", path: "/", method: "GET" } as DispatcherDispatchOptions,
      { onError } as DispatcherDispatchHandlers,
    );
    expect(denied).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("evil.com") }),
    );
    const passed = pd.dispatch(
      { origin: "https://ok.com", path: "/", method: "GET" } as DispatcherDispatchOptions,
      { onError: vi.fn(), onConnect: vi.fn() } as unknown as DispatcherDispatchHandlers,
    );
    expect(passed).toBe(true);
  });
});
```

（若 undici 类型导出名与上不符——以 `node_modules/undici/types/dispatcher.d.ts` 实测为准调整 import 与形态，语义断言不变。）

- [ ] **Step 2: 确认失败**（模块不存在 → FAIL）

- [ ] **Step 3: 实现**

`electron/domains/security/network-gate.ts`：

```ts
/**
 * 网络安全门单例（SP5 spec §4）：判定供三个拦截层共享——
 * ① PolicyDispatcher 包全局 undici dispatcher（proxy-dispatcher 槽）
 * ② 渲染层 session/window（renderer-guard，Task 5）
 * ③ 本地 CONNECT 代理与子进程 env 注入（local-proxy/command-tool/mcp-manager，Task 4）
 * 模块单例安装照 installCommandGate 先例；electron-free（vitest 直测）。
 */
import { Dispatcher, type DispatcherDispatchHandlers, type DispatcherDispatchOptions } from "undici";
import type { SecurityEventSink } from "../../../src-react/domains/security/model/types";
import { hostFromUrl, judgeDomain, normalizeDomain, type NetworkPolicyState, type NetworkVerdict } from "./domain-policy";

export type PolicyProvider = () => NetworkPolicyState | null;

export class PolicyDispatcher extends Dispatcher {
  constructor(
    private readonly inner: Dispatcher,
    private readonly judge: (host: string) => NetworkVerdict,
    private readonly onBlocked: (host: string, rule: string) => void,
  ) {
    super();
  }

  dispatch(options: DispatcherDispatchOptions, handler: DispatcherDispatchHandlers): boolean {
    let host = "";
    try {
      host = options.origin ? new URL(String(options.origin)).hostname : "";
    } catch {
      host = ""; // 非 URL origin（unix socket 等）透传——fail-open（spec §9）
    }
    if (host) {
      const verdict = this.judge(host);
      if (!verdict.ok) {
        this.onBlocked(verdict.host, verdict.rule);
        try {
          handler.onError(new Error(`网络安全策略已拒绝 ${verdict.host}（规则：${verdict.rule}）`));
        } catch {
          // handler 抛错不向策略层传播（fail-open 不制造新故障）
        }
        return false;
      }
    }
    return this.inner.dispatch(options, handler);
  }

  close(callback?: () => void): Promise<void> {
    return this.inner.close(callback);
  }

  destroy(err?: Error | null, callback?: () => void): Promise<void> {
    return this.inner.destroy(err, callback);
  }
}

export class NetworkGate {
  private proxyUrl: string | undefined;

  constructor(
    private readonly policyProvider: PolicyProvider,
    private readonly audit: SecurityEventSink,
  ) {}

  judgeHost(host: string): NetworkVerdict {
    const policy = this.policyProvider();
    if (policy === null) return { ok: true }; // sandboxEnabled=false 旁路（裁定 3）
    try {
      return judgeDomain(normalizeDomain(host), policy);
    } catch {
      return { ok: true }; // fail-open（spec §9）
    }
  }

  judgeUrl(url: string): NetworkVerdict {
    const host = hostFromUrl(url);
    if (host === null) return { ok: true }; // fail-open
    return this.judgeHost(host);
  }

  /** 子进程 proxy env：门旁路或代理未启动时 undefined（零行为变化） */
  childProxyEnv(): Record<string, string> | undefined {
    if (this.policyProvider() === null || !this.proxyUrl) return undefined;
    return {
      HTTPS_PROXY: this.proxyUrl,
      HTTP_PROXY: this.proxyUrl,
      ALL_PROXY: this.proxyUrl,
      NO_PROXY: "localhost,127.0.0.1,::1",
    };
  }

  setProxyUrl(url: string | undefined): void {
    this.proxyUrl = url;
  }

  /** 审计发射（四层共用，source 分层） */
  blockedAudit(host: string, rule: string, source: string, sessionId?: number): void {
    this.audit({
      eventType: "network.blocked",
      decision: "blocked",
      detail: { host: host.slice(0, 200), rule, source },
      sessionId,
    });
  }
}

let installed: NetworkGate | null = null;

export function installNetworkGate(opts: {
  policyProvider: PolicyProvider;
  audit: SecurityEventSink;
}): NetworkGate {
  installed = new NetworkGate(opts.policyProvider, opts.audit);
  return installed;
}

export function getNetworkGate(): NetworkGate | null {
  return installed;
}

/** 测试隔离用（生产不调用） */
export function uninstallNetworkGateForTest(): void {
  installed = null;
}
```

`proxy-dispatcher.ts` 改造（策略槽 + 记住最近 spec + 自动重放）：

```ts
import {
  Agent,
  EnvHttpProxyAgent,
  ProxyAgent,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";
import {
  toDispatcherSpec,
  type DispatcherSpec,
  type ProxyParams,
} from "./proxy-config";

/** 网络策略钩子（SP5 network-gate 注入）：null = 未装策略（现状行为） */
export interface PolicyHook {
  judgeHost: (host: string) => { ok: true } | { ok: false; host: string; rule: string };
  onBlocked: (host: string, rule: string) => void;
}

let policyHook: PolicyHook | null = null;
let lastSpec: DispatcherSpec = { kind: "direct" };

export function setPolicyHook(hook: PolicyHook | null): void {
  policyHook = hook;
  replay(); // 槽位变化即按最近代理形态重包
}

/** 按代理参数设置全局 dispatcher（幂等：整体替换，无残留旧实例状态） */
export function applyProxyDispatcher(params: ProxyParams): void {
  lastSpec = toDispatcherSpec(params);
  replay();
}

function replay(): void {
  setGlobalDispatcher(buildDispatcher(lastSpec));
}

/** 形态 → undici Agent 实例（策略已装则外包 PolicyDispatcher） */
function buildDispatcher(spec: DispatcherSpec): Dispatcher {
  let inner: Dispatcher;
  switch (spec.kind) {
    case "proxy":
      inner = new ProxyAgent({ uri: spec.uri });
      break;
    case "env":
      inner = new EnvHttpProxyAgent();
      break;
    default:
      inner = new Agent();
  }
  if (!policyHook) return inner;
  // 延迟 import 防环（network-gate → domain-policy，不回指本模块，实无环；
  // 但 PolicyDispatcher 定义在 network-gate，import 顶部即可）
  const { PolicyDispatcher } = require("./../security/network-gate") as typeof import("./../security/network-gate");
  return new PolicyDispatcher(inner, policyHook.judgeHost, policyHook.onBlocked);
}
```

（顶部静态 import 更符合项目风格——直接 `import { PolicyDispatcher } from "../security/network-gate"`，**实现时用静态 import 并删除上面的 require 注释块**；app-settings → security 方向的跨域 import 照 chat.service → file-gate 先例。）

`security.service.ts` 加 onConfigChange（构造 opts 可选项 + setConfig/init 尾部触发）：

```ts
  constructor(
    private opts: {
      db?: SecurityOptionPrismaLike;
      audit?: SecurityEventSink;
      onConfigChange?: (key: SecurityConfigKey) => void;
    } = {},
  ) { this.registerHandlers(); }

  async init(): Promise<void> {
    const rows = await listSecurityOptions(this.db);
    this.config = parseSecurityConfig(rows);
    this.opts.onConfigChange?.("sandboxEnabled"); // 装配侧读取全部网络配置后决策（key 仅作触发器）
  }
  // setConfig 的缓存更新之后追加一行：
  //   this.opts.onConfigChange?.(key);
```

`Application.ts` 装配（installFileGate 块之后、FileHistoryService 之前插入）：

```ts
    // 网络安全门（SP5）：单例安装 + 代理槽接线；provider 豁免域 30s TTL 缓存
    import { installNetworkGate } from "./domains/security/network-gate"; // 顶部
    import { setPolicyHook, applyProxyDispatcher } from "./domains/app-settings/proxy-dispatcher"; // 顶部
    import { buildExemptDomains } from "./domains/security/domain-policy"; // 顶部
    import { UPGRADE_URL } from "./Constants"; // 顶部（若已有则复用）

    const providerDomains: string[] = []; // TTL 缓存
    let providerDomainsAt = 0;
    const readProviderDomains = async (): Promise<string[]> => {
      if (Date.now() - providerDomainsAt < 30_000) return providerDomains;
      try {
        const rows = await prisma.provider.findMany({ select: { baseUrl: true } });
        providerDomains.length = 0;
        providerDomains.push(...rows.map((r) => r.baseUrl));
        providerDomainsAt = Date.now();
      } catch (e) {
        Log.error("provider 豁免域读取失败，豁免面退化为 loopback+升级域", e);
      }
      return providerDomains;
    };
    // 同步快照版：judgeHost 是同步调用，TTL 内用缓存，过期由异步刷新
    const networkGate = installNetworkGate({
      policyProvider: () => {
        const config = securityService.getConfigValue();
        if (!config.sandboxEnabled) return null;
        return {
          exemptDomains: buildExemptDomains(providerDomains, UPGRADE_URL),
          domainAllow: config.domainAllow,
          domainDeny: config.domainDeny,
          blockAllNetwork: config.blockAllNetwork,
          maliciousDomainProtection: config.maliciousDomainProtection,
        };
      },
      audit: (event) => auditLogService.append(event),
    });
    setPolicyHook({
      judgeHost: (host) => networkGate.judgeHost(host),
      onBlocked: (host, rule) => networkGate.blockedAudit(host, rule, "fetch"),
    });
    // TTL 异步刷新（首启动即拉一次）
    void readProviderDomains();
    securityService 传入 opts.onConfigChange（见下）——需要在 new SecurityService 时加：
    //   onConfigChange: () => {
    //     void readProviderDomains();
    //   },
    // （本地代理生命周期接线在 Task 4；此处先只接豁免域刷新）
```

注意：`new SecurityService({...})` 的 opts 增补 `onConfigChange`；UPGRADE_URL 若为空串，buildExemptDomains 已忽略（Task 1 测试锁定）。`prisma` 已在 Application 顶部 import。刷新触发器改造为 tick 风格亦可，**但 policyProvider 必须保持同步**（undici dispatch 同步路径）。

- [ ] **Step 4: 确认通过**：`npm run test -- tests/security/network-gate.test.ts` → PASS；全量 `npm run test` 无回归（proxy-dispatcher 相关既有测试若断言 dispatcher 形态，按"无 hook 时行为不变"核对）
- [ ] **Step 5: Commit**：`feat(安全中心): NetworkGate 单例 + undici PolicyDispatcher 全局策略层——判定序实时读配置 + provider 豁免域 TTL 缓存 + onConfigChange 钩子`

---

### Task 4: 本地 CONNECT 代理 + 子进程 env 注入 + MCP 入口预判

**Files:**
- Create: `electron/domains/security/local-proxy.ts`
- Modify: `electron/domains/ai/agent/command-tool.ts`（env 注入）
- Modify: `electron/domains/ai/agent/mcp-manager.ts`（assertMcpUrlAllowed + stdio env）
- Modify: `electron/Application.ts`（代理生命周期）
- Test: `tests/security/local-proxy.test.ts`、`tests/security/mcp-url-gate.test.ts`、`tests/ai/command-tool-proxy.test.ts`

**Interfaces:**
- Consumes: `getNetworkGate`/`NetworkGate.judgeHost`/`blockedAudit`（Task 3）
- Produces: `class LocalConnectProxy { start(): Promise<number>; stop(): Promise<void>; get port(): number | undefined; }`（模块 electron-free）；`export function childProxyEnvOrUndefined(): Record<string, string> | undefined`（network-gate 已有 childProxyEnv——command-tool 经 getNetworkGate()?.childProxyEnv() 消费）；`export function assertMcpUrlAllowed(row: McpServerConfig, checkUrl?: (url: string) => NetworkVerdict): void`（mcp-manager 导出）；`export function mergeStdioEnv(row: McpServerConfig): Record<string, string> | undefined`

- [ ] **Step 1: 失败测试**

`tests/security/local-proxy.test.ts`（真实起 server + 本地 TCP echo 目标）：

```ts
import net from "node:net";
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { LocalConnectProxy } from "../../electron/domains/security/local-proxy";
import { installNetworkGate, uninstallNetworkGateForTest } from "../../electron/domains/security/network-gate";

/** 本地 echo 目标（模拟放行站点：127.0.0.1 在豁免面） */
function echoServer(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.pipe(socket));
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as net.AddressInfo).port }));
  });
}

describe("LocalConnectProxy", () => {
  beforeAll(() => {
    installNetworkGate({
      policyProvider: () => ({
        exemptDomains: ["localhost", "127.0.0.1", "::1"],
        domainAllow: [],
        domainDeny: ["evil.com"],
        blockAllNetwork: false,
        maliciousDomainProtection: false,
      }),
      audit: () => {},
    });
  });
  afterAll(() => uninstallNetworkGateForTest());

  it("CONNECT 放行：管道双向通（经代理连本地 echo）", async () => {
    const { server, port } = await echoServer();
    const proxy = new LocalConnectProxy(() => import("../../electron/domains/security/network-gate").then((m) => m.getNetworkGate()!));
    const proxyPort = await proxy.start();
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(proxyPort, "127.0.0.1", () => {
          socket.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
        });
        let buf = "";
        socket.on("data", (chunk) => {
          buf += chunk.toString();
          if (buf.includes("\r\n\r\n")) {
            const rest = buf.split("\r\n\r\n").slice(1).join("");
            if (rest) resolve(rest);
          }
        });
        socket.on("error", reject);
        socket.write = socket.write.bind(socket); // 发送数据需在 200 响应后——见下方实现说明
        setTimeout(() => socket.write("ping"), 50);
      });
      expect(data).toContain("ping");
    } finally {
      await proxy.stop();
      server.close();
    }
  });

  it("CONNECT 拒绝：403 + X-Block-Reason 头 + 审计", async () => {
    const audit = vi.fn();
    // 重新安装带审计 sink
    const { installNetworkGate: reinstall } = await import("../../electron/domains/security/network-gate");
    reinstall({ policyProvider: () => ({ exemptDomains: ["localhost", "127.0.0.1"], domainDeny: ["evil.com"] } as never), audit });
    const proxy = new LocalConnectProxy(async () => (await import("../../electron/domains/security/network-gate")).getNetworkGate()!);
    const proxyPort = await proxy.start();
    const resp = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxyPort, "127.0.0.1", () => {
        socket.write("CONNECT evil.com:443 HTTP/1.1\r\nHost: evil.com:443\r\n\r\n");
      });
      socket.on("data", (c) => resolve(c.toString()));
      socket.on("error", reject);
    });
    expect(resp).toContain("403");
    expect(resp).toContain("X-Block-Reason: deny");
    expect(audit).toHaveBeenCalled();
    await proxy.stop();
  });

  it("未启动即 stop / 重复 start 幂等", async () => {
    const proxy = new LocalConnectProxy(async () => null as never);
    await expect(proxy.stop()).resolves.toBeUndefined();
  });
});
```

（测试中 CONNECT 放行用例的时序说明：本地 echo 目标必须先收 200 再发数据——实现里 200 头与管道建立后 `socket.write("ping")` 由 setTimeout 50ms 保证先后；若偶发竞态改用 `socket.once("data")` 后再 write。）

`tests/ai/command-tool-proxy.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { makeRunCommandTool } from "../../electron/domains/ai/agent/command-tool";
import { installNetworkGate, uninstallNetworkGateForTest } from "../../electron/domains/security/network-gate";

describe("run_command 子进程 proxy env 注入（SP5）", () => {
  it("门装且代理启动时 env 含 HTTPS_PROXY（子进程 echo 验证）", async () => {
    installNetworkGate({
      policyProvider: () => ({ exemptDomains: ["localhost"], domainDeny: [] } as never),
      audit: () => {},
    });
    const gate = require("../../electron/domains/security/network-gate").getNetworkGate();
    gate.setProxyUrl("http://127.0.0.1:3128");
    const tool = makeRunCommandTool();
    const out = await tool.execute(
      { workspacePath: process.cwd(), sessionId: 1, onSecurityEvent: () => {} },
      { command: "node -e \"console.log(process.env.HTTPS_PROXY || 'none')\"" },
    );
    expect(out).toContain("http://127.0.0.1:3128");
    uninstallNetworkGateForTest();
  });
  it("门未装时 env 不注入（none）", async () => {
    uninstallNetworkGateForTest();
    const tool = makeRunCommandTool();
    const out = await tool.execute(
      { workspacePath: process.cwd(), sessionId: 1 },
      { command: "node -e \"console.log(process.env.HTTPS_PROXY || 'none')\"" },
    );
    expect(out).toContain("none");
  });
});
```

`tests/security/mcp-url-gate.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { assertMcpUrlAllowed, mergeStdioEnv } from "../../electron/domains/ai/agent/mcp-manager";
import { installNetworkGate, uninstallNetworkGateForTest } from "../../electron/domains/security/network-gate";

describe("MCP 入口预判与 stdio env（SP5）", () => {
  it("http url deny 命中 → 抛错（未触 SDK 构造）", () => {
    installNetworkGate({ policyProvider: () => ({ exemptDomains: [], domainDeny: ["evil.com"] } as never), audit: () => {} });
    expect(() =>
      assertMcpUrlAllowed({ id: 1, name: "s", transport: "http", url: "https://evil.com/mcp" }),
    ).toThrow(/网络安全策略已拒绝 evil.com/);
    uninstallNetworkGateForTest();
  });
  it("放行不抛；stdio url 缺省不判", () => {
    installNetworkGate({ policyProvider: () => ({ exemptDomains: [] } as never), audit: () => {} });
    expect(() =>
      assertMcpUrlAllowed({ id: 1, name: "s", transport: "http", url: "https://ok.com/mcp" }),
    ).not.toThrow();
    expect(() => assertMcpUrlAllowed({ id: 1, name: "s", transport: "stdio", command: "npx" })).not.toThrow();
    uninstallNetworkGateForTest();
  });
  it("mergeStdioEnv：门未装返回原 env；门装+代理时合并注入", () => {
    expect(mergeStdioEnv({ id: 1, name: "s", transport: "stdio", command: "npx", env: { A: "1" } })).toEqual({ A: "1" });
    installNetworkGate({ policyProvider: () => ({ exemptDomains: [] } as never), audit: () => {} });
    require("../../electron/domains/security/network-gate").getNetworkGate().setProxyUrl("http://127.0.0.1:3128");
    expect(mergeStdioEnv({ id: 1, name: "s", transport: "stdio", command: "npx", env: { A: "1" } })).toEqual({
      A: "1",
      HTTPS_PROXY: "http://127.0.0.1:3128",
      HTTP_PROXY: "http://127.0.0.1:3128",
      ALL_PROXY: "http://127.0.0.1:3128",
      NO_PROXY: "localhost,127.0.0.1,::1",
    });
    uninstallNetworkGateForTest();
  });
});
```

- [ ] **Step 2: 确认失败**（模块/导出不存在 → FAIL）

- [ ] **Step 3: 实现**

`electron/domains/security/local-proxy.ts`：

```ts
/**
 * 本地 CONNECT 代理（SP5 spec §5）：127.0.0.1 随机端口；
 * CONNECT 目标 host 经 NetworkGate 判定——拒 403 + X-Block-Reason，放行直连管道。
 * 明文 HTTP 绝对 URI 请求同判定（拒 403，放行转发）。
 * electron-free（node:http + node:net）；上游企业代理链式转发 v1 不做
 * （spec §5 边界：app 代理与子进程门同开时子进程直连，判定仍生效）。
 */
import http from "node:http";
import net from "node:net";
import type { NetworkGate } from "./network-gate";
import type { NetworkVerdict } from "./domain-policy";

export class LocalConnectProxy {
  private server?: http.Server;
  private portValue?: number;

  constructor(private readonly getGate: () => Promise<NetworkGate | null> | NetworkGate | null) {}

  get port(): number | undefined {
    return this.portValue;
  }

  async start(): Promise<number> {
    if (this.server) return this.portValue!;
    const server = http.createServer((req, res) => {
      void this.handlePlainRequest(req, res);
    });
    server.on("connect", (req, clientSocket, head) => {
      void this.handleConnect(req, clientSocket, head);
    });
    server.on("error", (e) => {
      // 监听失败等：调用方经 start() 的 reject 感知；运行期错误不抛
      if (!this.portValue) throw e;
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as net.AddressInfo;
        this.portValue = addr.port;
        resolve(addr.port);
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    this.portValue = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** CONNECT host:port → 判定 → 管道（照 Node 官方 proxy 示例模式） */
  private async handleConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
  ): Promise<void> {
    const target = String(req.url ?? "");
    const host = target.split(":")[0];
    const gate = await this.getGate();
    const verdict: NetworkVerdict = gate ? gate.judgeHost(host) : { ok: true };
    if (!verdict.ok) {
      gate?.blockedAudit(verdict.host, verdict.rule, "proxy");
      clientSocket.end(`HTTP/1.1 403 Forbidden\r\nX-Block-Reason: ${verdict.rule}\r\nConnection: close\r\n\r\n`);
      return;
    }
    const port = Number(target.split(":")[1] ?? 443);
    const upstream = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  }

  /** 明文 HTTP（绝对 URI）同判定转发 */
  private async handlePlainRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = String(req.url ?? "");
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      host = "";
    }
    const gate = await this.getGate();
    const verdict = host && gate ? gate.judgeHost(host) : { ok: true as const };
    if (!verdict.ok) {
      gate?.blockedAudit(verdict.host, verdict.rule, "proxy");
      res.writeHead(403, { "X-Block-Reason": verdict.rule });
      res.end();
      return;
    }
    const target = new URL(url);
    const upstream = http.request(
      { hostname: target.hostname, port: target.port || 80, path: target.pathname + target.search, method: req.method, headers: req.headers },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  }
}
```

`command-tool.ts`（头部 import 追加 + runExec env）：

```ts
import { getNetworkGate } from "../../security/network-gate";

// runExec 的 exec options 改为：
    child = exec(
      command,
      {
        cwd,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_BUFFER,
        env: buildChildEnv(),
      },
      ...
// 新增（isDangerousCommand 附近）：
/** 子进程 env（SP5）：网络安全门装且本地代理启动时注入 proxy 指向，缺省继承 */
function buildChildEnv(): NodeJS.ProcessEnv | undefined {
  const proxyEnv = getNetworkGate()?.childProxyEnv();
  return proxyEnv ? { ...process.env, ...proxyEnv } : undefined;
}
```

（`buildChildEnv` 是纯转发查询，command-tool 依旧无 electron import——network-gate electron-free。）

`mcp-manager.ts`（createDefaultClient 改造 + 两导出）：

```ts
import { getNetworkGate } from "../../security/network-gate";
import type { NetworkVerdict } from "../../security/domain-policy";

/** MCP http 入口预判（SP5 spec §6）：deny 抛错（含 host 与规则，回喂状态机 error 文案） */
export function assertMcpUrlAllowed(row: McpServerConfig): void {
  if (row.transport !== "http" || !row.url) return;
  const verdict: NetworkVerdict = getNetworkGate()?.judgeUrl(row.url) ?? { ok: true };
  if (!verdict.ok) {
    getNetworkGate()?.blockedAudit(verdict.host, verdict.rule, "mcp");
    throw new Error(`网络安全策略已拒绝 ${verdict.host}（规则：${verdict.rule}）`);
  }
}

/** stdio 子进程 env（SP5）：合并 proxy 注入（门未装原样返回） */
export function mergeStdioEnv(row: McpServerConfig): Record<string, string> | undefined {
  const proxyEnv = getNetworkGate()?.childProxyEnv();
  return proxyEnv ? { ...row.env, ...proxyEnv } : row.env;
}

// createDefaultClient 内：
//   http 分支构造 transport 之前：assertMcpUrlAllowed(row);
//   stdio 分支 env: mergeStdioEnv(row),
```

`Application.ts` 生命周期接线（Task 3 的 onConfigChange 回调扩展 + LocalConnectProxy 启停）：

```ts
    // 本地 CONNECT 代理（SP5）：按配置需要启停（spec §5 生命周期）
    import { LocalConnectProxy } from "./domains/security/local-proxy"; // 顶部
    const localProxy = new LocalConnectProxy(() => getNetworkGate());
    const syncProxyLifecycle = async () => {
      const config = securityService.getConfigValue();
      const needed =
        config.sandboxEnabled &&
        (config.domainAllow.length > 0 ||
          config.domainDeny.length > 0 ||
          config.blockAllNetwork ||
          config.maliciousDomainProtection);
      const running = localProxy.port !== undefined;
      if (needed && !running) {
        try {
          const port = await localProxy.start();
          networkGate.setProxyUrl(`http://127.0.0.1:${port}`);
        } catch (e) {
          Log.error("本地网络代理启动失败，子进程网络维持现状", e);
        }
      } else if (!needed && running) {
        networkGate.setProxyUrl(undefined);
        await localProxy.stop();
      }
    };
    // SecurityService opts.onConfigChange 扩为：
    //   onConfigChange: () => { void readProviderDomains(); void syncProxyLifecycle(); },
    await syncProxyLifecycle().catch((e) => Log.error("网络代理生命周期初始化失败", e));
    app.on("quit", () => void localProxy.stop());
```

（注意 onConfigChange 在 SecurityService 构造时传入——syncProxyLifecycle 与 localProxy 须在 `new SecurityService` 之前声明，或以 let 提升引用后赋值；实现时调整声明序保证引用就绪。）

- [ ] **Step 4: 确认通过**：三个新测试文件 PASS；全量无回归
- [ ] **Step 5: Commit**：`feat(安全中心): 本地 CONNECT 代理 + run_command/MCP stdio proxy env 注入 + MCP http 入口预判`

---

### Task 5: 渲染层与窗口防护薄壳

**Files:**
- Create: `electron/domains/security/renderer-guard.ts`
- Modify: `electron/main.ts`（createWindow 内挂 setWindowOpenHandler/will-navigate）
- Modify: `electron/Application.ts`（session.webRequest 装配）
- Test: `tests/security/renderer-guard.test.ts`

**Interfaces:**
- Consumes: `getNetworkGate`（Task 3）
- Produces: `export function installSessionGuard(): void`（session.defaultSession.webRequest.onBeforeRequest）；`export function handleWindowOpen(url: string): "deny" | "external"`（纯函数：external=经 shell.openExternal 外开，deny=拒绝且已审计）；`export function shouldAllowNavigation(url: string, devServerOrigin: string | undefined): boolean`

- [ ] **Step 1: 失败测试**（`tests/security/renderer-guard.test.ts`，vi.mock electron 照 delete-file-tool.test.ts 先例）

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const openExternal = vi.fn();
vi.mock("electron", () => ({
  shell: { openExternal: openExternal },
}));
vi.mock("../../electron/domains/security/network-gate", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../electron/domains/security/network-gate")>();
  return { ...orig, getNetworkGate: vi.fn() };
});

import { getNetworkGate } from "../../electron/domains/security/network-gate";
import { handleWindowOpen, shouldAllowNavigation } from "../../electron/domains/security/renderer-guard";
import type { NetworkGate } from "../../electron/domains/security/network-gate";

function mockGate(judgeUrl: (u: string) => { ok: true } | { ok: false; host: string; rule: string }) {
  const blockedAudit = vi.fn();
  (getNetworkGate as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    judgeUrl,
    blockedAudit,
  } as unknown as NetworkGate);
  return blockedAudit;
}

describe("handleWindowOpen（SP5 裁定 3：恒拒内开窗）", () => {
  it("放行域 → external 并调 openExternal", () => {
    const blocked = mockGate(() => ({ ok: true }));
    expect(handleWindowOpen("https://ok.com")).toBe("external");
    expect(openExternal).toHaveBeenCalledWith("https://ok.com");
    expect(blocked).not.toHaveBeenCalled();
  });
  it("deny 域 → deny + 审计 source=renderer", () => {
    const blocked = mockGate(() => ({ ok: false, host: "evil.com", rule: "deny" }));
    expect(handleWindowOpen("https://evil.com")).toBe("deny");
    expect(openExternal).not.toHaveBeenCalled();
    expect(blocked).toHaveBeenCalledWith("evil.com", "deny", "renderer");
  });
  it("门未装（null）→ external（旁路但不开内窗）", () => {
    (getNetworkGate as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
    expect(handleWindowOpen("https://any.com")).toBe("external");
  });
});

describe("shouldAllowNavigation", () => {
  it("仅 file:// 与 dev server 放行；http(s) 远程一律拒", () => {
    expect(shouldAllowNavigation("file:///app/index.html", undefined)).toBe(true);
    expect(shouldAllowNavigation("http://localhost:5173/x", "http://localhost:5173")).toBe(true);
    expect(shouldAllowNavigation("https://evil.com", undefined)).toBe(false);
    expect(shouldAllowNavigation("http://localhost:5173/x", undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: 确认失败** → FAIL（模块不存在）

- [ ] **Step 3: 实现**（`electron/domains/security/renderer-guard.ts`）

```ts
/**
 * 渲染/Chromium 层防护（SP5 spec §6）：markdown img、SkillHub 图标走
 * session.webRequest 判定；window.open 链接恒拒内开窗、放行域转系统浏览器；
 * 主窗口导航仅 file:// 与 dev server。薄壳 + 纯函数（electron mock 可测）。
 */
import { session, shell } from "electron";
import { getNetworkGate } from "./network-gate";

/** 窗口开放判定："external"=经系统浏览器外开（放行域/门旁路），"deny"=拒绝 */
export function handleWindowOpen(url: string): "deny" | "external" {
  const gate = getNetworkGate();
  const verdict = gate ? gate.judgeUrl(url) : { ok: true as const };
  if (!verdict.ok) {
    gate?.blockedAudit(verdict.host, verdict.rule, "renderer");
    return "deny";
  }
  void shell.openExternal(url).catch(() => {}); // 外开失败静默（不回退内开窗）
  return "external";
}

/** 主窗口导航白名单：file:// 与 dev server（http(s) 远程导航一律拒） */
export function shouldAllowNavigation(url: string, devServerOrigin: string | undefined): boolean {
  if (url.startsWith("file://")) return true;
  return devServerOrigin !== undefined && url.startsWith(devServerOrigin);
}

/** session 级判定（Application 装配一次）：仅 http(s) 过门，拒则 cancel */
export function installSessionGuard(): void {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
    const gate = getNetworkGate();
    const verdict = gate ? gate.judgeUrl(details.url) : { ok: true as const };
    if (!verdict.ok) {
      gate?.blockedAudit(verdict.host, verdict.rule, "renderer");
      callback({ cancel: true });
      return;
    }
    callback({});
  });
}
```

`main.ts` createWindow（did-finish-load 块附近追加）：

```ts
import { handleWindowOpen, shouldAllowNavigation } from "./domains/security/renderer-guard";

  win.webContents.setWindowOpenHandler(({ url }) => ({
    action: handleWindowOpen(url) === "deny" ? "deny" : "deny", // 恒拒内开窗；external 已由 handleWindowOpen 外开
  }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!shouldAllowNavigation(url, VITE_DEV_SERVER_URL)) {
      event.preventDefault();
    }
  });
```

（`setWindowOpenHandler` 返回恒 `{ action: "deny" }`——外开动作已在 handleWindowOpen 内完成；注释说明。）

`Application.ts`（network gate 装配块尾追加）：

```ts
    installSessionGuard(); // SP5：渲染层 webRequest 判定
```

- [ ] **Step 4: 确认通过**：`npm run test -- tests/security/renderer-guard.test.ts` PASS；全量无回归
- [ ] **Step 5: Commit**：`feat(安全中心): 渲染层防护——session.webRequest 域名判定 + window.open 恒拒内开窗转系统浏览器 + 主窗口导航白名单`

---

### Task 6: 网络安全二级页 + i18n + 守卫

**Files:**
- Create: `src-react/domains/security/components/NetworkDetailView.tsx`
- Modify: `src-react/domains/security/components/SecurityCenter.tsx`（视图栈 + 入口）
- Modify: `src-react/domains/security/components/SandboxCard.tsx`（network 入口启用）
- Modify: `src-react/i18n/locales/{zh-CN,en-US}/security.json`
- Modify: `src-react/domains/security/components/AuditCenter.tsx`（兜底变量）
- Test: `tests/security/audit-event-message.test.ts`（known +1）

**Interfaces:**
- Consumes: `SecurityConfigState["defaults"].maliciousDomains`（Task 2）；RuleSection（既有）；`SecurityApi.setConfig`（既有）
- Produces: 二级页视图 `"network"`；i18n key 族 `security:networkDetail.*`、`security:audit.events.network_blocked`

- [ ] **Step 1: 失败测试**——`tests/security/audit-event-message.test.ts` known 列表追加 `"network.blocked"`（network 族归位）

- [ ] **Step 2: 确认失败** → FAIL（known 缺项）

- [ ] **Step 3: 实现**

`NetworkDetailView.tsx`（照 FileDetailView 骨架：内置只读区 + 两 RuleSection + 两开关行 + 诚实边界提示）：

```tsx
/**
 * 网络安全二级页（SP5 spec §6/§7）：内置恶意域只读区 + 用户允许/拒绝名单 CRUD +
 * 断网与恶意拦截开关 + 子进程覆盖边界提示。
 */
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { SecurityConfig, SecurityConfigKey } from "../model/types";
import { SecurityApi } from "../api/security.api";
import RuleSection from "./RuleSection";

interface NetworkDetailViewProps {
  config: SecurityConfig;
  defaults: { maliciousDomains: string[] };
  onBack: () => void;
  onRulesChange: (config: SecurityConfig) => void;
  onToggle: (key: SecurityConfigKey, value: unknown) => void;
}

/** 域名条目校验（SP5）：非空即收（服务端 pickDomainArray 归一化兜底） */
const validateDomain = (raw: string): string | null => {
  const trimmed = raw.trim();
  return trimmed !== "" ? trimmed : null;
};

export default function NetworkDetailView({
  config,
  defaults,
  onBack,
  onRulesChange,
  onToggle,
}: NetworkDetailViewProps) {
  const { t } = useTranslation(["security"]);
  const save = async (key: SecurityConfigKey, items: string[]) => {
    try {
      onRulesChange(await SecurityApi.setConfig(key, items));
    } catch {
      toast.error(t("security:error.saveFailed"));
    }
  };
  const switches: { labelKey: string; descKey: string; k: "blockAllNetwork" | "maliciousDomainProtection" }[] = [
    { labelKey: "security:networkDetail.blockAllNetwork", descKey: "security:networkDetail.blockAllNetworkDesc", k: "blockAllNetwork" },
    { labelKey: "security:networkDetail.malicious", descKey: "security:networkDetail.maliciousDesc", k: "maliciousDomainProtection" },
  ];
  return (
    <div className="space-y-6">
      <h3 className="text-sm font-medium">{t("security:networkDetail.title")}</h3>
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft size={14} />
        {t("security:audit.back")}
      </Button>
      <p className="text-xs text-muted-foreground">
        {t("security:networkDetail.priorityNote")}
      </p>
      {switches.map(({ labelKey, descKey, k }) => (
        <div key={k} className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label className="text-sm font-normal">{t(labelKey)}</Label>
            <p className="text-xs text-muted-foreground">{t(descKey)}</p>
          </div>
          <Switch
            aria-label={t(labelKey)}
            checked={config[k]}
            onCheckedChange={(checked) => onToggle(k, checked)}
          />
        </div>
      ))}
      <RuleSection
        titleKey="security:networkDetail.denylist.title"
        descKey="security:networkDetail.denylist.desc"
        placeholderKey="security:networkDetail.denylist.placeholder"
        invalidKey="security:invalidEntry"
        items={config.domainDeny}
        validate={validateDomain}
        onSave={(items) => save("domainDeny", items)}
      />
      <RuleSection
        titleKey="security:networkDetail.allowlist.title"
        descKey="security:networkDetail.allowlist.desc"
        placeholderKey="security:networkDetail.allowlist.placeholder"
        invalidKey="security:invalidEntry"
        items={config.domainAllow}
        validate={validateDomain}
        onSave={(items) => save("domainAllow", items)}
      />
      <section className="space-y-2">
        <div>
          <h4 className="text-sm font-medium">
            {t("security:networkDetail.builtin.title")}
          </h4>
          <p className="text-xs text-muted-foreground">
            {t("security:networkDetail.builtin.desc")}
          </p>
        </div>
        <details className="space-y-1">
          <summary className="cursor-pointer text-xs text-primary">
            {t("security:networkDetail.builtin.expand", { count: defaults.maliciousDomains.length })}
          </summary>
          {defaults.maliciousDomains.map((item) => (
            <div key={item} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{item}</span>
              <Badge variant="outline" className="shrink-0 text-[10px]">
                {t("security:networkDetail.builtinTag")}
              </Badge>
            </div>
          ))}
        </details>
      </section>
      <p className="text-xs text-muted-foreground">
        {t("security:networkDetail.boundaryNote")}
      </p>
    </div>
  );
}
```

`SecurityCenter.tsx`：`SecurityView` 加 `"network"`；`view === "network"` 分支渲染 `<NetworkDetailView config={config} defaults={defaults ?? { fileBlocklist: [], maliciousDomains: [] }} onBack={() => setView("home")} onRulesChange={setConfig} onToggle={updateConfig} />`；SandboxCard 传 `onOpenNetwork={() => setView("network")}`。

`SandboxCard.tsx`：ENTRIES 第三项加 `view: "network"`（类型联合加 `"network"`）、props 加 `onOpenNetwork: () => void`、onOpen 解析链加分支；头注释删"网络安全 SP5 上线前维持禁用占位"改 SP5 已启用。

`security.json`（zh-CN 与 en-US 同步；zh 示例）——`audit.events` 追加：

```json
"network_blocked": "已拦截网络请求：{{host}}（规则：{{rule}}，层：{{source}}）"
```

en-US：`"Blocked network request: {{host}} (rule: {{rule}}, layer: {{source}})"`。

新增 `networkDetail` 块（zh-CN）：

```json
"networkDetail": {
  "title": "网络安全",
  "priorityNote": "判定优先级：内置豁免（模型服务/本机）> 拒绝名单 > 允许名单 > 断网模式 > 恶意域拦截；名单支持 *.example.com 子域通配。",
  "blockAllNetwork": "断网模式",
  "blockAllNetworkDesc": "允许名单与内置豁免之外的全部网络请求将被拒绝",
  "malicious": "恶意网站拦截",
  "maliciousDesc": "拦截访问内置恶意域名清单中的站点",
  "denylist": {
    "title": "拒绝名单",
    "desc": "命中即拒（优先于允许名单）",
    "placeholder": "如 evil.com 或 *.evil.com"
  },
  "allowlist": {
    "title": "允许名单",
    "desc": "命中即放行（断网模式下仍然放行）",
    "placeholder": "如 api.example.com 或 *.example.com"
  },
  "builtin": {
    "title": "内置恶意域清单",
    "desc": "代码内置、随版本更新，不可删除；关闭上方开关后不再拦截",
    "expand": "展开 {{count}} 条"
  },
  "builtinTag": "内置",
  "boundaryNote": "覆盖边界：主进程请求（模型调用/MCP/技能市场）、渲染层图片与链接、以及遵循代理环境变量的命令子进程；直连 socket 等深层绕过不在本层防护内。"
}
```

en-US 对应翻译（`"title": "Network Safety"`、`"priorityNote": "Priority: built-in exemptions (model APIs/localhost) > denylist > allowlist > offline mode > malicious domains; patterns support *.example.com wildcards."`、`"blockAllNetwork": "Offline mode"`、`"blockAllNetworkDesc": "All requests outside the allowlist and built-in exemptions will be denied"`、`"malicious": "Malicious site blocking"`、`"maliciousDesc": "Block access to domains in the built-in malicious list"`、`"denylist": { "title": "Denylist", "desc": "Match denies (takes precedence over allowlist)", "placeholder": "e.g. evil.com or *.evil.com" }`、`"allowlist": { "title": "Allowlist", "desc": "Match allows (still allowed in offline mode)", "placeholder": "e.g. api.example.com or *.example.com" }`、`"builtin": { "title": "Built-in malicious domains", "desc": "Code-built-in, updated with app versions, cannot be removed; not enforced when the switch above is off", "expand": "Expand {{count}} entries" }`、`"builtinTag": "Built-in"`、`"boundaryNote": "Coverage: main-process requests (model calls/MCP/skill market), renderer images and links, and command subprocesses honoring proxy env vars; deep bypasses such as raw sockets are out of scope."`）。

`AuditCenter.tsx` entryText 兜底变量链追加 `host`、`rule`、`source`（照 SP4 size/reason 先例位置）。

- [ ] **Step 4: 确认通过**：`npm run test -- tests/security/audit-event-message.test.ts` PASS；`npm run typecheck`（前端类型变更消费全过）；全量三绿
- [ ] **Step 5: Commit**：`feat(安全中心): 网络安全二级页——双名单 CRUD + 断网/恶意拦截开关 + 内置清单只读区 + network_blocked 双语词条与守卫`

---

### Task 7: 手工验收清单 + 全量三绿

**Files:**
- Create: `docs/superpowers/acceptance/2026-09-17-security-center-sp5.md`

**Interfaces:** 无代码；样式照 `docs/superpowers/acceptance/2026-09-17-security-center-sp4.md`

- [ ] **Step 1: 全量三绿取证**：`npm run test && npm run typecheck && npm run lint`（数字以实际输出为准）
- [ ] **Step 2: 写验收清单**（8 组走查，每组操作步骤 + 预期结果 + spec 引用）：
  1. 二级页入口与结构（SandboxCard 网络安全可点、返回、优先级说明）
  2. 域名单 CRUD 与归一化（输入 `Example.COM.` 保存显示 `example.com`；`*.example.com` 通配）
  3. 拒绝名单端到端（deny 域 → 对话让 AI 调 SkillHub 触发主进程 fetch？改用可观测路径：deny `api.skillhub.cn` → 技能市场页报错 + 审计 network.blocked source=fetch）
  4. 断网模式（开 blockAllNetwork → 技能市场挂、模型对话仍通（豁免）、run_command `curl https://example.com` 403 + 审计 source=proxy）
  5. 恶意拦截（内置清单取首条域构造访问 → 拦截 + 审计 rule=malicious；关开关放行）
  6. MCP http 入口（配一个 deny 域的 http MCP → 连接失败文案含"网络安全策略已拒绝"+ 审计 source=mcp）
  7. 渲染层（markdown 输出含 `[x](https://deny域)` 链接点击不响应 + 审计 source=renderer；`<img src=deny域>` 破图；普通链接系统浏览器打开）
  8. 回归（SP2 命令门/SP3 文件门/SP4 批量门抽查 + sandboxEnabled 关 → 全门旁路：deny 域 curl 通、审计无 network.blocked）
- [ ] **Step 3: Commit**：`docs(安全中心): SP5 手工验收清单`

---

## Self-Review（计划自审记录）

1. **Spec 覆盖**：spec §3→T1；§7+写路径→T2；§4→T3；§5→T4；§6→T5；§8+二级页→T6；§10 测试→各任务 Step1；验收→T7。✅ 无缺口
2. **占位符扫描**：BUILTIN_MALICIOUS_DOMAINS 为完整 114 条真实数组（Task 1 Step 3 内联，采集快照 `.superpowers/sp5-malicious-seed.txt` 留档）；Task 2 引用不重复罗列（同一常量）；其余无 TBD/待补
3. **类型一致性**：NetworkVerdict/NetworkPolicyState 三处消费签名一致；childProxyEnv 返回形状在 T3/T4 测试一致；SecurityConfigState.defaults 扩展在 T2 产出、T6 消费一致；assertMcpUrlAllowed/mergeStdioEnv 签名 T4 内自洽
4. **勘误（对 spec）**：① spec §6 的 createDefaultClient `checkUrl?` 参数设计在计划中改为 `assertMcpUrlAllowed(row)` 独立导出 + createDefaultClient 内部调用（可测性更好：预判先于 SDK 构造，且 McpManager 依赖注入路径不变）；② spec §4 "NetworkGate.install(provider, auditSink)" 签名微调为 installNetworkGate(opts)（与 installCommandGate 族一致）；③ spec §5 上游链式转发降级为 v1 不做（边界已记）——三条均为实现层细化，判定语义不变
