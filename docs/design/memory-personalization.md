# 记忆管理（个性化）技术方案

> 调研基准：main 分支 995bf652（2026-11-05）。所有路径相对仓库根，`electron/`、`src-react/` 等桌面端路径省略 `apps/tianshu-desktop/` 前缀处均已写全。引用的函数/常量/表名均来自真实代码。

## 1. 模块定位与总览

天枢的「记忆管理（个性化）」不是一个单一模块，而是三层机制的组合：

| 层 | 形态 | 存储 | 更新方式 | 注入方式 |
| --- | --- | --- | --- | --- |
| **用户显式配置层** | 人设 persona、回复风格、称呼、手动长期记忆 `personalization.memory`、自定义指令 | option 表（type="app"）13 个 key | 用户在设置面板手动编辑 | 每轮聊天拼进 system prompt（`buildPersonalizedSystem`） |
| **AI 进化画像层** | 四板块 markdown 画像（工作背景/个人背景/当前关注/近期动态） | option 表 per-user key `personalization.<userId>.memoryProfile`（≤8000 字符；批9 前为全局单 key，旧键兼容回落） | 每晚 02:00–04:00 窗口由 LLM 从近 7 天对话提炼；用户 AI 指令即时改写 | 每轮聊天以【用户画像记忆】段拼进 system prompt |
| **会话级上下文层（working memory）** | 会话历史 + 压缩摘要 | `message`/`session` 表（`session.summary`/`compactedUpToId`） | 工具输出瘦身、滞回截断、手动/自动压缩 | system 注入【此前对话摘要】+ 历史消息回喂 + `search_history` 工具按需捞回 |

设计裁定（spec `docs/superpowers/specs/2026-09-09-memory-evolution-design.md` D8）：**不新建 Prisma 表、不升 DB 版本**，记忆正文存 option 表单个 key 的 markdown 文本——因此 31 张业务表中没有记忆专属表。

职责分布：**桌面端是数据与调度的唯一宿主**（option 表 + 每夜整理调度器都在桌面主进程）；无头服务端只有「读侧注入」；移动端经桌面被控面（server-face）五端点遥控，自身零存储。

关键文件一览：

- 后端管线：`apps/tianshu-desktop/electron/domains/ai/personalization/`（memory-compiler / memory-scheduler / memory.service / memory-inflight / personalization.config / personalization.repo / personalization.prompt）
- 共享纯函数（三端单源）：`packages/tianshu-core/src/personalization-config.ts`、`packages/tianshu-core/src/personalization-prompt.ts`
- 协议契约：`packages/tianshu-protocol/src/memory-contract.ts`
- 会话上下文纯函数：`packages/tianshu-core/src/history-truncate.ts`、`tool-output-trim.ts`、`time-context.ts`、`scenario-prompt.ts`、`run-chat-stream.ts`
- 前端设置页：`apps/tianshu-desktop/src-react/domains/app-settings/components/MemoryGroup.tsx`（含 `memory/ImportMemoryDialog.tsx`、`memory/ResetMemoryDialog.tsx`、`memory/MemoryMarkdown.tsx`）
- 移动端：`apps/tianshu-mobile/src/app/memory.tsx`、`src/store/memory.store.ts`、`src/transport/memory-api.ts`
- 桌面被控面：`apps/tianshu-desktop/electron/domains/server-face/memory-tap.ts`
- 服务端读侧：`apps/tianshu-server/src/core/personalization.ts`、`src/core/chat-runner.service.ts`

## 2. 数据模型

### 2.1 option 表 13 个个性化 key（无专属表）

单源定义在 `packages/tianshu-core/src/personalization-config.ts`（`PERSONALIZATION_KEYS` / `PERSONALIZATION_LIMITS` / `defaultPersonalization`），桌面端 `electron/domains/ai/personalization/personalization.config.ts` re-export 并持有 `fromAppOptions` 解析段：

| key | 限长 | 默认 | 语义 |
| --- | --- | --- | --- |
| `personalization.responseStyle` | 枚举 8 值 | `default` | 回复风格（default=不注入风格段） |
| `personalization.welcomeLoading` / `fileChangeDetails` | bool | true/false | 渲染层 UI 开关（`use-personalization-ui.ts` 消费） |
| `personalization.customInstructions` | 1500 | 空 | 全局规则指令 |
| `personalization.userNickname` / `aiName` | 20 | 空/「天枢」 | 身份段 |
| `personalization.persona` | 4000 | 空 | 人设（默认空=不注入；`DEFAULT_PERSONA` 仅预填前端编辑弹窗，见 `src-react/domains/app-settings/model/personalization-options.ts`） |
| `personalization.memory` | 1500 | 空 | **用户手动长期记忆**（D1：与画像记忆是两个独立概念，互不迁移） |
| `personalization.memoryProfile` | 8000 | 空 | **AI 进化画像正文**（markdown） |
| `personalization.memoryEnabled` | bool | true | 生成开关（关=停生成不停注入，记忆保留转只读） |
| `personalization.memoryModelId` | 10 | 空 | 强指定整理模型 id（空=自动解析候选序） |
| `personalization.memoryLastCompiledAt` | 40 | 空 | 上次定时整理时间（ISO） |
| `personalization.memoryLastError` | 200 | 空 | 最近整理失败原因（设置页展示） |

存储语义：行不存在=默认值，存在=用存的值（含空串）。**画像三键（memoryProfile / memoryLastCompiledAt / memoryLastError）批9（2026-11-05）起按 `personalization.<userId>.<field>` 命名空间拆行实现多用户隔离**（key 单源 `personalizationUserKey`/`memoryProfileKeyFor`，主进程 repo 读写与前端 settings:set 同源；其余键保持本机全局）；带 userId 读取时旧全局行兼容回落 + 首读迁移搬入（升级不断忆），详见 §3.5。

