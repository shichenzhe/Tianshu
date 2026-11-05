# 专家与专家团技术方案

> 调研基线：main 995bf652（2026-11-05）。路径约定：桌面端路径相对 `apps/tianshu-desktop/`，server 端相对 `apps/tianshu-server/`，共享包相对 `packages/`。

## 1. 模块定位与总览

**专家（Expert/Assistant）= 一行人设配置**。`assistant` 表一行即一个专家：systemPrompt（五段式人设）+ 模型调参覆盖（temperature/topP/maxTokens）+ 附带技能（skillNames ≤3）+ 推荐提示词（quickPrompts ≤3）。专家不是独立进程或独立模型，而是 chat 请求组装期的一段配置注入。

**专家团（Team）= 多专家协作机制**。`expertType="team"` 的专家行携带 1-13 名 `TeamMember`（members JSON 列）。绑定专家团的会话中，system 换为「主理人组装」（成员清单 + 协作铁律 + 工具说明），并注入 `dispatch` 内置工具——主理人按成员 id 调度成员做单轮非流式补全，产出原文回喂主理人统筹。是**主理人-成员（lead-member）模式的 prompt 驱动 supervisor**，非 subagent 派生（成员无工具、无会话历史、无落库）。

**技能（Skill）= 可挂载能力包**。数据根 `~/.tianshu/<分组>/skills/`（`electron/commons/paths.ts` 的 `skillsDir()`）下含 `SKILL.md` 的子目录，frontmatter 仅认 `name/description` 两字段。渐进披露：system 只注入「技能名: 一句话描述」清单段，正文经 `read_skill` 工具按需读取。

**连接器（Connector）= MCP 服务器的产品化皮**。`mcpServer` 表 + 连接器市场（24 卡片）+ 自定义连接器弹窗，底层是 stdio/HTTP 双 transport 的 MCP 客户端，工具以 `mcp__<server>__<tool>` 前缀注册进聚合 registry。

| 概念 | 数据载体 | 管理入口（桌面） | 运行时注入点 |
|---|---|---|---|
| 专家 | `assistant` 行 | `/module/ai/experts`（`ExpertsView`） | `assembleContext` 的 system 槽位 + 参数合并 |
| 专家团 | `assistant.expertType/members` | 同上（`AssistantDialog` team 态） | `buildTeamLeadSystem` + `dispatch` 工具 |
| 技能 | 文件系统 + `skillRecord/skillStat` | 同页「技能」Tab（`SkillsView`） | system 技能清单段 + `read_skill` 工具 |
| 连接器 | `mcpServer` 行 | 同页「连接器」Tab（`ConnectorMarketView`） | `mcp__*` 工具注册进 `tool-registry` |

三者在 `/module/ai/experts` 一页统管（`src-react/domains/ai/experts/views/ExpertsView.tsx`，Tab：assistants/skills/connectors，URL 参数 `?tab=skills|connectors` 直达、专家 Tab 另有 `?view=market|mine` 子视图态），路由注册于 `src-react/routes/index.tsx` 的 `path: "experts"`（懒加载 L45）。

桌面端文件分布速览（后端在 `electron/domains/ai/`，专家仓储落在 chat 域而非独立 assistant 域；前端管理页在 `src-react/domains/ai/`）：

```
electron/domains/ai/
├── chat/assistant.repo.ts     专家仓储（IPC/导入导出/工具装配）
├── chat/expert-team.ts        TeamMember 类型源 + 主理人 system 组装（纯函数）
├── chat/expert-catalog.ts     parseJsonStringArray + mergeExpertSkills（纯函数）
├── chat/chat.service.ts       assembleContext/collectToolDefinitions/memberModelText
├── agent/create-expert.ts     create/update_expert 工具 + 成员校验常量单源
├── agent/recommend-expert-tool.ts  list_experts/recommend_expert 两跳推荐
├── agent/dispatch-member-tool.ts   专家团调度工具
├── agent/skill-loader.ts      SKILL.md 扫描与 frontmatter 解析
├── agent/skill-prompt.ts      system 技能清单段注入
├── agent/read-skill.ts        read_skill 渐进披露工具
├── skill/                     skill.repo/installer/hub/stats/builtin/archive/sync
├── mcp/mcp.repo.ts            mcpServer 仓储
└── agent/mcp-manager.ts       MCP 连接与 mcp__* 注册（工具面预算折叠）
```

## 2. 数据模型

### 2.1 assistant 表（`prisma/schema.prisma` L74-97）

```
model assistant {
  id           Int      @id @default(autoincrement())
  name         String
  icon         String?            // 单个 emoji（写面 EMOJI_RE 校验，UTS51 宽松）
  systemPrompt String             // 五段式：角色/能力/流程/输出/注意事项
  temperature  Float?             // 三参数为模型缺省的会话级覆盖
  topP         Float?
  maxTokens    Int?
  builtin      Boolean  @default(false)   // 删除守卫 ASSISTANT_BUILTIN；list 排序置顶
  description  String?
  tags         String?            // JSON 数组字符串列（≤3）
  sourceSlug   String?            // 市场来源 slug（可回溯）
  profession   String?            // 职业头衔（30 字内）
  quickPrompts String?            // JSON 数组字符串列（≤3）
  categoryId   String?            // 市场 12 分类 id（如 "06-ContentCreative"）
  skillNames   String?            // JSON 数组字符串列（≤3，限已安装技能）
  expertType   String?            // agent | team；NULL = 默认单专家
  members      String?            // TeamMember[] JSON（team 时有效）
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  userId       Int?               // v12 多用户隔离
  @@index([userId], map: "assistant_userId_index")
}
```

列契约：`expertType` 只存 `"team"|NULL`（"agent" 归一不写列，写面三处同口径：repo `create`/create_expert 工具/导入）；数组列坏 JSON 一律防御性回退空数组（展示/清单字段，行存在即不应让 send 失败）。

### 2.2 技能双表

- `skillRecord`（L185-198）：`name @unique`/`slug`/`version`/`source`（builtin|market|import|create…）/`dir`/`description`/`enabled`/`scenarios`（JSON 数组，场景打标）/`installedAt`/`updatedAt`。文件系统是事实源，DB 行是登记与启停状态——`skill:list` 每次做「扫描→比对→落库→返回」自愈对账（`skill-sync.ts` 的 `syncSkillRecords`）。
- `skillStat`（L199-208）：事件流埋点，`event` 枚举 `install|enable|disable|uninstall|batch_enable|batch_disable|batch_uninstall|create`（**无 use/读取事件**）；索引 `@@index([name, createdAt])` 由 `ensureEventStatMaintenance` 启动幂等补建（不走 v1 快照，避免快照 sha256 指纹变化触发旧库 drop 重建）。

### 2.3 连接器表

