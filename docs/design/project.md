# 项目模块技术方案

> 调研基线：main 分支（2026-11-05）。桌面端路径基准 `apps/tianshu-desktop/`（`electron/` 主进程、`src-react/` 渲染进程）。
> 项目模块经多批演进落地：一期（项目 + 能力挂载 + 动态流会话）→ 二期（资产空间）→ 三期（计划/任务/AI 工具组/附件/自定义字段）→ A7 批（三端协议化 + 移动端页面）。

## 1. 模块定位与总览

项目（Project）是天枢中以「一件事」为单位组织 AI 协作的容器：把**指令（systemPrompt）+ 资产空间（专属 workspace 目录树）+ 能力挂载（专家/技能/连接器）+ 计划清单（planItem/planView）+ 会话 + 定时任务**收敛到同一归属下。定位对标「AI 版的 GitHub Projects / Linear」：计划体系提供类 SaaS 工单的多视图管理，能力挂载与项目提示词让 AI 成为"项目专属成员"。

两个层级（路由注册于 `src-react/routes/index.tsx` 294/302 行，懒加载 81/85 行）：

- **项目 Hub** `/module/project`（`src-react/domains/project/views/ProjectHubView.tsx`，174 行）：
  头部（标题/副标题/新建按钮）→「我的项目」搜索 + `ProjectCard` 卡片网格（搜索为客户端 name 过滤，大小写不敏感）→「从模版创建」横向模版卡。四类内置模版定义在 `model/project-templates.ts`（`PROJECT_TEMPLATES`）：
  - `prd-workflow` 产品需求全流程（需求收集/PRD/研发协同/测试验收）
  - `market-research` 市场调研（调研框架/竞品对比/结构化报告）
  - `bug-tracking` Bug 跟踪（缺陷记录/分级 P0~P3/修复状态流转）
  - `blank` 空白项目（空 prompt）
  每个模版携带 `prompt`（落为项目 systemPrompt）与 `welcome`（动态流首条消息）。
- **项目工作台** `/module/project/:projectId`（`views/ProjectWorkspaceView.tsx`，236 行）：
  左侧三 Tab（计划 plan / 任务 tasks / 资产 assets，`?tab=` 缺省 plan，已删除的旧 `?tab=activity` 非法值回落 plan）分别渲染 `PlanPane` / `TasksPane` / `AssetsPane`；底部快速发起条 `ProjectChatBar` 贯穿三 Tab（providers/models 双空的引导态不渲染，`needsChatSetup` 判据）；右列配置面板 `ConfigPanel`（w-80 border-l 可收起，标题经 `usePageHeader` 提升到 TopBar 右段）。`getDetail` 抛 `PROJECT_NOT_FOUND` → toast + 跳回 Hub。

主进程后端 `electron/domains/project/` 五个仓储/纯函数件：

| 文件 | 职责 |
|---|---|
| `project.entity.ts` / `project.repo.ts` | 项目 CRUD、成员、能力挂载、资产空间与动态流会话生命周期 |
| `asset.entity.ts` / `asset.repo.ts` | 资产空间文件/目录面（列表/建夹/改名/删除/上传/用量/预览/定位） |
| `plan-item.entity.ts` / `plan-item.repo.ts` | 计划事项（单表双视图聚合）+ 自定义字段定义 + 附件关联（批8 起读侧带存在性 `valid`） |
| `plan-view.entity.ts` / `plan-view.repo.ts` | 计划视图配置 CRUD |
| `project-prompt.ts` | 提示词组装纯函数（无 IO） |
| `project-memory.ts` | 项目记忆纯函数件（批8：memory.md 条目渲染/合并/正文提取，无 IO） |
| `project-change-bus.ts` | 项目级变更扇出总线 |

测试 35 个文件在 `tests/project/`（`project-repo` / `plan-item-repo` / `plan-view-repo` / `asset-repo` / 五视图组件 / `task-session` / `session-isolation` 等），前端 API 层 `src-react/domains/project/api/` 四件（`project.api.ts` 导出 `PROJECT_CHANGED_EVENT = "project:changed"`、`plan-item.api.ts` 导出 `PLAN_ITEMS_KEY`/`PLAN_ITEMS_MINE_KEY`、`plan-view.api.ts`、`asset.api.ts`）。

## 2. 数据模型（六张表逐一说明）

Schema：`prisma/schema.prisma` 314–394 行。全部无外键关联（service 层维护），业务数据按 userId/ownerId 隔离（v12 多用户隔离：userId 由主进程从 token 解出，不信任前端传参）。

### 2.1 project（314 行）

```
id / name / systemPrompt(String?) / templateKey(String?) / ownerId / createdAt / updatedAt
@@unique([ownerId, name], map: "idx_project_owner_name")
```

项目主表。`systemPrompt` 是项目级系统提示词（UI 称"项目指令"，Markdown，`InstructionEditDialog` 编辑）；`templateKey` 记录创建模版（仅溯源展示，不参与运行时行为）；同 owner 下项目名唯一——创建与改名均经 `ensureNameAvailable`（改名传 excludeId 排除自身），冲突抛稳定码 `PROJECT_NAME_EXISTS`。

### 2.2 projectMember（326 行）

```
id / projectId / userId / role(String @default("member")) / joinedAt
@@unique([projectId, userId], map: "idx_project_member_pid_uid")
```

成员表，`role` 现仅 `owner | member` 两值（schema 无枚举约束，字符串列）。创建项目时 `createOwnerAndBindings` 写一行 owner 成员。`listMembers` 按 joinedAt asc 排序、join user 表取昵称（缺昵称回退用户名）。**注意：当前没有增删成员/改角色的 IPC 通道**，成员表实际写入路径只有创建时的 owner 行——多人协作是数据模型先行、入口未开（详见 §6 P1）。

### 2.3 projectBinding（336 行）

```
id / projectId / itemType(String) / itemId(Int) / createdAt
@@unique([projectId, itemType, itemId], map: "idx_project_binding")
```

