# 计划：聊天消息编辑、复制及时间戳显示

来源：PRD「聊天消息编辑、复制及时间戳显示功能」+ 2026-09-08 会话中批准的设计（bounded 路径，设计在聊天中呈现并获用户批准）。
约束：用户明确要求——不使用 worktree（直接在 master 开发）、不使用 TDD 流程（测试随实现一起写）、最终由用户自行验证。

## Global Constraints

- **i18n**：禁止在 JSX/JS 中硬编码用户可见文案；zh-CN 与 en-US 两个 locale JSON 必须同步添加 key；使用 `t("chat:...")`。
- **主题**：禁止硬编码颜色类（`bg-blue-*` 等）；时间戳等用 `text-muted-foreground`、图标按钮 hover 用 `hover:bg-primary-subtle hover:text-primary`。
- **命名**：文件名 kebab-case；变量/函数 camelCase；组件 PascalCase。
- **代码质量**：函数不超过 20 行、只做一件事；所有异常必须处理；重复 2 次及以上抽取函数。
- **风格**：Prettier 双引号、分号、tabWidth=2、printWidth=80。
- **测试**：Vitest，放 `tests/ai/`，命名 `*.test.ts(x)`；前端组件测试参考 `tests/ai/markdown-view.test.ts` / `tests/ai/task-form.test.ts` 的既有模式。
- **PRD 关键口径**：
  - 时间格式：当天 `HH:mm`（分钟补零）；同年非当天 zh `9月6日 14:30`（月日不补零）/ en `Sep 6, 14:30`；跨年 zh `2025/1/1 10:00` / en `Jan 1, 2025, 10:00`。
  - 编辑重发 = 更新原 user 消息内容（保留原 createdAt）+ 删除其后全部消息 + 重跑流（与 regenerate 的截断语义一致）。
  - 生成中（会话 isStreaming）：user 消息 hover 操作栏隐藏编辑与复制按钮，时间戳正常显示。
  - 编辑态：轻量专用编辑条（不复用 ChatInput 的联想/token 能力）；提示文案「编辑后将从此处重新开始对话，已有产物不会被删除」；Enter 发送 / Shift+Enter 换行 / Esc 取消；空内容禁用发送。

## Task 1: 后端 editAndResend IPC

文件：`electron/domains/ai/chat/chat.service.ts`、`tests/ai/chat.service.test.ts`

1. 从 `regenerate`（chat.service.ts:962）中抽取私有方法（如 `truncateAfterAndStream`）：入参 sessionId + 保留边界 index + sender；职责 = 删除边界之后全部消息 + `compactedUpToId` 失效时 `updateSummary(sessionId, null, null)` + `streamAndPersist(sessionId, abort, sender)`。`regenerate` 改为调用它，行为不变。
2. 新增 `async editAndResend(sessionId: number, messageId: number, content: string, sender?: WebContents)`：
   - 首句并发检查 `this.aborts.has(sessionId)` → `CONCURRENT_REQUEST`（与 send/regenerate 同模式，AbortController 在首个 await 前注册）。
   - 查 session，不存在 → `SESSION_NOT_FOUND`。
   - `prisma.message.findMany({ where: { sessionId }, orderBy: { createdAt: "asc" } })` 定位 `messageId`；不存在或 `role !== "user"` → `MESSAGE_NOT_FOUND`。
   - `prisma.message.update` 更新该消息 `blocks = serializeBlocks([{ type: "text", text: content }])`（保留原 createdAt）。
   - 调用抽取的截断方法重跑流。
   - catch 中 `this.aborts.delete(sessionId)` 后 rethrow（幂等空操作语义与 send 一致）。
3. 注册 IPC：`ipcMain.handle("chat:editAndResend", (event, sessionId, messageId, content) => this.editAndResend(sessionId, messageId, content, event.sender))`，放在现有 `chat:regenerate` handler 旁（chat.service.ts:669 附近）。
4. 测试（扩展 `tests/ai/chat.service.test.ts`，按需增强 prismaStub 增加 `message.update`/`message.deleteMany`）：更新内容正确、尾部消息被删、非 user 消息报 `MESSAGE_NOT_FOUND`、消息不存在报 `MESSAGE_NOT_FOUND`、并发（aborts 已有该 session）报 `CONCURRENT_REQUEST`。

