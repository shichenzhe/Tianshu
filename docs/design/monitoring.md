# 用量监控技术方案

> 调研日期：2026-11-05。范围：桌面端（apps/tianshu-desktop）用量监控模块现状 + 无头端（apps/tianshu-server）对称实现 + 移动控制端消费面，并对照业界 LLM 可观测性主流做法给出改进空间。
> 现状基线：监控本体由 MO 批（2026-10-27）落地，被控面读面由 A6 批落地，聚合纯函数与协议类型已收编共享包单源。本文除 §5 业界对比外全部基于仓库实测代码。

## 1. 模块定位与总览

用量监控是**机器遥测（telemetry）**面，回答「AI 到底跑了多少、花了多少 token、工具好不好用」；它不是操作日志（审计语义，见 §7 边界）。监控对象为三个业务场景（`MonitorScene = "chat" | "graph" | "automation"`，定义于 `packages/tianshu-protocol/src/monitor-contract.ts`）的两类事件：

- **LLM 调用事件**（`llmCallEvent`）：一次助手回合 / 图节点的 token 用量与耗时；
- **工具调用事件**（`toolCallEvent`）：一次工具执行的终态（done/denied/error）与耗时。

整条数据流（本地桌面端视角）：

```
LangChain 流（usage_metadata 多轮记账，agent-chunk-emitter）
  └─ runChatStream（@tianshu/core）收尾 → blocks 里的 usage 块
       └─ chat.service 流收尾 → usageFromBlocks 提取
            └─ recordLlmCall（fire-and-forget，静默吞错）
                 └─ SQLite llmCallEvent 表（启动时 90 天裁剪）
                      └─ MonitorRepository.getStats（7 天窗口 findMany）
                           └─ computeMonitorStats 内存聚合（@tianshu/core 单源）
                                └─ IPC monitor:stats → MonitorView
                                     （KPI / 7 天趋势 / 模型分布 / 工具排行）
```

工具事件同构：`tool-gate.ts` 终态回调 `toolStats` → `recordToolCall` → `toolCallEvent` 表。

**现状能力一览**（有/无清单，后文逐一展开）：

- 有：三场景全量埋点（无采样）、7 天窗口聚合、场景筛选、按模型/按工具分布、90 天保留裁剪（仅桌面）、无头端对称读面 + 移动端遥控查看；
- 无：成本核算（无单价表）、事件明细列表/会话下钻、导出与归档、trace 树视图、错误/中止轮次成功率口径（这两类轮次不写 llm 事件）、桌面 UI 远程主机遥看（监控页未接主机路由层）。

**单源原则**（MO 批收编后的形态）：

| 职责 | 单一权威源 | 消费方 |
| --- | --- | --- |
| 协议类型 `MonitorScene` / `MonitorStats` | `packages/tianshu-protocol/src/monitor-contract.ts` | 三端 |
| 埋点函数 `recordLlmCall` / `recordToolCall` / `recordGraphMonitorEvents` / `usageFromBlocks` | `packages/tianshu-core/src/monitor-events.ts` | 桌面 + server 埋点共六处 |
| 聚合纯函数 `computeMonitorStats` | `packages/tianshu-core/src/monitor-stats.ts` | 桌面 `monitor.repo` + server `monitor.service` |
| 桌面仓储与 IPC | `apps/tianshu-desktop/electron/domains/ai/monitor/monitor.repo.ts` | 桌面本地 + 桌面被控面（A6） |
| server 聚合接口 | `apps/tianshu-server/src/modules/monitor/` | 移动端等遥控方 |

桌面端 `electron/domains/ai/monitor/` 下 `monitor-events.ts` 与 `monitor-stats.ts` 现为 re-export `@tianshu/core` 的过渡形态（保三处埋点的 import 路径不变）。

## 2. 数据模型

双端 schema 同构：桌面 `apps/tianshu-desktop/prisma/schema.prisma:481-512`，server `apps/tianshu-server/prisma/schema.prisma:457-486`（注释口径逐字一致）。

### 2.1 llmCallEvent（LLM 调用事件）

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `id` | Int 自增 | 主键 |
| `userId` | Int? | 多用户隔离（v12 起业务表统一带 userId；IPC 层经 token 解出，前端不传用户 id） |
| `scene` | String | `chat` / `graph` / `automation` 三值 |
| `modelId` | Int? | chat/automation 场景有值；**graph 场景恒 null**（trace 无模型归属） |
| `sessionId` | Int? | chat/automation 会话；graph 去会话化（2026-10-28）后不写 |
| `graphId` | Int? | 仅 graph 场景 |
| `inputTokens` / `outputTokens` | Int（NOT NULL） | 该事件的输入/输出 token 数 |
| `durationMs` | Int? | 耗时：chat/automation 为整轮 wall-clock（含工具执行时间）；graph 为节点级 |
| `createdAt` | DateTime | 落库时间，聚合主查询键 |

索引：`@@index([userId, createdAt])`——7 天窗口聚合的主查询路径。