```
model skillRecord {
  id          Int      @id @default(autoincrement())
  name        String   @unique       // 与 frontmatter name 一致（去重键）
  slug        String?                // 市场来源 slug
  version     String?
  source      String                 // builtin | market | import | create …
  dir         String                 // 技能条目目录（卸载越界校验锚点）
  description String?
  enabled     Boolean  @default(true)
  scenarios   String?                // JSON 数组：场景打标（daily/coding/design）
  installedAt DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model mcpServer {
  id        Int      @id @default(autoincrement())
  name      String                 // 与市场 id 判等（已添加判定键）
  transport String                 // stdio | http
  command   String?                // stdio 三件
  args      String?
  env       String?
  url       String?                // http 两件
  headers   String?
  enabled   Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  userId    Int?
  @@index([userId], map: "mcpServer_userId_index")
}
```

- `toolPermission`（L176-183）：`workspaceId + toolName` 唯一（`idx_tool_permission_ws_tool`），工作空间级工具审批记忆（「不再询问」，server 侧同构移植：approve remember 写入 + isToolAllowed 查表免审）。

### 2.4 会话关联

`session` 表（L115-141）持 `assistantId Int?`（绑定专家）、`mode`（agent|ask|plan）、`scenario`（场景标记）、`compactedUpToId/summary`（压缩态）、`projectId`（项目会话判定——`projectId != null` 即项目会话，plan_* 工具注入属地依据）——这些列共同决定专家在请求组装期的注入形态。

### 2.5 共享包类型与市场数据（单源）

- `packages/tianshu-protocol/src/expert-contract.ts`：`ExpertTeamMemberDto`、`AssistantSavePayload`（三态写面）、`ExpertMarketSummary/ExpertMarketDetail`（marketList 概要不带 systemPrompt，避免全量下发长 prompt）；`server-event.ts` 定义被控面 WS 通道 `assistant/query|detail|save|delete|marketList|marketDetail|export|import`。
- `packages/tianshu-core/src/expert-market/`：市场数据本体（12 分类分片 `marketplace/expert-01-product-design.ts` … `expert-12-industry-consulter.ts`），聚合导出 `MARKET_EXPERTS`（59 条，其中 `type:"team"` 团队 10 条）、`EXPERT_CATEGORIES`（12）、`SCENARIOS`（6 场景，`expertSlugs` 引用完整性编译期校验）、纯函数 `toCreateParams(item)`（team 条目透传 `expertType:"team"+members`）。桌面 `src-react/domains/ai/experts/data/marketplace.ts` 原位 re-export 保持旧导入路径。
- `TeamMember` 类型唯一源在桌面 `electron/domains/ai/chat/expert-team.ts`，前端经相对路径 type-only 跨层引用（`assistant.api.ts`/`AssistantDialog.tsx`）；移动端消费协议包 `ExpertTeamMemberDto`（同形不同名，bridge 双端各自契约）。

## 3. 核心技术方案

### 3.1 专家定义与运行时组装

**定义面（仓储）**：`electron/domains/ai/chat/assistant.repo.ts` 的 `AssistantRepository`——IPC 通道 `assistant:list|create|update|delete|export|import`（`handleUser` 解 userId 隔离）。模块顶层零重依赖副作用（prisma 惰性单例 `prismaClient()`，dialog 方法内惰性 import——rolldown 打包后模块顺序不可依赖）。关键函数：

- `toRecord(row)`：DB 行归一（可空列转 undefined、数组列经 `parseJsonStringArray`、`expertType` 仅 `"team"` 透传、`members` 经 `parseTeamMembers`）。
- 导入导出：`serializeExpert/parseExpertJson`（zod schema `expertExportSchema`：`kind:"tianshu-expert"+version:1` 魔术标识，10 内容字段；`superRefine` 复用 `validateTeamMembers` 集合校验——与工具链同一函数 DRY 单源）+ `dedupeName`（`${name}-2/-3` 递增查重闭包）+ `filterImportableSkills`（skillNames 剔除未安装，与 create_expert 工具同口径）。
- 归属校验：`requireOwned(id, userId)`（不存在与越权同报错，不泄露存在性）；被控面读口 `getOwned(id, userId)`。
- 构造器装配专家工具组：`registerExpertTools()` 把 `create_expert/update_expert/list_experts/recommend_expert` 注册进聚合 registry（`listInstalledNames` 由 Application 启动序注入 skillRepo 已安装清单）。

**对话式创建/修改**：`electron/domains/ai/agent/create-expert.ts` 的 `makeCreateExpertTool/makeUpdateExpertTool`（WorkBuddy expert-manager 移植）——`kind:"write"` 走统一审批（`runToolCall` 挂起，批准后才 execute），错误一律转 `错误: ...` 字符串回喂模型不抛出；userId 取自工具 ctx（会话归属用户）。成员校验常量 `TEAM_MEMBER_ID_RE/TEAM_MEMBERS_MAX(13)/TEAM_MEMBER_ID_MAX(64)/teamMemberSchema/validateTeamMembers` 导出为工具/导入/IPC 三写面单源；跨字段校验 `validateTeamFields`（members 仅 team 可带、team 必带 1-13 员、update 差量不强求）。

**专家推荐**：`recommend-expert-tool.ts` 两跳组（2026-11-01 目录出 system 批）——`list_experts` 无参返回内置专家目录文本（`slug｜名称（头衔）：描述`，数据源 `MARKET_EXPERTS`），`recommend_expert` 依目录渲染推荐卡（candidates slug 1-3 + reason，未知 slug 剔除防幻觉，前端 `ExpertRecommendCard` 消费）。注入条件 `allowExpertRecommend`（chat.service.ts L1751）：agent 模式且未绑专家（team 助手亦为绑定态）——工具不在=目录不在，推荐能力同生同灭。

**运行时组装**（核心函数 `ChatService.assembleContext`，`electron/domains/ai/chat/chat.service.ts` L2084-2307，`chat:send` 与用量拆解共用同口径）：