## Task 2: 前端 API/hook + EditBar 编辑态

文件：`src-react/domains/ai/api/chat.api.ts`、`src-react/domains/ai/chat/hooks/use-chat-send.ts`、新增 `src-react/domains/ai/chat/components/EditBar.tsx`、`src-react/domains/ai/chat/views/ChatView.tsx`、`src-react/i18n/locales/zh-CN/chat.json`、`src-react/i18n/locales/en-US/chat.json`、新增 `tests/ai/edit-bar.test.tsx`

1. `ChatApi.editAndResend(sessionId, messageId, content)`：`invoke<void>("chat:editAndResend", sessionId, messageId, content)`。
2. `useChatSend` 增加 `editResend(messageId, content)`：与 `regenerate` 同模式（startStream → invoke → catch 中 finishStream + invalidate + rethrow）。
3. 新组件 `EditBar`（默认导出，React 组件）：props `{ initialText: string; onCancel: () => void; onSubmit: (text: string) => void }`。卡片样式与 ChatInput 一致（`rounded-xl border border-border/50 bg-card px-3 py-2 shadow-sm`）；顶部提示行（Info 图标 + `text-xs text-muted-foreground` 文案 `chat:message.editHint`）；textarea 受控回填 `initialText`，挂载后 focus 且光标置文末；底部右侧 取消（复用 `common:cancel`）与 发送（`chat:message.resend`，`content.trim()` 为空时 disabled）按钮；键盘 Enter（非 IME 组合、非 Shift）提交、Shift+Enter 换行、Escape 取消。
4. `ChatView.tsx` ChatPane：新增 state `editing: { messageId: number; text: string } | null`；`MessageList` 下方输入区渲染：editing 非空时 ChatInput 加 `hidden` 类保持挂载（保草稿）并渲染 EditBar 于其上方；EditBar onSubmit → `setEditing(null)` 后调用 `editResend(messageId, text)`（错误 toast + mapIpcError，与 handleRegenerate 同模式）；onCancel → `setEditing(null)`。回调命名 camelCase。
5. i18n：两个 locale 的 `chat` namespace 同步加 `message.editHint`、`message.resend`（结构嵌套在既有 `message` 对象下，注意不得与顶层 key 重名）。
6. 测试 `tests/ai/edit-bar.test.tsx`：回填内容与初始 focus、空内容发送禁用、Esc 触发 onCancel、Enter（非 Shift）触发 onSubmit 且携带文本、Shift+Enter 不触发提交。

## Task 3: 时间格式化 + user 消息 hover 操作栏

文件：新增 `src-react/domains/ai/chat/lib/message-time.ts`、`src-react/domains/ai/chat/components/MessageItem.tsx`、`src-react/domains/ai/chat/components/MessageList.tsx`、`src-react/domains/ai/chat/views/ChatView.tsx`（接线 onEdit）、两个 locale 的 `chat.json`（`message.edit`）、新增 `tests/ai/message-time.test.ts`