### 2.2 toolCallEvent（工具调用事件）

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `userId` / `scene` / `sessionId` | 同上 | — |
| `toolName` | String | 工具名（工具别名层归一后的 canonical 名） |
| `state` | String | `done` / `denied` / `error` 三终态 |
| `durationMs` | Int? | 仅执行路径有值；denied（未真正执行）无计时 |
| `createdAt` | DateTime | — |

索引：`@@index([userId, createdAt])` + `@@index([userId, toolName])`（工具排行分组路径）。

### 2.3 载荷保留策略：零载荷

事件表**不存任何入参出参**——无 prompt/completion 文本、无工具 args/output、无错误 message、无 errorCode。这是有意的最小化设计：原文另有归属，事件表只做度量计数：

- chat 轮次原文（含 usage 块本身）在 `message.blocks`（`UsageBlock { type: "usage"; input: number; output: number }` 定义于 `packages/tianshu-protocol/src/chat-contract.ts:78`）；
- graph 执行明细在 `automationRun.graphTrace` JSON（`TraceEntry` 含 tokens/toolCalls/error/outputPreview 等，桌面定义于 `electron/domains/ai/orchestration/graph-executor.ts:107`）与 `graphRunNode` 节点级详情表（runId/nodeId/status/promptTokens/completionTokens 等列）；
- 工具调用的拒绝原因在 `securityAuditLog`（见 §7）。

### 2.4 建表与保留期（双端不一致，如实记录）

- **桌面**：不走 v1 快照（快照 sha256 指纹变化会触发旧库 drop 重建，见 CLAUDE.md 快照守卫说明），由 `ensureMonitorTables()`（`electron/commons/prisma-client.ts:85`）启动幂等 `CREATE TABLE IF NOT EXISTS` 建两表 + 补三索引；`Application.execute()`（`electron/Application.ts:133`）在 `initDatabase` 后调用，失败仅记日志不阻塞启动。
- **server**：经 Prisma 基线迁移建表（`apps/tianshu-server/prisma/migrations/0_init/migration.sql:329`），无运行时 DDL。
- **保留期**：桌面 90 天——`ensureEventStatMaintenance()`（`prisma-client.ts:188`）启动时对 `llmCallEvent`/`toolCallEvent`（连同 `skillStat`/`automationStat` 埋点表）按 `cutoff = now - 90 天` `deleteMany` 裁剪，且必须串行待 `ensureMonitorTables` 成功后再跑（`Application.ts:128` 注释明确：维护函数会对新表 deleteMany，微任务交错下会 `no such table`）。**server 端无任何裁剪逻辑**（全仓 grep `llmCallEvent.deleteMany` 零命中），无头端长驻进程下事件表无界增长；桌面裁剪也只在启动时跑一次，应用长驻数周期间不清理。

## 3. 核心技术方案（埋点链路）

### 3.1 LLM usage 的来源：LangChain usage_metadata 的多轮记账

天枢 LLM 栈统一 LangChain，token 数据源是 `AIMessageChunk.usage_metadata`（`{ input_tokens, output_tokens, ... }` 归一口径）。难点在流式 + 多步工具循环：一次助手回合包含**多次模型调用**（每轮工具循环一步），每次调用又分**多个流式 chunk**，且不同厂商上报习惯不同（OpenAI 兼容系末 chunk 单报全值；anthropic/google 分 chunk 增量报）。

记账收敛在 `packages/tianshu-core/src/agent-chunk-emitter.ts` 的 `makeUsageAccumulator()`（210-263 行），由 `consumeAgentStream` 驱动：

1. **流式 chunk 报告**：`on_chat_model_stream` 事件的 chunk 带 `usage_metadata` 时 `addStreamReport(runId, usage)` 按 run_id 累加进轮账——增量口径累加正确，末 chunk 单报全值也正确（LangChain `AIMessageChunk.concat` 对 usage_metadata 求和）；
2. **end 权威覆盖**：`on_chat_model_end` 的聚合消息（concat 产物）是「该轮权威总值」，`settleRun(runId, endUsage)` 以其**覆盖**轮账后结算入总账；`settledRuns` 集合保证同一轮 stream/end 双报不双计；仅聚合上报的模型（流式不报 usage 的回退分支）在此首次入账；
3. **finish 兜底**：`finish()` 把轮账仍有余额的 run（退化流缺 end 事件）按已上报值兜底结算，幂等可双调（轮账清空后二调返回原值）。

错误与中止路径语义不同（`agent-chunk-emitter.ts:390-400`）：错误路径**补调一次** `finish()` 转发已结算余额（终审 T9a：保险丝触顶截断等场景不丢 token 统计）——所以「错误但有部分产出的轮次」仍会写事件行；**用户中止路径不调 finish——中止轮无 usage 块、不写事件行**（与「已生成内容照常保留」的 UI 口径一致，但统计上这轮调用消失）。

最终 `runChatStream`（`packages/tianshu-core/src/run-chat-stream.ts:398`）把总额写进 blocks：`blocks.push({ type: "usage", input, output })`。