1. **定位模型**：`session.getEffectiveModelId` → `prisma.model/provider` 行；上下文窗口三层兜底 `effectiveContextWindow`（model 显式 > provider 级默认 > `DEFAULT_CONTEXT_WINDOW=131072`）。
2. **参数合并**：`mergeParams([模型行缺省, assistant 行覆盖, 会话 overrides])`——专家调参压过模型缺省。
3. **历史读取**：压缩态（`compactedUpToId` 下推 SQL `id gt`）过滤 error 行；`withTimeBlock` 时间行注入最后一条 user 消息 blocks 头部（随请求刷新、system 与历史保持逐字节稳定以利前缀缓存）。
4. **base system**：非项目会话 = `assistantRow.systemPrompt`；项目会话 = `buildProjectSystemBase(项目指令+挂载专家声明, base)`（专家 prompt 嵌入助手槽位而非替换项目段）。
5. **技能并入**：`mergeExpertSkills(启用集, parseJsonStringArray(assistantRow.skillNames), 全扫描集)`（`chat/expert-catalog.ts`，并入 = `skills ∪ (allSkills ∩ skillNames)` 保序追加）——绑定专家即显式激活，未启用可补入、已卸载静略；项目会话挂载收窄优先不并入。
6. **模式包裹**：`buildModeSystem(mode, base, skills)`（ask 零工具零技能零扫描 / plan 追加指令段）→ `buildPersonalizedSystem`（persona 前置+行为段后置，全默认时逐字节还原）→ `buildScenarioSystem(session.scenario, …)`（场景提示段居末）→ 压缩态追加 `【此前对话摘要】`。
7. **工具集**：`collectToolDefinitions`（L1758-1841）——registry 聚合定义（+每请求构造的 `makeReadSkillTool(skills, onRead)` 与 dispatch）→ 未绑目录白名单过滤（`mcp__` 前缀、bash、library_search、search_history、`browser_*` 前缀、create_skill、工作流五件、create_schedule、widget、create/update_expert、推荐组——用户级能力不依赖工作空间）→ 项目专属 `PLAN_TOOL_NAMES` 非项目会话剔除 → `filterToolsBySession`（场景门控）→ `filterDisabledTools`（安全中心单名禁用=对模型不存在，闭包实时读）。

**专家目录段已删**（2026-11-01 批）：原 system 固定目录段（~2970 字符/每轮，86% 固定开销）改为随 `list_experts` 工具结果两跳注入——未绑专家 agent 会话每轮省全额目录成本，仅推荐真实发生时经工具结果付一次性代价。

**选用入口**：

- 新建任务落地页：`new-task/store/new-task-store.ts` 的 `assistantId` 草稿（不持久化，resetDraft 清）→ `new-task/lib/dispatch.ts` 在 `SessionApi.create({workspaceId, scenario})` 后 `SessionApi.setAssistant(created.id, assistantId)` 落库再 send（默认值跳过省两次 IPC）。
- 会话中切换：`chat/components/expert-sub-menu.tsx`（＋菜单「专家」二级浮层，搜索过滤+单选，双模式——会话模式写 `session:setAssistant`，草稿模式 `onPick` 纯前端暂存供新建任务页对齐）；底部「召唤更多专家」跳 `/module/ai/experts?tab=assistants`。
- 空会话 `ExpertPromptChips`（quickPrompts 胶囊，点击填入输入框可编辑后发送；展示条件：专家存在 && 有 quickPrompts && 会话尚无 user 消息）。

### 3.2 专家团协作机制

**类型与组装**（`electron/domains/ai/chat/expert-team.ts`，纯函数零依赖直测）：

- `TeamMember { id, name, profession, systemPrompt }`——id 为调度引用键（kebab-case，如 risk-officer），其余为展示与人设。
- `parseTeamMembers(raw)`：坏 JSON/非数组回退 `[]`，元素缺任一必填字段剔除（与 `parseJsonStringArray` 同为防御性解析，但管对象数组需逐字段形状校验，故独立实现）。
- `buildTeamLeadSystem({leadPrompt, members, withDispatch})`：四段以空行拼接——主理人 prompt 原文 →【团队成员】（`调度成员时传成员 id：` + 每行 `- id｜花名（职业头衔）`）→【协作铁律】→【工具说明】。空成员返回 null（调用方回退裸 prompt）；空 leadPrompt 跳过首段；`withDispatch=false` 时铁律段与工具说明整体缺席（dispatch 被安全中心禁用时 system 与工具集同缺席，成员清单保留展示语义——对齐目录段 G1 门控读法）。

协作铁律四条（`TEAM_LEAD_RULES_HINT`，spec 二期原文）：

```
1. 严禁主理人代写成员产出：必须真实调度成员取得分析，不得虚构、替代或改写成员观点。
2. 分阶段推进，上一阶段成员产出原文完整传入下一阶段调度的 context；同一阶段内
   无数据依赖的成员，应在同一次回复中并行调用 dispatch（为每位成员写独立的任务
   简报），全部回传后再进入下一阶段。
3. 成员只对主理人回传结论：主理人统筹汇总后再形成面向用户的回答。
4. 面向用户的输出使用用户的语言。
```

**调度工具**（`electron/domains/ai/agent/dispatch-member-tool.ts`，工具名常量 `DISPATCH_MEMBER_TOOL_NAME = "dispatch"`）：

- 参数 schema：`{member（≤64，成员 id）, task（1..2000，本轮任务简报）, context?（≤8000，前序阶段产出原文）}`。
- `kind:"read"` 免审批——只发起模型调用、无文件/系统副作用。
- 执行：精确匹配成员 id（查不到回 `错误: 团队中不存在成员「X」，可用成员：...` 文案，不触模型调用）→ `deps.modelText({system: member.systemPrompt, prompt: buildMemberPrompt(task, context)})`——`buildMemberPrompt` 两段组装（`【任务】`必选 + 有 context 时 `【前序阶段产出】`），**产出原文直返（截断/汇总由主理人统筹），不落库不外显**；成员执行失败转 `错误: 成员「name」执行失败（message）` 回喂。
- 模型装配：`ChatService.memberModelText(modelRow, providerRow)`（chat.service.ts L1850）——`createChatModel` + LangChain `chat.invoke([SystemMessage, HumanMessage])` 非流式补全，`AbortSignal.any([会话中止信号, AbortSignal.timeout(120_000)])` 先到先断（120s 熔断：成员单轮任务重于交接摘要的 30s，子 agent 独立分析可深推理）；`aiMessageContentToText` 抽文本。成员**复用会话当前模型与 provider**（不持独立模型绑定）。
- **受控并行的真实并行性**：主循环引擎为 `createReactAgent + ToolNode`（`packages/tianshu-core/src/run-chat-stream.ts`，RC-T4 入包），LangGraph ToolNode 对同一条 AI 消息内的多个 tool_call 并发执行——铁律 #2 的「同一次回复中并行调用 dispatch」由此兑现，同阶段多名成员补全真实并发。
- 工具**每请求构造**（`collectToolDefinitions` L1813：`makeDispatchMemberTool(team)`）——deps 持当次成员清单、当次会话中止信号（streamAndPersist 调用点补入）与 modelText 闭包，与注册进 registry 的静态工具不同生命周期。

**注入门控矩阵**（assembleContext L2210-2241）：

| 会话态 | teamLeadSystem | dispatch 工具 | 铁律/工具说明段 |
|---|---|---|---|
| team + 有成员 + agent/plan 模式 | 四段完整 | 注入 | 有 |
| team + 有成员 + ask 模式 | 成员清单段 only | 不注入（ask 零工具） | 无 |
| team + 有成员 + dispatch 被安全中心禁用 | 成员清单段 only | 不注入 | 无（`withDispatch=false`） |
| team + members 坏数据/空 | null → 回退裸 prompt | 不注入 | — |
| agent 专家/未绑专家 | 无此段 | 不注入 | — |