**绑定对象是三类 AI 能力源实体**：`ProjectBindingType = "assistant" | "skill" | "mcpServer"`（`project.entity.ts` 第 10 行），`itemId` 指向 `assistant` / `skillRecord` / `mcpServer` 表主键（类型→表映射 `ITEM_TABLES` 在 `project.repo.ts` 32–40 行）。语义是"项目预设能力"：挂载集进入项目会话 system prompt 的软约束声明段（预设≠围墙，见 §3.4），并在非 ask 模式下收窄技能清单。写面为全量替换（`setBindings` → `replaceBindings`：先 deleteMany 再 createMany，空数组即清空）；详情读面逐行回查源实体（`toBindingItem` → `findBindingSource`），源被删时 `itemName` 以 `#id` 兜底并标 `valid=false`（UI 灰显，编辑不静默丢弃——Task 6 裁定）。

### 2.4 planItem（347 行）

```
id
projectId    Int?    // NULL = 本地任务（仅任务 Tab 可见）
title        String
status       String @default("not_started")  // not_started|in_progress|paused|done（表格三态与看板四态取并集）
priority     String @default("P1")           // P0|P1|P2|P3
assigneeId   Int?    // 预留，单成员场景恒当前用户
tags         String?         // JSON string[]
customFields String?         // JSON Record<fieldName, string|number>
startDate    DateTime?       // 排期开始（甘特/日历视图）
dueDate      DateTime?       // 截止日期
source       String @default("manual")       // manual|ai|template
description  String?         // Markdown 原文（弹窗编辑/预览）
aiSummary    String?         // AI 进展摘要（只经工具追加，人路径不可编辑）
sortOrder    Int @default(0) // 看板列内序
createdById  Int
createdAt / updatedAt
```

**扁平单表，无父子层级**（对比 Jira epic/story、Linear subissue——见 §5）。`projectId NULL` 行是"本地任务"：不属于任何项目、仅任务 Tab 的个人聚合可见（ProjectChatBar 的本地任务开关即引导 AI 落此类行）。`aiSummary` 是人机分界线：只由 `todo_write` 工具经 `appendAiSummaryLine`（`plan-item.entity.ts` 322 行纯函数）追加 `[yyyy-MM-dd] text` 行，人类 UI 不可编辑。`tags`/`customFields` 为 JSON 字符串列，读取经 `parseJsonColumn` 容错（畸形 JSON/形状不符降级空数组/空对象）。自定义字段**定义**不在本表——复用 option 表 `type = "planFields:<projectId>"`（value=字段名、note=类型 text|number|date，`planFieldsType` 函数）。

### 2.5 planView（370 行）

```
id / projectId
name       String @default("")   // 空串 = 播种默认视图（UI 显示本地化类型名 PLAN_VIEW_NAME_KEYS）
type       String @default("table")  // table|kanban|list|gantt|calendar
groupBy    String?               // status|priority|assignee（看板分组依据）
filterJson String @default("{}")
sortJson   String @default("[]")
sortOrder  Int @default(0)
createdAt / updatedAt
```

**视图 = 展示类型 + 筛选/排序/分组配置；不复制数据，共享项目 planItem 单表**（Notion database+view 同构，见 §5）。同名唯一性由 v5 部分索引（`WHERE name != ''`）保证——Prisma 无法表达部分索引故不在 schema 声明（382 行注释）。首次 `planView:list` 返回空则 `$transaction` 懒播种两条默认视图（table sortOrder 0 + kanban sortOrder 1，name 均为空串）。`filterJson` 形状 `{ conditions: FilterCondition[] }`，条件 field ∈ `title|status|assigneeId|source|priority|tags`、op ∈ `contains|in|notIn|isMe|notMe`；`sortJson` 为 `SortRule[]`（field ∈ `status|priority|dueDate|createdAt|title`，dir asc|desc）——契约见 `packages/tianshu-protocol/src/project-contract.ts` 与引擎 `packages/tianshu-core/src/plan-view-engine.ts`。

### 2.6 planItemAttachment（386 行）

```
id / planItemId / fileName(展示名，含扩展) / assetPath(项目 workspace 相对路径) / createdAt
@@index([planItemId], map: "plan_item_attachment_planItemId_index")
```

**挂的是项目资产空间里的文件引用**：`assetPath` 是相对资产根的路径（上传落 `attachments/xxx` 或挑选资产树已有文件），文件实体在数据根 `projects/<id>/assets` 目录树。删单条事项/删附件关联**保留**文件实体；删整个项目时文件实体随资产目录树一并销毁（`project.repo.ts` `remove` 的双语义注释，210–214 行）。附件关联表无 projectId 列，删项目时按事项 id 集先删（v6 设计取舍）。批8 P3 起双保险死链治理：资产 delete/rename 反查关联级联解绑/改绑（`asset.repo.ts`，按本项目事项 id 集圈定）；附件列表读取逐行校验存在性置 `valid`（缺失 → false，UI 置灰；不可判定恒 true 不误灰）。

### 2.7 关联散列（其他表的 projectId 列）

| 表 | 列 | 语义 |
|---|---|---|
| `workspace`（108 行） | `projectId Int?` | 项目资产空间行（name = `资产 · <项目名>`，`ensureAssetWorkspace` 创建）；不进全局空间列表（workspace:list 按 projectId:null 过滤） |
| `session`（125/134 行） | `projectId Int?` + `planItemId Int?` | 项目会话归属；`planItemId` 是"一任务一会话"关联（create 按其查重复用，免索引，schema 134 行注释） |
| `automationTask`（232 行） | `projectId Int?` | NULL = 全局任务（三期子系统 E：项目定时任务） |

## 3. 核心技术方案

### 3.1 项目生命周期（`electron/domains/project/project.repo.ts`，682 行）

IPC 通道 8 条（`registerHandlers`，全部经 `handleUser` 包裹——userId 由 token 解出（`commons/ipc-user`），ownerId 不再信任前端传参）：
`project:list / getDetail / create / update / delete / setBindings / listMembers / appendMemory`。批8 起另持安装式审计出口 `installAuditSink`（Application 接 auditLogService，缺席静默）：`remove`/`setBindings` 分别入账 `project.removed`/`project.bindingChanged`。

