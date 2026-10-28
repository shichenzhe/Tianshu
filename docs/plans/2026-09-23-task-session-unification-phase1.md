# 一期实施计划：项目/任务会话统一到会话域（删动态 Tab 内嵌）

> 2026-09-23 编制。前置讨论结论：项目/任务会话不再内嵌于项目工作台，统一在
> ChatView（会话详情页）查看；项目与任务作为会话的关联属性存在。二期再做
> 「我的项目」区并入空间树、会话卡片项目标记、⌘F、AI 建待办预填等。

## 0. 现状关键事实（已核实）

- `session` 表已有 `projectId` 列（`prisma/schema.prisma`），项目创建即建
  会话（`project.repo.ts:520` `createProjectSession`）
- `session:listAll` **过滤 `projectId: null`**（`session.repo.ts:373-376`）——
  项目会话不进侧边栏任务树与搜索；`workspace:list` 同样过滤项目资产空间
  （`session.repo.ts:228` 注释：留给二期）
- 项目上下文注入已通：`chat.service.ts:2073` `getPromptContext` →
  `project-prompt.ts` `buildProjectSystemBase`（项目 systemPrompt + 专家
  prompt + 能力软约束）
- `plan_*` 四工具靠 `ctx.projectId` 属地校验（`plan-tools.ts`），链路不依赖
  会话容器位置
- ChatView 顶行已有会话内搜索（`SessionSearchBox`）、产物旁挂
  （`ArtifactsPanel`）、`usePageHeader` leading/trailing 机制
- `ChatPane` 的 `boundAssistantIds/boundSkillNames` 过滤集目前仅项目侧传
  （`ChatPane.tsx:40-43`）
- `PlanItemApi` 无单条 get；项目计划缓存 key `PLAN_ITEMS_KEY(projectId)`

## 1. 设计决策

| # | 决策 | 理由 |
|---|------|------|
| D1 | 任务↔会话关联放 **`session.planItemId`**（会话持有关联），不动 planItem 表 | `listAll` 一次吐全归属，侧边栏树/面包屑/任务概览零额外查询；「一任务一会话」由 create 复用逻辑保证 |
| D2 | 「项目主会话」= 该项目 **createdAt 最早** 的会话 | 多会话后 `toRecordWithSession` 的 `findFirst` 需定序，项目创建时建的那条天然最早 |
| D3 | 项目页输入框瘦身为**快速发起条**：`await send` 成功 → `navigate(/module/ai?session=id)`，失败留在原地 toast | 保留 WorkBuddy 式「项目详情输入即发起」入口；流式由 ChatView 承接（chat.store 全局共享） |
| D4 | 一期必须打通**会话域可见性**：`listAll` 放开项目会话 + 侧边栏新增按项目分组 | 否则 D3 跳转后 ChatView `selectedSession` 找不到（sessions 不含项目会话），落点为空 |
| D5 | 项目/任务会话在 ChatView 打开时，ChatInput 能力联想仍传**项目挂载过滤集** | `buildProjectSystemBase` 软约束说「仅用已挂载能力」，联想不过滤则为行为回归 |
| D6 | 事项「推进」入口放 `PlanItemCapsuleRow`（表/列表）+ `TasksPane` 行 + 看板卡标题区；无会话则 `session:create`（带 projectId/planItemId/title=任务标题）→ 跳转；有会话直接跳 | 对齐 WorkBuddy「任务↔会话一一推进」；五视图不常驻输入框 |
| D7 | schema 变更（session 加 `planItemId`）并入 **v1 全量建表脚本**，`DATABASE_VERSION` 保持 1 | 项目未发布，先例：v11–v14 已并入 v1（ed7d3c4） |

## 2. 实施批次（每批独立可提交、可测试）

### 批 1：后端数据链

