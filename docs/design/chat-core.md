# 聊天核心链路技术方案

> 调研基线：main @ 995bf652（2026-11-05）。文中路径均相对仓库根；桌面端代码位于
> `apps/tianshu-desktop/`，服务端 `apps/tianshu-server/`，移动端 `apps/tianshu-mobile/`，
> 共享包 `packages/tianshu-protocol`、`packages/tianshu-core`。所有函数名/字段名/常量
> 均出自当前代码，未实现能力如实标注。

## 1. 总览：一次提问的完整生命周期

以桌面端一次带图片、带工具的提问为例，链路自渲染进程到模型再回到落库，共六步：

1. **发送**（渲染进程）：`src-react/domains/ai/chat/hooks/use-chat-send.ts` 的 `send()`
   先 `startStream(sessionId)` 置流式态，`appendOptimisticMessage()` 本地写入负 id 占位
   （`lib/optimistic-user-message.ts`），再 `invoke("chat:send", params)`。`ChatSendParams`
   定义在 `packages/tianshu-protocol/src/chat-contract.ts`：`{ sessionId, content, modelId?,
   overrides?, images?, skillRefs?, contentRefs? }`。
2. **落库用户消息**（主进程）：`electron/domains/ai/chat/chat.service.ts`（2645 行的
   `ChatService`）`send()` 首行做并发检查（`aborts` Map 命中即抛 `CONCURRENT_REQUEST`，
   AbortController 在首个 await 前注册消除 TOCTOU），随后可选触发自动压缩
   `autoCompactIfBudgeted()`，进入 `sendRound()`：会话校验 → 请求级模型写回
   （`sessionRepo.setSessionModel`）→ 图片附件转块 → `appendMessage` 落库 user 消息 →
   `autotitleIfDefault`（首条消息截前 20 字作初始标题）。
3. **上下文组装**：`assembleContext()`（chat.service.ts L2084）解析生效模型
   （`getEffectiveModelId` 三级链：`session.currentModelId` > `workspace.defaultModelId`
   > `firstEnabledLlmModelId` 兜底）、合并采样参数（`mergeParams` 三级覆盖：
   model 默认 < assistant < 单次 overrides）、按压缩态过滤历史
   （`id > compactedUpToId`）、最后一条 user 消息注入时间行（`withTimeBlock`）、
   组装 system（个性化 `buildPersonalizedSystem` + 模式 `buildModeSystem`（ask/plan/agent）
   + 项目上下文 `buildProjectSystemBase` + 专家团 `buildTeamLeadSystem` + 场景段
   `buildScenarioSystem` + 压缩摘要段 + 工作流挂载元说明）。
4. **流式执行**：`streamAndPersist()`（L1941）经引擎接缝 `agentRunner.run()` 驱动
   `runChatStream`（实现单源在 `packages/tianshu-core/src/run-chat-stream.ts`）——
   langgraph `createReactAgent` + `streamEvents(v2)` 多步工具循环，事件经
   `consumeAgentStream`（`packages/tianshu-core/src/agent-chunk-emitter.ts`）归一为
   `onChunk` 协议回调。
5. **流式回传**：每个 chunk 双路扇出——`ChatService.emit()` 先调
   `emitChatChunk()`（`electron/domains/server-face/chat-tap.ts`，进程级 EventEmitter
   tap 点，供被控面 SSE/relay 无头订阅），再向全部 `BrowserWindow.webContents`
   推 `chat:stream:{sessionId}`（按通道自滤；审批横幅卡死修复后改全窗广播，
   已销毁窗口跳过）。渲染层 `use-chat-send.ts` 消费 chunk：text/reasoning delta 经
   `StreamBuffer`（`store/stream-buffer.ts`，30ms 节流）写 zustand `chat.store.ts`，
   tool-update/approval-request 经 `updateTool()` 合入 `ToolStreamMap`。
6. **持久化收尾**：流结束后 assistant 消息整体落库（中断也保留已生成部分），
   usage 块提取后 `recordLlmCall` 写 `llmCallEvent` 监控表，error 时推 error chunk，
   否则推 finish + fire-and-forget 的 AI 起标题 `generateTitleIfFirstExchange()`
   （首轮判定 `visible.length === 2`，成功推 `title-updated` chunk 刷新侧栏）；
   finally 清 aborts/snapshots 注册并作废未决审批（`approvals.voidAll` +
   `confirmForms.respond(cancel)`）。

### 1.1 IPC 通道面（主进程 handleUser 注册，v12 多用户隔离）