1. `message-time.ts` 导出 `formatMessageTime(iso: string, locale: string): string`，基于 `Intl.DateTimeFormat`：与当前时间（`new Date()`）同日 → `HH:mm`（hour/minute 均 2 位数字）；同年不同日 → zh-CN `9月6日 14:30` / en-US `Sep 6, 14:30`（月日不补零）；不同年 → zh-CN `2025/1/1 10:00` / en-US `Jan 1, 2025, 10:00`。无效日期输入返回空串。纯函数、可单测（当前时间经 `vi.useFakeTimers` 或注入 now 参数控制——优先注入 `now?: Date` 参数以便测试）。
2. `MessageItem.tsx` user 分支重构：外层改 `group flex flex-col items-end`；气泡保持现有样式与搜索高亮逻辑不变；气泡下方新增操作栏（`opacity-0 group-hover:opacity-100 transition-opacity`，`onMouseEnter` 时 setState 记录 hover 触发重渲染以重算时间——跨天显示正确）：左 `text-xs text-muted-foreground` 时间戳（`formatMessageTime(message.createdAt, i18n.language)`）、中 编辑按钮（Pencil 图标，存在 `onEdit` 时渲染）、右 复制按钮（Copy 图标，逻辑复用 assistant 分支 handleCopy 的剪贴板写入 + copied 对勾反馈 + `common:copied` toast；`hideActions` 为 true 时不渲染编辑与复制）。按钮尺寸/hover 样式与 assistant 操作行一致（`h-7 w-7 p-0 text-muted-foreground hover:bg-primary-subtle hover:text-primary`）。
3. `MessageItemProps` 新增 `onEdit?: (messageId: number) => void`、`hideActions?: boolean`。
4. `MessageList.tsx`：props 增加 `onEdit?: (messageId: number) => void` 并透传给 MessageItem；`onEdit={isStreaming ? undefined : onEdit}`（与 onRegenerate 同模式）、`hideActions={isStreaming}`；同时把现有 `onRegenerate` 透传行的模式保持一致。
5. `ChatView.tsx` ChatPane：`MessageList` 传 `onEdit={handleEdit}`，`handleEdit(message)` → 从 messages 缓存（`queryClient.getQueryData(["messages", session.id])` 或现有数据流）取该消息 text 块拼接文本 → `setEditing({ messageId, text })`。
6. i18n：`chat` namespace 加 `message.edit`（zh「编辑」/ en "Edit"）。
7. 测试 `tests/ai/message-time.test.ts`：当天（分钟补零如 `09:05`）、同年非当天（月日不补零）、跨年、无效输入；zh/en 双 locale 断言。

## 验收口径（对齐 PRD）

- 悬停用户消息 → 操作栏浮现（时间戳/编辑/复制）；生成中只显示时间戳。
- 复制 → 剪贴板写入纯文本 + 对勾/Toast 反馈。
- 编辑 → 底部输入区变为 EditBar（原输入框隐藏但保留草稿）；发送后原消息更新、其后消息被替换为新生成回复；取消无副作用。
- 时间显示跨天自动切换正确（hover 即重算）。
- `npm run test`、`npm run lint`、`npm run typecheck` 全绿。

## Task 4: 编辑框原位化（用户后续变更，2026-09-08 批准）

设计变更：编辑框从底部输入区移到被编辑消息的原位；底部聊天输入框恢复常驻。

1. `MessageItem.tsx`：props 新增 `isEditing?: boolean` 与 `editInitialText?: string`；user 分支当 `isEditing && !hideActions` 时以 `<EditBar>` 原位替换气泡（外层 items-end 列内，宽度 `w-full max-w-[75%]`），编辑态不渲染 hover 操作栏；`hideActions`（会话 sending）期间恢复普通气泡显示（沿用防呆，流结束自动回来）。assistant 分支不变。
2. `MessageList.tsx`：props 新增 `editing?: { messageId: number; text: string } | null`，向各 MessageItem 透传 `isEditing={editing?.messageId === message.id}`、`editInitialText={editing?.text}`。
3. `ChatView.tsx`：移除底部 EditBar 渲染与 ChatInput 的 `hidden` 门控（ChatInput 常驻不卸载）；`MessageList` 传 `editing`；`handleEditSubmit`/`handleEditCancel` 不变；防呆新增：底部 `handleSend` 成功发起后 `setEditing(null)`（避免编辑重发静默截断刚发的新消息）。
4. `EditBar.tsx`：仅调整外层宽度/布局以适配原位（组件 props 与行为不变）。
5. 测试：更新受影响断言；`npm run test` 全量 + `typecheck` + `lint` 全绿。

验收：点 user 消息编辑 → 该消息气泡原位变编辑框（含提示文案与取消/发送），底部输入框始终可用；编辑中发送新消息自动退出编辑态；其余交互与 Task 1-3 行为一致。

## Task 5: AI 回复消息时间戳（用户新 PRD，2026-09-08 批准）