判别用 `assistantRow.expertType === "team"`（而非 members 非空——agent 行也有该列）；`runtimeFilter()` 读安全中心 `BUILTIN_TOOLS/disabledTools`。

**三写面一校验链**：桌面表单 `AssistantDialog.tsx`（agent/team 类型切换，team 态 1-13 成员行四字段编辑，`TEAM_MEMBER_ROW_MAX=13` 前端自持同值；提交差量语义 `team→agent` 显式 `members:null` 清列）；导入 JSON 随团透传（`expertExportSchema` 同 schema）；市场 10 个团队条目（如 `ai-content-creator-team` 主理人+成员人设全文，WorkBuddy agents 原文复刻）经 `toCreateParams` 一键落库。三路最终都汇 `AssistantRepository.create/update` 的 `assertMembersValid`（逐员 `teamMemberSchema` + 集合 `validateTeamMembers`，与工具链同一函数）。

**一轮专家团会话的完整时序**（以「内容创作专家团」两阶段为例）：

```
用户输入 → chat:send
  → assembleContext：
      teamMembers = parseTeamMembers(assistant.members)        // 2 名成员
      teamLeadSystem = buildTeamLeadSystem({leadPrompt, members, withDispatch:true})
      base = teamLeadSystem（嵌入助手槽位，项目会话再包项目段）
      system = buildScenarioSystem(...buildPersonalizedSystem(buildModeSystem(...)))
  → collectToolDefinitions：makeDispatchMemberTool({members, abortSignal, memberModelText})
  → runChatStream（createReactAgent 循环）：
      第 1 轮 AI 输出 2 个 dispatch tool_call（同阶段并行，ToolNode 并发执行）
        dispatch({member:"copywriter", task:"写初稿..."})
          → modelText({system:成员人设, prompt:【任务】...}) → 120s 内非流式补全 → 原文作 ToolMessage 回喂
        dispatch({member:"editor", task:"审校角度评估..."})   // 与上并发
      第 2 轮 AI 输出 1 个 dispatch（第二阶段，context=上轮产出原文）
      第 3 轮 AI 汇总输出 → 面向用户的最终回答（铁律 #3/#4）
  → streamAndPersist 落库（成员产出不落库不外显——改进点见 §6 P1）
```

**已知边界（如实）**：无头服务端 chat-runner **不移植**专家团调度（`apps/tianshu-server/src/core/chat-runner.service.ts` 头注释「专家目录与专家团（recommend_expert/dispatch）不移植」）——远程会话绑定 team 专家时仅以主理人 systemPrompt 作普通单专家 base（L1125 `buildModeSystem(mode, assistantRow?.systemPrompt, skills)`），无铁律段无 dispatch 工具；server 亦不做 `mergeExpertSkills` 专家附带技能并入（桌面独有，尽管 server 保留同名 `expert-catalog.ts` 双份）。移动端因此对远程 team 专家只能编辑定义，不能体验调度。

### 3.3 技能系统

**格式与发现**（`electron/domains/ai/agent/skill-loader.ts`，纯 Node fs 同步、禁止 import electron、vitest 直测）：

- 条目 = 目录下含 `SKILL.md` 的子目录；`parseFrontmatter` 只提取 `name/description`（`---` 包裹、`FIELD_RE = /^(\w+):\s*(.+)$/` 行解析、缺一跳过该技能）；同名（按 frontmatter name，目录名不一致以此为准）后者忽略；点前缀隐藏目录（如 crash 残留 `.staging-*`）不扫防幽灵技能抢占真名。
- 性能：`readHead` 只读 4KB 头部（`FRONTMATTER_PEEK_BYTES=4096`，闭合块在头部内即止，超限未闭合畸形块回退全读）——chat:send 热路径每次组装全扫，技能目录小扫描快。
- 目录源（`ChatService.collectSkills`，L1885）：用户级 `skillsDir()` 在前 = 优先级高，工作空间级 `path.join(workspaceDir, ".tianshu", "skills")` 绑定目录时追加；**每次 send 现算无缓存**（增删技能免重启生效）。禁用即时生效：`collectEnabledSkills` 按 DB `skillRecord.enabled` 过滤（`filterDisabledSkills`，禁用对模型=不存在）。

**注入**（`agent/skill-prompt.ts` 的 `buildSystemPrompt`，纯函数）：skills 非空时 system 追加技能清单段，每行 `- name: description`，段首明示两跳取用方式（`read_skill` 工具 + 包内文件以 path 参数读取）；skills 为空原样返回 base（零 token 开销）。渐进披露完整链：清单段（常驻 system）→ `read_skill` 正文（按需）→ 技能包内子文件（`references/*.md` 等，第三跳）。

**read_skill 工具**（`agent/read-skill.ts`）：

- 按名查清单（精确匹配，查不到不触任何磁盘读取）；`BODY_LIMIT=256KB` 超限截断加 `…（已截断）` 标注。
- 子文件安全：`resolveWithinSkillDir` 双重边界校验——resolve 前缀校验（防 `../` 字面逃逸）+ realpath 跟随后再校验（防包内 symlink 指向包外），越界拒绝不触读；NUL 字节文件拒绝（二进制内容不支持读取）。
- `onRead(ctx, skill)` 回调为「读取即意图信号」：workflow-creator 技能被成功读取即把会话挂进 `workflowIntentSessions` 开工作流工具组的门（截断路径同样触发；查无/读败/越界不触发）；server 侧 `core/tools/read-skill.ts` 双份同构。

**安装三通道与市场**（`electron/domains/ai/skill/`）：

- `skill.repo.ts`（`SkillRepository`）：IPC `skill:list`（自愈对账）/`skill:setEnabled`/`skill:setScenarios`/`skill:batchSetEnabled`/`skill:uninstall`/`skill:batchUninstall`/`skill:import`/`skill:pickImport`/`skill:stats`/`skill:readSkill`；卸载仅允许 skillsDir 内路径（`isInsideDir` 防越界）且拒绝系统内置技能（重启自愈重装，UI 系统组本就无卸载入口）。
- 安装编排委托 `skill-installer.ts`（`SkillInstaller`，deps 注入可测）：市场下载 zip / 本地导入（zip 或目录，dryRun 走预检）/ 系统文件选择器三通道；市场请求全走 `skillhub-client.ts`（`SkillHubClient`：X-API-Key 鉴权 + 退避重试 + 下载量计入团队 Key 归因），hub 数据映射 `skillhub-mapping.ts`（`mapHubSkill/mapHubDetail`）。
- 内置自愈 `builtin-skills.ts`（`ensureBuiltinSkills`）：`BUILTIN_SKILL_NAMES = ["skill-creator", "workflow-creator"]` 启动逐个确保已安装且 source 正确（目录缺 → `cpSync` 递归复制 + upsert 全量；目录在 → 仅 upsert 纠 source，启停/描述等用户状态原样保留）。
- 对话式创建 `create-skill.ts`（`create_skill` 工具：落盘用户技能目录、不依赖工作空间未绑目录也放行、write 审批；与 create_expert 同批的「AI 自举能力面」设计）。
- 归档 `skill-archive.ts`（zip 导入解包）。