`ChatService.registerHandlers()`（chat.service.ts L484）注册的通道全集：

| 通道 | 方法 | 说明 |
|---|---|---|
| `chat:send` | `send()` | 发送（含图片/技能引用/文件引用/参数覆盖） |
| `chat:compact` | `compact()` | 手动 /compact 压缩 |
| `chat:regenerate` | `regenerate()` | 任意位置重生成 |
| `chat:editAndResend` | `editAndResend()` | 编辑重发 |
| `chat:stop` / `chat:status` | `stop()` / `status()` | 中止 / 快照查询 |
| `chat:usage` | `getUsageBreakdown()` | 五类 token 拆解（输入框环形指示器） |
| `chat:polish` | `polishText()` | 落地页润色（professional/concise/translate-en 三风格，一次性不落库） |
| `chat:handoverSummary` | `handoverSummary()` | 转办交接摘要（批 12，`handover-summary.ts`，确认后另存待办） |
| `agent:approve` | `approvals.respond()` | 审批决议（IPC 口） |
| `agent:confirmRespond` | `confirmForms.respond()` | 确认卡决议（confirm_form 工具挂起） |
| `permission:get/set` | `permissions.get/set()` | 会话权限模式 default（逐次审批）/full（放行）——`PermissionStore` 内存态 |
| `permission:rememberTool` / `listAllowedTools` / `forgetTool` | — | 工作空间级工具记忆（toolPermission 表，参照 Claude Code allowed-tools） |
| `permission:listFullGrants` / `revokeAllFull` | — | SP6 系统授权卡：full 会话总览与一键收回 |
| `permission:listRemembered` / `revokeRemembered` / `revokeAllRemembered` | — | 工具记忆管理（撤销后回逐次审批流） |

会话/工作空间 CRUD 通道（`session:*`/`workspace:*`）由 `SessionRepository` 构造器另行
注册。业务错误 message 只传错误码（Electron invoke 拒绝仅保留 message），渲染端
`mapIpcError`（`chat/lib/error-message.ts`）映射 i18n。

## 2. 数据模型（session / message / artifact）

Schema 定义在 `apps/tianshu-desktop/prisma/schema.prisma`（server 仓为同构副本，
31 张表，业务表带 userId 隔离）：

- **session**（L115）：`workspaceId`、`assistantId?`、`currentModelId?`（会话记住上次
  选模）、`title`（默认「新会话」）、`mode`（agent/ask/plan）、`scenario`
  （daily/coding/design）、`pinnedAt?`/`archivedAt?`、`projectId?`、`summary?` +
  `compactedUpToId?`（/compact 压缩态二元组：摘要文本 + 压缩点消息 id）、
  `lastMessageAt`、`userId`、`planItemId?`、`lastReadMessageId?`（未读角标游标）、
  `appId?`（应用绑定，工作流工具面收窄）。
- **message**（L144）：`sessionId`、`role`（user/assistant/system）、`blocks`
  （**JSON 文本列**，`MessageBlock[]` 序列化，见 §3.1）、`modelId?`、`assistantId?`、
  `error?`（错误轮次保留行但不回喂模型）、`durationMs?`、`createdAt`。
  注意没有 token 计数列——usage 直接内嵌在 blocks 里的 `usage` 块。
- **artifact**（L302）：`userId + workspaceId + relPath` 唯一键，`sessionId` 记录
  最近一次写入来源——聊天 write 工具产物的登记表（见 §3.6）。
- **artifactFavorite**（L436）：`workspaceId + relPath` 唯一键，`userId`，收藏标记。

仓储层 `electron/domains/ai/chat/session.repo.ts`（1414 行 `SessionRepository`）：
`listSessions/listAllSessionsSummarized/querySessions`（会话列表，`enrichSummaries` 批量
补末条消息摘要——纯函数 `summarizeLastMessage` 在 `packages/tianshu-core/src/last-message.ts`，
kind 优先级 text > image > tool > empty，摘要截 80 字符）、`listMessages`/`searchMessages`
（历史渲染与全文检索）、`appendMessage`（落库即刷 `lastMessageAt` 并 fire-and-forget
`recordArtifacts`）、`updateSummary`、`pinSession/archiveSession`、`markSessionRead` 等。

## 3. 核心技术方案

### 3.1 blocks 协议（消息内容模型）

块类型单源在 `packages/tianshu-protocol/src/chat-contract.ts`，`MessageBlock` 是七种块的
union（对齐 Vercel AI SDK UIMessage 形态的设计取向）：

