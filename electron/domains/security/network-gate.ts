/**
 * 网络安全门单例（SP5 spec §4）：判定供三个拦截层共享——
 * ① PolicyDispatcher 包全局 undici dispatcher（proxy-dispatcher 槽）
 * ② 渲染层 session/window（renderer-guard，Task 5）
 * ③ 本地 CONNECT 代理与子进程 env 注入（local-proxy/command-tool/mcp-manager，Task 4）
 * 模块单例安装照 installCommandGate 先例；electron-free（vitest 直测）。
 */
import { Dispatcher } from "undici";
import type { SecurityEventSink } from "../../../src-react/domains/security/model/types";
import {
  hostFromUrl,
  judgeDomain,
  normalizeDomain,
  type NetworkPolicyState,
  type NetworkVerdict,
} from "./domain-policy";

export type PolicyProvider = () => NetworkPolicyState | null;

export class PolicyDispatcher extends Dispatcher {
  constructor(
    private readonly inner: Dispatcher,
    private readonly judge: (host: string) => NetworkVerdict,
    private readonly onBlocked: (host: string, rule: string) => void,
  ) {
    super();
  }

  dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    let host = "";
    try {
      host = options.origin ? new URL(String(options.origin)).hostname : "";
    } catch {
      // 非 URL origin（unix socket 等）透传——fail-open（spec §9）
    }
    if (host) {
      const verdict = this.judge(host);
      if (!verdict.ok) {
        try {
          this.onBlocked(verdict.host, verdict.rule);
        } catch {
          // 审计发射失败不影响判定路径（fail-open 不制造新故障）
        }
        try {
          // undici 8 v2 handler 同步错误惯例（照 DispatcherBase 先例：
          // 传 null controller，.d.ts 未建模故需断言；fetch/Legacy 包装层均忽略）
          handler.onResponseError?.(
            null as unknown as Dispatcher.DispatchController,
            new Error(
              `网络安全策略已拒绝 ${verdict.host}（规则：${verdict.rule}）`,
            ),
          );
        } catch {
          // handler 抛错不向策略层传播（fail-open 不制造新故障）
        }
        return false;
      }
    }
    return this.inner.dispatch(options, handler);
  }

  close(callback: () => void): void;
  close(): Promise<void>;
  close(callback?: () => void): void | Promise<void> {
    return callback === undefined
      ? this.inner.close()
      : this.inner.close(callback);
  }

  destroy(err: Error | null, callback: () => void): void;
  destroy(callback: () => void): void;
  destroy(err: Error | null): Promise<void>;
  destroy(): Promise<void>;
  destroy(
    err?: Error | null | (() => void),
    callback?: () => void,
  ): void | Promise<void> {
    if (typeof err === "function") {
      return this.inner.destroy(err);
    }
    if (err === undefined) {
      return callback === undefined
        ? this.inner.destroy()
        : this.inner.destroy(callback);
    }
    return callback === undefined
      ? this.inner.destroy(err)
      : this.inner.destroy(err, callback);
  }
}

export class NetworkGate {
  private proxyUrl: string | undefined;

  constructor(
    private readonly policyProvider: PolicyProvider,
    private readonly audit: SecurityEventSink,
  ) {}

  judgeHost(host: string): NetworkVerdict {
    try {
      const policy = this.policyProvider();
      if (policy === null) return { ok: true }; // sandboxEnabled=false 旁路（裁定 3）
      return judgeDomain(normalizeDomain(host), policy);
    } catch {
      return { ok: true }; // fail-open（spec §9，含 provider 抛错——照 makeCommandDecider 先例）
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
  blockedAudit(
    host: string,
    rule: string,
    source: string,
    sessionId?: number,
  ): void {
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