**统计**（`skill/skill-stats.ts`）：

- `recordSkillEvent` 供五写入点 fire-and-forget（调用方不 await，catch+Log.warn 吞错——埋点属可观测性，失败绝不影响主流程；delegate 缺席静默跳过保持可测性）。
- `aggregateGroupedSkillStats` 供 `skill:stats` 全量行内存聚合（本地单机事件量级千级，设计决策 4），产出 `SkillStatItem{installs/creates/enables/disables/uninstalls/batchOps/lastActiveAt}`；未知事件忽略（`counterKey` null）。
- server 端 `skills/stats` 同口径（`skills.service.ts` L163：`usedCount = 该技能全部事件计数合计`、`lastUsedAt = 最新事件 ISO`，SQL groupBy 下推）——**两端的「用量」都是事件活动度，非真实 read_skill 消费量**（见 §6 P3）。

**专家×技能**：专家 `skillNames` ≤3，三写面（表单胶囊选已安装/工具创建/导入）均过滤未安装；会话绑定专家后经 3.1 步骤 5 并入清单——「绑定专家即显式激活」语义，且 read_skill 消费集与 system 清单同源（专家附带技能展示即可读）；项目会话维持挂载收窄前的全量启用扫描集（预设≠围墙，二期 §3.7：read_skill/mcp 全量可用，会话中可按需用预设外能力）。

**场景**：`skillRecord.scenarios` 打标（`skill:setScenarios`）+ 前端 `new-task/lib/scenario.ts` 的 `filterScenarioSkills`（场景下已打标已启用技能混排进预设胶囊尾部）；注意两套场景口径并存——新建任务会话列 `SCENARIO_KEYS = ["daily","coding","design"]`（3 值，i18n 预设胶囊），市场导航 `SCENARIOS`（6 值，含 `expertSlugs` 专家推荐组），后者仅市场/推荐消费，不进 chat 组装。

### 3.4 连接器与 MCP

**仓储**：`electron/domains/ai/mcp/mcp.repo.ts`——IPC `mcpServer:list|create|update|delete|reconnect`（handleUser userId 隔离）。

**生命周期与注册**（`electron/domains/ai/agent/mcp-manager.ts`）：连接（`StdioClientTransport`/`StreamableHTTPClientTransport`，SDK `@modelcontextprotocol/sdk`）→ `listTools` → 以 `mcp__<server>__<tool>` 前缀 `registerTools` 进聚合 tool-registry（卸载 `unregisterTools`）；网络出口过 `security/network-gate`；prisma 与 client 工厂全部依赖注入（单测 vi.mock 替换）。

**工具面预算折叠**（2026-11-01，spec `docs/superpowers/specs/2026-11-01-mcp-tool-surface-budget.md`）：单 server 直接工具面超 `MCP_TOOL_SURFACE_BUDGET_TOKENS = 4000`（`estimateTokens` 1token≈2 字符，与 context-usage `toolDefinitionTokens` 同源）时折叠为 `list_tools/call_tool` 两聚合工具，直接工具 schema 不再常驻每会话 payload——依据实测：22 工具 HTTP MCP ≈12K 字符 ≈6K token/每轮；4K 线让小 server 直注体验不变、大 server 改两跳（与专家目录出 system 同构的渐进披露）。**背景约束**：引擎（langgraph）工具集静态绑定不支持动态挂载，defer 必须在注册层完成。

**前端**：`src-react/domains/ai/mcp/views/ConnectorMarketView.tsx`——工具栏（搜索 + 自定义连接器入口）+ `MARKET_CONNECTORS` 24 卡片响应式网格（`lib/market-connectors.ts`，2/3/4 列）+ `McpManageDialog`（自定义连接器，支持 mcp-json 批量导入模板 `lib/mcp-json.ts`）；已添加判定 `DB name === 市场 id`；`ConnectorCard` 单卡。

**与专家的关系**：连接器不绑定专家——`mcp__*` 工具面向全会话常驻（未绑目录会话同权，见 3.1 步骤 7 白名单），专家侧无「附带连接器」字段（对照 skillNames 的差距，见 §6 P2）。安全面：stdio MCP 的工具调用走统一审批 + `toolPermission` 工作空间记忆；**stdio MCP 写面（经 MCP server 反向写桌面数据）明确不做**（2026-10-26 用户裁定，本文改进建议不含此项）。

## 4. 三端布局

### 4.1 桌面端（apps/tianshu-desktop）——全功能面

- **管理面**：`src-react/domains/ai/experts/views/ExpertsView.tsx`（三 Tab，Tab 行挂 TopBar `usePageHeader` pill 组）；`ExpertMarketView`（市场：分类/搜索/排序 `lib/market-filter.ts`，场景卡 `ScenarioCard`，专家卡 `ExpertCard`，详情 `ExpertDetailDialog`）+ `MyExpertsView`（我的：管理网格 编辑/删除/开对话/导入导出 + 空态引导页 + 创建流复用「创建技能」预填桥——新会话+预填模板跳聊天页）；专家编辑表单 `assistant/components/AssistantDialog.tsx`（双类型/成员行/技能胶囊/分类/调参/差量提交 `diffArrayInput/diffOptionalString/diffOptionalValue`）。
- **技能面**：`skills/views/SkillsView.tsx` 分发 `SkillDiscoverView`（技能中枢市场，`skillhub.api.ts`）与 `SkillManagerView`（已装管理：启停/批量/卸载/统计/场景打标）；API 层 `skills/api/skill.api.ts`。
- **连接器面**：`mcp/views/ConnectorMarketView.tsx` + `components/McpManageDialog.tsx`/`ConnectorCard.tsx`。
- **消费面**：新建任务（new-task 域专家草稿 + AttachMenu）；会话内（`expert-sub-menu` 切换、`ExpertPromptChips` 提示词胶囊、`ExpertRecommendCard` 推荐卡、`skill-sub-menu` 技能引用）。
- **被控面**：`electron/domains/server-face/routes.ts` 透出 WS 通道 `assistant/query|detail|save|delete|marketList|marketDetail|export|import`（detail 归属校验后全量透出含 members；save 单条 upsert 三态；marketList/marketDetail 数据源 `@tianshu/core/expert-market`）供远程端遥控。
- **单 UI 多主机**：`api/assistant.api.ts` 的 `list` 经 `routeInvoke` 主机路由化（本地 invoke 原通道零变化；远程走 `data-source/remote-catalog` 的 `remoteAssistantList` 形状转换）；写方法仍本地 IPC。