graph 场景不走流式 accumulator：`graph-executor.ts:1523` 的 `extractTokenUsage(raw)` 直接读节点调用的 AIMessage——`usage_metadata.input_tokens/output_tokens` 优先，OpenAI 兼容协议读 `response_metadata.usage`（`prompt_tokens`/`completion_tokens`）兜底，均缺席则省略（不硬造）。token 随节点结果存进 `TraceEntry.tokens = { promptTokens, completionTokens }`。

### 3.2 三处埋点（桌面端，函数与行号实测）

**chat**（`electron/domains/ai/chat/chat.service.ts`）：

- LLM：流收尾持久化 assistant 消息之后，`usageFromBlocks(result.blocks)`（2040 行）提取 usage 块 → `void recordLlmCall(prisma, {...})`（2042 行）。**一行事件 = 一次助手回合**（回合内多轮模型调用的 token 已由 accumulator 求和，`durationMs = Date.now() - startedAt` 为整轮耗时、含工具执行时间）。
- 工具：agent 装配时注入 `toolStats` 回调（1655 行）：`(e) => void recordToolCall(prisma, { ...e, scene: "chat", userId: session.userId ?? null, sessionId })`。

**automation**（`electron/domains/ai/automation/automation-runner.ts`）：prompt 任务跑完 `extractUsage(result.blocks)`（449 行，本地同款 usage 块提取的私有实现）→ `recordLlmCall`（451 行，`modelId: task.modelId`，durationMs 整轮）；工具经同款 `toolStats`（440 行，scene `automation`）。

**graph**（`electron/domains/ai/orchestration/graph-executor.ts`）：不走 usage 块，改由 run 收尾统一转换——`finishRun`（1852 行，成功/失败同径）调 `recordGraphMonitorEvents(prisma, { graphId, userId, sessionId: null, trace })`（1858 行）。`buildGraphMonitorEvents`（core `monitor-events.ts:97`，纯函数）遍历 `TraceEntry`：带 `tokens` 的节点逐个产出 llm 事件（`modelId` 恒 null），`toolCalls` 数组逐条产出工具事件（`state: call.ok ? "done" : "error"`），`Promise.all` 一次性写入。同一份 trace 同时也把总额落进 `automationRun` 行的 `promptTokens`/`completionTokens` 列（`sumTokens`），监控表与 run 行是并行记账而非派生。

**写入策略四特征**：

- **全量无采样**——本地单机量级下每回合/每工具终态各一行，无采样率配置；
- **异步 fire-and-forget**——所有调用点 `void` 前缀不 await，不阻塞主流程；
- **静默吞错**——`recordLlmCall`/`recordToolCall` 内部 try-catch 空 catch（core 零依赖无 Log；「埋点属可观测性，失败绝不影响主流程」）；
- **可注入**——PrismaLike 结构子集接口（`LlmCallPrismaLike`/`ToolCallPrismaLike`），stub/真实客户端均可，缺席（纯函数测试形态）静默跳过。

### 3.3 工具事件终态判定

`toolStats` 回调合同定义在 `electron/domains/ai/agent/tool-gate.ts:116`（agent 装配面的可选注入项）：

- **denied（无计时）**：六处拒绝路径各报一次——工作空间未绑定/权限未授（475）、命令门 HIGH/CRITICAL 拦截（494）、文件门越界（516）、审批拒绝（544）、无人值守强拒（568）、危险工具门（651）；
- **done / error（有计时）**：工具执行收尾统一出口（700 行），`state` 以输出是否以「错误:」前缀开头判定，`durationMs = Date.now() - toolStartedAt`；用户中止的提前返回处不报（spec §4.2 裁定）。

### 3.4 聚合查询与 IPC

`MonitorRepository`（`electron/domains/ai/monitor/monitor.repo.ts`，`Application.ts:280` 实例化注册）构造函数内 `handleUser("monitor:stats", (_, userId, scene?) => this.getStats(...))` 注册 IPC——userId 由 token 层解出，scene 非白名单值归 undefined（聚合全量）。`getStats(userId, scene?)` 三步：

1. 7 天窗口（`WINDOW_DAYS = 7`）`Promise.all` 对两表 `findMany`，各取聚合所需 4 列（llm：modelId/inputTokens/outputTokens/createdAt；tool：toolName/state/durationMs/createdAt）；
2. 收集非 null `modelId` 去重后联查 `model` 表补模型名（`name ?? modelId ?? #id` 三级回退）；
3. `computeMonitorStats(llmRows, toolRows, models, now)` **内存聚合**——无 SQL groupBy（头注释口径：本地单机千级行，automation-stats `computeStats` 同构、skill-stats 决策 4 同判词）。

聚合口径细节（core `monitor-stats.ts` 头注释即文档）：

- 工具成功率 = `done/(done+denied+error)`——**denied 进分母**（与自动化成功率「skipped 不进分母」刻意不同：工具被拒是可观测结果）；
- `byModel` 跳过 `modelId = null` 的行（graph 场景——今日/趋势已含其 token，模型分布不重复计）；
- 趋势 7 天含空日补零（旧→新），日键 `localDateKey` 取设备本地时区 `yyyy-MM-dd`；
- `avgDurationMs` 仅非 null 行参与均值；`byModel` 按 inputTokens 降序、`tools` 按 total 降序。