| 块 | 字段 | 说明 |
|---|---|---|
| `TextBlock` | `text` | 正文 |
| `ThinkingBlock` | `text` | 深度思考流（OpenAI 兼容系 `reasoning_content`） |
| `UsageBlock` | `input/output` | 每轮 token 记账（落库内嵌，监控从此提取） |
| `ToolCallBlock` | `toolCallId/toolName/args/state/output?` | 工具调用；state 六值 `ready/awaiting-approval/running/done/denied/error`，落库恒终态 |
| `ImageBlock` | `imagePath/mime/name?` | 多模态图片，`imagePath` 相对数据根（§3.5） |
| `SkillRefBlock` | `name` | 技能引用——库内只存名，组装侧 `loadSkill` 展开全文 |
| `FileRefBlock` | `path/content` | 文件内容引用——内容随块落库，零重读零 TOCTOU |

序列化/解析/回喂转换三函数在 `packages/tianshu-core/src/blocks.ts`：

- `serializeBlocks()`：直接 `JSON.stringify`；
- `parseBlocks()`：按 `isValidBlock` 逐块校验形状，畸形块丢弃、坏 JSON 返回空数组
  （历史数据容错）；
- `blocksToModelMessages()`：历史回喂转换（async）——text/skill_ref/file_ref 归并为
  content；image 经注入的 `loadImage` 读盘转 LangChain `image_url` part 且**前置于文本**
  （Qwen-VL 系惯例）；tool_call 转 `AIMessage.tool_calls` + 紧随一条 `ToolMessage`
  （续聊时模型可见自己上轮工具使用）；thinking/usage 不回喂。读取器以依赖注入
  （`ImageDataUrlLoader`/`SkillBodyLoader`）保持包纯 Node 可测。

桌面原位 `electron/domains/ai/chat/blocks.ts` 已改 re-export 兼容（老 import 链不变），
双份基线由 `npm run check:drift` 守护。

### 3.2 runChatStream 工具循环（引擎核心）

`packages/tianshu-core/src/run-chat-stream.ts`，T3-3 换引擎后为 langgraph 实现：

- **执行器**：`createReactAgent({ llm, tools: new AliasToolNode(tools), prompt: system })`
  + `streamEvents({ messages }, { version: "v2", recursionLimit: maxSteps * 2, signal })`。
  步数保险丝 `DEFAULT_MAX_STEPS = 50`；`recursionLimit = 2n`（一步 agent = 模型 + 工具
  两个 super-step，langgraph 1.5.0 实测口径）。
- **工具装配**：core 包对工具定义近乎不透明（最小结构 `ToolDefinitionLike{name,
  description}`），宿主经 `options.toTools` 注入适配器——桌面侧由 chat.service 薄包装
  `runChatStream()` 固定注入 `toLangChainTools`
  （`electron/domains/ai/orchestration/langchain-tool-adapter.ts`，串起
  `agent/tool-gate.ts` 的 runToolCall 安全门/两级审批/审计链）。⚠ 未注入 toTools 且
  agent+toolDefinitions 在场时**静默纯聊**，无错误信号——消费方必须注入。
- **工具选择与并行**：工具集由 `collectToolDefinitions()`（chat.service.ts）按会话装配
  ——`read_skill` 与 `mcp__*` 常驻（不依赖工作空间），文件四件套等需绑定目录，
  plan_* 仅项目会话，workflow 组经 `tool-gate` 场景门控，专家目录推荐工具仅未绑专家的
  agent 会话；ask 模式恒空集（纯对话）。是否并行由模型决定（LangChain 单次响应多
  tool_calls 时 `ToolNode` 并发执行），执行序在 chunk 层按 `toolCallId` 保序呈现。
  静态注册面（chat.service.ts 模块加载段 L172-198 `registerTools()`）：plan_*
  三件（项目专属）、`show_widget`、`library_search`、`search_history`、
  `show_table/show_summary/show_chart`（工作流查询结果渲染卡，同门展示组）、
  `confirm_form`（写类工作流执行前人确认卡）；运行时按会话注入 `web` 工具组、
  文件四件、`run_command`、`create_schedule`、`dispatch_member`（专家团）等。
- **老名别名归一**：`AliasToolNode.runTool()` 覆写——模型模仿历史 blocks 发出老工具名
  （如 `write_file`）时经 `canonicalToolName()`
  （`packages/tianshu-core/src/tool-alias.ts`）归一为新名分发，绑定面（node.tools）
  恒新名不双列。