### 4.2 无头服务端（apps/tianshu-server）——管理面 + 裁剪消费面

- `src/modules/assistant/`（HTTP）：`assistant/controller.ts` 的 `@Post('query'|'export'|'import')`；`assistant.service.ts`——query 返回 `AssistantBrief[]`（id/name/icon/quickPrompts 概要，systemPrompt 不外露；无头端专家表现阶段通常为空，控制端 UI 空态即「无可选专家」）；export/import 复用 `src/core/expert-io.ts`（与桌面同语义的 `serializeExpert/parseExpertJson/dedupeName`，双份受 drift manifest 守护）；全部行归 `COMPANION_USER_ID`。
- `src/modules/skills/`（HTTP）：`@Post('query'|'read'|'setEnabled'|'installUpload'|'stats')`；清单与 chat-runner 同一 `loadSkills`（`src/core/tools/skill-loader.ts` 双份）+ skillRecord 对账 enabled；read 读全文（移动端发送前并入消息文本——mirror ⚡token 机制同构）；installUpload base64 zip ≤3MB（relay 单帧 4MiB 余量约束）；`skillsDir` 与 chat-runner 同口径（config tianshu.dataRoot + `TIANSHU_DATA_ROOT` 覆盖——曾因 CWD 相对路径致管理面与 chat 消费目录分叉的教训已修）。
- `src/core/chat-runner.service.ts`：消费 `session.assistantId` 的 systemPrompt/调参（L1059/L1125）；**无**专家团调度、专家附带技能并入、专家推荐组（见 3.2/3.1）；`src/core/expert-catalog.ts`/`skill-prompt.ts` 为保留双份（RC-T5 裁定：闭包不纯未入 @tianshu/core，差异入 T7 drift manifest）。

### 4.3 移动端（apps/tianshu-mobile）——遥控管理面

- `src/app/experts.tsx`（38.8K，A2 批）：页内分段 [我的|市场]（spec 裁定统一单页）——我的走被控面 `assistant/query 概要 → detail 全量 → save`，编辑器含专家团成员行动态增删 ≤13 行（校验纯逻辑 `src/logic/expert-team.ts`：`TEAM_MEMBER_ID_RE/TEAM_MEMBERS_MAX/TEAM_MEMBER_ID_MAX` 与 `TeamValidation` 错误码枚举，`buildPayload/applyTeamFields` 三态——服务端 repo 仍为权威，前端报错仅提前拦截）；市场 `marketList 概要（无 systemPrompt）→ marketDetail 全文预览 → assistant/save 新建`；JSON 文件导入（`pickExpertJsonFile/parseExpertImportPreview`）；内置专家禁改名/删除（表单置灰 + 服务端 ASSISTANT_BUILTIN 双保险）；错误码经 `EXPERT_ERROR_CODES` 映射 toast。
- 技能市场：`src/app/skills/market.tsx` + `skills/[slug].tsx`（详情），安装/启停走被控面通道。
- 会话消费：`src/app/session/[id].tsx` 的 `expertId` state（MT-T2：请求级覆盖随 startSend 携带，非会话级绑定）；远程 team 专家因 server 无 dispatch 体验等同单专家。
- 入口：`(tabs)/settings.tsx` 的「专家」「技能市场」设置行（L436 `router.push("/experts")` / L399 `"/skills/market"`）；`_layout.tsx` 注册 `headerShown:false`（根级路由双标题防线惯例）。

## 5. 业界主流做法对比

### 5.1 OpenAI GPTs / Assistants API

**模型**：GPT = 人设（instructions）+ 绑定模型 + 工具三件（code_interpreter/file_search/function）+ 知识文件，GPT Store 分发；Assistants API 将其服务端化（Assistant 持久对象 + Thread 会话状态 + Run 驱动 + vector_store 文件检索），官方已宣布将其淘汰收敛至 Responses API/Agents 方向。**天枢对照**：`assistant` 表与 GPT 配置模型几乎同构（systemPrompt≈instructions、skillNames≈function 工具面、quickPrompts≈conversation starters、市场≈GPT Store、JSON 导入导出≈配置文件分享）；两点本质差异——①天枢专家是**客户端组装期配置**而非服务端持久对象（无 Thread/Run 生命周期，状态全在 session/message 本地库），顺应了 Assistants API 本身的退潮；②天枢**无专家级知识库/文件绑定**（资料库 library 是用户级，经 library_search 工具检索，专家无法声明资料域，见 §6 P2）。

### 5.2 Claude Code subagents + skills

**模型**：subagent 是 `.claude/agents/*.md` 定义文件（frontmatter：name/description/tools/model），主代理经 Agent 工具派发——**独立上下文窗口、可持独立工具集与独立模型、可后台并行、可 worktree 隔离、只回传最终报告**（本运行环境即实证：Explore/Plan/general-purpose 等 agent 类型定义）。skills 是 `SKILL.md` 目录（frontmatter name/description + references/ 渐进披露 + 可带脚本），调用方按需加载进当轮，打包分发。**天枢对照**：技能体系近乎直接同构——SKILL.md/frontmatter 两字段/清单段+read_skill 两跳/技能包内子文件 path 三跳/市场+本地导入双通道，连「渐进披露压 system token」的动机都一致（本仓 2026-11-01 两批优化同思路）；专家团则有本质差距——成员是**无独立工具、无独立上下文、无独立模型、无并行编排状态的单轮文本补全**（轻量「人设分身」），不是真 subagent；换来的是实现极简（一个工具+一段 system 纯函数可直测）与行为可控（铁律 prompt 硬约束调度纪律）。

### 5.3 Coze

**模型**：Bot（人设+开场白+变量+模型）+ 插件（API 封装的工具市场）+ 工作流（可视化编排，可嵌 Agent 节点做子任务）+ 知识库（文档/表格/照片三档）+ 触发器（定时/webhook），商店生态分发。**天枢对照**：专家≈Bot、技能+连接器≈插件市场、`/module/ai/graphs`（graphDefinition/graphRunNode 显式 DAG）≈工作流、automationTask（schedule/webhook）≈触发器、专家市场≈商店；Coze 的多 agent 是**工作流节点级编排**（显式 DAG，确定性流转），天枢专家团是**会话内 prompt 驱动隐式调度**（灵活免搭建但不可视化审计）——两者在天枢是互补并存的两层（专家团=会话内、graphs=跨会话自动化）。

### 5.4 Dify

**模型**：单 Agent 两种策略（ReAct 自然语言推理循环 / Function Calling 原生工具调用）+ Workflow 编排 + 多 Agent 协作模式（Leader-Worker：管理者拆解分派、worker 执行回传、变量在节点间传递）。**天枢对照**：天枢主循环=Function Calling 式（`createReactAgent` + 原生 tool calling + streamEvents(v2)，非 ReAct 文本协议——回避了 ReAct 解析脆弱性）；专家团与 Dify 多 Agent 协作（Leader-Worker）形态最接近——主理人即 Leader、dispatch 即分派、context 参数即产出传递、协作铁律即管理者行为约束；差异是天枢成员固定单轮（无 worker 内部迭代循环）、无成员级记忆变量、无 DSL 可视化。