- **create**（181 行），顺序链：
  1. `ensureNameAvailable` 同 owner 重名校验；
  2. 建 project 行（name/systemPrompt/templateKey/ownerId）；
  3. `createOwnerAndBindings`：写 owner 成员行 + 初始挂载 `replaceBindings`；
  4. `ensureAssetWorkspace`：`assetsDirOf` = `projectsDir()/projects/<id>/assets` 建目录（`ensureAssetsDir` 失败抛中文错误附 cause，不落脏 workspace 行）+ 建 workspace 行（v12：资产空间随项目 owner）；
  5. `createProjectSession`：会话挂 projectId + workspaceId、title=项目名、`currentModelId` 继承「全局最近一次选择」（按空间查恒取不到值，二期口径）、非空 `welcomeMessage` 经 `appendWelcomeMessage` 落首条 assistant 文本块消息并刷新 lastMessageAt；
  6. `emitProjectChanged` 广播。
- **getDetail**（144 行）：
  1. `mustVisibleRow` 可见性校验；
  2. `ensureAssetWorkspace` 自愈（一期旧项目升级后首个 getDetail 即完成迁移，无需 SQL 数据脚本）；
  3. 主会话取「最早创建」（`orderBy createdAt asc`——项目创建时建的那条，多会话后语义稳定，D2）；主会话被用户经会话树删光时**自愈重建**（D10，复用创建链不传 welcomeMessage，项目页不再 404）；list 侧缺会话兜底 0 不自愈（轻列表路径）；
  4. 返回 `ProjectDetail = { project, assetWorkspaceId, bindings, session }`（session 立即反映重绑后的资产空间，自愈当次即一致）。
- **remove**（217 行），级联链（顺序固定）：
  1. `assertProjectOwned`（仅 owner）；
  2. `removeAssetWorkspace`：`fs.rm` 整个 `projects/<id>` 目录树 + workspace 行（fs 失败仅记日志不阻断 DB 级联，残留目录留用户手动清理）；
  3. 按事项 id 集删 planItemAttachment（表无 projectId 列）→ automationTask → planItem（projectId 精确匹配，本地任务 null 不受影响）→ planView；
  4. message → session（逐会话 `revokeSession` 回收会话级路径授权，T28；内部自吞错）→ projectMember → projectBinding → project；
  5. 审计 `project.removed` 入账（批8 P2：不可逆级联必留痕）→ `emitProjectChanged`。
- **update**：仅 owner；改名时显式判空校验重名（空串绕过 truthiness 漏洞已修）。
- **变更扇出**：`project-change-bus.ts` 的 `emitProjectChanged` 双消费者——渲染层全窗 `PROJECT_CHANGED_EVENT`（React Query `["projects"]` 前缀失效）+ 进程级订阅者扇出（face 事件桥外发 `project.changed` 给远程控制端重拉；订阅者异常隔离，face 桥故障不打断本地通知链）。与 automation-change-bus 同构（2026-11-01 批③）。

### 3.2 成员/权限模型

- **可见性**：`mustVisibleRow` / 公开方法 `assertProjectVisible`（A7 起提升为公开，被 planView/asset 的 face tap 逐方法守门复用）——owner 或 projectMember 行任一即可见；**不可见与不存在统一报 `PROJECT_NOT_FOUND`**（不泄露存在性）。列表 `list(ownerId)` 仅返回 owner 的项目（成员可见的项目暂不进列表——见 §6 P1）。
- **写面分级**：项目基础字段/挂载/删除仅 owner（`assertProjectOwned`）；**planItem 写面仅要求项目可见**（`assertItemOperable` → `assertProjectVisible`），即成员可改计划；本地任务仅创建者可操作。
- **处理人约束**：`ensureAssigneeIsMember`——`assigneeId` 非空时必须是该项目成员（本地任务无项目，跳过校验）。
- **角色**：owner/member 两值，无更细粒度；项目域审计已接入 `securityAuditLog`（批8 P2，见 §6）。

### 3.3 资产空间（`asset.repo.ts`，9 通道）

`projectAsset:list / createFolder / rename / delete`（基础四通道）+ `projectAsset:upload / storage / openFile / revealFile / pickFiles`（传输五通道）。`AssetRepository` 构造注入 `ProjectRepository`（复用 `ensureAssetWorkspace` 自愈）：

- `resolveAssetRoot`：project 行缺失抛 `PROJECT_NOT_FOUND`，否则经自愈取 workspace 目录与 id。
- **路径沙箱 `safeJoin`**：`resolve` 后必须仍落在资产根内，拦截 `../` 穿越、绝对路径注入、空字节注入；`""` 与 `"/"` 归一到根。
- **名称治理**：`sanitizeName` 剥离 Windows 保留符号 + `\p{Cc}` 控制字符（覆盖 C0/C1/DEL）与首尾空白/点号；`uniqueName` 重名追加 " (2)"、" (3)"…（扩展名保留）。
- 目录缺失自愈：`readDirWithSelfHeal`（ENOENT → mkdir recursive 返回空）；`assertNotRoot` 拒绝对资产根本身的删除/改名（防整空间误删/逃出 workspace 记录）。
- 用量：`storage` 经 `walkDirSize` 递归 du（withFileTypes+lstat 口径不跟随符号链接，天然防符号环；目录缺失/不可读按 0）+ 恒定软配额 `ASSET_QUOTA_BYTES = 5GiB`（`asset.entity.ts`——仅 UI 用量提示，上传不做大小与总量硬拦截）。
- 上传 `upload`：逐文件 basename → 清洗 → 重名序号 → `copyFile`，单文件失败收集进 `failed` 不中断循环，同批次同名靠串行拿到不同序号。
- `openFile`（`shell.openPath` 系统默认程序，仅文件）/ `revealFile`（`shell.showItemInFolder`）/ `pickFiles`（系统多选对话框）。
- 附件死链治理（批8 P3）：`delete` 后按 assetPath 反查级联解绑关联（文件精确/文件夹前缀，按本项目事项 id 集圈定防跨项目误伤，失败仅记日志）；`rename` 后关联 assetPath 同步迁移（uniqueName 最终名 + 文件夹前缀平移）。资产实删入账审计 `projectAsset.deleted`（批8 P2，安装式 sink）。