### 2.2 memoryProfile 的 markdown 格式（全链路统一）

`apps/tianshu-desktop/src-react/domains/app-settings/model/memory-markdown.ts`（主进程经反向 import 共用）：

- 四节固定标题精确匹配（`MEMORY_SECTION_DEFS`）：`## 工作背景` / `## 个人背景` / `## 当前关注` / `## 近期动态`，节序固定；
- 条目行格式 `[YYYY-MM-DD|#msgId] - 内容`（批9 P4 溯源：`|#msgId` 为来源消息 id，旧格式 `[YYYY-MM-DD] - 内容` 与无日期行兼容解析——`parseMemoryEntry`）；近期动态按日期倒序（`sortRecentEntries`）；
- 存储格式 = AI 输出格式 = 导入粘贴格式，仅展示时切分（`parseMemoryMarkdown`：无任何已知标题 → 全部进工作背景节）；
- 超限截断保尾部（`truncateMemoryMarkdown`，尾部为最新内容）；导入合并 `mergeMemoryMarkdown`：三节文本追加、近期动态合并重排；逐条删除 `removeMemoryEntryLine`（批9 IA 升级：按节内行序移除，节内唯一条目删除后整节消失）。

### 2.3 会话级记忆相关字段与表

- `session.summary` + `session.compactedUpToId`（`apps/tianshu-desktop/prisma/schema.prisma` session 表）：/compact 压缩摘要与压缩点游标——历史只取压缩点之后，摘要经 system 注入替代旧消息（chat.service.ts:2126-2135、2270-2271）。
- `vectorChunk` 表（schema 464 行）：`userId/collection/sourceName/seq/text/vector/model`，当前**仅服务资料库检索**（collection=`library`），与画像记忆无关——复用可能性见 §6。
- `toolPermission` 表（schema 176 行）：审批「记住此决定」的 workspace 级工具白名单（`respondApprovalRemember`，chat.service.ts:2625）——周边意义上的「权限记忆」，不在本方案主线。

## 3. 核心技术方案

### 3.1 prompt 注入链路（每轮组装）

桌面端注入点在 `ChatService.assembleContext`（`apps/tianshu-desktop/electron/domains/ai/chat/chat.service.ts:2242-2271`）：

```
buildModeSystem(mode, base, sessionSkills)        // 模式 system（agent/ask/plan + 专家 prompt + 技能清单）
  ↓ buildPersonalizedSystem(personalization, ·)   // 个性化包裹（2242-2246 行）
  ↓ buildScenarioSystem(session.scenario, ·)      // 场景段追加到末尾
  ↓ (+ WORKFLOW_MOUNT_NOTE 条件元说明)
  ↓ (+ 【此前对话摘要】session.summary，压缩后)   // 2270-2271 行
```

服务端同构注入点：`apps/tianshu-server/src/core/chat-runner.service.ts:1132-1134`（`loadPersonalization(this.prisma.option)` → `buildPersonalizedSystem` → `buildScenarioSystem` → 摘要段），与桌面逐段对齐（PL-1 批）。

`buildPersonalizedSystem`（`packages/tianshu-core/src/personalization-prompt.ts`）的段序固定：

```
persona（前置） → baseSystem → 【回复风格】 → 【身份】 → 【用户长期记忆】(memory)
→ 【用户画像记忆】(memoryProfile) → 【用户自定义指令】(customInstructions)
```

- 空段跳过，`"\n\n"` 连接；全默认且 baseSystem 为 undefined 时返回 undefined（AI SDK 语义：不发空 system，否则 anthropic/gemini 拒收）；
- **缓存友好硬约束（spec §4.6/D3）：同 config → 逐字节相同输出**，段内禁止时间戳/随机数/会话相关内容——这是为服务端前缀缓存命中率设计的；
- 与此配套，时间上下文**不进 system**：`packages/tianshu-core/src/time-context.ts` 的 `withTimeBlock` 把「当前时间：2026-11-05 10:30 周四 UTC+08:00」作为独立 text block 插到最后一条 user 消息 blocks 头部（每请求唯一无缓存的新增部分），server 端 chat-runner.service.ts:1100-1106 同构。

读取策略：`loadPersonalization`（桌面 `electron/domains/ai/personalization/personalization.repo.ts` / server `src/core/personalization.ts`）**每次调用现查 option 表、刻意不缓存**——设置修改对下一轮对话即刻生效（spec D2）；读取异常回退全默认+日志，绝不让设置问题打断对话。批9（2026-11-05）起桌面侧签名 `loadPersonalization(userId?)`：画像三键按 `personalization.<userId>.*` 命名空间读取（A 画像不进 B 对话），userId 缺省保持旧全局行读取（server 读侧无用户面，行为不变——drift manifest 过账）。**注入预算治理（P6，批9）**：assembleContext 组装前经 `trimPersonalizationForBudget(config, contextWindow)`（`packages/tianshu-core/src/personalization-budget.ts`）——预算 `max(2048, floor(window×0.12))` token，无窗口不裁剪；超预算按段保留优先序裁剪（customInstructions > memory > 工作背景/个人背景 > 当前关注 > 近期动态；persona 恒保留先占预算；`trimProfileToBudget` 对画像逐行丢弃——近期动态丢节尾最旧、其余节丢节头最旧），预算内逐字节不变（前缀缓存友好）；usage 面板同步透出「记忆占用」（ContextUsageBreakdown.memory，含于 system 项的拆解展示）。

一个开启全部个性化项后的 system 实际形态（段序即拼接序，空段跳过）：

