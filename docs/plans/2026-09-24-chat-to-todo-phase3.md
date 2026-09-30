# 三期实施计划：会话到任务的结构化产出（PRD §3.3/§2.2 落地）

> 2026-09-24 编制。一期（会话统一）/二期（导航统一+健壮性）已完成并验收
> （全量 1925 绿；真实应用冒烟：快照守卫迁移生效、planItemId 落库）。
> 三期对应 WorkBuddy PRD 的两个体验增强：对话 → 待办的结构化转化、
> plan_* 工具卡片富化。

## 0. 前置事实

- 消息链路：ChatView → ChatPane → ChatMessages → MessageList → MessageItem；
  MessageItem 操作行现有复制/重新生成/时间戳（user 侧另有编辑/复制）
- `PlanItemDialog`（21K）由 PlanPane 管理打开态，字段完备（状态/优先级/
  处理人/标签/日期/附件/自定义字段）
- `aiSummary` 字段只经 `plan_append_summary` 工具写入（人路径不可编辑）
- `ToolCallCard`（4.1K）渲染工具调用卡片；plan_* 工具输出为回喂模型的
  文本字符串
- `parseBlocks` 可提取消息 text 块拼接 Markdown 原文（ActivityPane 删前
  的 handleEdit 同口径）

## 1. 设计决策

| # | 决策 | 理由 |
|---|------|------|
| D12 | 「转为待办」放 assistant 消息操作行（图标按钮），仅项目会话渲染；点击打开 PlanItemDialog，预填 title=消息文本首行截断、description=消息 Markdown 原文 | PRD §3.3「从对话一键提取」最小闭环；aiSummary 是工具专属字段不预填（人路径不可编辑语义保留），PRD「AI 摘要预填」由 description 预填承接 |
| D13 | 回调经 props 链传递（ChatPane → ChatMessages → MessageList → MessageItem 可选 prop，未传不渲染按钮），不引入 context | 项目内既有模式是 props 透传（editing/onRegenerate 同链），保持一致 |
| D14 | PlanItemDialog 打开态抽为可在 ChatView 复用（hook 或提升 dialog 实例），PlanPane 行为零变化 | DRY；避免两份 dialog 状态逻辑 |
| D15 | plan_* 工具卡片富化：解析工具名+入参/输出文本渲染结构化摘要（如 plan_update →「状态: 进行中 → 完成」），仅 plan_* 四工具，通用卡片不动 | PRD §2.2「信息卡片区」在任务语境的具体化；泛化的富卡片无后端支撑不做 |

## 2. 实施批次

### 批 10：消息「转为待办」预填

1. props 链：`onConvertToTodo?: (messageId: number) => void` 钻透
   ChatPane/ChatMessages/MessageList/MessageItem（未传不渲染，普通会话
   行为不变）；MessageItem 操作行加图标按钮（ListPlus，muted hover
   primary，aria-label i18n）
2. ChatView：项目会话（session.projectId 非空）提供回调——取消息缓存
   该条 record，`parseBlocks` 拼 text 块为 description、首行截断为
   title，打开 PlanItemDialog（预填 mode，projectId=session.projectId）
3. PlanItemDialog 复用改造（D14）：探查其 props/打开态结构后最小改造
   （如支持 initial 值入参），PlanPane 既有调用零变化；创建成功 toast +
   失效 PLAN_ITEMS_KEY
4. i18n（zh/en 双语）+ 测试：按钮仅项目会话渲染、预填内容正确、创建
   成功失效缓存

### 批 11：plan_* 工具卡片富化

1. 探查 ToolCallCard 现状（数据源：入参 argSummary？输出文本？）后实现
   plan_create/plan_update/plan_append_summary/plan_list 的结构化摘要行
   （D15；解析失败回退现有文本形态，宁退不崩）
2. i18n + 测试：四工具各一用例 + 畸形输入回退

## 3. 批 12：会话「转办」（用户裁定，替代批 10 的消息级入口）

批 10 的消息操作行「转为待办」偏离真实需求——转办是**会话级工作交接**，
非单条消息转存。入口/交互/摘要重做，批 10 成果部分回退：

1. **入口**：ChatView 顶行 trailing——SessionSearchBox 与
   ArtifactsPanelToggle **之间**加转办按钮（ArrowRightLeft 图标），仅
   session.projectId 非空渲染
2. **AI 交接摘要**（照 memory-compiler.ts 同构模式）：新建
   `electron/domains/ai/chat/handover-summary.ts`——五段结构 prompt
   （工作目标/关键结论/复刻建议（含已定决策可放心沿用）/当前状态/
   交付物），`generateText` + provider-factory 调模型（会话当前模型，
   缺省默认模型），纯函数可单测；IPC `chat:handoverSummary(sessionId)`
   读会话消息拼 prompt，返回 markdown；无模型/无消息明确报错
3. **转办弹框**（project 域新组件）：打开即调摘要——Loading「AI 摘要
   生成中」→ 预填摘要文本域（可编辑）；失败/超时（前端 ~30s）显示
   「生成失败，请手动输入」+ 重试；标题输入必填；确认 →
   PlanItemApi.create（title/description=摘要/projectId）→ toast +
   失效计划缓存（自动交接完成）
4. **批 10 回退**：删 MessageItem→ChatPane 的 onConvertToTodo props 链、
   ChatView todoDraft、PlanItemDialog 的 defaultTitle/defaultDescription
   （无消费方）、chat:message.convertToTodo key；相关测试同步

## 4. 明确不做

- 消息内 AI 自动建议「建待办」链接（需 AI 输出协议设计，无 PRD 截图
  之外的输入，收益存疑）
- 通用富卡片（天气/搜索结果卡片）：无对应工具域
- 点赞/朗读/分享（无后端）

## 5. 验收标准

1. 项目会话顶行（搜索与面板开关之间）有转办按钮；点击弹框自动生成
   五段式 AI 交接摘要（Loading → 预填可编辑，失败可重试/手输）；
   填标题确认后待办入库、计划 Tab 可见；普通会话无按钮
2. 消息操作行不再有「转为待办」按钮（批 10 回退干净）
3. plan_* 工具卡片显示结构化摘要（建出什么/状态流转/摘要新行）
4. `npm run test` / `typecheck` / `lint` 全绿