### 5.5 CrewAI / AutoGen

**模型**：CrewAI 以 role/goal/backstory 三件定义 Agent、Task 对象分派、process 选 sequential（顺序流水）/hierarchical（manager LLM 统筹派活与汇总）、crew 共享 memory（短期/长期/实体）；AutoGen（AG2）以多 Agent **对话**为核心——GroupChat + manager 路由、agent 间互发消息、human-in-the-loop 可插入。**天枢对照**：TeamMember 四字段（id/name/profession/systemPrompt）≈role/goal/backstory 的压缩；主理人≈hierarchical manager；**无共享 memory**（成员间上下文仅靠主理人显式传 context 原文，铁律 #2）；**星型拓扑**（成员是被调方不互相对话、不可反呼主理人或互相移交，铁律 #3「成员只对主理人回传」）——比 AutoGen 群聊可控性更强（无对话风暴风险），表达力弱于对等协作。

### 5.6 LangGraph supervisor / swarm

**模型**：supervisor=中心路由节点（每轮由 supervisor LLM 决定下一个 worker+指令，循环直至完成）；swarm=成员间 handoff（各成员声明移交条件，共享 state 通道带全文上下文流转）；两者都是显式状态图编程。**天枢对照**：天枢主循环引擎本身就是 langgraph `createReactAgent`（单 agent React 循环），但专家团**未用图编排**——dispatch 是「工具调用形态的 supervisor」，比 graph supervisor 更轻（无显式状态机、无节点定义、复用既有工具循环零新增编排基建）；handoff/swarm 式对等移交天枢未做（语义上由铁律显式禁止）。另天枢 `/module/ai/graphs` 的 graphDefinition 显式 DAG 与 LangGraph 状态图定位重叠，属流程编排模块话题（另文）。

### 5.7 对照总结