返回的 `MonitorStats` 形状（协议 `monitor-contract.ts` 单源）：`today { inputTokens, outputTokens, llmCalls, toolCalls, toolSuccessRate }` + `trend[7] { date, inputTokens, outputTokens, llmCalls, toolCalls }` + `byModel[] { modelId, name, calls, inputTokens, outputTokens }` + `tools[] { toolName, total, done, denied, error, avgDurationMs, successRate }`。

### 3.5 前端呈现（/module/ai/monitor）

路由：`src-react/routes/index.tsx`（271 行 `path: "monitor"`，懒加载 MonitorView，在 `/module/ai` 认证布局内）。前端文件均在 `src-react/domains/ai/monitor/`：

- **api/monitor.api.ts**：`MonitorApi.stats(scene?)` → `invoke<MonitorStats>("monitor:stats", scene)`；类型 re-export 协议包（A6 批自前端收编后的回流引用）；
- **views/MonitorView.tsx**：React Query `queryKey: ["monitor", "stats", scene]`，场景切换即失效重拉；结构为三段——KPI 卡行（今日输入/输出 token、LLM 调用数、工具调用数·今日成功率，`KpiCard` 为 AutomationStatsPanel 同款）、7 天趋势（`MonitorTrendChart`）、双表（按模型分布：模型名/调用数/输入/输出 token；工具排行：总数/成功率/平均耗时/拒绝数/错误数，denied/error > 0 标 `text-destructive/80`）。场景筛选 chips（all/chat/graph/automation）存 **store/monitor.store.ts**（zustand，仅 scene 一字段）并挂 TopBar trailing（`usePageHeaderStore`）；
- **components/MonitorTrendChart.tsx**：纯 CSS 双柱图（无图表库）——每日两柱 token 总量（`bg-primary`）/调用次数（`bg-primary-active`），**两序列各自以窗口内单日最大值独立归一**（token 量级远大于次数，共用基准会让调用柱恒 3px 不可读）；零值柱 2px 且 `opacity-30` 保持占位，tooltip 用原生 `title` 插值；
- **lib/format.ts**：`formatCount` / `formatDuration`；
- **i18n**：`chat:monitor.*` 命名空间键（title/sceneAll/trendTokens/byModelTitle/toolsTitle 等），zh-CN 与 en-US 双份 `src-react/i18n/locales/{zh-CN,en-US}/chat.json`；
- **测试**：`tests/ai/` 下 `monitor-table.test.ts`（建表）、`monitor-events.test.ts`（埋点纯函数）、`monitor-stats.test.ts`（聚合）、`monitor-store.test.ts`、`monitor-view.test.tsx`、`monitor-emit-chat.test.ts`（chat 链路落库）六件套。

### 3.6 无头端对称埋点（server）

server 三处埋点与桌面逐字同位（MO 批对称移植，埋点函数同引 `@tianshu/core` dist）：

- **chat**：`apps/tianshu-server/src/core/chat-runner.service.ts`——`usageFromBlocks` 后 `void recordLlmCall(this.prisma, {...})`（994 行，scene `chat`、`modelId: ctx.modelRow.id`）；agent 装配 `toolStats` 回调（1168 行）转发 `recordToolCall`；
- **automation**：`src/modules/automation/automation-runner.ts`——`toolStats`（441 行）与 `extractUsage` 后 `recordLlmCall`（467 行），Prisma 句柄经 `graphExecutorRuntime().db` 取（server 无独立 monitor 域，运行时注入面复用 graph 的）；
- **graph**：executor 进程级运行时 `src/core/graph/executor-runtime.ts` 定义 `recordMonitorEvents?` 注入面（`GraphMonitorEventsParams` 与桌面 `recordGraphMonitorEvents` 入参同形），`src/modules/graph/graph.module.ts:88` 装配为 `void recordGraphMonitorEvents(prisma, params)`（授权面 5/7 头注释即此）。

### 3.7 测试覆盖

- `tests/ai/monitor-table.test.ts`：`ensureMonitorTables` 建表/幂等；
- `tests/ai/monitor-events.test.ts`：`usageFromBlocks` / `buildGraphMonitorEvents` / record 函数吞错与 PrismaLike 缺席跳过；
- `tests/ai/monitor-stats.test.ts`：`computeMonitorStats` 聚合口径（成功率分母、空日补零、null modelId 跳过等）；
- `tests/ai/monitor-emit-chat.test.ts`：chat 链路端到端落库（真替身 prisma）；
- `tests/ai/monitor-store.test.ts` / `monitor-view.test.tsx`：前端 store 与视图渲染。

## 4. 三端布局（本地事件 vs 无头端事件）

设计原则：事件**不跨端回传**——谁执行谁落自己的库（本地遥测各自闭环），遥控方按需拉取**聚合面**（只读、不拉明细）。