```
{persona 用户人设}
{buildModeSystem：模式指令 + 专家 systemPrompt + 技能清单}
【回复风格】
以直言不讳的风格回答：省略寒暄与客套话……
【身份】
你的名字是「小枢」，对话中以此自称。
称呼用户为「老王」。
【用户长期记忆】
以下是用户希望你长期记住的信息，请在对话中遵循：
{personalization.memory 手动记忆}
【用户画像记忆】
以下是系统从对话中提炼的用户画像，请在对话中参考：
## 工作背景
[2026-10-20] - 后端用 NestJS，示例不用 PHP
## 个人背景
……（四板块全文，≤8000 字符）
【用户自定义指令】
用户设定的全局规则，必须遵守：
{customInstructions}
{场景段（daily/coding/design）}
【此前对话摘要】        ← 仅压缩后存在
{session.summary}
```

### 3.2 记忆生成/进化机制（AI 管线）

三入口共用一套 compiler（spec §5.1）：

| 入口 | 触发 | 输入 | 落库 |
| --- | --- | --- | --- |
| 定时整理 | MemoryScheduler 02:00–04:00 窗口命中 | 近 7 天对话 + 当前记忆 | profile + LastCompiledAt |
| 启动补跑 | 启动 90s 后评估，距上次整理 >24h | 同上 | 同上 |
| AI 指令 | 用户在设置页/移动端/消息级「存入记忆」（批9 P7）发送指令（如「删掉天气相关记忆」） | 指令 + 当前记忆 | 仅 profile（不更新 LastCompiledAt，避免干扰「当日未整理」判断） |

批9（2026-11-05）：三入口均按 userId 画像归属落当前用户命名空间键（IPC 经 token 解出 userId；被控面经 withUserId 取被控端当前登录用户；scheduler 逐用户迭代）。

**调度器**（`electron/domains/ai/personalization/memory-scheduler.ts`）：

- 30s tick（`TICK_MS`），决策纯函数 `decideMemoryTick`（注入时钟可测）：开关关/inflight → noop；距上次尝试 <10 分钟（`RETRY_BACKOFF_MS` 失败退避 I1，批9 按用户独立计数）→ noop；补跑标志消费（M4，贯穿整轮用户迭代）；`hour ∈ [2,4)` 且当日未整理（`isSameLocalDay` 比对 LastCompiledAt）→ compile；
- **批9 per-user 迭代**：tick 遍历 user 表逐用户决策并整理（id 升序；素材按该用户会话过滤），单用户失败记录该用户失败原因后继续其余用户；user 表空（全新库）静默空转；
- 失败写 `memoryLastError`（限 200 字符，per-user key）供设置页展示，静默等待下一轮；
- **无头服务端没有调度器**——记忆数据与每晚整理均在桌面端（memory-contract.ts 头注释 A5/A6/AR 批先例）。

**素材采集** `fetchRecentConversation`（`memory-compiler.ts`）：近 7 天 user/assistant 消息，**过滤未归档且 `projectId: null` 的普通会话**（项目动态流不进夜间记忆；批9 起会话再按 `userId` 收敛——A 的对话不进 B 的画像）；`take: 500` 倒序限量取回再翻转，`keepRecentLines` 从尾端累积 ≤30000 字符（保最新丢最旧）；`rowToLine` 拼文本块为「用户/助手」行，**批9 P4 起行携带 `[#msgId]` 溯源标记**（`用户[#8421]：内容`），供 compiler 在条目 `[YYYY-MM-DD|#msgId]` 中回写来源。

**模型解析** `resolveMemoryModel`（memory-compiler.ts:285-301）：候选序 = 设置页强指定 `memoryModelId` → 各用户空间 `workspace.defaultModelId` → 全体用户启用模型（`listAllEnabledAnyUser`，v12 隔离裁定：画像为本机全局）；逐候选验证 model 启用且 provider 有运行时配置（`getRuntimeInfo`）。

**编译** `compileMemory`（memory-compiler.ts:313-350）：经 `createChatModel`（LangChain）单次 invoke；user prompt 头部注入时间行（模型无时钟，条目日期/淘汰过时内容需「今天」基准）。`MEMORY_COMPILER_SYSTEM_PROMPT`（64-109 行）是质量核心，历经三轮实测修订：

- 画像式提炼而非流水账：同主题合并、条数上限（工作背景 ≤8 / 个人背景 ≤8 / 当前关注 ≤5 / 近期动态 ≤10）、单条 ≤100 字、总长 ≤8000；
- **准入二判据**（改变后续回应方式 或 半年后仍有参考价值），存疑即丢（精度优先）；
- **素材来源限定**：只从「用户：」内容提炼，助手输出的代码/方案/工具输出不进画像（2026-10-23 次级模型防污染，注释明确参照 OpenAI ChatGPT bio 准入判据、Anthropic memory tool 指南、mem0 NOT-extract 负面清单）；
- 具体负面清单（临时查询/当天已解决的调试/粘贴材料本身/世界常识/敏感信息/寒暄）+ 频率词禁令（问过一次天气 ≠ 日常关注天气）+ 判断示例（few-shot 判断对照）；
- 与旧记忆合并：有效保留可改写、过时删除、冲突以新材料为准（简化版冲突消解，见 §5 Mem0 对比）；
- **条目溯源（批9 P4）**：条目格式 `[YYYY-MM-DD|#消息id] - 内容`，消息 id 取自素材行 `[#id]` 标记（无对应素材可省略）——设置页据此跳回来源会话；
- **显式失效规则（批9 P4）**：当前关注/近期动态条目日期距今天超过 30 天且近期材料中无新材料支持 → 移出画像（时间基准为 prompt 头部时间行——防旧条目永久占坑）。

