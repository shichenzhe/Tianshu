/**
 * IPC 通道白名单（单一事实源）：
 * - INVOKE/SEND 为主进程注册的请求通道（renderer → main）
 * - EVENT 为主进程推送的事件通道（main → renderer），PREFIXES 匹配动态通道
 * preload 据此收敛暴露面（防渲染层 XSS 直达任意 ipcRenderer 通道）；
 * src-react/lib/ipc.ts 的 IPCChannel 类型由 INVOKE 数组推导，加通道只改这里。
 * 本模块必须保持零依赖（preload/renderer/main 三方共同打包）。
 */
export const IPC_INVOKE_ALLOWLIST = [
  // user 域
  "user:getByUsername",
  "user:create",
  "user:modify",
  "user:login",
  "user:verifyToken",
  "user:modifyPassword",
  // option 域
  "option:listByType",
  "option:create",
  "option:delete",
  "option:update",
  // AI 模块（可选）
  "provider:list",
  "provider:getById",
  "provider:create",
  "provider:update",
  "provider:delete",
  "model:listByProvider",
  "model:listAll",
  "model:create",
  "model:update",
  "model:delete",
  "model:test",
  "model:listOllama",
  "workspace:list",
  "workspace:create",
  "workspace:update",
  "workspace:delete",
  "workspace:bindDirectory",
  "workspace:unbindDirectory",
  "workspace:openLocal",
  "workspace:openDirectory",
  "workspace:readFile",
  "workspace:revealFile",
  "workspace:exportFile",
  "session:listByWorkspace",
  "session:create",
  "session:rename",
  "session:delete",
  "session:setModel",
  "session:setAssistant",
  "session:setMode",
  "session:listAll",
  "session:pin",
  "session:archive",
  "session:searchByTitle",
  "message:listBySession",
  "message:search",
  "assistant:list",
  "assistant:create",
  "assistant:update",
  "assistant:delete",
  "chat:status",
  "chat:send",
  "chat:regenerate",
  "chat:editAndResend",
  "chat:stop",
  "chat:compact",
  "chat:usage",
  "chat:polish",
  "agent:approve",
  "permission:get",
  "permission:set",
  "permission:rememberTool",
  "permission:listAllowedTools",
  "permission:forgetTool",
  // 系统授权卡（SP6 安全中心）
  "permission:listFullGrants",
  "permission:revokeAllFull",
  "permission:listRemembered",
  "permission:revokeRemembered",
  "permission:revokeAllRemembered",
  "skill:openDir",
  "skill:list",
  "skill:setEnabled",
  "skill:setScenarios",
  "skill:batchSetEnabled",
  "skill:uninstall",
  "skill:batchUninstall",
  "skill:import",
  "skill:pickImport",
  "skill:stats",
  "skill:readSkill",
  "skillhub:list",
  "skillhub:top",
  "skillhub:categories",
  "skillhub:install",
  "file:pickAndRead",
  "file:pickLocalFiles",
  "file:listWorkspaceFiles",
  "file:readWorkspaceFile",
  "file:readExternalFile",
  // 资料库
  "library:list",
  "library:search",
  "library:addFiles",
  "library:createFolder",
  "library:rename",
  "library:move",
  "library:delete",
  "library:revealItem",
  "library:subtreeCount",
  "library:tree",
  "mcpServer:list",
  "mcpServer:create",
  "mcpServer:update",
  "mcpServer:delete",
  "mcpServer:reconnect",
  "mcpServer:setEnabled",
  "mcpServer:statuses",
  // 自动化模块
  "automation:list",
  "automation:create",
  "automation:update",
  "automation:delete",
  "automation:toggle",
  "automation:runNow",
  "automation:templates",
  "automation:runs:page",
  "automation:stat",
  // 项目模块
  "project:list",
  "project:getDetail",
  "project:create",
  "project:update",
  "project:delete",
  "project:setBindings",
  "project:listMembers",
  // 项目资产空间（二期）
  "projectAsset:list",
  "projectAsset:createFolder",
  "projectAsset:rename",
  "projectAsset:delete",
  "projectAsset:upload",
  "projectAsset:storage",
  "projectAsset:openFile",
  "projectAsset:revealFile",
  "projectAsset:pickFiles",
  // 计划事项（三期）：fields 两通道 Task 3 注册 handler
  "planItem:list",
  "planItem:listMine",
  "planItem:create",
  "planItem:update",
  "planItem:delete",
  "planItem:move",
  "planItem:fields:list",
  "planItem:fields:save",
  "planItem:attachments:list",
  "planItem:attachments:create",
  "planItem:attachments:delete",
  // 计划视图（三期子系统 A）：5 通道 Task 4 注册 handler
  "planView:list",
  "planView:create",
  "planView:update",
  "planView:delete",
  "planView:reorder",
  // 个性化记忆（记忆与进化）
  "personalization:applyMemoryInstruction",
  "personalization:compileMemory",
  // 设置（通用设置面板）
  "settings:getAll",
  "settings:set",
  "settings:getAutoLaunch",
  "settings:setAutoLaunch",
  "settings:getKeepAwake",
  "settings:setKeepAwake",
  "settings:setProxy",
  "settings:storageInfo",
  "settings:pickDirectory",
  "settings:openDirectory",
  "settings:beep",
  "settings:openExternal",
  "settings:testNotification",
  // 应用信息
  "app:getInfo",
  "app:getVersion",
  "app:getName",
  // 窗口控制（快捷键分发）
  "window:toggleFullScreen",
  // 日志
  "log:info",
  "log:warn",
  "log:error",
  // 安全中心（SP1）
  "security:getConfig",
  "security:setConfig",
  "security:auditList",
  "security:auditExport",
  "security:auditClear",
  "security:openBackupDir",
  "security:resetCommandRules",
  "security:resetFileRules",
  // 更新日志
  "update-log:getContent",
  "update-log:getConfig",
] as const;

/** ipcMain.on 注册的消息通道（fire-and-forget） */
export const IPC_SEND_ALLOWLIST = [
  "check-for-updates",
  "install-update",
] as const;

/** 主进程 webContents.send 推送的事件通道（renderer 侧 on/once） */
export const IPC_EVENT_ALLOWLIST = [
  "main-process-message",
  "update-available",
  "update-downloaded",
  "update-error",
  "update-not-available",
] as const;

/** 动态事件通道前缀（chat:stream:<sessionId>） */
export const IPC_EVENT_PREFIXES = ["chat:stream:"] as const;

export type IpcInvokeChannel = (typeof IPC_INVOKE_ALLOWLIST)[number];

const INVOKE_SET = new Set<string>(IPC_INVOKE_ALLOWLIST);
const SEND_SET = new Set<string>(IPC_SEND_ALLOWLIST);
const EVENT_SET = new Set<string>(IPC_EVENT_ALLOWLIST);

/** invoke 通道是否放行 */
export function isInvokeAllowed(channel: string): boolean {
  return INVOKE_SET.has(channel);
}

/** send 通道是否放行 */
export function isSendAllowed(channel: string): boolean {
  return SEND_SET.has(channel);
}

/** 事件监听通道是否放行（含动态前缀匹配） */
export function isEventAllowed(channel: string): boolean {
  return (
    EVENT_SET.has(channel) ||
    IPC_EVENT_PREFIXES.some((p) => channel.startsWith(p))
  );
}