| 端 | 埋点落库（写面） | 读面 |
| --- | --- | --- |
| 桌面本地 | chat.service / automation-runner / graph-executor 三处 → `~/.tianshu/<分组>/database/local.db` | IPC `monitor:stats` → `/module/ai/monitor` MonitorView |
| 无头端 server | 对称三处：`src/core/chat-runner.service.ts`（994 行 recordLlmCall / 1168 行 toolStats-recordToolCall）、`src/modules/automation/automation-runner.ts`（441/467 行，经 `graphExecutorRuntime().db` 取 Prisma 句柄）、graph 经 `executor-runtime` 注入 `recordMonitorEvents`（`src/modules/graph/graph.module.ts:88`，授权面 5/7） | `POST /monitor/stats`（`src/modules/monitor/monitor.controller.ts`）：`@Public` 豁免 JWT、`TIANSHU_TOKEN` 静态 token 守卫照常；`MonitorService.getStats(COMPANION_USER_ID, scene)`（`monitor.service.ts`，与桌面 repo 逐字同构，compute 引 core dist） |
| 桌面被控面（server-face） | 不另落库——直接复用本地 MonitorRepository | `electron/domains/server-face/routes.ts` 的 `handleMonitorStats`（359 行）：scene 白名单（`SCENE_LIST`）→ `faceDeps().monitor.stats(userId, scene)` → `MonitorRepository.getStats`；路由表注册 `"POST monitor/stats"`（2506 行）；deps 装配在 `server-face/ipc.ts:564`（monitorRepo 由 Application 注入，缺席报 bizError 5000「monitor 面未装配」） |
| 移动控制端 | 无 | `apps/tianshu-mobile/src/app/monitor.tsx` + `src/store/monitor.store.ts`：`transport.request("POST", ENDPOINTS.monitor.stats, { scene })`，`activeTransport()`（`connections.store.ts:327`）抽象直连/relay 两形态；信封解包查 `body.success === true`；`loadSeq` 序号守卫防迟到响应覆盖新场景；入口由 capability 门控（`app/(tabs)/settings.tsx:329` `capabilities?.includes("monitor")`）；趋势柱高纯函数 `src/logic/monitor-trend.ts`（与桌面不同：整个窗口共用一个 token 峰值） |

能力协商（`packages/tianshu-protocol/src/server-event.ts`）：无头端 `CAPABILITIES` 与桌面被控端 `DESKTOP_CAPABILITIES` 均含 `"monitor"`（无头端是 MO 批、桌面是 A6 监控读面）；端点常量 `ENDPOINTS.monitor.stats = "monitor/stats"`。relay 链路下移动端请求与其他远端端点同走 relay transport（E2E 加密信道），无监控专属通道。

**多用户口径差异**：桌面事件按真实 `userId` 隔离（chat 取 session 行、automation 取 task 行）；server 是单伴生用户模型，聚合恒用常量 `COMPANION_USER_ID`（`src/commons/config/tianshu-config.entity.ts`，全仓 20+ 处同口径）。

**现状缺口（如实记录）**：桌面 UI 的监控页**未接主机路由层**——`monitor.api.ts` 直 `invoke` 本地通道，而 chat/model/provider/session/skill 等域已按 `src-react/domains/ai/data-source/host-route.ts` 的 `routeInvoke` 模式双通道路由化（本地 invoke / 远程 `requestRemote(connId, ...)` 适配器，UI 透明）。即：HostSwitcher 切到远程主机后，`/module/ai/monitor` 仍显示**本地**数据；远程主机的用量目前只有移动端（或任何直连 monitor/stats 的控制端）能看，主机页（/module/ai/server）本身也无用量模块。

## 5. 业界主流做法对比