### 3.4 绑定机制与项目提示词（`project-prompt.ts` + `chat.service.ts`）

- **上下文采集** `getPromptContext(projectId)`（`project.repo.ts` 340 行）：project 行 + 挂载行按类型分组（`groupBindingIds` 保持挂载写入顺序；`orderByIds` 修 findMany in-查询不保序）回查三源——assistant 取 `systemPrompt`、skillRecord 取 `name`、mcpServer 取 `name` 且**仅 `enabled: true` 行**（声明与实际一致：禁用 server 的工具未注册进 registry，软约束不得将其列为可用能力）→ 产出 `ProjectPromptContext { projectName, systemPrompt, boundAssistantPrompts, boundSkillNames, boundConnectorNames, memoryMarkdown }`。项目行缺失返回 null（调用方回退助手 prompt）。批8 P0：`memoryMarkdown` 为资产空间 `memory.md` 正文（尽力读入，缺失/空为 null；8000 字符预算保最新整段）。
- **组装** `buildProjectSystemBase` 纯函数（无 IO）：`[project.systemPrompt, ...boundAssistantPrompts, 会话所选助手 prompt, 项目记忆段, 能力声明段]` 以 `\n\n` 拼接，全空返回 undefined。能力声明段 `buildCapabilitySection` 生成「【项目预设能力】技能：… / 连接器：… + 优先使用引导语」——**预设是默认起点而非围墙**，用户在会话中要求用预设外的技能/连接器时模型可按需直接调用。项目记忆段（批8 P0）「【项目记忆】…」注入 memory.md 正文（AI 沉淀层，置于指令/专家之后、能力声明之前）。
- **消费点** `electron/domains/ai/chat/chat.service.ts`（~2190 行）：`session.projectId` 非空且非 ask 模式时 `isolateProjectTools(skills, projectCtx)`（350 行）——技能清单按挂载集**收窄**为实际可用集（`mounted = skills.filter(skill => boundSkillNames.includes(skill.name))`，防声明未安装技能名；此时专家附带技能不并入），但**工具集不硬过滤**（read_skill/mcp 全量可用）。项目上下文空时声明段也随 `declaredCtx` 收窄。段序：项目指令 → 挂载专家 → 会话所选助手/专家团主理人（`teamLeadSystem` 嵌入而非替换，项目段保留在前）→ 项目记忆段（批8）→ 预设能力声明，其后叠加个性化段/场景段/工作流元说明。

### 3.5 plan 体系（单表双视图 + 五视图渲染 + 协议化视图引擎）

**后端**（`plan-item.repo.ts` 11 通道：事项 6 + 字段定义 2 + 附件 3；`plan-view.repo.ts` 5 通道 `planView:list/create/update/delete/reorder`——后者历史裸 `ipcMain.handle` 无 userId 参数，A7 起 face tap 层补守卫）：

- **单表双视图聚合**：`list(projectId, userId)` 计划 Tab 数据源（sortOrder asc + updatedAt desc，本地任务不可见）；`listMine(userId)` 任务 Tab 数据源（`OR: [assigneeId=me, createdById=me]`，含本地/项目行，updatedAt desc）。
- **校验链**：create/update 共用 `ensureEnumOrThrow`（status/priority/source 枚举，undefined 走缺省）、title trim 非空；`ensureAssigneeIsMember`；`toDateOrNull` ISO 日期透传（空串/null 清空，非法串抛中文错误）。
- **列内序**：`nextSortOrder(projectId, status)` 按「(projectId, status) 列」独立取 max+1——新建与状态变更（update 内 status 变更时重算，防弹窗编辑等裸 update 绕过 move 造成落列错位）落目标列尾；`move` 通道接收前端计算的落点序（`PlanKanbanView.computeSortOrder`：无落点=列尾 max+1、有落点=与前一项后邻均值，防筛选态错序）。
- **视图配置**：`create` 重名自动 `(n)` 后缀（`uniqueName`，空串默认视图语义不参与后缀）；`remove` 最后一个拒删（`PLAN_VIEW_LAST_ONE`——单一不变量：项目至少保留一个视图）；JSON 列读取 `parseJsonOr` 畸形降级默认值并 warn。
- **自定义字段**：`listFields`（option 域 `planFields:<projectId>` 行，note 缺失/非枚举的畸形行丢弃）；`saveFields` 全量替换（deleteMany + createMany）+ `normalizeFieldsOrThrow`（name trim 非空、三枚举、项目内不重名）+ `cleanRemovedFieldValues`（消失字段名同步清理项目内全部行 customFields 键，单行失败收集、收尾汇总抛出）。
- **附件**：`attachments:list/create/delete` 三通道——`createAttachment` 仅写一行关联记录（上传与挑选资产树已有文件同构），`assertAttachmentVisible` 按所属事项守门；`listAttachments` 逐行校验 assetPath 存在性置 `valid`（批8 P3 死链失效态，workspace 行缺失/本地任务不可判定恒 true）。

**视图引擎**（A7 批下沉共享包，双端单份权威源）：`packages/tianshu-core/src/plan-view-engine.ts` 导出四纯函数：

- `filterItems`：条件 AND + 标题搜索叠加（独立参数）；未知 field/op 恒真=忽略（单视图坏配置不打崩计划页）。
- `sortItems`：规则数组按序比较，空规则走缺省序（状态序 → sortOrder → id）；空字符串日期恒排最后。
- `groupItems`：status/priority 全枚举组保留（空列也显示）；assignee 组 = unassigned + 候选成员 + 数据内出现者。
- `parseViewConfig`：畸形 JSON/形状不符降级空配置。