1. `MessageItem.tsx` assistant 分支：操作行（复制/重新生成/模型名）最右追加时间戳——与模型标识同 flex 行（items-center 基线对齐）、`ml-2 text-xs text-muted-foreground select-none pointer-events-none`、`opacity-0 group-hover:opacity-100 transition-opacity duration-150`（外层已有 group；操作行本身常显行为不变）。无模型标识时时间戳仍在行尾显示。
2. 跨天重算与 user 消息同机制：外层 `onMouseEnter`/`onMouseLeave` setState，hovered 且非 streaming 时以 `formatMessageTime(message.createdAt, i18n.language)` 计算（复用既有纯函数与测试，格式规则与用户消息完全一致）。
3. `streaming`（打字机阶段）不渲染时间戳；失败/空内容消息照常显示（落库 createdAt）；每条独立计算。
4. DRY：user 与 assistant 时间戳 span 抽取共用组件（如 `HoverTimestamp`，放 MessageItem.tsx 内部或独立文件，按体量定）。
5. 移动端长按条款不实现（桌面应用）。
6. 测试：新增 assistant 时间戳组件测试（hover 显示 / streaming 不显示 / 复用 HoverTimestamp 一致性）；`npm run test` 全量 + `typecheck` + `lint` 全绿。

验收（对齐 PRD）：悬浮 AI 回复消息时模型标识右侧显示时间戳且格式与用户消息一致；移出淡出无残留；流式生成中不显示；样式与用户消息视觉统一。

## Task 6: 编辑重发乐观更新（用户反馈，2026-09-08 批准）

问题：后端 editAndResend 已删尾部消息，但前端 `["messages", sessionId]` 缓存流结束前不刷新——流式期间仍显示旧历史消息、live 气泡渲染在列表最底部。

1. 新增纯函数 `truncateMessagesForEdit(messages: MessageRecord[], messageId: number, text: string): MessageRecord[]`（放 `src-react/domains/ai/chat/lib/`，文件名 kebab-case）：定位 messageId（不存在则原样返回），保留该消息及之前，其后移除；该消息 blocks 乐观更新为 `serializeBlocks([{ type: "text", text }])`（复用 `../model/blocks`）；不修改传入数组（返回新数组）。
2. `ChatView.tsx` `handleEditSubmit`：调 `editResend` 前以该函数 `queryClient.setQueryData(["messages", session.id], ...)` 乐观更新；catch 中 `invalidateQueries({ queryKey: ["messages", session.id] })` 恢复真值（toast 兜底已有）。
3. 单测：纯函数（定位/裁剪/改写/不存在时原样/不可变性）；ChatView 接线（成本可控则组件级，否则以现有模式说明）。
4. `npm run test` 全量 + `typecheck` + `lint` 全绿。

验收：编辑提交后该消息立即显示新文本、其后历史立即消失、live 气泡紧跟其后生成；提交失败时列表恢复服务器真值。范围不扩到 regenerate。

## Task 7: 新建任务按钮样式统一（用户需求，2026-09-08 批准）

1. `src-react/domains/ai/layout/components/AiSidebar.tsx`：「新建任务」按钮（当前 shadcn `Button size="sm"` + `Plus` 图标 + `hover:bg-primary hover:text-primary-foreground`）改为复用 `SidebarNavButton` 渲染——与「专家/自动化/资料库」入口同款样式（h-8/gap-2.5/text-muted-foreground/hover:bg-primary-subtle hover:text-primary/折叠态 Tooltip）；图标 `Plus` → `MessageSquare`（lucide，size 16）；label（`chat:sidebar.newTask`）与 onClick（handleCreateSession）不变。
2. `npm run test` 全量 + `typecheck` + `lint` 全绿。

验收：新建任务按钮与自动化等入口视觉一致，图标为聊天气泡。

## Task 8: 侧边栏入口去掉 Tooltip（用户需求，2026-09-08 批准）

1. `src-react/domains/ai/layout/components/AiSidebar.tsx` 的 `SidebarNavButton`：移除 `TooltipProvider/Tooltip/TooltipTrigger` 包裹与折叠态 `TooltipContent`，直接渲染现有 div；`collapsed` prop 若因此不再被组件使用则从 props 与四处调用点一并移除（展开态本无 Tooltip，行为不变；折叠态仅剩图标）；4 个 Tooltip 导入随删；组件注释同步更新。
2. `npm run test` 全量 + `typecheck` + `lint` 全绿。

验收：新建任务/专家/自动化/资料库四个入口 hover 不再弹提示。

## Task 9: 用户菜单新增设置/记忆与进化入口（用户需求，2026-09-08 批准）