| 方案 | 形态 | trace 粒度 | 成本核算 | 保留策略 |
| --- | --- | --- | --- | --- |
| **Langfuse** | 开源 LLM 工程平台（云/自托管） | **trace → span/generation/event 树**：一次请求/会话为 trace，内嵌模型调用（generation）、工具 span、agent 步骤；trace 按 session 聚合成会话视图，支持人工/自动评估打分（scores） | 内置模型单价表自动「单价 × usage」折算；支持自定义模型价格、分层定价（pricing tiers：同一模型按条件匹配 batch/分层价，2025-12 引入） | 云侧按量计费（trace+observation+score 三元计费，采样与 span 过滤直接降账单）；自托管 v3 起事件存储走 ClickHouse（+ Postgres/Redis），TTL 自管 |
| **Helicone** | 代理层/AI 网关统计（也提供 async logger / 消息队列旁路） | 请求级（每次过网关的调用一行），按 key/tag/user/route 维度切片聚合，弱树形；顺带缓存/限流/重试治理 | 单价表折算 + 预算告警/限额 | 云侧分级保留；self-host 可自管 |
| **OpenTelemetry GenAI semantic conventions** | 埋点**标准**（非产品后端），GenAI SIG 2024-04 起演进，现维护在 OTel GenAI semconv 专仓 | span 级：`gen_ai.*` 属性（`gen_ai.usage.input_tokens` / `output_tokens`、`gen_ai.system`、`gen_ai.operation.name` 等）+ prompt/completion 以 span event 携带；agent 会话树靠 span 父子关系天然表达，配任意 OTel 后端 | 标准不含单价，成本由所选后端自算 | 取决于后端（Jaeger/Signoz/ClickHouse 等） |
| **OpenAI / Anthropic 官方 usage dashboard** | 厂商控制台 + Usage API | 组织/项目/模型级日聚合曲线 + 速率限制用量，**无单会话 trace**，粒度最粗但零接入成本；OpenAI 另有按 feature/project 拆分 | 账单级精确（即计费本体）；API 可导出明细 | 厂商侧窗口（约 30 天曲线 + 账单记录长期） |
| **自建时序方案（ClickHouse/Timescale 常见形态）** | append-only 事件表 + 查询时聚合 | 事件级；树形需自建 parent_id/trace_id 列 | 自配单价表折算 | 物化视图按分钟/日 rollup + TTL 分层（热明细 + 冷归档），查询永不扫明细 |
| **天枢现状** | SQLite 事件表 + 读时内存聚合 | **事件级扁平**：无 trace 树、无 span 父子；一行 = 回合/节点/工具终态，sessionId 可关联回会话但前端不展示 | **无成本核算**（无单价表，token 原样展示；provider/model 表亦无价格字段） | 桌面 90 天启动时一次性裁剪；server 无裁剪；无归档导出 |

### 5.1 Langfuse（trace 树 + 成本 + 评估的参考标杆）

开源 LLM 工程平台，云托管与自托管（self-host 核心功能免费不限量）双形态。接入侧提供多语言 SDK、OpenAI drop-in 包装、LangChain CallbackHandler 等——对天枢这类 LangChain 栈，理论上一个 callback 即可挂上。数据模型三层：**trace（一次请求/会话根）→ observation（span 嵌套树，generation 表模型调用、span 表工具/agent 步骤、event 表轻量点）→ score（评估打分，人工标注或 LLM-as-judge 自动评估挂在 trace 上）**；trace 按 session_id 聚合成会话视图，能直接回答「这一个会话花了多少、哪一步最慢、哪次回答被打了低分」。

成本核算：内置主流模型单价表（社区维护的 model specs），观测到达时「单价 × usage」自动折算；支持自定义模型价格（v2 起）、分层定价 pricing tiers（2025-12 起，同一模型按条件——如 batch/上下文长度档——匹配不同价）。保留：云侧按 trace+observation+score 三元按量计费，采样与 span 过滤直接降账单；自托管 v3 起事件存储走 ClickHouse（配 Postgres/Redis），规模自管。

对天枢的启示：trace 树与会话聚合是最值得借鉴的形态（天枢 sessionId 已具备分组键）；成本单价表 + tiers 机制直接可平移（§6 改进 3）。

### 5.2 Helicone（代理层统计）

AI 网关形态：请求改走 `*.helicone.ai` 代理域名（或 async logger / 消息队列旁路，不拦截主路径），网关侧逐请求记录并转发上游。聚合维度是请求级：按 API key、自定义 header（user/session/route 的 property）、模型切片出 dashboards；顺带提供缓存（重复 prompt 省钱）、限流、重试、分布式路由等治理能力。成本有单价折算与预算告警。保留策略云侧分级、self-host 自管。

对天枢的启示：天枢是本地库直记（不经代理），多了一跳零成本；但「按属性切片」的思路对应天枢的 scene 维度——天枢目前只有 scene 一个切片轴，sessionId/userId/graphId 列已存但未提供查询面。

### 5.3 OpenTelemetry GenAI semantic conventions（标准而非产品）

OTel 语义约定的 GenAI 专卷（GenAI SIG 2024-04 成立，现已迁至 OTel GenAI semconv 专仓维护）。核心是把 LLM 调用建模为 span：属性如 `gen_ai.system`（provider）、`gen_ai.operation.name`（chat/completions 等）、`gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`（token 计数标准化，跨厂商可聚合）、`gen_ai.request.model` 等；prompt/completion 内容以 span event 携带（opt-in，隐私可控）；agent 会话树天然由 span 父子关系表达——一次会话根 span 下挂多步模型/工具子 span。OTel 本身只定义埋点与传输，后端任选（Jaeger/Signoz/ClickHouse 系）。

对天枢的启示：天枢若要对接标准生态（§6 改进 9），只需在 `recordLlmCall`/`recordToolCall` 旁挂一个 OTel span 构造器，属性名照 semconv 走即可复用整个后端生态；token 字段命名也可先对齐（input_tokens/output_tokens 天枢协议已是同义词）。

### 5.4 OpenAI / Anthropic 官方 usage dashboard

