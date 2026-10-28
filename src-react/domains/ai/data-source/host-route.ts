/**
 * 主机路由层（HD 批，spec §2.2）：api 模块内双通道路由——本地走 invoke
 * 原通道（透传零行为变化），远程走调用方给定的适配器闭包（server:* 通道
 * + 形状转换）。UI 组件对路由完全透明。
 */
import { invoke } from "@/lib/ipc";
import { activeHost, type ActiveHost } from "./host.store";

/** 当前激活远程 connId（本地主机返回 null） */
export function remoteConnId(): string | null {
  const host = activeHost();
  return host.kind === "remote" ? host.connId : null;
}

/**
 * 双通道路由（api 方法标准改造模式）：
 * - 本地：invoke(local.ch, ...local.args)——参数形状与改造前逐字一致
 * - 远程：remote() 适配器闭包（requestRemote + 形状转换 + connId 自取）
 */
export function routeInvoke<T>(
  local: { ch: string; args: unknown[] },
  remote: (connId: string) => Promise<T>,
): Promise<T> {
  const connId = remoteConnId();
  if (connId == null) {
    return invoke<T>(local.ch as never, ...(local.args as never[]));
  }
  return remote(connId);
}

/** 事件订阅路由（chunk 流）：返回取消订阅函数 */
export function routeSubscribe(
  local: (cb: (payload: unknown) => void) => () => void,
  remote: (connId: string, cb: (payload: unknown) => void) => () => void,
): (cb: (payload: unknown) => void) => () => void {
  return (cb) => {
    const connId = remoteConnId();
    return connId == null ? local(cb) : remote(connId, cb);
  };
}

export type { ActiveHost };