1. `prisma/schema.prisma`：session 模型加 `planItemId Int?`（索引不必加，
   一任务一会话查询量小）；同步 `script/v1` 全量建表脚本与
   `tests/.../v1-fullschema` 相关断言
2. `electron/domains/ai/chat/session.repo.ts`：
   - `SessionRecord`（repo 侧）补 `projectId?: number | null`、
     `planItemId?: number | null`，`toRecord` 吐出
   - `listAllSessions`（:373）删 `projectId: null` 过滤
   - `createSession`：`SessionCreateParams` 补 `projectId?`、`planItemId?`
     透传写库；`planItemId` 非空时先查重——已有会话则**直接返回既有会话**
     （复用语义，不报错）；`projectId` 非空时 `workspaceId` 强制取项目资产
     空间（防前端传错）
3. `electron/domains/project/project.repo.ts`：`toRecordWithSession`（:563）
   的 `findFirst({ projectId })` 加 `orderBy: { createdAt: "asc" }`（D2）
4. `src-react/domains/ai/api/session.api.ts`：`SessionRecord` /
   `SessionCreateParams` 补同名可选字段（前后端类型镜像）
5. 单测：create 带 planItemId 去重复用、listAll 含项目会话、主会话取最早

### 批 2：会话域可见性（侧边栏项目分组）

1. `SessionTreePanel.tsx`：分组渲染改造——**实施前先读 230 行后的分组渲染
   段**，确认孤儿 workspaceId 会话现状行为；`projectId` 非空的会话按项目
   分组（组名=项目名、FolderKanban 图标、与空间组同构可折叠），组内再按
   `planItemId` 有无排任务会话在前
2. 项目列表数据：复用现有 projects 查询缓存（与 `ProjectSidebarList` 同
   key，实施时对齐）；ChatView 与 SessionTreePanel 共用
3. i18n：`project` namespace 增删相应 key（zh-CN/en-US 同步）
4. 测试：树渲染含项目组、时间筛选覆盖项目会话

### 批 3：项目页发起 → 跳转闭环

1. `ProjectChatBar.tsx` 瘦身：删 `AgentProgress`、`BarApprovalBanner`、
   审批兜底注释链；`handleSend` 改为 `await send(...)` 成功后
   `navigate(\`/module/ai?session=${session.id}\`)`（D3）；保留
   ChatInput/权限胶囊/本地任务开关/#待办联想/计划缓存失效联动；
   `needsChatSetup`/`chatSettingsRoute` 原位保留（WorkspaceView 仍消费）
2. **流式衔接验证**（风险点 R1）：跳转时 ProjectChatBar 卸载、ChatView 的
   ChatPane 以同 `session.id` 挂载，chat.store 流状态全局共享，预期无缝；
   实施时以 `npm run dev` 实测流式输出与消息落库呈现，异常则退路：发送后
   仅落库跳转、ChatView 侧 invalidate 呈现
3. 测试：`project-chat-bar.test.tsx` 重写为「发送成功跳转/失败留驻」两例

### 批 4：ChatView 会话详情页增强（面包屑 + 任务概览 + 能力保真）

1. `ChatView.tsx` 顶行 leading：`session.projectId` 非空时渲染面包屑——
   主会话（无 planItemId）`项目名`；任务会话 `项目名 / 任务标题`（任务经
   `PLAN_ITEMS_KEY(projectId)` 缓存 find，无则 enabled 拉取）；点击回
   `/module/project/:id`；与既有 `WorkspacePathChip` 并存时面包屑在前
2. 右侧任务概览：`ArtifactsPanel` 打开时顶部加「任务概览」折叠区（仅
   `session.planItemId` 非空渲染）——状态/优先级/日期只读（复用
   `PlanItemCapsuleRow` 只读态或轻量行）+ `aiSummary`（Markdown 只读）+
   「在项目中查看」链接
