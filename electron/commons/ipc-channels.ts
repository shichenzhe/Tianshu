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
  // provider 级连通测试（终审 I-2：comfyui 无模型行，设置页「测试连接」）
  "provider:test",
  "model:listByProvider",
  "model:listAll",
  "model:create",
  "model:update",
  "model:delete",
  "model:test",
  "model:listOllama",
  "model:listRemote",
  "workspace:list",
  "workspace:create",
  "workspace:update",
  "workspace:delete",
  "workspace:bindDirectory",
  "workspace:unbindDirectory",
  "workspace:openLocal",
  "workspace:openDirectory",
  "workspace:readFile",
  "workspace:listDir",
  "workspace:revealFile",
  "workspace:exportFile",
  "workspace:listArtifacts",
  "workspace:toggleArtifactFavorite",
  // 查看变更 tab：工作树变更列表与单文件 diff（git 只读三命令白名单）
  "workspace:gitStatus",
  "workspace:gitDiff",
  "file:pickLocalFolder",
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
  // 文件窗 AI 面板（T22）按 id 精确拉取单会话（ChatPane 渲染数据源）
  "session:getById",
  // P1 尾未读角标：已读游标单调推进（ChatPane 消息就绪/定稿后上报；
  // repo.markSessionRead 归属 + message 属会话校验，同报 SESSION_NOT_FOUND）
  "session:markRead",
  "message:listBySession",
  "message:search",
  "assistant:list",
  "assistant:create",
  "assistant:update",
  "assistant:delete",
  "assistant:export",
  "assistant:import",
  "chat:status",
  "chat:send",
  "chat:regenerate",
  "chat:editAndResend",
  "chat:stop",
  "chat:compact",
  "chat:usage",
  "chat:polish",
  "chat:handoverSummary",
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
  // 粘贴附件：截图 blob 落盘（字节钉住在渲染层完成）与 macOS size-0
  // 截图主进程兜底（chat.service，spec 2026-10-10）
  "file:savePastedImage",
  "file:readClipboardImage",
  // 消息图片块展示：按相对数据根路径读 dataUrl（多模态附件回看）
  "file:readMessageImage",
  // 聊天输出便捷导出批：dataUrl 图片另存为（消息图片 lightbox / mermaid
  // 导出 / widget 截图下载共用）+ widget 图表区域截图（iframe rect DIP →
  // event.sender.capturePage）
  "file:saveDataUrl",
  "widget:capture",
  // 内置浏览器：清除浏览数据（cookies 登录态 / cache 站点存储与缓存）；
  // 工具栏动作（WorkBuddy `...` 菜单）：设备模拟 / 截图到剪贴板 / 外开
  "browser:clearData",
  "browser:emulateDevice",
  "browser:captureScreenshot",
  "browser:openExternal",
  // 资料库
  "library:list",
  "library:search",
  "library:addFiles",
  "library:createFolder",
  "library:createFile",
  "library:importFolder",
  "library:addLink",
  "library:openLink",
  "library:rename",
  "library:move",
  "library:delete",
  "library:revealItem",
  "library:subtreeCount",
  "library:tree",
  "library:writeFileContent",
  "library:toggleFavorite",
  "library:markViewed",
  "library:listRecent",
  "library:listFavorites",
  "mcpServer:list",
  "mcpServer:create",
  "mcpServer:update",
  "mcpServer:delete",
  "mcpServer:reconnect",
  "mcpServer:setEnabled",
  "mcpServer:statuses",
  "mcpServer:sync",
  "mcpServer:openHub",
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
  "automation:stats",
  // 监控模块（token/工具监控）
  "monitor:stats",
  // 编排域（LangGraph）
  "orchestration:list",
  "orchestration:create",
  "orchestration:update",
  "orchestration:delete",
  "orchestration:toggle",
  "orchestration:templates",
  "orchestration:runTest",
  "orchestration:cancelTestRun",
  "orchestration:runs",
  "orchestration:runNodes",
  "orchestration:polishPrompt",
  "orchestration:pickBinaryFile",
  "orchestration:exportWorkflow",
  "orchestration:exportWorkflows",
  "orchestration:importWorkflow",
  "orchestration:testNode",
  "orchestration:webhookEnable",
  "orchestration:webhookDisable",
  "orchestration:webhookStatus",
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
  "settings:getWebhookPort",
  "settings:setWebhookPort",
  "settings:getRunRetention",
  "settings:setRunRetention",
  "settings:getAutoLaunch",
  "settings:setAutoLaunch",
  "settings:getKeepAwake",
  "settings:setKeepAwake",
  "settings:setProxy",
  "settings:storageInfo",
  "settings:getDataRoot",
  "settings:setDataRoot",
  "settings:relaunchApp",
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
  // 终端域（DetailPanel 终端 tab）：create/probe/replay 走 invoke（鉴权；
  // probe 探活挂起重挂的 pty 是否仍存活，replay 拉回放缓冲——重挂续连不
  // 空白），高频 write/resize/kill 走 send
  "terminal:create",
  "terminal:probe",
  "terminal:replay",
  // 文件独立窗口（WorkBuddy office window 对齐）；pickFile/grantFilePath
  // 本期 Task 1 先登记通道，handler 由后续任务注册
  "fileWindow:open",
  "fileWindow:confirmClose",
  "fileWindow:cancelClose",
  "fileWindow:close-ready",
  "fileWindow:setSessionState",
  "fileWindow:getSessionState",
  "fileWindow:pickFile",
  "fileWindow:grantFilePath",
  "fileWindow:revokeSession",
  // 文件窗 AI 面板「打开主页」：唤起主窗（show+focus）
  "fileWindow:focusMain",
  // 文件窗跨窗导航（T22，spec §13 项 3）：ChatPane 设置类入口 → 聚焦
  // 主窗并发 fileWindow:navigate 事件（主窗渲染层跳转对应路由）
  "fileWindow:openRoute",
  // 文件窗口保存写回（spec 2026-10-14 §5.2；handler 见 file-write-ipc，
  // fileChanged 事件已在上方 EVENT 白名单）
  "workspace:writeFile",
  // 被控面（server-face spec §6.3）：状态查询与启停开关；配置编辑
  // （端口/host/relay/token）走 setEnabled 对象载荷合并落库（spec §13 项 1）
  "serverFace:status",
  "serverFace:setEnabled",
  // 被控面登录用户上报（问题 2 方案 A 2026-10-22）：渲染层登录/登出/
  // 切换/rehydrate 时上报 userId，face resolveUserId/info 身份跟随真实
  // 登录用户（此前只能猜 user 表最新一行，切回旧账号即错位）
  "serverFace:reportActiveUser",
  // 控制端（T16）：连接注册表 CRUD/测试 + 本地无头端启停 + session 遥控
  // 透传（session 类末参可选 connId，缺省走活动连接 activeConnId）
  "server:connectionList",
  "server:connectionSave",
  "server:connectionDelete",
  "server:testConnection",
  "server:localStart",
  "server:localStop",
  "server:localStatus",
  "server:sessionList",
  "server:sessionGet",
  "server:sessionSend",
  "server:sessionAbort",
  "server:sessionCreate",
  // 会话删除（双端均有 session/delete；UI 打磨——列表行删除入口）
  "server:sessionDelete",
  // 远程审批应答（T17，移动端 spec §4.2「顺带补」）：POST session/approve
  // 透传——被控端 4040 = 该审批已被处理或已失效（双端竞速先到/超时自动拒）
  "server:sessionApprove",
  // 控制端模型面：provider/query 全量查（headless+desktop 被控端均有）；
  // provider/save 仅无头端有此端点（desktop 被控面 provider 只读——模型
  // 配置在其本地 AI 模块页管理），UI 按 headless 判定（capabilities 含
  // graph）才开编辑表单
  "server:providerQuery",
  "server:providerSave",
  // 模型面打磨（FA 批）：批量删除（级联/单删）、连通测试、上游模型拉取
  "server:providerDelete",
  "server:providerTest",
  "server:providerFetchModels",
  // 会话重命名 + 专家列表（发送选专家，send assistantId）+ 重新生成
  "server:sessionUpdate",
  "server:sessionRegenerate",
  "server:assistantQuery",
  // 单 UI 远程态侧栏分组树（HD-A1）：workspace 概要列表
  "server:workspaceList",
  // 聊天面板对齐（CU 批）：编辑重发 + 会话权限模式
  "server:sessionEditResend",
  "server:sessionAccessMode",
  // P1 尾未读角标：远程主机已读推进透传（session/read——与移动端
  // loadHistory 后上报同语义，被控端清远端角标经 enriched session.updated）
  "server:sessionRead",
  // 文件面（FA-T3）：files 三端点透传（@ 联想/守卫读取/图片上传）
  "server:filesList",
  "server:filesRead",
  "server:filesUploadImage",
  // 对齐批（AL）：上下文用量 + 技能面（联想/读全文）
  "server:sessionUsage",
  "server:skillsQuery",
  "server:skillsRead",
  // ＋菜单子菜单（PM 批）：技能启停
  "server:skillsSetEnabled",
  // 控制端编排区（GA-T8）：graph 五端点 + automation 四端点透传（同款
  // 末参可选 connId，缺省走活动连接；启停语义 = automation/save 全量
  // enabled 字段，无 toggle 端点——Ruling 12）
  "server:graphQuery",
  "server:graphSave",
  "server:graphDelete",
  "server:graphRun",
  "server:graphRunAbort",
  "server:automationQuery",
  "server:automationSave",
  "server:automationDelete",
  "server:automationRunNow",
  // webhook 配置遥控（WH 消费端批）
  "server:webhookEnable",
  "server:webhookDisable",
  "server:webhookStatus",
  // 控制端 ui-drive（UD-T2，spec §3.3）：被控桌面端 UI 驱动三端点透传
  // （openSession 配「在被控端打开」按钮；notify/openRoute 协议端点供
  // 外部/调试调用，spec §6 假设 2 不配 UI）
  "server:uiOpenSession",
  "server:uiNotify",
  "server:uiOpenRoute",
  // 桥审批应答（TB-T2，spec §4.2）：渲染层审批卡 → 主进程 bridge-executor
  // 收敛挂起审批（本地通道，非远程透传——执行与 respond 回传都在主进程）
  "server:bridgeDecision",
  // 备份域（spec 2026-10-27 §4）：四 invoke（入参含连接 id，仅 direct 开放）
  // + 恢复后用户手动重启薄封装；backup:progress 事件在 EVENT 白名单。
  // 多用户扩展（spec 2026-10-28）：claim 邀请码申领（成功自动写回连接
  // backupToken）+ invites/clients 管理面五通道（admin 判定在 server 端）
  "backup:list",
  "backup:create",
  "backup:restore",
  "backup:delete",
  "backup:relaunch",
  "backup:claim",
  "backup:invites:create",
  "backup:invites:list",
  "backup:invites:delete",
  "backup:clients:list",
  "backup:clients:delete",
] as const;