厂商控制台内建用量页：组织/项目/模型级的日花费曲线、token 用量拆分、速率限制消耗水位，OpenAI 另按 feature/project 细分且有 Usage API（可编程拉取明细）；Anthropic Console 同构（每模型 token 数与花费 + Usage Report 导出 API）。特点：**账单级精确（它就是计费本体）、零接入成本；但只有聚合曲线，无单会话/单请求 trace，粒度最粗，窗口约 30 天曲线 + 账单记录**。厂商面板覆盖不了自部署/本地模型，也不覆盖工具执行维度。

对天枢的启示：天枢对接的正是多家厂商的自配 AK——官方 dashboard 碎片化（要登 N 个控制台），这正是本地统一用量面的价值主张；但成本折算缺位（§6 改进 3）让「统一看花费」这一半价值未兑现。

### 5.5 自建方案常见形态（ClickHouse/Timescale 时序聚合）

规模自建的主流配方：append-only 事件宽表（含 trace_id/parent_id 列表达树）写入时序库；**物化视图按分钟/日 rollup** 聚合（sum tokens、count、p95 延迟），面板永远查 rollup 不扫明细；**TTL 分层保留**（热明细 7-30 天 + 冷归档/降采样永久）。ClickHouse 凭列存压缩与聚合速度是该场景默认选型，Timescale（PG 扩展）在已有 PG 栈时更顺。风险面：自建要自己解决单价表、版本升级、面板开发。

对天枢的启示：天枢 SQLite 单机形态在本地场景合理（千级行内存聚合实测够用）；但 server 长驻部署可以借鉴「rollup + TTL」思想的最小版本——日聚合表 + 周期裁剪（§6 改进 2/8），不必引入时序库。

### 5.6 对照结论

1. **trace 粒度**：业界已收敛到「会话/请求 → agent 步骤 → 模型调用」三级树（Langfuse trace/span、OTel span 父子、各 agent 框架 run tree）。天枢事件扁平，但**树源数据已齐**——chat 的 sessionId、graph 的 `automationRun.graphTrace`（节点树 + 每节点 toolCalls）都是现成结构，缺的是统一 trace 视图与前端下钻。
2. **成本核算**：Langfuse/Helicone 均以「内置单价表 + 自定义价格」折算；天枢零成本面。对多厂商自配 AK 的天枢用户，成本感知是真实刚需（用户心智即云厂商 AK 计费）。
3. **保留策略**：天枢桌面 90 天一次性裁剪在单机场景够用；无头端无界增长在长期部署下是实际风险；业界标准是 TTL 常态化 + rollup 分层。
4. **流式 token 统计**：天枢 accumulator（run_id 去重 + end 权威覆盖 + finish 兜底 + 错误路径补调）与 LangChain 官方累加语义对齐，属正确实现；缺口仅在 provider 完全不上报 usage_metadata 时无本地估算兜底（此时回合无 usage 块、事件缺失）。

## 6. 改进空间（按优先级，附落地点）

**P0（低成本、补现成缺口）**

1. **监控页主机路由化**：

   - 改造点：`src-react/domains/ai/monitor/api/monitor.api.ts` 按 `host-route.ts` 的 `routeInvoke` 模式——本地分支 `invoke("monitor:stats", scene)` 原样；远程分支走 `requestRemote(connId, "POST", ENDPOINTS.monitor.stats, { scene })` 适配器（`server.api.ts` 已有该原语与信封解包）；
   - 依赖项全部就绪：被控面端点（`server-face/routes.ts` 的 `POST monitor/stats`）、协议常量（`ENDPOINTS.monitor.stats`）、capability 位（`DESKTOP_CAPABILITIES`/`CAPABILITIES` 均含 monitor）；
   - 顺手在主机页（/module/ai/server）加用量摘要卡；「远程主机的用量桌面遥看」即补齐。

2. **server 端保留期裁剪**：无头端补齐 90 天裁剪（对齐桌面 `ensureEventStatMaintenance` 的 cutoff 语义）；server 是长驻进程，建议 `setInterval` 周期跑（如每日）而非仅启动跑；桌面也可同款改造为周期任务。

**P1（价值主体）**

3. **成本单价配置与折算**：

   - 配置面：model 表加输入/输出单价列，或 option 表键值配置（provider 级默认 + model 级覆盖两档）；
   - 折算面：`MonitorStats` 增 cost 口径字段，`computeMonitorStats` 单源折算——该函数桌面/server/移动端三端共用，一次改动三端生效；
   - 边界：graph 场景 modelId 恒 null，需按图内节点实际模型补查或标「未知价」；预留 cache token 单独计价位（anthropic `cache_read_input_tokens` 与普通输入价差大，先留字段不折价）。

4. **会话级 trace 下钻**：聚合页点击模型/工具行 → 按 sessionId 分组的事件明细（分页列表，事件表已有 sessionId 列无需改表）；graph 场景直接复用 `automationRun.graphTrace` 的既有节点树（运行历史已渲染该数据）；达成业界「聚合 → 下钻到会话/树」的标准动线。

5. **错误/中止轮补行**：现状错误轮有部分 usage 才写行、中止轮恒不写——「消失的调用」是统计盲区，回合错误率不可观测。建议 llmCallEvent 加 `outcome`（ok/error/aborted）列，无 usage 也写行（token 记 0），聚合面补「回合成功率」KPI；改动点在 `agent-chunk-emitter` 中止路径补报 + `runChatStream` 无 usage 也产块（或埋点处独立判定）。