桌面 `src-react/domains/project/model/plan-view-engine.ts` 保留为 re-export 兼容层——**渲染进程必须子路径导入** `@tianshu/core/plan-view-engine`（包入口聚合含 run-chat-stream/e2e-crypto 等 Node 侧模块，根导入会把 node:fs 拖进 renderer）。

**渲染**（`PlanPane.tsx` 视图驱动）：`usePlanViews` hook（`model/use-plan-views.ts`）管激活视图（`?viewId=` 路由参数，兼容旧 `?view=`）+ draft 未保存调整态（切换视图/刷新即丢弃）+ 保存两动作（`saveAsNew` 命名新建 / `saveOverwrite` 覆盖回写）+ 增删改名与类型切换（立即保存）；变更乐观更新 setQueryData、失败 invalidate 回滚 + toast。五视图组件：

- `PlanTableView`：行内状态切换走 move 通道；优先级/处理人走 update；
- `PlanKanbanView`：分组泳道拖拽（分组依据 status/priority/assignee 由视图 draft.groupBy 驱动），`computeSortOrder` 计算落点序；
- `PlanListView`：状态四组折叠清单——勾选完成走 move、组内 + 携组状态快速新增；
- `PlanCalendarView`：月格视图——点格空白预置该日 dueDate 开新建弹窗、点 chip 开编辑；
- `PlanGanttView`：时间轴条形——pointer 拖拽平移/边缘拉伸调期走 `handleChangeDates` 乐观落库、点条开编辑。

工具栏与编辑设施：

- `PlanViewTabs`：视图 Tab 切换/添加看板/重命名/删除保护/未保存圆点（视图列表为空时整条不渲染）；
- `PlanFilterPopover`：六字段条件增删 + 保存为新视图/覆盖保存/重置，条件变更写 draft；
- `PlanViewSettingsPopover`：类型切换立即保存 + 看板分组依据入 draft；
- `PlanItemDialog`：新建/编辑全字段弹窗（`PlanItemCapsuleRow` 属性胶囊行 + `CustomFieldsEditor` 自定义字段 + `PlanItemAttachments` 附件区）；
- 日期经 `model/plan-date.ts`（`dateKeyToIso` UTC 零点语义，测试 `plan-date.test.ts`）；
- `TasksPane`：任务 Tab 个人聚合清单（自取 userId 拉 `planItemsMine`，不依赖 projectId 切换重挂）。

### 3.6 与 AI 能力的联动（四条链）

1. **项目会话快速发起**（`components/ProjectChatBar.tsx`）：底栏复用 ai 域 `ChatInput`，发送受理即跳 `/module/ai?session=<id>`（流式输出、进度与审批横幅由 ChatView 的 ChatPane 承载——chat.store 全局流态，ChatPane 挂载先订阅流再经 chat:status 快照恢复，跨视图无内容丢失）。保留能力：权限胶囊、**本地任务开关**（T8：开启时消息末尾追加 `LOCAL_TASK_DIRECTIVE` 指令，引导 AI 建的待办落为 projectId 置空的本地任务，不进项目计划）、`#` 待办联想（数据源即计划缓存）、能力挂载过滤集、/compact。`invalidatePlanCachesOnStreamEnd` 发送时挂一次性流结束监听（finish/error 时失效 `PLAN_ITEMS_KEY`/`PLAN_ITEMS_MINE_KEY` 后自解绑）——AI 工具可能已在主进程直写计划清单，失效驱动五视图/徽标/#联想实时反映。会话内 `@` 文件引用经 `assetWorkspaceId` 定位（`ChatPane.tsx` 63 行注释：资产空间被 workspace:list 过滤，项目侧传 `{ id: assetWorkspaceId }` 不经全局空间列表解析）。
2. **AI 工具组 todo_write/todo_read**（`electron/domains/ai/agent/plan-tools.ts`）：`makePlanTools(deps)` 产出两工具（2026-10-29 由 plan_* 五件坍缩二件，`PLAN_TOOL_NAMES` 显式名集供 chat.service 非项目会话剔除）。纯 Node 实现（禁 import electron，prisma 经 deps 结构注入可测）：
   - `todo_write`（kind:"write"，走统一两级审批门禁）：批量操作——无 id=新建（title 必填、dueDate yyyy-MM-dd、priority/tags 可选，落 `source:"ai"`、`assigneeId:null` 设计裁决：AI 建的任务默认未指派，人可后续指派）；有 id=更新（status 流转 `transitionOne` 落目标列尾 + progress 追加 `appendProgressOne`）。
   - `todo_read`：无参=全量清单（#id/标题/状态/最近进展）、带 id=单任务完整详情（含描述与进展全文——AI 推进的内容依据）。
   - 防线：`ctx.projectId == null` 直接拒绝（"当前会话未关联项目"）；`findOwnedItem` 属地校验（跨项目行视同不存在）；批量内逐项错误隔离（"第 N 项"前缀，单项失败不阻断）；**坍缩语义裁定：不做 TodoWrite 式 omission-delete 全量覆写**——计划清单人机共享（source 区分 ai/manual），漏项即删会误删人类任务；进展行只增不改；更新项显式拒绝改标题（防静默忽略）。工具描述带 `GROUNDING_NOTE`（"清单不在文件系统"）掐掉模型在文件系统找任务文件的错误路径。