/** ipcMain.on 注册的消息通道（fire-and-forget） */
export const IPC_SEND_ALLOWLIST = [
  "check-for-updates",
  "install-update",
  // 终端域（DetailPanel）：高频流数据不走 invoke；id 仅 create 成功者持有
  "terminal:write",
  "terminal:resize",
  "terminal:kill",
  // browser_use：渲染层 webview dom-ready 上报会话绑定（guest 注册表）
  "browser:bindSession",
] as const;

/** 主进程 webContents.send 推送的事件通道（renderer 侧 on/once） */
export const IPC_EVENT_ALLOWLIST = [
  "main-process-message",
  "update-available",
  "update-downloaded",
  "update-error",
  "update-not-available",
  // 内置浏览器：guest 站内开窗（target=_blank）转新 tab 转发
  "browser:openInNewTab",
  // 业务变更推送（preload 拒听非白名单事件，缺此两通道时
  // use-automation-tasks/useGraphs 的失效监听会静默失效）：
  // automation:tasks-changed 修既有 bug（scheduler 推送从未放行）；
  // orchestration:graphs-changed 图试运行收尾推送（先例同上）
  "automation:tasks-changed",
  "orchestration:graphs-changed",
  // 图试运行/运行中的节点状态实时推送（GraphEditorView 画布高亮监听；
  // preload 拒听非白名单事件，缺此通道高亮会静默失效）
  "orchestration:node-status",
  // AI 面板联动（web 工具 open_browser）：主进程 → 渲染层开右栏浏览器 tab
  "detailPanel:openBrowser",
  // 文件独立窗口：resources 投递 / 关闭询问 / AI 写盘联动
  "fileWindow:deliver",
  "fileWindow:close-request",
  // 跨窗导航（T22）：openRoute handler → 主窗渲染层路由跳转
  "fileWindow:navigate",
  // 库维度文件变更（T14 修复轮：AI write_file 直改库文件全窗广播；
  // workspace:fileChanged 反解不了库 storagePath，另立事件）
  "fileWindow:libraryChanged",
  "workspace:fileChanged",
  // ui-drive（spec 2026-10-17 §2.3，UD-T1）：被控面三端点 → 主窗渲染层
  // 动作——会话打开 / sonner toast / 路由跳转（openRoute 白名单已在主
  // 进程校验，渲染层二次校验前缀双保险；preload 拒听非白名单事件）
  "ui:openSession",
  "ui:notify",
  "ui:openRoute",
  // 桥审批卡（TB-T2，spec §4.2）：主进程 bridge-executor write 门 → 渲染层
  // 审批卡（工具名/参数摘要/允许/拒绝——应答走 server:bridgeDecision）
  "server:bridgeApproval",
  // 备份域（spec 2026-10-27 §4）：备份/恢复四相字节进度推送
  // （设置面板 BackupGroup 进度条监听；preload 拒听非白名单事件）
  "backup:progress",
] as const;

/** 动态事件通道前缀（chat:stream:<sessionId>、terminal:data:<ptyId>、terminal:exit:<ptyId>、
 * server:chunk:<connId>:<sessionId>（远程流式回显）、server:event:<connId>（远程
 * session.updated/error 合并通道，T16） */
export const IPC_EVENT_PREFIXES = [
  "chat:stream:",
  "terminal:data:",
  "terminal:exit:",
  "server:chunk:",
  "server:event:",
] as const;

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