1. `src-react/components/layout/UserMenu.tsx`：在「修改密码」后分隔线与「帮助」Sub 之间插入两个 `DropdownMenuItem`（顺序：设置、记忆与进化）：设置 = lucide `Settings` 图标；记忆与进化 = lucide `Lightbulb` 图标；样式与现有项一致（size 14 mr-2 + cursor-pointer）；onClick 空占位 + 中文注释标记功能待接（点击仅收起菜单，无动作）。
2. i18n：`layout` namespace 双 locale 同步加 `userMenu.settings`（zh「设置」/ en "Settings"）、`userMenu.memoryEvolution`（zh「记忆与进化」/ en "Memory & Evolution"）；先检查既有 key 避免重名（注意顶层与嵌套不重名规则）。
3. `npm run test` 全量 + `typecheck` + `lint` 全绿。

验收：用户下拉菜单在帮助上方显示两个新入口，视觉与其他菜单项一致，点击无动作。

## Task 10-12: 设置面板 - 通用模块（PRD 2026-09-08，用户批准设计并授权自主推进）

设计裁决（controller）：
- 左侧其他分类（个人主页/外观/快捷键）置灰占位，PRD 仅定义通用
- 渲染层偏好（语言/字体）走 localStorage（同语言切换先例 tianshu-locale）；系统行为（自启/锁屏/代理/路径/通知/技能开关）走后端 option 表（type="app"）
- 语言接既有 i18n；字体 = html font-size 三档 14/16/18px（rem 基准缩放）
- 代理：session.setProxy + 主进程 undici dispatcher 尽力接（过高成本记待接）
- 工作空间默认路径仅存配置（消费流程不存在，记待接）；音效仅 无/默认两项（资源待定，默认=shell.beep）
- 新 settings namespace；新增 electron/domains/settings/ 域 + src-react/domains/settings/ 域

### Task 10: 后端 settings 服务 + IPC + 单测
1. 新 `electron/domains/settings/settings.service.ts`（参照 chat.service 的 ipcMain.handle 注册模式；Application.ts 照 OptionRepository 实例化方式接线）：
   - `settings:getAll` → option 表 type="app" 全部 {name,value}（可复用/扩展 option.repo）
   - `settings:set(name, value)` → upsert（updateMany count=0 则 create，type="app"）
   - `settings:getAutoLaunch`/`settings:setAutoLaunch(enabled)` → app.getLoginItemSettings/setLoginItemSettings
   - `settings:setKeepAwake(enabled)`/get → powerSaveBlocker（prevent-display-sleep）起停与状态
   - `settings:setProxy(mode, host?, port?)` → 持久化 option + session.defaultSession.setProxy（direct/system/proxy 映射）+ 尽力接主进程 undici 全局 dispatcher（探查 provider 网络层；成本过高则只做 session 层并报告）
   - `settings:storageInfo` → { userDataPath, cacheBytes, diskTotal, diskFree }（目录递归大小 + statfs；计算逻辑抽纯函数）
   - `settings:pickDirectory` → dialog.showOpenDialog({properties:["openDirectory"]}) → string|null
   - `settings:openDirectory(path)` → shell.openPath
   - `settings:beep` → shell.beep
2. skill 开关联动：探查 skill-installer/skill-sync 的安装/更新路径，读 option 开关（autoInstallTrustedSkills/autoUpdateSkills，默认 false）；能接则接（安全检测通过后自动安装 / 未被用户编辑过的技能自动更新），接不上仅存配置并在报告说明
3. 前端 `src-react/domains/ai/.../settings.api.ts` 占位（或 Task 11 建）——本任务只后端 + IPCChannel 类型登记（src-react/lib/ipc.ts）
4. 单测（tests/ai/settings.service.test.ts，参照 chat.service.test mock 模式）：upsert 语义、autoLaunch 读写映射、keepAwake 起停幂等、proxy 模式映射纯函数、storageInfo 计算（临时目录）、skill 开关默认值
5. `npm run test`/`typecheck`/`lint` 全绿