3. **任务推进入口**（`lib/task-session.ts` `openTaskSession`）：任务 → 专属会话直达——`["sessions","all"]` 缓存按 `planItemId` 找既有会话命中即跳（零 IPC 往返）；否则 `SessionApi.create({ projectId, planItemId, title })`（不传 workspaceId，后端解析项目资产空间；并发双击由后端按 planItemId 查重复用兜底，D1"一任务一会话"）；返回归档会话先 `archive(created.id, false)` 撤销（D9，否则 listAll 过滤 archivedAt 后跳转落点成空）；本地任务（projectId null）无资产空间与会话域归属，不提供推进入口。配套 `store/plan-advance.store.ts` 预填桥：计划视图「AI 推进」入口写引导语（`#<id>《标题》`+模板），底栏 ChatInput `consume()` 读后即清（二次消费得 null 天然防重复）。另有 `components/HandoverDialog.tsx` 会话级工作交接（三期批 12）：打开即调 `chat:handoverSummary` AI 交接摘要（Loading → 预填可编辑文本域，失败/超时 30s 兜底可重试可手输）→ 确认创建项目待办（description=摘要、source=manual、属性六字段随载荷）→ 按返回 id 批量挂附件（失败仅 toast 不阻断）→ 项目记忆沉淀（批8 P0：摘要 + 产出物索引 fire-and-forget 回写资产空间 `memory.md`，失败静默）。
4. **项目定时任务**（三期子系统 E，`electron/domains/ai/automation/automation-runner.ts`）：`automationTask.projectId` 非空时读 `project.systemPrompt` 注入 system prompt（227–231 行 `projectPrompt`）；`createSession` 会话归属 projectId（全局任务显式 null，322 行）——plan 工具组依赖 `ctx.projectId`，项目自动化会话因此具备读写项目计划的能力面；删除项目级联清任务（§3.1）。前端入口在 `ConfigPanel`：项目任务行列表（名称/频率/状态/上次运行/启停/立即运行，projectId 前端过滤）+ `CreateTaskDialog` 项目预设（资产空间锁定）+ 前往自动化入口。

## 4. 三端布局

### 4.1 桌面端（apps/tianshu-desktop）——全功能 Owner 端

§3 全部能力。前端 `src-react/domains/project/` 目录构成：

- `views/` 2：`ProjectHubView`（Hub 列表）、`ProjectWorkspaceView`（工作台容器）；
- `components/` 24，分四组：
  - 计划五视图与配置：`PlanTableView` / `PlanKanbanView` / `PlanListView` / `PlanCalendarView` / `PlanGanttView` / `PlanViewTabs` / `PlanFilterPopover` / `PlanViewSettingsPopover` / `PlanViewNameDialog`；
  - 事项编辑：`PlanItemDialog` / `PlanItemAttachments` / `PlanItemCapsuleRow` / `CustomFieldsEditor`；
  - 任务/资产：`TasksPane` / `AssetsPane` / `AssetFileTable` / `AssetUploadDropZone`；
  - 项目与配置：`ProjectChatBar` / `ConfigPanel` / `CreateProjectDialog` / `ProjectCard` / `InstructionEditDialog` / `PickerDialog` / `CapabilityRow` / `RemovableTag` / `HandoverDialog`；
- `model/` 4（`plan-view-engine` 兼容层 / `use-plan-views` / `project-templates` / `plan-date`）；
- `api/` 4（project / plan-item / plan-view / asset）；
- `store/` 1（`plan-advance.store`）、`lib/` 1（`task-session`）。

### 4.2 服务端（apps/tianshu-server）——无项目域；workspace 模块与项目的关系

**server 侧没有项目概念**。`src/modules/workspace/workspace.service.ts` 是无头端**自身**的工作空间数据面（HD-A1 被控端工作空间透出 + A8 写面，spec 2026-10-26 §1.2）：

- `WorkspaceService.query/create/update/delete` 四方法，透出 `WorkspaceBrief` 概要四字段（id/name/directoryPath/defaultModelId）——**projectId 字段刻意不外露**（服务头注释明示"icon/审计字段/writeApprovedAt/projectId 不外露"）。
- `COMPANION_USER_ID` 单用户读写自有行；重名收口稳定码 `WORKSPACE_NAME_DUPLICATE`/`WORKSPACE_INVALID`；delete 事务化硬级联 message→session→workspace 行 + 清 toolPermission 记忆行，不删磁盘；写后 `workspace.changed` 事件刷新（EventBusService）。

即：桌面端项目资产空间虽是带 projectId 的 workspace 行，但远程透出时被过滤掉（不进 workspace 分组树）；项目数据远程化改走 A7 专用通道。桌面被控面 `electron/domains/server-face/` 四个 tap 桥接（复用主进程 repo 单实例——Application 注入，严禁 face 侧二次构造，构造函数会重复注册 IPC handler）：

- `project-tap.ts`：`createProjectFace` 六端点（query/getDetail/create/update/remove/listMembers）；getDetail 只回 `sessionId` 不泄完整 SessionRecord（聊天形状不耦合）；repo 稳定码转 `FaceProjectError`（routes 侧 bizError 信封，控制端按码提示）。
- `plan-item-tap.ts`：`createPlanItemFace` 十端点桥（repo 自带 userId 校验/枚举校验/成员资格校验，tap 只做 userId 前置序适配）。
- `plan-view-tap.ts`：只读桥 `createPlanViewFace`——逐方法先经 `ProjectRepository.assertProjectVisible` 守卫（补 `PlanViewRepository` 历史裸暴露无 userId 参数的缺口），守卫集中单测全覆盖。
- `project-asset-tap.ts`：资产空间桥。

协议 DTO 单份在 `packages/tianshu-protocol/src/project-contract.ts`（A7 批自桌面 entity 收编）：远程载荷剔除 ownerId/createdById（身份唯一来源 withUserId）；`ProjectDetailResult` 只带 sessionId；含全部 plan 枚举常量（`PLAN_STATUSES`/`PLAN_PRIORITIES`/`PLAN_SOURCES`/`PLAN_VIEW_TYPES`/`PLAN_GROUP_BYS`/`PLAN_FIELD_TYPES`）与稳定错误码 `PROJECT_ERROR_CODES` 七枚（PROJECT_NOT_FOUND/PROJECT_NAME_EXISTS/PLAN_ITEM_NOT_FOUND/PLAN_VIEW_LAST_ONE/ASSET_PATH_ESCAPE/ASSET_NOT_FOUND/ASSET_NAME_INVALID）。

### 4.3 移动端（apps/tianshu-mobile）——遥控页面（A7 批）

**有项目页面**，经 direct/relay transport 遥控桌面端被控面：