- **事件归一**：`consumeAgentStream()` 把 StreamEvent 映射为回调协议
  `EmitterCallbacks{onTextDelta/onReasoningDelta/onToolCall/onToolResult/onToolError/
  onFinish/onError}`。关键难点全在 id 关联：模型 tool_call id（`on_chat_model_end` 的
  `tool_calls[].id`）与执行事件 run_id（`on_tool_start/end` 仅携 run_id）经挂起项
  `(name, args)` 匹配 + `serializedToolCallId` 直配兜底建 `runIdToCallId` 映射；
  `on_tool_end` 载荷 `ToolMessage.tool_call_id` 仅在本流已发射过的 id（`emittedCallIds`）
  时采信，防陌生 id 劫走终态导致 chunk 串不上被静默丢弃。名字比较双侧归一
  （新老名混布期防同名对失配双发射）。
- **usage 记账**：`makeUsageAccumulator()` 按 run_id 去重——流式 chunk 增量报 +
  `on_chat_model_end` 聚合值覆盖结算（该轮权威总值），跨轮累加，多步 agent 一轮流
  得到全步合计（对齐旧 AI SDK totalUsage 语义）；错误路径补调 `finish()` 转发余额
  （否则保险丝截断场景监控 DB 缺 token 统计）。
- **块级落块**（run-chat-stream.ts 内部）：`appendDelta` 维护开放 text/thinking 块
  （工具调用打断文本流时关闭，后续文本另起新块保序）；`handleToolCallPart` 落
  `state="ready"` 块并推 ready chunk；`finalizeToolBlock` 按 `finalStates`（拒绝/中止
  终态记录 Map，键 toolCallId）落 denied，否则按 `output.startsWith("错误:")` 判
  error/done；`finalizeInterruptedToolBlocks` 把中断时未达终态的块统一记
  `error("已中断")`；usage 有值则追加 `usage` 块。
- **错误分类**：`classifyError()`（`packages/tianshu-core/src/error-classify.ts`）输出
  七值错误码 `AUTH_FAILED/RATE_LIMITED/MODEL_NOT_FOUND/IMAGE_UNSUPPORTED/TIMEOUT/
  NETWORK/UNKNOWN`——HTTP 状态码优先（statusCode/status 双形状兼容 openai/anthropic/
  google SDK），400 + image/vision 关键词判 IMAGE_UNSUPPORTED，其余按 message 关键字
  兜底。渲染层按 `chat:errors.<code>` 映射 i18n 文案。**无自动重试**——错误码直达
  用户，重试是显式动作（regenerate 或重发）。

### 3.3 流式传输与中断

- **chunk 协议**：`ChatStreamChunk` 七型（chat-contract.ts）：`text-delta`/
  `reasoning-delta`/`finish`/`error{errorCode,message}`/`title-updated`/
  `tool-update{toolCallId,toolName,args?,state,output?}`/
  `approval-request{toolCallId,toolName,argSummary}`。三承载同构：IPC
  `chat:stream:{sessionId}`、SSE `message.chunk`、relay event 帧——全部 chunk 类型
  不过滤原样透传。
- **中断语义**：`chat:stop` → `ChatService.stop()` 一行 `this.aborts.get(sessionId)?
  ?.abort()`。信号贯穿三层：`streamEvents({ signal })` 停模型流；`toLangChainTools`
  透传给工具执行的 fetch/进程；`consumeAgentStream` 的 `isAborted()` 判定——
  **用户主动中止不是错误**：不记录错误码、不推 error chunk，已生成内容照常落库，
  未决工具块记「已中断」。流收尾 finally 统一作废挂起审批与确认卡。
- **快照恢复**：主进程 `accumulateSnapshot()`/`applyToolChunk()` 把 chunk 累积为
  `StreamSnapshot{text,thinking,tools{order,map}}`；切回会话时渲染层先订阅再查
  `chat:status`，`streaming=true` 则以快照整体覆盖恢复（`setStreamContent`），
  FIFO 下先 flush 本地缓冲防重复渲染；迟到的 status 响应不得复活已结束流态
  （`ended` 哨兵）。
- **审批挂起**：写类工具在 default 权限模式下经 `ApprovalCoordinator`（`agent/
  approval.ts`）挂起 execute，推 `approval-request` chunk；应答三口共用
  `approvals.respond()`——IPC `agent:approve`、`agent:confirmRespond`（确认卡）、
  远程 face 通道。「允许并记住」写 `toolPermission` 表（工作空间级免审记忆）。