| 维度 | 天枢 | GPTs/Assistants | Claude Code | Coze | Dify | CrewAI/AutoGen | LangGraph |
|---|---|---|---|---|---|---|---|
| 人设载体 | assistant 行（本地 DB） | GPT 配置（云端） | agents/*.md（文件） | Bot（云端） | Agent 应用配置 | role/goal/backstory（代码） | 节点 prompt（代码） |
| 工具绑定 | 会话级场景门控+专家附带技能 | GPT 级三件 | subagent 级 tools 字段 | Bot 级插件 | 节点级 | Agent 级 | 节点级 |
| 知识/记忆 | 用户级 library（无专家绑定） | GPT 级文件/vector_store | skills 包内文件 | Bot 级知识库 | 应用级知识库 | crew 共享 memory | 共享 state |
| 多 agent | 主理人+单轮成员（prompt 驱动） | 无（单 assistant） | 真 subagent（独立上下文/工具/模型） | 工作流节点编排 | Leader-Worker | 对话/分派、可对等 | supervisor/swarm |
| 能力分发 | 专家市场 59 条+JSON 文件 | GPT Store | 文件/git/插件 | 商店 | DSL 模板 | 代码 | 代码 |
| Token 策略 | 渐进披露三跳+预算折叠 | 服务端托管 | 渐进披露（清单→正文） | 平台托管 | 平台托管 | 用户自理 | 用户自理 |

共同趋势：**人设配置化、能力包（skills/plugins）即插即用、渐进披露压 token、多 agent 从代码编排走向模型自主调度**。天枢四点全部踩中，且有两处本地实践走在前：专家目录出 system 改两跳工具（未绑专家会话每轮省 ~2970 字符、86% 固定开销归零）与 MCP 工具面预算折叠（4K token 线，22 工具 server 从 6K/轮降到两跳聚合）。

## 6. 改进空间

按优先级排列，均结合现状给落点（**不含 stdio MCP 写面——已裁定不做**）：

**P1 专家团可观测性缺口**。`memberModelText`（chat.service.ts L1850）直接 `chat.invoke`，绕过 `recordLlmCall/recordToolCall` 埋点——成员调用的 token 消耗不进 `/module/ai/monitor` 用量监控（llmCallEvent/toolCallEvent 表无记录），也不进 `getUsageBreakdown` 五类拆解（system/tools/messages/mcp/skills 均不含成员上下文与成员补全输出），专家团会话的真实成本对用户不可见。建议：dispatch execute 内补 `recordLlmCall`（成员名/轮次作元信息）+ dispatch 本身记 `recordToolCall`；用量面板（`context-usage-button.tsx`）增设「成员调度」分类。改动集中在 dispatch-member-tool 的 deps 注入面，不动主循环，风险低。

**P1 成员调度过程不可见**。成员产出「不落库不外显」（dispatch-member-tool 头注释），用户只看到主理人最终回答——多轮 dispatch 期间界面无进度感，事后无法审计成员观点来源（对照 Claude Code 子代理可见性差距明显）。建议：成员产出以专用 block 型（如 `memberReport`）落进当轮 assistant 消息 blocks（`chat/blocks.ts` 与 server `logic/blocks.ts` 双份同改——历史教训：新块型必须双改），前端折叠卡渲染（`AgentProgress`/`ToolCallCard` 先例）；须同步 `@tianshu/protocol` chunk/blocks 契约与移动端 blocks 逻辑。

**P2 成员能力升级为受限 subagent**。当前成员零工具（纯文本人设单轮），「先查资料再分析」类任务无法自营，主理人只能自己代查再贴给成员。建议：dispatch 增可选只读工具子集（library_search/search_history/web 摘要类），仍单轮、仍非流式、工具白名单经专家表单配置（默认空保持现状）；对齐 Claude Code subagent 的 tools 字段语义，而不引入独立上下文管理与并行编排状态。注意 120s 熔断需随工具调用重估。

**P2 专家级知识库绑定**。对照 GPTs vector_store/Coze 知识库，assistant 无 libraryItem 绑定字段，专家与资料仅靠用户级 library_search 弱关联，「法律顾问专家只查法规库」表达不出。建议：assistant 表加 `libraryIds` JSON 列（v1 后新增 `script/vN` 版本脚本——勿直改 v1 快照，快照 sha256 指纹守卫会触发旧库 drop 重建），组装期 system 追加资料域声明 + library_search 检索范围收窄（复用 `isolateProjectTools` 项目会话收窄先例）；被控面 detail/save 与协议 `AssistantSavePayload` 同步扩列。

**P2 专家附带连接器**。skillNames 有附带机制而连接器没有（3.4 末）——专家无法声明「本专家依赖 XX 连接器」，工具面靠全会话常驻兜底。建议：assistant 加 `mcpServerIds` JSON 列，组装期对绑定但未启用的连接器给 system 提示注入（声明可用能力名而非自动启停——连接器启停属安全配置语义，不随专家变更）；折叠态（超 4K 预算）连接器照走 list_tools/call_tool 两跳不受影响。

**P3 技能使用级埋点**。skillStat 事件枚举只有安装/启停类，无 `use`——技能是否真被 read_skill 消费无从统计，两端 stats 的 `usedCount/lastActiveAt` 实为「事件活动度」而非使用量（`skill-stats.ts` 桶枚举 + server `skills.service.ts` L163 合计口径）。建议：read_skill 成功读取时 fire-and-forget `recordSkillEvent(name, "use")`（`onRead` 回调已是现成挂点，仅 workflow intent 在用），聚合加 uses 桶；列契约「索引由 ensureEventStatMaintenance 幂等补建」已为免迁移扩事件留好路。

**P3 builtin 机制启用**。`builtin` 列 + `ASSISTANT_BUILTIN` 删除守卫 + list 置顶排序（`orderBy: [{builtin: "desc"}, ...]`）俱在，但桌面侧无种子写入路径（市场添加走 `toCreateParams` 恒 `builtin:false`），机制空置。建议：随版本预装 2-3 个精选专家（builtin:true，卸载守卫已天然防误删），新用户开箱即有可选人设；配套「恢复出厂」重装路径（参照 `ensureBuiltinSkills` 启动自愈先例）。

**P3 服务端专家团对齐（评估项）**。server chat-runner 不移植 dispatch，远程/移动端 team 会话退化为单专家（3.2 已述，README 来源表明示裁剪）。`expert-team.ts` 本是纯函数（零依赖），当初未入 `@tianshu/core` 是因 expert-catalog/skill-prompt 闭包不纯连坐（RC-T3 no-go，RC-T5 双份保留）；可评估将 `buildTeamLeadSystem/parseTeamMembers` 单独收编 core，server 版补 dispatch 工具（memberModelText 在 server 侧有同构件可参照：chat-runner 已移植 handover-summary 的非流式补全形态），使三端团队语义一致。注意 server jest partial mock interop 坑（历史教训：named import 失效——工具实现走 deps 注入面），及收编后 drift manifest 基线重置（`npm run check:drift -- --rebase` 人工复核）。

**P3 成员 prompt 前缀缓存（验证型）**。成员 systemPrompt 最长 2 万字符 ×13 员，每次 dispatch 全量重传；同会话内同一成员的 system 段逐字节稳定（`buildMemberPrompt` 仅变 user 段），具备 provider 前缀缓存命中条件。建议：守住 memberModelText 组装时 system 原文零加工（现状已满足，后续改动勿加时间戳类内容），在支持 prompt caching 的 provider 路径验证缓存命中收益；先量化（P1 埋点落地后）再决定是否显式标 cache 断点。

## 附录：关键函数/通道索引

| 符号 | 位置（桌面 electron/ 相对） | 职责 |
|---|---|---|
| `parseTeamMembers` / `buildTeamLeadSystem` | `domains/ai/chat/expert-team.ts` | 成员 JSON 防御解析 / 主理人 system 四段组装 |
| `parseJsonStringArray` / `mergeExpertSkills` | `domains/ai/chat/expert-catalog.ts` | 数组列解析 / 专家附带技能并入 |
| `AssistantRepository.toRecord/create/update` | `domains/ai/chat/assistant.repo.ts` | 行归一与三态写（IPC assistant:*） |
| `serializeExpert/parseExpertJson/dedupeName` | `domains/ai/chat/assistant.repo.ts` | 专家 JSON 导入导出链 |
| `ChatService.assembleContext` | `domains/ai/chat/chat.service.ts` L2084 | 会话→system/参数/技能/工具全量组装 |
| `ChatService.collectToolDefinitions` | `domains/ai/chat/chat.service.ts` L1758 | 工具集四层过滤（白名单/项目/场景/禁用） |
| `ChatService.memberModelText` | `domains/ai/chat/chat.service.ts` L1850 | 成员单轮补全（120s 熔断） |
| `ChatService.collectSkills/collectEnabledSkills` | `domains/ai/chat/chat.service.ts` L1885 | 双目录扫描 / DB 启停过滤 |
| `makeCreateExpertTool/makeUpdateExpertTool` | `domains/ai/agent/create-expert.ts` | 对话式专家写面（write 审批） |
| `teamMemberSchema/validateTeamMembers` | `domains/ai/agent/create-expert.ts` | 成员校验三写面单源 |
| `makeListExpertsTool/makeRecommendExpertTool` | `domains/ai/agent/recommend-expert-tool.ts` | 两跳专家推荐组 |
| `makeDispatchMemberTool` | `domains/ai/agent/dispatch-member-tool.ts` | 专家团调度工具（read 免审批） |
| `parseFrontmatter/loadSkills` | `domains/ai/agent/skill-loader.ts` | SKILL.md 发现（4KB 头部窥读） |
| `buildSystemPrompt` | `domains/ai/agent/skill-prompt.ts` | system 技能清单段注入 |
| `makeReadSkillTool`（`resolveWithinSkillDir`） | `domains/ai/agent/read-skill.ts` | 技能正文/子文件渐进披露 |
| `SkillRepository` / `SkillInstaller` / `ensureBuiltinSkills` | `domains/ai/skill/*.ts` | 对账/安装编排/内置自愈 |
| `recordSkillEvent/aggregateGroupedSkillStats` | `domains/ai/skill/skill-stats.ts` | 埋点采集与聚合 |
| `SkillHubClient/mapHubSkill` | `domains/ai/skill/skillhub-client.ts`/`skillhub-mapping.ts` | 技能中枢市场 |
| MCP 连接注册 / `MCP_TOOL_SURFACE_BUDGET_TOKENS` | `domains/ai/agent/mcp-manager.ts` | mcp__* 注册与 4K 预算折叠 |
| `toCreateParams/MARKET_EXPERTS/SCENARIOS` | `packages/tianshu-core/src/expert-market/index.ts` | 市场数据单源（59 条/12 类/6 场景） |
| `ExpertTeamMemberDto/AssistantSavePayload` | `packages/tianshu-protocol/src/expert-contract.ts` | 三端契约 |
| `AssistantService.query/export/import` | `apps/tianshu-server/src/modules/assistant/assistant.service.ts` | 无头端专家 HTTP 面 |
| `SkillsService`（query/read/installUpload/stats） | `apps/tianshu-server/src/modules/skills/skills.service.ts` | 无头端技能 HTTP 面 |
| 被控面 assistant 八通道 | `apps/tianshu-desktop/electron/domains/server-face/routes.ts` | WS 遥控（marketList/marketDetail 等） |
| `applyTeamFields/buildPayload` | `apps/tianshu-mobile/src/logic/expert-team.ts` | 移动端成员编辑纯逻辑 |