- `src/app/projects/index.tsx`（hub，693+ 行）：PageHeader + 搜索 + 分段 [项目|我的任务]。项目 Tab：项目卡（名称/指令摘要一行/相对更新时间），点击 push 工作台，长按/⋯ 出操作面板（重命名/编辑指令/删除——Alert 二键确认，文案明示级联删资产/会话/计划/视图/自动化）；`DialogShell` 新建（名称+指令可选，含 `DEFAULT_TEMPLATE_KEY` 模版集）。我的任务 Tab：范围（all/assigned/created）/来源（all/local/project）chips + 标题过滤（store 内纯前端）+ 行列表（状态点/优先级色点/所属项目名，本地显示「本地」）。页内双重门禁：无连接/无 `project` 能力 → 降级引导页。
- `src/app/projects/[id].tsx`（工作台，1054+ 行）：分段 [计划|资产|关于]。计划 = 激活视图 chips（`parseViewConfig` 条件+排序经 core 引擎过滤排序）→ **groupBy 固定 status 分组**（不可切）→ 拍平为 FlatList 条目（组头行/事项行/组尾「+」快速新建行——遵循折叠组拍平虚拟化铁律：行级 memo、行上禁 flex-1）；事项行 = 标题/优先级色点（P0 语义红/P1 主题色/P2/P3 中性灰）/处理人昵称/截止 MM-dd；点击进 `PlanItemDialog`（全字段+自定义字段+附件）。资产 = 面包屑+用量条+行列表；图片 `readAssetImage` 弹层预览、文本走 `FilePreviewModal`（files/read + assetWorkspaceId），其余类型 toast 引导桌面端。关于 = 指令只读卡 + 成员列表 + bindings 只读清单（valid=false 置灰标注）。
- `src/store/project.store.ts`（781+ 行）：hub/tasks/detail/plan/assets 五面 store；请求前经请求序号 + activeConnId + transport 三重防迟到校验 + project 能力/连接前置门禁；写面 `enqueueWrite` 串行、写后局部刷新。**身份注记：wire 协议不透出当前用户 id**——`listMine` 结果按 assigneeId/createdById 众数推断 currentUserId（"指派给我 OR 我创建"的二元组里「我」必为众数）；推断不出（空列表）时范围过滤退化为启发式。
- 传输层 `src/transport/`（`direct-transport.ts`/`relay-transport.ts`/`wire.ts`），项目域 API 请求复用 `ENDPOINTS`。

## 5. 业界主流做法对比

| 维度 | GitHub Projects/Issues | Linear | Notion | Jira | AI IDE（Cursor / Claude Code） | 天枢项目模块 |
|---|---|---|---|---|---|---|
| 容器模型 | repo/org → Project | team → project（跨 cycle 组织） | page → database | project → board | workspace = 目录根（打开即项目） | project 六合一容器（指令+资产+能力+计划+会话+自动化） |
| 工单层级 | issue 平铺 + 新式 sub-issue | issue + subissue + relations | database 行即页，页面树无限层级 | epic → story → subtask 强层级 | 无工单概念 | **planItem 扁平无层级**、无依赖关系 |
| 多视图 | table/board/roadmap | saved Views（filter+sort+group 可存可分享） | database 多视图（table/board/calendar/gallery/list/timeline），单数据多视图 | scrum/kanban board + JQL 强筛选 | 无 | **planView 五视图 + filterJson/sortJson/groupBy 可存配置**，引擎协议化三端复用——与 Linear Views/Notion view 同构 |
| 项目-资源绑定 | issue/PR 天然归 repo | issue 手动/规则归 project | 行属页面树 | issue 归 project + components | 文件天然属目录 | **projectBinding 三类 AI 能力源 + workspace 行挂资产空间 + session.planItemId 挂任务会话**——「把 AI 能力挂进项目」是独有维度 |
| 项目记忆/规则 | 无 | 无 | 无 | 无 | `.cursor/rules` 目录 + 项目 memories；CLAUDE.md + 全局/项目 memory 分层 | `project.systemPrompt` 单文档 + 四模版 prompt；aiSummary 逐事项进展；**memory.md 交接自动沉淀（批8）注入会话上下文** |
| 协作权限 | org/team/role 细粒度 + issue 级 assignee | team 角色（admin/member/guest） | 页面级 share + 权限矩阵 | project role + 工作流权限 | 无多人概念 | owner/member 两值；数据模型先行，**邀请/移除入口未开**；成员写计划仅查可见性 |
| AI 写入面 | Copilot 建议（人确认） | Linear Asst（排序/去重/摘要） | AI 填属性/写页 | Atlassian Intelligence（问答为主） | agent 全权写工作区 | **todo_write/todo_read 人机共享清单**：AI 只增不删（防误删人类任务）、进展只追加、写走审批门禁——人机分界比业界更明确 |

逐项展开：

- **GitHub Projects/Issues**：资源容器是 repo（issue/PR 天然归属），Project 是跨 repo 的聚合视图层（table/board/roadmap）；协作靠 org/team 角色体系。天枢对照：项目本身就是一等容器（六合一），planView 承担了其 Projects 的视图职责；缺少的是 issue 的 label/milestone 这类轻量横切维度（天枢 tags 字段已有，milestone 无对应物）。
- **Linear**：plan（项目）→ cycles（时间盒）→ issues，Views 是「保存的 filter+sort+group」且可分享、支持 subissue 与 relation（blocks/blocked-by）。天枢的 planView 配置面与 Views 同构（filterJson/sortJson/groupBy 三件套），但无 cycle 时间盒、无 subissue 层级、无分享；Linear 的 Triage 收件箱在天枢对应「AI 建任务默认未指派 → 人指派」的分工流，已有雏形。
- **Notion**：database + view 的「单数据多视图」模型是天枢 planView 的直接同款（五视图类型集合也接近，Notion 多 gallery/timeline 少 gantt）；自定义属性类型（text/number/date/select/relation）对照天枢自定义字段三类型（text/number/date）——缺 select 单选与 relation 关联字段。
- **Jira**：epic → story → subtask 强层级 + scrum/kanban 双板 + sprint + JQL。天枢刻意选了扁平模型（单表双视图），换来 A7 移动端遥控链路的协议简单性；JQL 级强查询语言在天枢由结构化 filterJson 承担，表达力够用但不可组合嵌套（无 OR 条件）。
- **AI IDE（Cursor/Claude Code）**：workspace=目录根，项目记忆走 `.cursor/rules`（分层 rule 文件）与 CLAUDE.md（手写约定）+ memory 目录沉淀。天枢 `project.systemPrompt` 等价于手写 rule 层，且多了「绑定专家/技能/连接器」的运行时能力预设（业界 IDE 的等价物 .mcp.json 不进 prompt 声明）；差距在记忆自动沉淀与分层装载。