- **重生成/编辑重发**：`regenerate()`（任意位置 assistant 消息 → 定位其前最后一条
  user → `truncateAfterAndStream` 删其后全部重跑）；`editAndResend()`（user 消息就地
  改写，保留原 skill_ref/image 块，删其后重跑）。压缩点消息被删时同步清
  `summary/compactedUpToId`（否则历史过滤会得到空上下文）。均为**破坏性覆盖**，
  无分叉树（§5 对比）。
- **续跑/压缩**：`/compact` 指令 `COMPACT_DIRECTIVE` 走一次普通流式轮，末条 assistant
  文本回填 `session.summary` + `compactedUpToId`；自动压缩 `autoCompactIfBudgeted()`
  在用户消息落库前探测预算（`probeSendCost` 与回喂同口径估算），超
  `AUTO_COMPACT_TRIGGER_RATIO = 0.8` 触发，冷却带 `AUTO_COMPACT_COOLDOWN_GROWTH =
  1.2`（会话粒度内存 Map 基线），失败静默放行（硬截兜底在 truncateHistory）。
  server 端 chat-runner **不移植自动压缩**，但压缩态读取保留（桌面写入的摘要可消费）
  ——无头端的超窗兜底完全依赖 `truncateHistory` 硬截。
- **辅助补全族**（同一 createChatModel 工厂的短路径）：AI 起标题
  `titleModelText()`（SystemMessage「不超过 12 字中文标题」+ 双轮文本截 200 字，
  30s 超时，失败静默降级）；专家团成员单轮 `memberModelText()`（120s 熔断 + 会话
  中止信号 `AbortSignal.any` 组合）；交接摘要 `runHandoverSummary()`；落地页润色
  `polishText()`（三风格指令常量 `STYLE_PROMPTS`）。共同点：非流式 invoke、必须带
  超时（M7 判词：半开连接不得永久挂起）、失败不阻断主链路。

### 3.4 历史截断与上下文组装

单源 `packages/tianshu-core/src/history-truncate.ts` + `tool-output-trim.ts`：

- **token 估算**：`estimateTokens = ceil(len/2)`（中文场景近似）；单消息
  `estimateMessageTokens`：text/thinking 按文本、image 恒 `IMAGE_TOKEN_ESTIMATE =
  1000`、tool_call 按 args JSON + output 全文 + 20 结构开销（按 0 计会让工具密集
  会话误判未超窗）。
- **输出预留**：`estimateReserveTokens = (maxTokens ?? DEFAULT_RESERVE_OUTPUT_TOKENS
  = 4096) + system + 工具定义 JSON`——输入预算扣除后才是不挤压输出的历史窗口。
- **滞回式截断**：`truncateHistory()` 未超预算全量原样返回（**前缀逐字节稳定，
  服务端前缀缓存持续命中**）；超预算后一次截到 `(1 - headroom 0.2)`，之后多轮只追加
  尾部不再动头部；至少保留最近一条（keep-at-least-one）。
- **旧轮工具输出瘦身**：`trimHistoryToolOutputs()`（spec §18 项 1）——非最近
  `TRIM_RECENT_ROUNDS = 2` 个工具轮且 output 超 `TRIM_THRESHOLD_CHARS = 6000` 的块，
  替换为「头 `TRIM_HEAD_CHARS = 3000` + `[已截断 N 字符]` 标注 + 尾
  `TRIM_TAIL_CHARS = 1000`」。只作用于**发给模型的回喂副本**——DB blocks、编辑重发、
  MessageItem 回看全量不动；倒序遍历使跨消息「最近 N 轮」判定成立。执行顺序：
  trim 在前、truncate 在后（截断判定天然消费瘦身后的成本）。
- **组装链**（assembleContext）：system 与历史保持逐字节稳定的前提下，把易变的
  时间行（`withTimeBlock`，`packages/tianshu-core/src/time-context.ts`，格式
  `2026-11-05 14:30 周四 UTC+08:00`）注入**最后一条 user 消息 blocks 头部**——
  放 system 头部会让整个对话历史的前缀缓存周期性作废。场景段
  （`scenario-prompt.ts` 的 daily/coding/design 三段）与工作流挂载元说明追加 system
  末尾；压缩摘要以`【此前对话摘要】`段拼在 system 末。历史过滤掉 `role==="system"`
  与 `error != null` 行。