### Task 11: SettingsDialog 骨架 + 常规组 + settings namespace
1. i18n：新增 settings namespace（zh-CN/en-US JSON + src-react/i18n/index.ts 注册 ns 数组与 resources）
2. 新 `src-react/domains/settings/`：`api/settings.api.ts`（invoke 封装全部 Task 10 通道）+ `components/SettingsDialog.tsx`
3. SettingsDialog：Dialog 约 max-w-4xl × 70vh；左栏固定宽导航（通用=当前高亮；个人主页/外观/快捷键 disabled + 敬请期待提示）；右栏滚动区四分组标题（常规/权限/存储/通知），本任务实现常规组，其余三组渲染分组容器（内容 Task 12 填充）
4. 常规组：语言下拉（接 i18n.changeLanguage + localStorage `tianshu-locale`，参照 LanguageSelector 逻辑）；字体大小三档滑条（小/默认/大刻度；localStorage `tianshu-font-scale`，html fontSize 14/16/18 即时生效 + 启动恢复）
5. UserMenu「设置」onClick 接线打开 SettingsDialog（移除 Task 9 占位注释）
6. 全部文案走 t()；主题变量样式；`npm run test`/`typecheck`/`lint` 全绿

### Task 12: 权限/存储/通知组 + 联动 + 组件测试
1. 权限组：锁屏运行开关（setKeepAwake）、开机自启开关（getAutoLaunch/setAutoLaunch）、网络代理三态下拉（自定义展开 host/port 输入，setProxy）、自动安装可信技能/技能自动更新开关（settings:set + getAll 初始值）
2. 存储组：storageInfo（Loading 态 + 三段进度条：缓存 primary/磁盘已用 muted/可用更浅 + 已用/总量数值 + userData 路径小字 + 说明文案）、[打开目录]（openDirectory）、默认工作空间路径（getAll 初始 + [更改] pickDirectory + settings:set 持久化 + 说明文案）
3. 通知组：桌面通知（Notification.permission：未授权→[去授权]跳系统设置 openExternal；已授权→[测试通知] new Notification 示例）、客户端通知开关（settings:set）、提示音下拉（无/默认，选中默认时 settings:beep 试听）
4. 开关即时视觉反馈；耗时操作 Loading；修改实时保存
5. 组件测试（tests/ai/settings-dialog.test.tsx）：开关联动初始值/保存调用、代理自定义表单显隐、通知授权状态分支；`npm run test`/`typecheck`/`lint` 全绿

## Task 13: 测试通知改走主进程 + 可见反馈（bug 修复，2026-09-09）

根因（systematic-debugging）：macOS UNNotification API 下未签名应用（dev 模式）通知被系统静默丢弃；渲染层 Notification.permission 谎报 granted，点击后无任何反馈。

1. 后端 `electron/domains/app-settings/settings.service.ts`：新增 `settings:testNotification(title, body)` IPC——`Notification.isSupported()` false 抛 `TEST_NOTIFICATION_UNSUPPORTED`；`new Notification({ title, body }).show()`（Electron 主进程模块，注意与渲染层 DOM Notification 区分导入）。
2. `src-react/lib/ipc.ts` 登记 + `SettingsApi.testNotification(title, body)` 封装。
3. `NotificationsGroup.tsx`：点击改走 IPC；成功 toast.info（i18n：测试通知已发送 + 「若未显示，请检查系统设置中的通知权限」提示）；失败 toast.error（mapIpcError 或既有 error key 风格）。`desktop-notification.ts` 的 sendTestNotification 移除或改为 IPC 封装。
4. i18n 双 locale 新 key。
5. 测试：后端通道单测（isSupported false 抛错码 / 构造参数与 show 调用）+ 组件测试更新（断言 IPC 调用与成功/失败 toast）。
6. `npm run test` 全量 + `typecheck` + `lint` 全绿。

验收：点击「测试通知」必有反馈（成功提示或错误提示）；生产打包后通知可显示；dev 下未弹时用户被明确引导检查系统权限。

## Task 14-16: 设置面板 - 快捷键模块（PRD 2026-09-09，用户批准设计含裁决表）