**P2（长线演进）**

6. **导出与归档**：明细/聚合 CSV·JSON 导出；裁剪前归档到数据根 `app/` 分组（桌面 backup 基建可搭车，`packages/tianshu-core/src/backup-archive-crypto.ts` 已有归档加密件）。
7. **token 本地估算兜底**：provider 不上报 usage_metadata 时按字符近似或本地 tokenizer 估算，事件加 `estimated` 标记列（诚实口径优于缺失）；挂点可在 LangChain callback 层或 `usageFromBlocks` 缺席分支。
8. **聚合下推/预聚合表**：事件行数上万后 findMany 全量读回内存聚合会退化，届时改 SQL groupBy（索引 `userId+createdAt` 已覆盖）或日粒度 rollup 表（`automationStat` 先例形态）。
9. **OTel GenAI semconv 导出面**：埋点层加可选 OTel exporter（`gen_ai.usage.input_tokens` 等属性，见 §5.3），用户可自接 Langfuse/自建后端——与内置监控并行不悖，是接入标准生态的最低成本通道。

## 7. 与 operationlog（操作日志）的边界

三套记录各管一段，勿混：

- **llmCallEvent / toolCallEvent（本模块）**：机器遥测——模型与工具的**行为度量**（token/耗时/终态计数）。无操作者叙事、无安全判定细节、无入参出参（零载荷）。
- **securityAuditLog（桌面安全审计）**：`prisma/schema.prisma:396`，hash 链防篡改（`prevHash`/`hash`/`sequence`），category 为 command-safety/file-safety/network/data-safety/config 五类（`electron/domains/security/audit/audit-log.service.ts` `categoryOf` 前缀映射）。工具 denied 的**原因**（命令门拦截、文件门越界、审批拒绝）在此留痕，事件表只留终态计数——同一工具调用的一体两面。
- **operationlog（server 脚手架遗留）**：`apps/tianshu-server/src/modules/operationlog/` 的 `operation_log` 表 + `OperationLogInterceptor`，语义是「用户对系统的管理操作」（谁改了什么）——但 `DISABLE_LOG: boolean = true` 硬开关写死，**实质停用**。桌面端无对应物（管理操作审计归 securityAuditLog 的 config 类）。若未来启用，边界应为：operationlog 记人操作、监控事件记 AI 行为、securityAuditLog 记安全判定，互不重复。

一张速查表收尾：

| 问题 | 看哪张表 | 看哪个页面/端点 |
| --- | --- | --- |
| 今天花了多少 token？ | `llmCallEvent` | `/module/ai/monitor`（桌面本地）、`monitor/stats`（远端） |
| 某工具为什么被拒？ | `securityAuditLog` | 安全审计页（category 前缀过滤） |
| 某次图运行哪步失败、输出了什么？ | `automationRun.graphTrace` + `graphRunNode` | 图运行历史（节点树渲染） |
| 某轮对话原文与该轮 usage？ | `message.blocks`（含 usage 块） | 会话视图本身 |
| 谁改了系统配置？ | `securityAuditLog`（config 类） | 安全审计页 |

---

### 附：关键文件索引（均为实测存在路径）

- 协议与共享包：`packages/tianshu-protocol/src/monitor-contract.ts`、`packages/tianshu-core/src/monitor-events.ts`、`packages/tianshu-core/src/monitor-stats.ts`、`packages/tianshu-core/src/agent-chunk-emitter.ts`、`packages/tianshu-core/src/run-chat-stream.ts`
- 桌面后端：`electron/domains/ai/monitor/monitor.repo.ts`、`electron/domains/ai/chat/chat.service.ts`、`electron/domains/ai/automation/automation-runner.ts`、`electron/domains/ai/orchestration/graph-executor.ts`、`electron/domains/ai/agent/tool-gate.ts`、`electron/commons/prisma-client.ts`、`electron/Application.ts`
- 桌面前端：`src-react/domains/ai/monitor/`（api/store/views/components/lib 五件）、`src-react/domains/ai/data-source/host-route.ts`、`src-react/routes/index.tsx`
- server：`src/modules/monitor/monitor.{controller,service,module}.ts`、`src/core/chat-runner.service.ts`、`src/core/graph/executor-runtime.ts`、`src/modules/graph/graph.module.ts`、`src/modules/automation/automation-runner.ts`、`src/modules/operationlog/`
- 被控面与移动端：`electron/domains/server-face/routes.ts`、`electron/domains/server-face/ipc.ts`、`apps/tianshu-mobile/src/app/monitor.tsx`、`apps/tianshu-mobile/src/store/monitor.store.ts`、`apps/tianshu-mobile/src/logic/monitor-trend.ts`

（路径前缀：桌面端相对 `apps/tianshu-desktop/`，server 相对 `apps/tianshu-server/`，移动端相对 `apps/tianshu-mobile/`。）