**输出校验** `validateMemoryOutput`（memory-compiler.ts:149-158）：剥代码块围栏 + 标题变体修复（`HEADING_VARIANT` 正则统一 `## **工作背景**` 等偏差）后**非空即接受**（2026-09-21 二次放宽：小模型不守格式时输出仍生效，质量由下次整理迭代收敛）；再经 parse→build→truncate 规范化。空输出 → `MEMORY_COMPILE_FAILED`。

**并发治理** `memory-inflight.ts`：模块级共享单槽（acquire/release/abortInflight），定时、手动整理、AI 指令三方互斥，防并发各写 memoryProfile 互相覆盖；应用退出统一 abort 在途请求。

**IPC 服务** `memory.service.ts`：`createMemoryHandlers` 纯逻辑依赖注入可测；五值错误码 `MEMORY_DISABLED | MEMORY_MODEL_MISSING | MEMORY_COMPILE_FAILED | MEMORY_NO_MATERIAL | MEMORY_BUSY`（不 throw、码透传渲染层映射 i18n）；指令入口限长 2000 截断（M1，防 IPC 直调撑爆 prompt，前端另有 500 限制）；前置闸门「开关通过后才取对话材料」（T5b 惰性求值）。

### 3.3 会话级上下文管理（working memory）

三级裁剪 + 一级召回，纯函数均在 `packages/tianshu-core/src/`，由 `run-chat-stream.ts`（`runChatStream`，RC-T4 自 mirror chat.service 剥出入包）统一消费：

1. **旧轮工具输出瘦身**（`tool-output-trim.ts`）：非最近 2 个工具轮（`TRIM_RECENT_ROUNDS`）且 output >6000 字符（`TRIM_THRESHOLD_CHARS`）的 tool_call 块替换为「头 3000 + `[已截断 N 字符]` + 尾 1000」；只改发给模型的回喂副本，DB blocks/编辑重发/回看全量不动。
2. **滞回式窗口截断**（`history-truncate.ts` `truncateHistory`）：token 估算 1 token≈2 字符（image 块按 1000 计）；未超预算全量原样返回（前缀逐字节稳定，服务端前缀缓存持续命中）；超预算一次截到 `(1-headroom)`，之后多轮只追加尾部不再动头部。预算扣除 `estimateReserveTokens`（输出 maxTokens 兜底 4096 + system + 工具定义 JSON 体积）。
3. **会话压缩**（chat.service.ts:200-224、1130-1240）：手动 `/compact` + 自动压缩（估算预算占 contextWindow ≥0.8 触发 `AUTO_COMPACT_TRIGGER_RATIO`，冷却带 1.2 防每轮连压）；摘要指令 `COMPACT_DIRECTIVE` 走一次普通流式发送轮（用户可见），末条 assistant 文本回填 `session.summary`/`compactedUpToId`；后续上下文 = 摘要（system 注入）+ 压缩点后消息。
4. **按需召回**：`search_history` 内置工具（`electron/domains/ai/agent/history-search-tool.ts`，spec 2026-11-02，WorkBuddy conversation_search 逆向借鉴）——三级裁剪单向有损，丢失细节对模型永久不可达，本工具兜底「需要时一次调用捞回」；检索实现为 **LIKE 子串匹配**（blocks contains，query 截 100 字符，扫描上限 60 条、每会话 3 片段、排除当前会话零访问）；`library_search` 工具（`agent/library-search-tool.ts`）桌面为文件名关键词匹配，server 侧（`src/core/library/library-tools.ts`）为向量版：`vectorChunk` 余弦（`vector-store.ts searchChunks`）+ BM25（`packages/tianshu-core/src/retrieval.ts rankBm25`，Intl.Segmenter 中文分词）+ RRF 融合（`rrfFuse`）。

时间上下文（`time-context.ts`）与场景段（`scenario-prompt.ts`：daily/coding/design 三场景）属环境注入，与记忆同走 system/user 组装链路。

### 3.5 userId 隔离与数据迁移（批9，2026-11-05）

画像三键（memoryProfile / memoryLastCompiledAt / memoryLastError）按 `personalization.<userId>.<field>` 命名空间拆行（改动最小方案——option 表不加列不建表）：

- **key 单源**：`personalizationUserKey(userId, field)` / `memoryProfileKeyFor(userId)` 等（`packages/tianshu-core/src/personalization-config.ts`），主进程 repo/scheduler/service/被控面与前端 `personalization-options.ts`（渲染层走 `@tianshu/core/personalization-config` 子路径，barrel 禁令）同源；
- **读侧**（`loadPersonalization(userId?)`）：per-user 行优先，缺席回落旧全局行；`fromAppOptions` 解析段签名不动（key 翻译收敛在 repo 层，server 双份段零扰动）；
- **迁移（升级不断忆）**：带 userId 首次读取时，旧全局行在场且新 key 缺席 → 旧值搬入当前用户命名空间（upsert），旧 key 行保留（兼容读取 + 可回滚）；新 key 已在场不覆盖；迁移写失败仅日志、读值仍回落旧全局行（对话不中断）。已知边界：升级后首个登录用户承继全局画像，此后新建用户经回落读亦可见该旧全局快照（增量隔离自迁移后生效——多用户升级语义挂账）；
- **scheduler**：夜间窗口逐用户迭代整理（素材按用户会话过滤；退避按用户独立计数）；兜底模型池保持 `listAllEnabledAnyUser`（v12 裁定沿用，「每用户独立候选池」多用户语义挂账）；
- **移动端被控面**：memory 五端点挂 `withUserId`（被控端当前登录用户），移动端 wire 零改动。

