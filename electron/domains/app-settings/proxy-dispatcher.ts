/**
 * 主进程 undici 全局代理应用：AI SDK 模型请求 / skillhub 等主进程 fetch
 * 走 Node 内置 undici（不经 Electron session），须独立设置全局 dispatcher。
 * 已实测 undici@8 的 setGlobalDispatcher 同时写入 v1/v2 兼容符号，
 * Node 全局 fetch 即刻生效（AI SDK provider 默认用全局 fetch）。
 * 注意："system" 在此层的含义是按 HTTP(S)_PROXY 等环境变量（EnvHttpProxyAgent），
 * 读取操作系统代理设置的能力在 Node 层不存在，OS 级跟随仅在 Electron session 生效。
 */
import {
  Agent,
  EnvHttpProxyAgent,
  ProxyAgent,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";
import { PolicyDispatcher } from "../security/network-gate";
import type { NetworkVerdict } from "../security/domain-policy";
import {
  toDispatcherSpec,
  type DispatcherSpec,
  type ProxyParams,
} from "./proxy-config";

/** 网络策略钩子（SP5 network-gate 注入）：null = 未装策略（现状行为） */
export interface PolicyHook {
  judgeHost: (host: string) => NetworkVerdict;
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
  return new PolicyDispatcher(
    inner,
    policyHook.judgeHost,
    policyHook.onBlocked,
  );
}