- **上下文窗口三层兜底**（2026-11-01 provider 窗口批）：`effectiveContextWindow()`
  = `model.contextWindow ?? provider.contextWindow ?? DEFAULT_CONTEXT_WINDOW =
  131_072`（128K）。此前 model.contextWindow 全 NULL 且无兜底，`truncateHistory` 的
  `!contextWindow` 分支直接原样返回——历史不截断、自动压缩不触发，实测长会话单轮
  input 失控至数百万 token（§6 详述）。
- **用量可视化**：`computeUsageBreakdown()`（`electron/domains/ai/chat/context-usage.ts`，
  server 仓 `src/core/context-usage.ts` 同构）与下次请求同口径组装，按五类拆分
  system/tools/messages/mcp/skills，供 `chat:usage` IPC 的输入框环形指示器。

### 3.5 多模态图片链路

- **入口**：`ChatSendParams.images: ChatSendImage[]`——`{ absPath, base64? }`；`base64`
  为远程主机链（控制端粘贴/拖拽 blob 不落控制端盘，经 `files/uploadImage` 上传被控端）。
  粘贴落盘走 `savePastedImage()`（`pasted-image-store.ts`，`PASTED_IMAGE_LIMIT_BYTES =
  10MB`）。
- **落库**：`sendRound` 调 `imageAttachmentBlocks(appDataHome(), [attachmentsDir(),
  libraryDir()], ...)`（`workspace-files.ts`）——absPath 必须落在数据根 attachments/
  library 白名单子目录内（防渲染层传任意路径让模型读任意本地文件），白名单外
  （工作空间目录）先 `stageImageIntoAttachments()` 收编复制进 attachments。产出
  `ImageBlock{ imagePath: 相对数据根路径, mime, name }`——**base64 不落库防 SQLite
  膨胀**，数据根迁移后相对路径仍有效。
- **回喂**：`blocksToModelMessages` 经注入的 `loadImage = readImageAsDataUrl(appDataHome(),
  imagePath)`（workspace-files.ts L152）读盘转 dataUrl——resolve 防穿越 + realpath
  双检（symlink 逃逸）+ mime 白名单 + ≤10MB；读不到（文件被删）降级占位文本
  `[图片 xxx 已失效]`，不阻断整条流；assistant 消息不支持图片块同降级。
- **远程展示**：server-face image 端点 `readImageWithinRoot()` 返回
  `{ mime, dataBase64 }`（`ImagePayload` 单一形态，direct/relay 同构；svg 不在远程
  白名单——不回传可含脚本的矢量图）。
- **错误路径**：非视觉模型收到 image part 时 OpenAI 兼容端点普遍 400，
  `classifyError` 判 `IMAGE_UNSUPPORTED`。

### 3.6 artifact 产物

- **登记**：`SessionRepository.appendMessage()` 落库后 fire-and-forget
  `recordArtifacts()`——`extractPaths()`（`artifact-aggregate.ts`）扫 blocks 中
  `canonicalToolName(toolName) === "write"` 且 `state === "done"` 的 `args.path`，
  逐路径 `prisma.artifact.upsert`（唯一键 `userId_workspaceId_relPath`，重写刷新
  sessionId/createdAt）。失败仅 `Log.warn` 不阻塞消息链路。
- **列表**：`listArtifacts()` 查表 + stat 过滤已删除文件；存量会话首次访问经
  `backfillArtifactsIfNeeded()` 回填——纯函数 `aggregateArtifacts()`（同文件）跨会话
  扫描消息 blocks，同文件（resolve 后绝对路径）去重取最新写入，相对路径以所属
  工作空间 `directoryPath` 为基。
- **收藏**：`toggleArtifactFavorite()` 写 `artifactFavorite` 表。
- **导出**：聊天 dataUrl 图片另存走 `media-export.ts` 的
  `parseImageDataUrl/sanitizeSaveName/saveImageDataUrl`（`file:saveDataUrl` 通道）。

## 4. 三端布局