小结：天枢 planView 的「单表 + 保存视图」与 Linear Views / Notion database view 完全同构，且筛选/排序/分组引擎已下沉 `@tianshu-core` 三端单份，这点上不落后；主要差距在（a）工单层级与依赖（无 subtask/dependsOn，甘特无依赖线）、（b）时间盒（无 Linear cycle / Jira sprint 对应物）、（c）协作权限深度（成员入口未开）。项目级记忆自动沉淀批8 已落第一层（交接触发的 memory.md + 双层上下文注入），对流结束级自动沉淀与 artifact 产物聚合入口仍是后续空间。

## 6. 改进空间（按优先级，均可落地）

**P0 项目级上下文/记忆沉淀**。✅ 已落地（批8，2026-11-05）。`HandoverDialog` 确认交接时把「决议（AI 五段式交接摘要）+ 产出物索引（附件 assetPath）」回写资产空间固定文件 **`memory.md`**（IPC `project:appendMemory` → `ProjectRepository.appendMemory`；条目以 HTML 注释标记行锚定、追加在尾、超 20 条裁最旧，纯函数件 `electron/domains/project/project-memory.ts`）；`getPromptContext` 尽力读入 memory.md 正文（`memoryMarkdown` 字段，缺失/空为 null），`buildProjectSystemBase` 拼装为「项目记忆」段（指令 → 挂载专家 → 会话助手 → **记忆** → 预设能力声明），形成「指令（人写）+ 记忆（AI 沉淀）」双层上下文。回写 fire-and-forget 失败静默不阻塞交接主流程；system 注入侧有 8000 字符预算（整段取舍保最新）。选择 memory.md 而非 AGENTS.md：AGENTS.md 业界语义是「给人/agent 的指令约定」，与项目 systemPrompt（人写指令层）职责重叠；memory.md 表达 append-only 的 AI 沉淀层更准确。artifact 表按 workspaceId 隔离的项目产物聚合入口未做（后续批）。

**P1 成员协作写面**。现状：`projectMember` 只有 `listMembers` 读通道，无 add/remove/改角色 IPC，多人协作进不去；且 `list` 仅返回 owner 的项目（成员可见的项目不出现在 Hub 列表）；planItem 写面只查项目可见性（成员=owner 权限）。落地：`project.repo.ts` 增 `project:addMember/removeMember/setMemberRole`（owner 专属，复用 `assertProjectOwned`），`list` 改为 `OR: [ownerId=me, member=me]` 联查；成员角色对 planItem 写面的收口（member 只读或可改自己指派的行）随权限模型一并裁定。

**P2 项目操作接入安全审计**。✅ 已落地（批8，2026-11-05）。`securityAuditLog` 基础设施（`electron/domains/security/audit/audit-log.service.ts`，eventType 前缀归类 + hash-chain 防篡改）经安装式 sink 接入项目域（`ProjectRepository/AssetRepository.installAuditSink`，Application 装配，缺席静默——terminal 同款模式）：`project.removed`（删除项目不可逆级联，detail 携项目标识）、`project.bindingChanged`（挂载 diff 按 `itemType:itemId` 键留痕 added/removed）、`projectAsset.deleted`（资产删除）三类事件。前缀归类经 `categoryOf` 显式覆盖表扩展：`project.removed`/`projectAsset.deleted` → `data-safety`，`project.bindingChanged` 走缺省 `config`。

**P3 附件死链治理**。✅ 已落地（批8，2026-11-05，「并做」双保险）。① delete/rename 反查：`asset.repo.ts` 删除后按 assetPath 反查级联解绑（文件精确/文件夹前缀，按本项目事项 id 集圈定防跨项目误伤，失败仅记日志不阻断删除）；改名后关联 `assetPath` 同步迁移（含 uniqueName 最终名与文件夹前缀平移）。② 读取失效态：`planItem:attachments:list` 逐行校验存在性置 `valid`（资产根下 `existsSync` 探测；文件缺失 → false），桌面 `PlanItemAttachments` chip 灰显 + 删除线 + title 死链提示（移动端 bindings `valid=false` 置灰同款先例；协议 DTO `PlanItemAttachmentRecordDto` 透传该字段，移动端 UI 消费留后续）。

**P4 plan 体系扩展**（均可落在既有单表/引擎上，无需新表）：
- planItem 增 `parentId` / `dependsOn` 支持子任务与甘特依赖线（对齐 Linear subissue / Jira epic-story）；
- 默认视图持久化（`?viewId=` 现不记忆，重启回第一个视图——可存 option 表 `planDefaultView:<projectId>`）；
- 看板 WIP 列限制（视图级配置，存 planView 新 JSON 列或并入 filterJson 扩展位）；
- 时间盒（cycle/sprint）可作 `filterJson` dueDate 区间条件的语法糖低成本试做。

**P5 移动端计划配置面**。现状：groupBy 固定 status、视图不可增改（协议面 `planView:list` 只读桥已支持列表，`PLAN_GROUP_BYS` 协议常量已透出）。低成本放开分组切换；视图配置编辑建议仍留桌面端（移动端输入成本高）。

**P6 能力挂载失效项清理**。✅ 已落地（批8，2026-11-05）。`ConfigPanel` 能力挂载区块在存在 `valid=false` 挂载时出现提示行（N 项失效挂载）+「清理失效挂载」按钮：前端过滤 valid 项经 `setBindings` 全量替换通道回写（成功 toast 携清理数）；单行 X 显式移除保留（编辑不静默丢弃的 Task 6 裁定不变）。