### 3.4 前端与移动端交互

- **桌面设置页** `MemoryGroup.tsx`（设置面板「记忆与进化」）：开关（乐观更新+失败回滚）、整理模型选择（ModelPicker 同源数据）、四板块只读 markdown 渲染（正文永远只读，修订 B）、「编辑」进入 AI 指令模式（底部指令框→主进程直接应用落库→失效 `["personalization"]` 缓存刷新）、重置（ResetMemoryDialog 二次确认，清 profile 不动开关/时间戳）、导入（ImportMemoryDialog 两步：复制预置提示词到外部 AI 生成四分类画像→粘贴合并追加）、手动整理按钮、状态行（上次整理时间/失败原因）。IPC 经 `src-react/domains/app-settings/api/memory.api.ts`（`personalization:applyMemoryInstruction` / `personalization:compileMemory` / `personalization:resolveMemorySources`——批9 起 token→userId）。**批9（2026-11-05）增**：画像随登录用户命名空间读写（前端 `parsePersonalizationOptions(items, userId)` per-user 行优先、写 `memoryProfileKeyFor(userId)`）；条目行 hover 逐条删除（`removeMemoryEntryLine`）与来源会话跳转（`resolveMemorySources` msgId→会话，关闭面板直达 `/module/ai?session=`，归属校验在主进程）；导出/导入 JSON 本地文件面（blob 下载 + `<input type=file>` 导入，画像走 mergeMemoryMarkdown 合并追加、手动记忆换行追加）；
- **消息级「存入记忆」入口（批9 P7）**：user 消息 hover 操作栏「存入记忆」按钮（MessageItem UserActionBar，Brain 图标）→ `applyInstruction`（管线现成只缺 UI 面；消息正文截 1800 字入指令；错误码经 `chat:memoryError.*` 映射 i18n）。未采用输入框 `/remember` 快捷指令方案——命令管线需特设「命令后文本改道记忆不发消息」的载荷语义，成本高于自包含的消息级按钮，且按钮与编辑/复制同区可发现性不弱；
- **移动端**（记忆进化批 2026-10-27，spec `docs/superpowers/specs/2026-10-27-mobile-memory-batch.md`）：`src/app/memory.tsx` 页（「我的」页入口，`capabilities?.includes("memory")` 门禁——`DESKTOP_CAPABILITIES` 含 `"memory"`，`packages/tianshu-protocol/src/server-event.ts:220`）；五端点 wire（`src/transport/memory-api.ts` → `ENDPOINTS.memory` 组）→ 桌面 `server-face/memory-tap.ts`（`createMemoryFace`：get 聚合读/saveConfig 显式携带才写/saveProfile 全量覆写空串=重置/applyInstruction+compile 转 MemoryService 公开方法——IPC 与被控面同源）；store（`src/store/memory.store.ts`）busy 单槽 + load 独立序号防迟到（资源隔离铁律）；错码五值 i18n 映射（`src/logic/memory-error.ts`）。不做：整段编辑、导入合并（留档）。

## 4. 三端布局（对称情况）

| 端 | 存储 | 调度 | 注入 | UI | 对称性说明 |
| --- | --- | --- | --- | --- | --- |
| **desktop** | option 表（唯一宿主） | MemoryScheduler 每夜窗口 | `assembleContext` → `buildPersonalizedSystem`（chat.service.ts:2242） | 设置面板全量（MemoryGroup） | 常量与拼接实现物理在 `@tianshu/core`，桌面 `personalization.prompt.ts` 仅 re-export（PL-1 拆分） |
| **server（无头端）** | 自己的 option 表（读侧，初始为空） | **无**（不实现不报） | `chat-runner.service.ts:1132` 同构注入 | 无 | `src/core/personalization.ts` 为桌面读段的**双份文件**（`fromAppOptions` 含 option-store 依赖不入包），`packages/tianshu-core/scripts/drift-manifest.json` `personalization-repo-read` 条目守护漂移；全默认时逐字节还原 modeSystem（D8），与桌面未配置行为一致 |
| **mobile** | 零本地存储 | 无 | 无（聊天经被控面/无头端，由宿主注入） | `/memory` 遥控页 | 契约单源 `@tianshu/protocol` memory-contract.ts；capability `memory` 桌面被控面专属，无头端连接不显示入口 |

不对称事实（重要）：

1. **server 的 option 模块是脚手架 stub**（`apps/tianshu-server/src/modules/option/option.service.ts` 为内存数组占位）——无头端没有个性化写面，其 option 表中的 `personalization.*` 行只能靠直接改库；因此**聊天切到远程无头主机时，注入的是无头端自己的记忆（通常为空），与桌面画像不同源**（单 UI 多主机架构下记忆不跟随主机切换，见 §6 改进点 2）。
2. **图执行/自动化管线不注入个性化**：`grep buildPersonalizedSystem` 在 `electron/domains/ai/orchestration/` 与 server graph 目录零命中——graph-prompt.ts（`renderNodePrompt`）只做模板变量替换，无画像/记忆段。
3. 移动端连桌面被控面时，五端点操作的就是桌面 option 表——与桌面设置页同一份数据，天然一致。

## 5. 业界主流做法对比

### 5.1 OpenAI ChatGPT Memory（bio + context 注入）