3. 能力过滤保真（D5）：`session.projectId` 非空时 ChatView 取
   `ProjectApi.getDetail(projectId).bindings` → 传 `boundAssistantIds` /
   `boundSkillNames` 给 ChatPane（过滤集查询与面包屑共用 detail 缓存）
4. i18n + 测试：面包屑两形态、任务概览渲染、过滤集传递

### 批 5：事项行「推进」入口

1. 新建 `src-react/domains/project/lib/task-session.ts`：
   `openTaskSession(planItem)`——有 `planItemId` 对应会话（listAll 缓存
   find）直接跳；无则 `SessionApi.create({ workspaceId: 资产空间,
   projectId, planItemId, title: 任务标题 })` 后失效 `["sessions"]` 缓存
   再跳（create 复用语义兜底并发双击）
2. 入口：`PlanItemCapsuleRow`（表/列表共用）、`TasksPane` 行、看板卡标题
   区各加图标按钮（MessageSquareText，muted hover primary，遵循项目按钮
   规范）
3. 测试：`openTaskSession` 单测（新建/复用/缓存失效）+ 入口渲染

### 批 6：删动态 Tab 内嵌（清理）

1. `ProjectWorkspaceView.tsx`：TABS 删 activity（三 Tab），缺省 tab 改
   `plan`；删 ActivityPane 渲染与 import；`ProjectChatBar` 保留（批 3 已
   瘦身）；文档头注释更新
2. 删文件：`ActivityPane.tsx`、`tests/project/activity-pane.test.tsx`
3. 检查死引用：`truncate-messages-for-edit`/`parseBlocks` 等在 ChatPane
   侧仍用（不删）；`chat.store` 的 `bumpSendVersion`/`sendVersions` 若仅
   为项目面板防呆而设则一并删（rg 确认消费方）
4. i18n 清理：`project:workspace.tabActivity`、`project:chatBar.viewContext`
   等孤儿 key（zh-CN/en-US 双侧）
5. 测试收敛：`project-workspace.test.tsx`（三 Tab/缺省 plan/无动态）、
   `chat.service.test.ts`/`memory-compiler.test.ts` 回归确认不受影响

## 3. 明确不做（一期边界）

- 「我的项目」区并入空间树 / 项目空间节点化（二期；一期树内项目分组已解可见性）
- 会话卡片/列表的项目徽标形态优化
- ⌘F 唤起会话内搜索、AI 建待办一键预填弹窗、工具卡片富化（信息卡片区）
- 点赞/朗读/分享/单条 token 元数据、Token 余额异常（无后端支撑，不做）
- `ChatPane` 过滤集 props 的通用化重构（D5 只做行为保真）

## 4. 验收标准

1. 项目页输入框发送 → 跳 ChatView，流式无缝衔接；该会话在侧边栏项目组
   可见、标题搜索可命中
2. 事项行「推进」→ 任务会话，面包屑 `项目名 / 任务标题`，右侧任务概览
   可见，`plan_*` 工具属地可用（projectId 链路不回归）
3. 再点「推进」复用同一会话（不重复建）
4. 项目工作台三 Tab（计划/任务/资产），动态 Tab 与 ActivityPane/
   原接线消失
5. `npm run test`、`npm run typecheck`、`npm run lint` 全绿

## 5. 风险点

| # | 风险 | 缓解 |
|---|------|------|
| R1 | 流式跨视图衔接（ProjectChatBar 卸载→ChatPane 接管） | chat.store 全局态理论上无缝；批 3 首先实测；退路=仅落库跳转+invalidate |
| R2 | SessionTreePanel 孤儿会话分组现状未知 | 批 2 实施前先读分组渲染段，再动 |
| R3 | v1 脚本与 schema 测试同步遗漏 | 批 1 内一起改，跑 v1-fullschema 测试 |
| R4 | 多会话后 `project.sessionId` 消费方（ProjectCard 等）未察觉语义变化 | D2 定序收窄；rg `session.id` 全量过一遍 project 域消费方 |
