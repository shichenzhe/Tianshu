/**
 * IPC 通信封装
 * 提供类型安全的 IPC 调用方法
 */
import { type IpcInvokeChannel } from "../../electron/commons/ipc-channels";
import { useUserStore } from "@/domains/user/store/user.store";

export type IPCChannel = IpcInvokeChannel;
// 通道白名单单一事实源在 electron/commons/ipc-channels.ts（preload 同源校验）

/**
 * 业务 IPC 末尾统一追加的登录 token（主进程 electron/commons/ipc-user.ts
 * 解出 userId；用户域等白名单通道由 handler 忽略该参数）
 */
/**
 * 业务 IPC 末尾统一追加的登录 token（主进程 electron/commons/ipc-user.ts
 * 解出 userId；用户域等白名单通道由 handler 忽略该参数）
 */
function authToken(): string {
  return useUserStore.getState().user.token;
}

/**
 * 调用主进程方法
 */
export async function invoke<T = unknown>(
  channel: IPCChannel,
  ...args: unknown[]
): Promise<T> {
  if (!window.ipcRenderer) {
    throw new Error("IPC Renderer not available");
  }
  // 末尾统一追加登录 token：业务通道解出 userId，白名单通道忽略
  return window.ipcRenderer.invoke(channel, ...args, authToken()) as Promise<T>;
}

/**
 * 发送消息到主进程（不等待响应）
 */
export function send(channel: string, ...args: unknown[]): void {
  if (!window.ipcRenderer) {
    throw new Error("IPC Renderer not available");
  }
  window.ipcRenderer.send(channel, ...args, authToken());
}

/**
 * 监听主进程事件
 */
export function on(
  channel: string,
  listener: (event: unknown, ...args: unknown[]) => void,
): () => void {
  if (!window.ipcRenderer) {
    throw new Error("IPC Renderer not available");
  }
  return window.ipcRenderer.on(channel, listener);
}

/**
 * 监听主进程事件（只触发一次）
 */
export function once(
  channel: string,
  listener: (event: unknown, ...args: unknown[]) => void,
): void {
  if (!window.ipcRenderer) {
    throw new Error("IPC Renderer not available");
  }
  window.ipcRenderer.once(channel, listener);
}

/**
 * 移除事件监听器
 */
export function removeAllListeners(channel: string): void {
  if (!window.ipcRenderer) {
    throw new Error("IPC Renderer not available");
  }
  window.ipcRenderer.removeAllListeners(channel);
}