| 端 | 位置 | 角色 |
|---|---|---|
| 桌面（Electron 主进程） | `electron/domains/ai/chat/`（chat.service/session.repo/artifact-aggregate/workspace-files/pasted-image-store/handover-summary 等 26 文件） | 全功能编排：会话/消息/压缩/标题/审批/监控埋点；`agent-runner.ts` 把回调风格引擎桥接为 `AgentRunner` 契约（`packages/tianshu-protocol/src/agent-runner.ts`，AsyncIterable chunk 流 + result 终值）——换基座（第二引擎）时替换此注入即可，chunk 协议/审批流/UI 零改动 |
| 共享包 | `packages/tianshu-core/src/`：run-chat-stream/agent-chunk-emitter/blocks/history-truncate/tool-output-trim/param-merge/error-classify/time-context/scenario-prompt/last-message/monitor-events | chat 纯函数全量（RC-T3/T4 自 mirror 剥出入包；桌面原位改 re-export）；协议类型在 `packages/tianshu-protocol/src/chat-contract.ts` |
| 无头服务端 | `apps/tianshu-server/src/core/chat-runner.service.ts`（53.5K）+ `modules/session/`（controller/service/repository） | 同一 `@tianshu/core` 引擎的无头版：裁剪自动压缩/标题生成/专家团/项目 prompt/监控埋点；审批三模式（default 自动拒/auto-approve/manual 挂起等远程应答）；HTTP+SSE 出口 |
| 移动端 | `apps/tianshu-mobile/src/app/session/[id].tsx` + `src/transport/`（direct-transport/relay-transport/sse-parser） | 纯消费端：同构 chunk 协议经 SSE（direct）或 relay 加密帧（`packages/tianshu-core/src/e2e-crypto.ts`）接收；审批应答 `ApproveParams{sessionId,toolCallId,approved,remember?,toolName?}`；provider/model 配置遥控走 `providerSave` 通道 |
| 被控面 | `electron/domains/server-face/chat-tap.ts` | `emitChatChunk` 进程级 tap：桌面 ChatService.emit 的旁路广播，SSE/relay 订阅者异常隔离（逐订阅者 try/catch），渲染层零改动 |

**监控埋点**：`packages/tianshu-core/src/monitor-events.ts`（桌面
`electron/domains/ai/monitor/monitor-events.ts` re-export）——`usageFromBlocks()` 从
落库 blocks 提取 usage 块，`recordLlmCall()` 写 `llmCallEvent` 表（userId/scene
（chat/graph/automation）/modelId/sessionId/inputTokens/outputTokens/durationMs），
`recordToolCall()` 写 `toolCallEvent`；消费面 `/module/ai/monitor` 用量监控页。

**测试覆盖**（Vitest，桌面端 `apps/tianshu-desktop/tests/ai/`）：引擎循环
`agent-loop.test.ts`（14.3K，注入 fake model 断言多步工具流）、事件归一
`agent-chunk-emitter.test.ts`（17.2K）、接缝 `agent-runner.test.ts`、审批
`approval.test.ts`、产物登记 `artifact-table.test.ts` 与聚合
`chat/artifact-aggregate.test.ts`、时间行 `chat/time-context.test.ts`、图片导出
`chat/media-export.test.ts`；core 包截断/瘦身/参数合并等纯函数随包内测试。

## 5. 业界主流做法对比

| 方案 | 流式事件模型 | 工具循环 | 与天枢的差异点 |
|---|---|---|---|
| **OpenAI Responses API** | 类型化事件流（`response.output_text.delta`、`response.function_call_arguments.delta`、`response.completed` 等约 30 种事件），服务端维护聚合状态（`previous_response_id` 链） | 服务端内置 loop（`tool_choice`/内置工具），客户端回传 function_call_output | 天枢 chunk 仅 7 型粗粒度自研协议，聚合状态在客户端 blocks 落库；无 `previous_response_id` 等价物，每轮全量回喂 |
| **Anthropic Messages SSE** | `message_start/content_block_start/content_block_delta/content_block_stop/message_delta` 结构化事件——块级定位（index），thinking/input_json_delta 均有专属 delta 型 | **客户端循环**：stop_reason=tool_use → 回传 tool_result 块 → 再请求 | 天枢同为客户端循环但由 langgraph prebuilt 承担；Anthropic 块 index 与天枢 toolCallId 定位思路等价，天枢 text/thinking 不带块 index（顺序即结构） |
| **Vercel AI SDK stream protocol** | UIMessage part 流（text/reasoning/tool-* 动态 part，state machine 驱动），data part 可带自定义载荷 | `streamText` + `maxSteps`（客户端步数上限）+ `stopWhen` | 天枢 blocks 协议明确对齐 UIMessage 形态（chat-contract.ts 头注释）；差异：AI SDK 的 part 有稳定 id 可局部更新，天枢 tool 块有 toolCallId 但 text/thinking 是流末整体落库 |
| **LangGraph agent 循环** | `createReactAgent` + `streamEvents(v2)` / `streamMode:"updates"`；recursionLimit 保险丝 | prebuilt ReAct 图，ToolNode 并发执行 | 天枢正是此实现（`recursionLimit = maxSteps*2` 换算实测口径）；在事件归一层（consumeAgentStream）做了大量 id 关联/usage 去重的脏活，这是直接裸用 streamEvents 的主要成本 |
| **Claude Code / ChatGPT 等产品交互** | 会话分叉（edit 分支树）、消息级 regenerate、续写（continue）、checkpoint 回滚 | — | 天枢 regenerate/editAndResend 是**破坏性截断重跑**（删尾部消息），无分叉树/多分支并存、无 checkpoint；压缩用摘要替换而非 OpenAI 的自动 truncation 或 Claude Code 的 /compact+checkpoint 双轨 |