- **核心机制**：两类记忆——① saved memories（bio 记忆）：条目级短句（如「用户是素食者」），由独立的记忆提取模型在对话中异步写入，用户在设置里有 Memories 列表可逐条查看/删除；② chat history references：近期对话本身作为参考上下文注入。运行时两类内容以 developer/system 消息形式拼接注入，且有临时聊天（tmp chat）模式完全绕过记忆。企业版支持共享团队记忆。
- **特点**：条目级 CRUD、用户可见可控、提取与应用解耦（提取模型 ≠ 对话模型）、支持 memory tool（2025 起 API 化：模型主动调用写入）。
- **适用场景**：大规模消费级产品、强隐私合规要求（逐条删除=合规刚需）。
- **与天枢对照**：天枢「手动 memory + 自动 memoryProfile」双轨与 ChatGPT「saved memories + chat history」形态神似；差异在天枢画像是**单文档整体覆写**而非条目级存储（批9 起设置页已支持逐条删除与来源会话跳转，条目级行内管理对齐 Memories 列表体验，但底层仍是整文档重写而非条目 CRUD）。天枢 compiler 的准入二判据注释里明确参照了「OpenAI ChatGPT bio 记忆准入判据」。

### 5.2 Claude Code（MEMORY.md 文件式持久记忆 + 自动召回）

- **核心机制**：分层 markdown 文件——企业/用户级 `~/.claude/CLAUDE.md`、项目级 `CLAUDE.md`、目录级级联、`@import` 引用、自动记忆（auto memory）按项目生成 `MEMORY.md`；**每会话开始全量注入 context**（无检索，靠分层与人工裁剪控制体积）；更新方式是 **agentic self-edit**——模型在对话中直接用文件编辑工具改自己的记忆文件，并被告知「改了要告诉用户」。
- **特点**：零基础设施（纯文件）、完全透明可 diff、记忆与代码同仓可版本管理；代价是无语义检索，记忆量受 context 硬约束，召回靠「全文在场」。
- **适用场景**：开发者工具、本地优先、记忆量中等（几千行内）。
- **与天枢对照**：天枢画像同为 markdown 单文档全量注入（Claude Code 模式），但更新走**独立 LLM 管线**（夜间批处理）而非对话内自编辑——好处是不占对话轮次、prompt 可深度工程化（负面清单/few-shot 判断例），代价是隐式提炼滞后最多 24h（批9 起消息级「存入记忆」按钮已补显式即时入口，隐式画像更新仍隔夜）。

### 5.3 Mem0（提取-更新-冲突消解管线）

- **核心机制**：两阶段流水线——① extraction phase：从对话轮提取候选事实（带 NOT-extract 负面清单）；② update phase：把候选事实与既有记忆做向量检索取出相关条目，交给 LLM 以工具调用形式决策 `ADD / UPDATE / DELETE / NOOP`（逐条 diff 式冲突消解），记忆以条目级向量化存储；检索时按当前对话语义取 top-K 注入。支持 Graph Memory 变体（实体+关系图谱）。
- **特点**：条目级生命周期管理、增量更新、冲突显式消解；是「记忆即数据管线」的工程化代表。
- **适用场景**：需要 API 化嵌入任意产品的记忆层、对话量大、需要精准控制记忆膨胀。
- **与天枢对照**：天枢 compiler 的「与旧记忆合并：有效保留、过时删除、冲突以新为准」就是**把 Mem0 的 update phase 压缩进单次 prompt 输出**（模型自己输出整份新文档=隐式 ADD/UPDATE/DELETE 全集）；无条目 ID、无向量召回、无两阶段。天枢 2026-10-23 修订已吸收 mem0 NOT-extract 负面清单思想（代码注释点名）。差距主要在规模：8000 字符内单文档够用，超出后需要条目化。

### 5.4 Letta/MemGPT（分页记忆：core / archival / recall）

- **核心机制**：把 LLM 当操作系统，上下文窗口=内存，外部存储=磁盘，分三区——① core memory：常驻 context 的结构化块（persona + human），**agent 经 memory_replace/memory_append 等记忆工具自编辑**；② archival memory：向量库全量记忆，经 `archival_memory_search` 工具按需分页读入；③ recall memory：对话历史本体，经 `conversation_search` 检索。agent 自主决定换页（core memory editing 触发 context 重排）。
- **特点**：agent 自治、无限记忆分页装载、上下文窗口利用率最优化；实现复杂、行为可预测性弱于外部管线。
- **适用场景**：长周期自主 agent（有状态的长期助理）、对话轮次极多且需精确自我管理。
- **与天枢对照**：天枢事实上已构成 Letta 三区的雏形映射——memoryProfile ≈ core memory（常驻注入，但由外部夜间管线管理而非 agent 自编辑）；vectorChunk+library_search ≈ archival memory（但集合仅资料库，未覆盖对话记忆）；search_history ≈ recall memory（LIKE 版）。缺的是「agent 在对话中主动写记忆」的 memory tool 面。

### 5.5 Zep（时间知识图谱，Graphiti）

- **核心机制**：记忆不是文档/条目，而是**时间知识图谱**——实体节点、事实边（带文本）、社区（community）摘要节点；每次对话增量抽取实体与事实，新事实与旧边冲突时不是删除而是**双时态失效**（bi-temporal：t_valid/t_invalid，业务时间与系统时间分离），保留完整演变史；检索为图遍历+向量混合（实体召回+事实边过滤+社区摘要兜底），天然支持「X 什么时候变成 Y 的」类时间推理。
- **特点**：时间推理与事实演变追踪是独有能力；重量级（需图数据库+多次 LLM 调用），延迟与成本高于文档式方案。
- **适用场景**：客服/CRM 等需要用户状态长期演变追踪、合规审计留痕的企业场景。
- **与天枢对照**：天枢「近期动态按日期倒序、跨天推进的主题写当前关注」已是无图版的时间感编排；但无失效语义（旧条目靠模型在下次整理时删），无法回答「用户关注点如何迁移」。对天枢体量，Zep 属于超配，但其「失效而非删除」思想可低成本借鉴（见 §6）。