设计裁决：语音 ⌘D 不做（无功能）；17 条 = 可自定义 11（设置⌘,/搜索⌘F/发送Enter/换行⇧Enter/新建⌘N/停止Esc/上一任务⌘[/下一任务⌘]/侧栏⌘B/产物面板⇧⌘B/全屏^⌘F）+ 固定 6（唤起窗口⇧⌥W/字号⌘+/⌘−/⌘0/@//斜杠/）；字号接 font-scale 三档；分发两类（AiLayout 全局 keydown + ChatInput/EditBar 读绑定）+ 主进程 globalShortcut 唤起窗口；持久化 localStorage `tianshu-keybindings`；有效性 = Enter/Esc/@// 或带 cmd/ctrl/alt 修饰；冲突 = 确认替换；⌘, 系统级组合警告但允许；lib 放 src-react/lib/keybindings/（无域依赖）。

### Task 14: 快捷键基建 lib + 单测
1. 新 `src-react/lib/keybindings/`（kebab-case 文件）：KeyBinding 数据模型（modifiers: "cmd"|"shift"|"ctrl"|"alt" 归一——event.metaKey(mac)/ctrlKey(win) 统一为 cmd；key 归一小写/命名键）、17 条 CommandDef 定义表（id/defaultBinding/customizable）、event→binding 解析、序列化（"cmd+shift+b"）与反解析、平台符号渲染（darwin ⌘⇧^⌥ / win Ctrl+Shift+Alt）、localStorage 读写（仅存用户改动，"unbound" 哨兵）、合成视图（默认+覆盖）、有效性检测（主键 Enter/Esc/@// 或含 cmd/ctrl/alt 修饰；裸单字符拒绝）、冲突查找（findConflict）、恢复默认清空。
2. 单测 tests/（位置随项目模式）：解析/序列化往返、平台符号、有效性矩阵、冲突查找、localStorage 哨兵语义、合成视图覆盖优先。
3. npm run test/typecheck/lint 全绿。

### Task 15: 分发执行与功能接线 + 单测
1. AiLayout 挂 window keydown 分发器（读合成绑定；布局级命令即使输入框聚焦也 preventDefault 执行；消费者优先：组件内 Esc（联想面板/编辑态）先于停止生成）。
2. 动作接线：设置面板打开（SettingsDialog open 状态迁移 Zustand，UserMenu 与快捷键共用）、会话内搜索打开、新建对话（提升 AiSidebar handleCreateSession 逻辑）、停止生成（当前会话 ChatApi.stop）、上一/下一任务（会话列表切换 ?session=）、侧栏切换、产物面板切换、全屏（新 IPC win.setFullScreen 切换）、字号 ⌘+/−/0（font-scale 递进/重置）。
3. ChatInput/EditBar：发送/换行改读绑定（默认行为不变）。
4. 主进程：globalShortcut Shift+Alt+W 唤起/隐藏主窗口（will-quit 注销）+ IPCChannel 登记。
5. 单测：分发器匹配矩阵（修饰键/主键/输入框聚焦场景）、各动作调用、globalShortcut 注册/注销。
6. npm run test/typecheck/lint 全绿。

### Task 16: 设置面板快捷键页 UI + i18n + 组件测试
1. SettingsDialog 左导航「快捷键」激活（去敬请期待）；右内容：搜索框（放大镜/占位/×与 Esc 清空/实时过滤命令列/无结果占位）+「全部恢复默认」（二次确认 AlertDialog）+ 三列表格（命令左对齐/绑定胶囊浅色高亮居中/操作列：可自定义=垃圾桶、固定=—、删除后=「设置」按钮）。
2. 编辑交互：点击绑定胶囊进入监听模式（该行显示「请按下新的快捷键组合」，局部 capture keydown）→ 按下即绑定；冲突弹确认（替换/取消）；无效组合 toast 提示需修饰键；⌘, 等系统级组合警告提示但允许；删除确认弹窗 → 显示「未绑定」。
3. i18n settings namespace 双 locale（shortcut.* 组）；禁止硬编码。
4. 组件测试：搜索过滤/无结果、监听模式捕获与生效、冲突弹窗分支、删除后重绑按钮、恢复默认刷新。
5. npm run test/typecheck/lint 全绿。

验收（对齐 PRD）：表格 17 条正确展示；搜索/恢复默认/修改/删除/冲突/无效/系统警告全链路；自定义重启恢复；恢复默认不影响固定绑定。
