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
  | "workspace:readFile"
  | "workspace:revealFile"
  | "workspace:exportFile"
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
  | "chat:editAndResend"
  | "chat:stop"
  | "chat:compact"
  | "chat:usage"
  | "chat:polish"
  | "agent:approve"
  | "permission:get"
  | "permission:set"
  | "permission:rememberTool"
  | "permission:listAllowedTools"
  | "permission:forgetTool"
  // 系统授权卡（SP6 安全中心）
  | "permission:listFullGrants"
  | "permission:revokeAllFull"
  | "permission:listRemembered"
  | "permission:revokeRemembered"
  | "permission:revokeAllRemembered"
  | "skill:openDir"
  | "skill:list"
  | "skill:setEnabled"
  | "skill:setScenarios"
  | "skill:batchSetEnabled"
  | "skill:uninstall"
  | "skill:batchUninstall"
  | "skill:import"
  | "skill:pickImport"
  | "skill:stats"
  | "skill:readSkill"
  | "skillhub:list"
  | "skillhub:top"
  | "skillhub:categories"
  | "skillhub:install"
  | "file:pickAndRead"
  | "file:listWorkspaceFiles"
  | "file:readWorkspaceFile"
  | "file:readExternalFile"
  | "mcpServer:list"
  | "mcpServer:create"
  | "mcpServer:update"
  | "mcpServer:delete"
  | "mcpServer:reconnect"
  | "mcpServer:setEnabled"
  | "mcpServer:statuses"
  // 自动化模块
  | "automation:list"
  | "automation:create"
  | "automation:update"
  | "automation:delete"
  | "automation:toggle"
  | "automation:runNow"
  | "automation:templates"
  | "automation:runs:page"
  | "automation:stat"
  // 项目模块
  | "project:list"
  | "project:getDetail"
  | "project:create"
  | "project:update"
  | "project:delete"
  | "project:setBindings"
  | "project:listMembers"
  // 项目资产空间（二期）
  | "projectAsset:list"
  | "projectAsset:createFolder"
  | "projectAsset:rename"
  | "projectAsset:delete"
  | "projectAsset:upload"
  | "projectAsset:storage"
  | "projectAsset:openFile"
  | "projectAsset:revealFile"
  | "projectAsset:pickFiles"
  // 计划事项（三期）：fields 两通道 Task 3 注册 handler
  | "planItem:list"
  | "planItem:listMine"
  | "planItem:create"
  | "planItem:update"
  | "planItem:delete"
  | "planItem:move"
  | "planItem:fields:list"
  | "planItem:fields:save"
  | "planItem:attachments:list"
  | "planItem:attachments:create"
  | "planItem:attachments:delete"
  // 计划视图（三期子系统 A）：5 通道 Task 4 注册 handler
  | "planView:list"
  | "planView:create"
  | "planView:update"
  | "planView:delete"
  | "planView:reorder"
  // 个性化记忆（记忆与进化）
  | "personalization:applyMemoryInstruction"
  | "personalization:compileMemory"
  // 设置（通用设置面板）
  | "settings:getAll"
  | "settings:set"
  | "settings:getAutoLaunch"
  | "settings:setAutoLaunch"
  | "settings:getKeepAwake"
  | "settings:setKeepAwake"
  | "settings:setProxy"
  | "settings:storageInfo"
  | "settings:pickDirectory"
  | "settings:openDirectory"
  | "settings:beep"
  | "settings:openExternal"
  | "settings:testNotification"
  // 应用信息
  | "app:getInfo"
  | "app:getVersion"
  | "app:getName"
  // 窗口控制（快捷键分发）
  | "window:toggleFullScreen"
  // 日志
  | "log:info"
  | "log:warn"
  | "log:error"
  // 安全中心（SP1）
  | "security:getConfig"
  | "security:setConfig"
  | "security:auditList"
  | "security:auditExport"
  | "security:auditClear"
  | "security:openBackupDir"
  | "security:resetCommandRules"
  | "security:resetFileRules"
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