## 6. 改进空间

1. ◐ **contextWindow 元数据缺失致截断失控（批5 目录层已落，余留风险收窄）**：历史上
   model.contextWindow 全 NULL 且无兜底——`truncateHistory` 的 `!contextWindow`
   分支原样返回、自动压缩永不触发，实测单轮 input 可失控至数百万 token（对照基线：
   天枢默认 system+工具约 3.5K token）。2026-11-01 批已加三层兜底
   （model > provider > `DEFAULT_CONTEXT_WINDOW = 131_072`，`effectiveContextWindow()`）
   并给 provider 表补 `contextWindow` 列（`ensureProviderColumns` 幂等补建）；
   **批5（Task 9，2026-11-05）插入内置目录层**：四层链 model > 内置目录
   （`@tianshu/core` `model-catalog.ts`，常见模型 id → 窗口/价格/能力，别名
   容错）> provider > DEFAULT，桌面/server 同源。**余留**：(a) 目录未收录模型
   仍落 131072 静态兜底；(c) `len/2` 估算对英文代码（~4 char/token）系统性低估。
2. ✅ **已落地（批5，Task 9，2026-11-05）**：瞬态重试与 fallback——
   `runChatStream`（core）对 `classifyError` 判瞬态（RATE_LIMITED/NETWORK/
   TIMEOUT）且**流建立前失败**（本次尝试零可见块产出——中途失败重试会重复
   推送内容，一律直报）的错误退避 1.2s 同模型重试 1 次；配置类错误
   （AUTH_FAILED/MODEL_NOT_FOUND/IMAGE_UNSUPPORTED）与 UNKNOWN 不重试直报
   （UNKNOWN 与 automation-retry 的可重试口径刻意不同：聊天有人在场，直报换
   确定性）；`fallbackModel` 注入时（桌面 `chat.service loadFallbackModel` /
   server `chat-runner` 同构解析 model.fallbackModelId）主模型失败后切备选
   再试 1 次，全灭报最后一次错误（message 尾缀 ` [fallback retried]`）。
   「用户中止非错误」语义不变（abort 检查先于重试判定，退避期间中止不再发
   起重试）。测试 `tests/ai/agent-retry-fallback.test.ts`（11 例）。
3. **无分叉/树状会话**：editAndResend 覆盖历史，无法对照多分支回答；也无消息级
   checkpoint（工具写盘副作用无法随 regenerate 回滚——仅 file-history 备份兜底）。
4. **text/thinking 块无 id**：流中不可局部修订（对比 AI SDK part id / Anthropic
   content_block index），未来做「工具结果内联进后续文本」或块级重渲染需先补协议。
5. **截断后无「丢失上下文」提示**：硬截静默发生，用户不知 earliest 消息被裁
   （可用量拆解已有数据，仅差 UI 提示）；压缩同理只有摘要段注入无显式标记 chunk。
6. **检索增强缺失**：截断/压缩均为有损，未配合 `search_history` 工具做「截断前
   先回捞」的分级策略（工具已存在，未与截断联动）。
7. **多消息并发恢复的边界**：快照恢复依赖单会话单流假设（aborts 按 sessionId 键），
   跨窗口同时打开同一会话时快照/缓冲各自累积，极端下重复渲染（现由 30ms 节流 +
   invalidate 重取掩盖）。
8. **chat.service 巨石文件**：2645 行单文件承载编排/IPC/审批/权限/压缩/标题/润色
   六域职责，与「函数只做一件事」的项目规范冲突；AgentRunner 接缝已就位，可按
   编排（streamAndPersist）/门控（permission/审批）/辅助补全（title/polish/handover）
   三块拆分。server 仓 chat-runner.service.ts（53.5K）同构移植意味着这块债务被
   双份复制——drift 容差守护的不是设计而是重复本身。