### 5.6 横向小结

| 方案 | 存储形态 | 更新者 | 检索 | 用户可见性 | 最适合 |
| --- | --- | --- | --- | --- | --- |
| ChatGPT Memory | 条目级（云端） | 独立提取模型+memory tool | 注入时筛选（服务端） | 列表逐条管理 | 消费级合规产品 |
| Claude Code | markdown 文件 | 对话内 agent 自编辑 | 全量注入+分层 | 完全透明可 diff | 开发者本地工具 |
| Mem0 | 条目级向量库 | 两阶段管线（extract→update 决策） | 向量 top-K | API 管理 | 可嵌入记忆层 |
| Letta/MemGPT | core 常驻块+archival 向量库 | agent 记忆工具自编辑 | 分页工具按需装载 | 工具可观察 | 长周期自主 agent |
| Zep | 时间知识图谱 | 增量抽取+边失效 | 图+向量混合 | 图谱可视化 | 事实演变/审计场景 |
| **天枢现状** | 单文档（option 行） | 外部夜间 LLM 管线 | 全量注入 | 四板块只读+AI 指令 | 单机桌面、记忆量小 |

### 5.7 对天枢的选型启示

各家可借件的「最小可用子集」：

- **ChatGPT**：条目级可见与逐条删除（合规与信任刚需）→ 对应 P4 的条目化与来源展示；
- **Claude Code**：markdown 单文档 + 用户可直接看/diff 的透明性天枢已有；缺的是「对话中即时写入」入口 → 对应 P3/P7；
- **Mem0**：update phase 的 ADD/UPDATE/DELETE 显式决策与 NOT-extract 负面清单——后者已吸收进 `MEMORY_COMPILER_SYSTEM_PROMPT`，前者在天枢体量下用「单 prompt 输出整份新文档」替代是合理简化，条目化后再考虑显式化；
- **Letta**：core（常驻）/archival（检索）分区——天枢四板块天然可二分：工作背景/个人背景=core（稳定、小、常驻），当前关注/近期动态=archival（时效、可检索）→ 对应 P1 混合形态；agent 自编辑 memory tool 是长期方向（需先解决幻觉写入与审批联动，天枢已有工具审批基建可复用）；
- **Zep**：bi-temporal 失效语义重量级，天枢用「条目日期 + 超龄淘汰规则」取其神（P4），图谱不引入。

## 6. 改进空间（按优先级）

### P1 条目级语义记忆检索（复用 vectorChunk 基础设施）——待后续批：依赖检索化立项

现状痛点：memoryProfile 单文档全量注入，8000 字符上限即天花板；「当前关注/近期动态」两类时效内容与「工作背景/个人背景」稳定内容同权重占坑，画像膨胀后每轮 token 成本线性上涨且无差别化。

落地方案：天枢**检索基础设施已就绪**——`vectorChunk` 表 + `VectorStore`（`electron/domains/ai/orchestration/vector-store.ts`：chunkText 分块/upsertChunks/searchChunks 内存余弦/searchFts BM25）+ `packages/tianshu-core/src/retrieval.ts`（rankBm25+rrfFuse）+ server 侧写入方先例（`src/core/library/library-vectorize.ts` 的 `vectorizeLibraryContent`，写后编排入库、失败静默跳过）。可新增 collection=`memory`：夜间整理时把画像条目逐条向量化（embedding 模型解析复用 graph-executor 的 embedTexts 路径）；聊天组装时按「最后一条 user 消息 + 会话标题」语义检索 top-K（8-16 条）注入，替换全量画像段。工作背景/个人背景可保留常驻注入（稳定且小），当前关注/近期动态走检索——即 Claude Code 常驻区 + Letta archival 的混合形态。注意桌面端 library 向量检索当前恒空（library 写面在 server），做桌面版需先落桌面 embedding 调用链。**批9（2026-11-05）注**：批9 交付的预算治理（P6）已覆盖「全量注入挤占窗口」的止血面（超预算按段裁剪），P1 的语义检索形态（常驻+检索混合）待检索化专项立项。

### P2 记忆的归属与跨主机一致性 —— ✅ 已落地（批9，2026-11-05，多用户隔离子项）

两个既成事实需要收敛：

1. **多用户隔离缺口——✅ 已落地（批9）**：画像三键按 `personalization.<userId>.<field>` 命名空间拆行（`memoryProfileKeyFor` 单源；读侧 per-user 优先 + 旧全局行首读迁移搬入，升级不断忆；scheduler 逐用户迭代、素材按用户会话过滤；被控面五端点挂 withUserId），A 的画像不再进 B 的对话。挂账：scheduler 兜底模型池保持 `listAllEnabledAnyUser`（「每用户独立候选池」语义待定）；手动记忆/人设/指令等其余键仍本机全局；迁移后新建用户经回落读可见升级前的旧全局快照（见 §3.5 边界注）。
2. **单 UI 多主机不同源——未落地**：聊天切远程无头端时注入的是无头端自己（通常为空）的 option 表（§4 不对称事实 1），用户感知为「换主机 AI 就失忆」。方案 A：把个性化读写面挂进 `src-react/domains/ai/data-source/` 主机路由层（host-route 双通道：本地 invoke / 远程适配器），设置页读写当前主机；方案 B：聊天载荷携带桌面画像（受 token 与隐私约束，仅适合小画像）；方案 C：被控面透出个性化同步端点（server 已有 memory-tap 先例可反向做）。

### P3 记忆生成的即时性（事件驱动触发）——未落地

