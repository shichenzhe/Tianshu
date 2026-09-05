/**
 * IPC 通信封装
 * 提供类型安全的 IPC 调用方法
 */

export type IPCChannel =
  // user 域
  | "user:getByUsername"
  | "user:create"
  | "user:modify"
  | "user:login"
  | "user:verifyToken"
  | "user:modifyPassword"
  // option 域
  | "option:listByType"
  | "option:create"
  | "option:delete"
  | "option:update"
  // AI 模块（可选）
  | "provider:list"
  | "provider:getById"
  | "provider:create"
  | "provider:update"
  | "provider:delete"
  | "model:listByProvider"
  | "model:listAll"
  | "model:create"
  | "model:update"
  | "model:delete"
  | "model:test"
  | "model:listOllama"
  | "workspace:list"
  | "workspace:create"
  | "workspace:update"
  | "workspace:delete"
  | "workspace:bindDirectory"
  | "workspace:unbindDirectory"
  | "workspace:openDirectory"
  | "session:listByWorkspace"
  | "session:create"
  | "session:rename"
  | "session:delete"
  | "session:setModel"
  | "session:setAssistant"
  | "session:setMode"
  | "session:listAll"
  | "session:pin"
  | "session:archive"
  | "session:searchByTitle"
  | "message:listBySession"
  | "message:search"
  | "assistant:list"
  | "assistant:create"
  | "assistant:update"
  | "assistant:delete"
  | "chat:status"
  | "chat:send"
  | "chat:regenerate"
  | "chat:stop"
  | "agent:approve"
  | "permission:get"
  | "permission:set"
  | "permission:rememberTool"
  | "permission:listAllowedTools"
  | "permission:forgetTool"
  | "skill:openDir"
  | "skill:list"
  | "skill:setEnabled"
  | "skill:batchSetEnabled"
  | "skill:uninstall"
  | "skill:batchUninstall"
  | "skill:import"
  | "skill:pickImport"
  | "skill:stats"
  | "skillhub:list"
  | "skillhub:top"
  | "skillhub:categories"
  | "skillhub:install"
  | "file:pickAndRead"
  | "file:listWorkspaceFiles"
  | "file:readWorkspaceFile"
  | "mcpServer:list"
  | "mcpServer:create"
  | "mcpServer:update"
  | "mcpServer:delete"
  | "mcpServer:reconnect"
  | "mcpServer:setEnabled"
  | "mcpServer:statuses"
  // 应用信息
  | "app:getInfo"
  | "app:getVersion"
  | "app:getName"
  // 日志
  | "log:info"
  | "log:warn"
  | "log:error"
  // 更新日志
  | "update-log:getContent"
  | "update-log:getConfig";

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
  return window.ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

/**
 * 发送消息到主进程（不等待响应）
 */
export function send(channel: string, ...args: unknown[]): void {
  if (!window.ipcRenderer) {
    throw new Error("IPC Renderer not available");
  }
  window.ipcRenderer.send(channel, ...args);
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
