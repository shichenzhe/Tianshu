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
} from "undici";
import {
  toDispatcherSpec,
  type DispatcherSpec,
  type ProxyParams,
} from "./proxy-config";

/** 按代理参数设置全局 dispatcher（幂等：整体替换，无残留旧实例状态） */
export function applyProxyDispatcher(params: ProxyParams): void {
  setGlobalDispatcher(buildDispatcher(toDispatcherSpec(params)));
}

/** 形态 → undici Agent 实例 */
function buildDispatcher(spec: DispatcherSpec) {
  switch (spec.kind) {
    case "proxy":
      return new ProxyAgent({ uri: spec.uri });
    case "env":
      return new EnvHttpProxyAgent();
    default:
      return new Agent();
  }
}