现状：夜间窗口+启动补跑+手动+消息级「存入记忆」（批9 P7 补齐即时显式入口），白天画像最多滞后 24h；「用户刚说了关键偏好，下一条消息就要被记住」做不到（隐式提炼仍隔夜）。inflight 单槽互斥（memory-inflight.ts）与 compileOnce 管线已具备随时复跑能力。落地：会话归档/删除/长时间无活动（如 30 分钟 idle）时触发一次增量整理（材料窗口可收窄到上次整理点之后）；成本护栏沿用失败退避与 LastCompiledAt 语义（需新增「部分整理」游标 key，如 `memoryLastMaterialAt`）。参照 ChatGPT 的轮内异步提取，但天枢可保守地从「会话生命周期事件」起步，避免每轮调用的成本与污染面。

### P4 记忆溯源与失效语义 —— ✅ 已落地（批9，2026-11-05）

原痛点：条目无 provenance（不知道哪条来自哪次会话），AI 指令误删无法审计；「近期动态」旧条目靠模型下次整理时淘汰，漏淘汰即永久占坑。**批9 落地**：素材行携带 `[#msgId]` 标记（fetchRecentConversation），条目行格式升级 `[YYYY-MM-DD|#msgId] - 内容`（旧格式兼容解析）；整理 prompt 增加显式失效规则（当前关注/近期动态条目超过 30 天无新材料支持 → 移出）；设置页条目行来源会话可跳转（`personalization:resolveMemorySources` msgId→会话，归属校验后直达）+ 逐条删除（IA 从「AI 指令」升级为「逐条删除」，对齐 ChatGPT Memories 列表体验——`removeMemoryEntryLine`）。

### P5 recall 面升级：search_history 语义化——待后续批：依赖检索化立项

现状：`history-search-tool.ts` 是 LIKE 子串匹配（注释明确 FTS5 否决原因：server Prisma 引擎栈无 FTS5，共享面不可假设），「上次讨论的那个部署方案」这类自然语言查询命中率低。落地：与 P1 同基础设施——message 按会话粒度摘要后入 vectorChunk（collection=`history`），search_history 改为向量+BM25+RRF（retrieval.ts 现成）；无 embedding 模型时降级现 LIKE 实现。P1 若落地本项几乎零边际成本。**批9（2026-11-05）注**：批9 未含检索化（P1/P5 均留给后续批），预算治理（P6）与条目溯源（P4）不依赖检索面。

### P6 画像注入的预算治理 —— ✅ 已落地（批9，2026-11-05）

原痛点：persona(4000)+memory(1500)+memoryProfile(8000)+customInstructions(1500) 全量进 system，`estimateReserveTokens` 虽计入 system 体积但无差异化压缩；小 contextWindow 模型下记忆段挤占历史窗口。**批9 落地**：`trimPersonalizationForBudget` / `trimProfileToBudget`（`packages/tianshu-core/src/personalization-budget.ts`，纯函数三端单源）——预算 `max(2048, floor(window×0.12))`（无窗口不裁剪），超预算按段保留优先序裁剪（customInstructions > memory > 工作背景/个人背景 > 当前关注 > 近期动态；persona 恒保留先占预算）；预算内逐字节不变（前缀缓存友好）；usage 面板透出「记忆占用」（ContextUsageBreakdown.memory / SessionUsageBreakdown.memory，含于 system 项的拆解展示）。

### P7 体验补齐（低成本）

- 对话内「记住这个」入口——✅ 已落地（批9）：user 消息 hover「存入记忆」按钮直调 `applyInstruction`（管线现成，只缺 UI 面；选消息级按钮弃输入框指令方案的理由见 §3.4）；
- 移动端差集：整段编辑与导入合并（spec 留档不做项）可经 saveProfile 全量覆写低成本补齐——未落地（挂账）；
- 记忆导出 JSON/跨设备迁移——✅ 已落地（批9）：设置页「导出/导入 JSON」本地文件面（画像走 ImportMemoryDialog 同款 mergeMemoryMarkdown 合并语义 + 手动记忆随行）；
- server 端记忆写面：option 模块目前是脚手架 stub，若远程无头主机要独立用记忆，需补最小写面（或直接复用 memory-tap 的 face 协议反向实现）——未落地（挂账）。

## 附：引用文件清单（抽查用）

- apps/tianshu-desktop/electron/domains/ai/personalization/memory-compiler.ts
- apps/tianshu-desktop/electron/domains/ai/personalization/memory-scheduler.ts
- apps/tianshu-desktop/electron/domains/ai/personalization/memory.service.ts
- apps/tianshu-desktop/electron/domains/ai/personalization/personalization.repo.ts（批9 userId 隔离读 + 迁移）
- apps/tianshu-desktop/electron/domains/ai/chat/chat.service.ts
- packages/tianshu-core/src/personalization-config.ts
- packages/tianshu-core/src/personalization-prompt.ts
- packages/tianshu-core/src/personalization-budget.ts（批9 预算治理）
- packages/tianshu-core/src/history-truncate.ts / tool-output-trim.ts / time-context.ts / retrieval.ts
- packages/tianshu-protocol/src/memory-contract.ts
- apps/tianshu-server/src/core/personalization.ts / chat-runner.service.ts / library/library-vectorize.ts
- apps/tianshu-desktop/src-react/domains/app-settings/components/MemoryGroup.tsx / model/memory-markdown.ts
- apps/tianshu-mobile/src/app/memory.tsx / src/store/memory.store.ts / src/transport/memory-api.ts
- apps/tianshu-desktop/electron/domains/server-face/memory-tap.ts / ipc.ts
- apps/tianshu-desktop/electron/domains/ai/agent/history-search-tool.ts / library-search-tool.ts
