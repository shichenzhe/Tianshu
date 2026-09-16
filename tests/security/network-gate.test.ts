/**
 * 网络安全门单测（SP5 Task 3）：judgeHost/judgeUrl 判定序与旁路、
 * blockedAudit 审计形态、childProxyEnv 子进程 env、
 * PolicyDispatcher 拒绝/放行双路径（undici 8 v2 handler 形态：
 * Dispatcher.DispatchOptions / Dispatcher.DispatchHandler / onResponseError）。
 * network-gate 零 electron import（vitest 直测，无需 mock electron）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dispatcher, getGlobalDispatcher } from "undici";
import type { NetworkPolicyState } from "../../electron/domains/security/domain-policy";
import {
  getNetworkGate,
  installNetworkGate,
  uninstallNetworkGateForTest,
} from "../../electron/domains/security/network-gate";

/** 判定输入用全量策略（judgeDomain 直接读各名单字段，部分态会抛错走 fail-open） */
const policy = (over: Partial<NetworkPolicyState>): NetworkPolicyState => ({
  exemptDomains: [],
  domainAllow: [],
  domainDeny: [],
  blockAllNetwork: false,
  maliciousDomainProtection: false,
  ...over,
});

/** 内层假 dispatcher：记录 dispatch 调用，可控放行 */
function fakeInner() {
  const calls: Dispatcher.DispatchOptions[] = [];
  const inner = {
    dispatch(options: Dispatcher.DispatchOptions) {
      calls.push(options);
      return true;
    },
    calls,
    close: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  } as unknown as Dispatcher;
  return { inner, calls };
}

describe("NetworkGate", () => {
  beforeEach(() => uninstallNetworkGateForTest());

  it("install 后 judgeHost 走判定序；provider null 时旁路放行", () => {
    const gate = installNetworkGate({
      policyProvider: () => policy({ domainDeny: ["evil.com"] }),
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
      policyProvider: () => policy({ domainDeny: ["evil.com"] }),
      audit: () => {},
    });
    expect(gate.judgeUrl("::bad::")).toEqual({ ok: true });
  });

  it("policyProvider 抛错 → judgeHost fail-open 放行（终审加固）", () => {
    const gate = installNetworkGate({
      policyProvider: () => {
        throw new Error("provider boom");
      },
      audit: () => {},
    });
    expect(gate.judgeHost("evil.com")).toEqual({ ok: true });
  });

  it("blockedAudit 走 audit sink（network.blocked）", () => {
    const audit = vi.fn();
    const gate = installNetworkGate({ policyProvider: () => null, audit });
    (
      gate as unknown as {
        blockedAudit: (h: string, r: string, s: string) => void;
      }
    ).blockedAudit("evil.com", "deny", "fetch");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "network.blocked",
        decision: "blocked",
        detail: { host: "evil.com", rule: "deny", source: "fetch" },
      }),
    );
  });

  it("childProxyEnv：代理未启动 undefined；setProxyUrl 后注入三变量 + NO_PROXY", () => {
    const gate = installNetworkGate({
      policyProvider: () => policy({}),
      audit: () => {},
    });
    expect(gate.childProxyEnv()).toBeUndefined();
    gate.setProxyUrl("http://127.0.0.1:3128");
    expect(gate.childProxyEnv()).toEqual({
      HTTPS_PROXY: "http://127.0.0.1:3128",
      HTTP_PROXY: "http://127.0.0.1:3128",
      ALL_PROXY: "http://127.0.0.1:3128",
      NO_PROXY: "localhost,127.0.0.1,::1",
    });
  });

  it("childProxyEnv：门旁路（provider null）恒 undefined（spec §5 不注入）", () => {
    const gate = installNetworkGate({
      policyProvider: () => null,
      audit: () => {},
    });
    gate.setProxyUrl("http://127.0.0.1:3128");
    expect(gate.childProxyEnv()).toBeUndefined();
  });

  it("PolicyDispatcher：deny 时 onResponseError 同步拒且不触 inner；放行透传", async () => {
    const { PolicyDispatcher } =
      await import("../../electron/domains/security/network-gate");
    const { inner, calls } = fakeInner();
    const gate = installNetworkGate({
      policyProvider: () => policy({ domainDeny: ["evil.com"] }),
      audit: () => {},
    });
    const pd = new PolicyDispatcher(
      inner,
      (host) => gate.judgeHost(host),
      () => {},
    );
    const onResponseError = vi.fn();
    const denied = pd.dispatch(
      { origin: "https://evil.com", path: "/", method: "GET" },
      { onResponseError } as unknown as Dispatcher.DispatchHandler,
    );
    expect(denied).toBe(false);
    expect(onResponseError).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        message: expect.stringContaining("evil.com"),
      }),
    );
    expect(calls).toHaveLength(0);
    const passed = pd.dispatch(
      { origin: "https://ok.com", path: "/", method: "GET" },
      {
        onResponseError: vi.fn(),
        onRequestStart: vi.fn(),
      } as unknown as Dispatcher.DispatchHandler,
    );
    expect(passed).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("代理重放不丢策略：applyProxyDispatcher 二次调用仍带 PolicyDispatcher wrap", async () => {
    const { setPolicyHook, applyProxyDispatcher } =
      await import("../../electron/domains/app-settings/proxy-dispatcher");
    const { PolicyDispatcher } =
      await import("../../electron/domains/security/network-gate");
    const gate = installNetworkGate({
      policyProvider: () => policy({ domainDeny: ["evil.com"] }),
      audit: () => {},
    });
    setPolicyHook({
      judgeHost: (host) => gate.judgeHost(host),
      onBlocked: () => {},
    });
    applyProxyDispatcher({ mode: "direct" });
    expect(getGlobalDispatcher()).toBeInstanceOf(PolicyDispatcher);
    applyProxyDispatcher({ mode: "proxy", host: "127.0.0.1", port: 3128 });
    expect(getGlobalDispatcher()).toBeInstanceOf(PolicyDispatcher);
    // 还原现场：卸策略槽并回直连，避免 wrap 泄漏到本文件其他用例
    setPolicyHook(null);
    applyProxyDispatcher({ mode: "direct" });
  });
});
