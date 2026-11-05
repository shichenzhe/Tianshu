# 工作流（流程编排）技术方案

> 调研基线：main 分支 995bf652（2026-11-05）。
> 桌面端路径基准 `apps/tianshu-desktop/`（`electron/` 主进程、`src-react/` 渲染进程），server 端基准 `apps/tianshu-server/`。
> 模块代码名 orchestration/graph，产品名「工作流」。DSL 校验与 LangGraph 编译器已物理收编 `packages/tianshu-core`（GA-T2 批），协议类型单源 `packages/tianshu-protocol`。

## 1. 模块定位与总览

工作流是天枢的**可视化节点编排引擎**：用户在画布上把 LLM 调用、HTTP 请求、代码脚本、检索、ETL、通知等 30 种节点连成有向图，可手动试运行、挂到自动化任务定时/事件触发、或经入站 webhook 被外部系统触发。产品形态明确对标 Coze 工作流——节点设计大量注释自述「参照 Coze HTTP 节点」（httpNodeSchema）、「Coze Choice 式」（condition）、「Coze Intent 式」（intent）、「Coze while 语义」（iterate）；运行记录体系对标 Coze 的节点级三层下钻（2026-10-28「图执行留痕去会话化」批，schema 注释原文「Coze 式运行记录体系」）。

核心链路一句话：

```
GraphJson（zod DSL，graphDefinition.graphJson 存库）
  → validateGraph 保存期校验（+normalizeGraph 自愈补 start/END）
  → compileStateGraph（@langchain/langgraph StateGraph + reducer state）
  → executeGraphRun：逐节点 handler（模板渲染→执行→graphRunNode 留痕→trace 追加）
  → finishRun：automationRun（run 级轨迹 graphTrace）+ graphRunNode（节点级完整输入/输出）
```

分层架构（单源与副本）：

- **共享单源**：`packages/tianshu-core/src/graph-schema.ts`（DSL 37 个 zod schema + validateGraph）、`graph-compiler.ts`（LangGraph 编译器）、`graph-http-guard.ts`（SSRF 守卫）、`graph-prompt.ts`（模板渲染）、`graph-inputs.ts`（typed 输入归一）；`packages/tianshu-protocol/src/graph-contract.ts`（HTTP 端点契约）+ `server-event.ts`（graph.run.updated 事件载荷）
- **桌面执行权威**：`electron/domains/ai/orchestration/`（17 文件），渲染层 `src-react/domains/ai/orchestration/`（22 文件）
- **server 执行副本**：`apps/tianshu-server/src/core/graph/graph-executor.ts`（自 mirror 摘取 + `executor-runtime.ts` 无头化装配）
- **移动端纯遥控**：`src/transport/graph-api.ts`，无编辑器（2026-10-27 裁定「不做编排页，编排通过对话完成」）

关键演进批次：GA 批（schema/compiler 收编 @tianshu/core + server 无头端 GA-T3/T4/T5/T6/T7/T8 摘取链）→ 2026-10-28 去会话化（graphRunNode 取代节点消息对）→ 2026-10-29 数据源引用/typed 输入/会话应用作用域切片 → 2026-11-02/04 图 HTTP 守卫与逃生口。

前端入口（`src-react/routes/index.tsx` 239/247 行注册，75 行懒加载）：

- `/module/ai/graphs` — 图列表 `views/GraphListView.tsx`（一级侧边栏入口；automation 页 graphs tab 复用同组件）
- `/module/ai/graphs/:id` — 编辑器 `views/GraphEditorView.tsx`（1663 行；`:id=new` 新建保存后 replace 到真实 id）
- 旧路径 `/module/ai/automation/graphs/:id` 兼容重定向（routes/index.tsx 287 行）

## 2. 数据模型

三张物理表 + 一组启动幂等建表函数构成持久层。图运行与自动化任务**共用 automationRun/automationStat**（姊妹文档 §2 详述字段语义），graphRunNode 为图专属。

schema 单源 `apps/tianshu-desktop/prisma/schema.prisma`；server 侧 `apps/tianshu-server/prisma/schema.prisma` 用 PascalCase 模型（`GraphDefinition`/`AutomationRun`/`GraphRunNode`）经 `@@map` 映射到**同名物理表**（本仓建表走 db push，GA-T3 摘表先例），两端口径逐字段一致。

### 2.1 graphDefinition（图定义）

| 字段 | 类型/缺省 | 语义 |
|---|---|---|
| `name` / `description` | String / String? | 列表卡片直显；删除被任务引用时错误信息拼任务名 |
| `graphJson` | String | GraphJson DSL 序列（见 §3.1） |
| `version` | Int @default(1) | **乐观锁而非语义版本**：update 必须携带库内值，不符抛 `VERSION_CONFLICT`；无发布/回滚/灰度语义 |
| `enabled` | Boolean @default(true) | 停用后：挂载任务 run failed(`graph_disabled`) 但不置任务 error（重新启用图调度自然恢复）；webhook 返回 `graph_not_available` |
| `userId` | Int? | 多用户隔离（IPC 经 `handleUser` 解 token）；历史行可空——列表/runPage/节点详情对 null-userId 图均不可见（终审收紧） |
| `nodeCount` | — | 前端派生字段：`toGraphRecord()` 从 graphJson JSON.parse 数 nodes（坏 JSON 容错 0，不炸列表） |

### 2.2 automationRun（run 级，与自动化任务共用表，见姊妹文档 §2.2）

图相关字段：`taskId Int?`（**null = 图试运行**，taskName 取图名）、`graphId Int?`、`graphTrace String?`（TraceEntry 数组 JSON）、`graphJsonSnapshot String?`（**执行时 graphJson 快照**，批1C 改进项 3：createRunRow 随 run 行写入、截 64KB——图改后历史轨迹/graphRunNode 节点行可对照当时结构；非图任务运行恒 null；免索引，按 run 行读取。桌面 v1 快照直改列（指纹重放自动重建旧开发库），server 侧 `1_automation_run_graph_snapshot` 双端成对迁移 + SQLite 存量库启动幂等补列）、`triggerType` 图侧值域 `manual`/`schedule`/`catchUp`/`retry`/`event`/`subflow`/`webhook`。run 状态机单一状态源只有 success|failed 两个终态——「aborted」是 failed+`user_aborted` 错误码的展示投影（server `GraphRunProjectionState`，executor-runtime.ts 28-31 行注释：queued 仅保留给控制层队列语义，server run 生命周期从 running 起）。

### 2.3 graphRunNode（节点级执行详情）

2026-10-28 去会话化：节点完整输入/输出落表，**取代**原「节点消息对落聊天会话」（一次性迁移 `cleanupGraphRunSessions()` 在 electron/commons/prisma-client.ts 159 行：删历史图运行会话、run.sessionId 置 null）。

| 字段 | 语义 |
|---|---|
| `runId` / `nodeId` / `nodeName` | `@@unique([runId, nodeId])`；环图重入 **upsert 覆盖（最后一轮为准）**——validateGraph 不查回边，条件回边下同节点多轮执行 create 会撞唯一约束（writeNodeRecord 注释） |
| `status` | `success \| failed` |
| `input` / `output` | 渲染后完整输入 / 完整输出，均截 64KB；failed 行 output 为失败全貌（`code: message + 【详情】detail`） |
| `errorJson` | `{ code, message, detail }`，与 trace error 同形（GraphNodeFailure 无 toolName 归属，该键缺省） |
| `toolCallsJson` | 工具调用摘要数组 `[{name, ok, durationMs}]`，同 trace |
| `promptTokens` / `completionTokens` / `durationMs` | 节点级用量 |
| `startedAt` | ISO 字符串，与 trace 条目同构（区别于 run 行的 DateTime） |
| `outputImage` | imageGen 产物**相对数据根路径**（轨迹内缩略图展示） |
| `errorOutput` | 循环节点死信：`onItemError=continue` 的失败项清单，下游经 `{{nodes.<id>.errorOutput}}` 引用落侧文件 |
| `fallbackJson` | llm 节点 `onError=defaultValue` 降级继续标记 `{code, message}`——实际执行失败但以默认输出继续，保留失败原因 |

建表不走 v1 快照（快照 sha256 指纹变化会触发旧库 drop 重建），由 `ensureGraphRunNodeTable()` 启动幂等补建（`CREATE TABLE IF NOT EXISTS` 原生 SQL + runId 索引）：桌面在 `electron/commons/prisma-client.ts` 127 行，server 在 `src/commons/database/ensure-graph-run-node-table.ts`。老 run 无节点行——`orchestration:runNodes` 返回空集，前端回落 trace 预览。

## 3. 核心技术方案

### 3.1 图 DSL（GraphJson）

单源 `packages/tianshu-core/src/graph-schema.ts`（1208 行、37 个 zod schema）；桌面 `src-react/domains/ai/orchestration/api/graph.schema.ts` 是 re-export 兼容层（渲染层既有 import 链零变化；子路径直指源文件不走包 barrel——barrel 含 e2e-crypto 会炸 sandbox 渲染层）。顶层结构：

```ts
{
  version: 1,
  inputSchema: Record<string, "string" | { type, required?, default?, enumValues?, description? }>,
  nodes: GraphNode[],           // min(1)
  edges: GraphEdge[],           // 「多节点零边」留给 validateGraph 给可读错误
  endPosition?: { x, y }        // END 虚拟节点画布坐标（仅布局元数据，执行器忽略）
}
```

**30 种节点 kind**（`graphNodeSchema` union；`NodeKind` 类型见 `src-react/domains/ai/orchestration/lib/graph-editor-model.ts`）。按族归类（字段细节以 schema 为准）：

- 控制流 7 种：
  - `start`——图输入变量声明载体（variables 数组回写 graph.inputSchema，单一事实源）；执行直通不写 state.nodes
  - `condition`——多分支按序评估（分支内条件 AND），命中路由到同名条件边；`fallback` 兜底分支名，无兜底回落 END
  - `intent`——querySource 交模型分类到 intents 清单（name=分支通道+description 辅助），零 prompt 门槛；未命中走 fallback（无则 `intent_no_match` 失败）
  - `delay`——等待 1-600s（轮询间隔/节流，随图中止）；**schema 注释明言「人在环审批需待审中心+持久化支撑，后续单独立项」**——HITL 缺位的官方表态
  - `subflow`——graphId 引用已保存图，inputs 为 HttpKV 映射（value 支持 `{{}}` 占位）；`async:true` fire-and-forget（主流程立即继续，运行记录落子图自身）；`subflowStack` 调用链防循环引用
  - `iterate`——loopMode 三态 `array`（itemsSource 表达式，JSON 数组优先解析失败按行拆分）/`count`（1..N 序数）/`while`（每轮求值 breakCondition）；`carryVariable` 承接变量（值=上一轮子图输出，首轮 carryInitial）；item 注入 itemVariable、索引入 `<itemVariable>Index`；`maxItems` 保险丝默认 100、`concurrency` 1-5 分批并发（while 不适用）、`onItemError: abort|continue`（continue 时失败项进 errorOutput 死信，全败才失败）
  - `merge`——多上游输出按 template 聚合为单 output（依赖 LangGraph 多入边天然同步等待：state.nodes 已含各上游结果）
- LLM/生成 2 种：
  - `llm`——modelId/systemPrompt/prompt/temperature；`tools: boolean | string[]`（agent 白名单）；`maxSteps` 1-50；`outputMode: text|branch`（branch 必带非空 branchOptions，JSON 提示词约束输出 `{"branch":"..."}`）；`timeoutMs` 默认 180s 上限 1h（含重试全程）、`retries` 0-5、`onError: abort|defaultValue` + `errorOutput` 降级
  - `imageGen`——双协议 `protocol: openai | comfyui`：openai 走 images/generations（b64_json/url 双兼容）；comfyui 走 workflow API（POST /prompt 提交 + /history 轮询 + /view 取图，workflowJson 占位符注入）
- 数据/IO 9 种：`http`（GET/POST/PUT/PATCH/DELETE；`auth` 五型 none/basic/bearer/header/acs3——阿里云 ACS3-HMAC-SHA256 签名，headerPrefix/algorithm 可改写；bodyType none/json/text/form/binary（文件 ≤10MB Buffer 上传）；retries 0-5、timeoutMs 默认 120s 上限 600s；bodyType 缺省带 body 时 preprocess 推断 json）、`code`（nodejs/python/bash spawn 临时脚本，stdout 即 output；pythonCommand 缺省 python（Windows 发行版适配）；timeoutMs 默认 30s **上限 24h**（用户裁定可调）；outputMode=branch 时 stdout 最后一个非空行作分支标签）、`fileRead`/`fileWrite`（限工作空间内；fileWrite 走 codeAuthorized 门禁）、`docExtract`（PDF/Word pdf-parse/mammoth 懒加载，txt/md 直读，maxChars 截断默认 64K）、`notify`（系统桌面通知 + 可选 IM webhook：feishu/dingtalk/wecom/custom）、`email`（nodemailer SMTP 直连）、`database`（五引擎 sqlite/postgres/mysql/oracle(thin)/sqlserver；`dataSourceId` 引用元库 dataSourceConfig 行（凭据不进图定义，切片 B）；params 参数化按各家驱动原样透传；`maxRows` 默认 1000 上限 10 万（输出字节联动预算）；`batchSource` JSON 二维参数数组批量模式——事务包裹逐行绑定失败整体回滚；retries 0-5 连接闪断重试）、`excelRead`/`excelWrite`/`csvRead`/`csvWrite`（xlsx 指定 sheet → JSON 行数组；CSV RFC4180 状态机流式解析——引号包裹/内嵌分隔符与换行/双引号转义，分块读不全量驻留；maxRows 熔断超限失败不静默截断）
- 检索 5 种：`librarySearch`（关键词空格分词 AND 内容匹配，输出命中文件名+片段 ≤maxResults；v1 关键词非向量，schema 注释「向量语义检索为后续演进」）、`vectorize`（text 分块 chunkSize/Overlap → embedding → vectorChunk 表条目级 upsert 重跑幂等）、`vectorSearch`（searchQuery → embedding → 同模型余弦 topK →「【条目名】片段」多段）、`hybridSearch`（BM25 全文 + 向量语义 + **RRF 融合**，单节点三模式 semantic/keyword/hybrid 对齐 Dify 知识检索心智；state 另挂 `hits` 旁路 FusedHit 数组供 rerank 消费）、`rerank`（消费上游 hits 做 cross-encoder 重排，业界事实标准 POST /rerank 同形；模型须 `model.type=reranker`；sourceNodeId 未连线时 hits 缺失报 `rerank_source_invalid` 系预期行为）
- 纯函数 5 种：`jsonParse`（source + path 点路径 a.b/a[0].b；arrayLines 数组逐行展开直连循环节点）、`jsonStringify`（解决 `{{nodes.x.output}}` 直接嵌 JSON body 破格式）、`variable`（多变量赋值 + 11 种操作链：trim/upper/lower/replace/slice/default/append/toNumber/now/dateAdd/dateFormat）、`aggregate`（count/sum/avg/min/max/distinctCount/groupByCount → 按键 JSON 对象，iterate 收尾统计）

**边与条件路由**：`graphEdgeSchema { from, to, condition?: {type:"branch", value} }`；`to:"END"` 哨兵。条件边 label 必须落在源节点的 `branchOptionsOf(node)`：condition=分支名+兜底名、intent=意图名+兜底、llm/code 仅 outputMode=branch 时的 branchOptions；编辑器边条件编辑与画布校验共用此函数（与 validateGraph 同规）。

**typed 输入**（切片 D 2026-10-29）：`inputFieldSchema` strict 对象——type ∈ string/number/boolean/enum/date（date 归一 yyyy-MM-dd），required/default/enumValues（仅 enum 可带且必非空不重复）/description ≤200；default 与类型自洽 superRefine 校验；旧字符串简写 `"string"` 双形态并存由 `parseInputSchema` 归一。runTest 期 `normalizeGraphInputs` 做 required 校验+default 填充+类型归一，缺参结构化报错（不再等模板渲染期才炸）。

**校验与自愈**：`validateGraph(json)` 跨节点检查产出结构化 GraphIssue：`duplicateNodeId`、`reservedNodeId`（id 撞 LangGraph 通道名 `inputs/nodes/route`——撞名编译期报晦涩 "already being used"，保存期前置拦截）、iterate 三模式必填（iterateCountRequired/iterateBreakRequired/iterateItemsRequired）、`uniqueEntry`（无入边节点恰 1 个）、`duplicateStartNode`/`startIncomingEdge`、`danglingEdge`（from/to 不存在；to=END 豁免）、`conditionNotBranchable`/`conditionValueOutOfRange`。zod union 失败经 `expandNodeUnionIssues` 按「最少错误的分支」展开为字段级 issue（每节点至多 4 条；kind 探针直选唯一分支防最少错误启发式误选宽容分支）。`normalizeGraph()` = `ensureStartNode()`（AI 生成图常省略无执行语义的 start——注入 `{id:"start",kind:"start"}` + start→唯一入口无条件边）+ `ensureEndEdges()`（无出边叶子补 to:END；**branch 节点不补**——无条件 END 边会与路由条件边双触发破坏分支语义，未命中分支由编译层 __fallback__→END 兜底）——保存统一自愈口（graph.repo parseGraphJson 内调用）。

### 3.2 执行引擎：LangGraph StateGraph（确认使用 LangGraph，非自研）

**编译器单源 `packages/tianshu-core/src/graph-compiler.ts`**（152 行；桌面 `electron/domains/ai/orchestration/graph-compiler.ts` 为 re-export）：

- `GraphState = Annotation.Root({ inputs, nodes: Annotation<Record<string,NodeResult>>({reducer:(prev,next)=>({...prev,...next}), default:()=>({})}), route })`——节点输出经 reducer merge 进共享 state；merge 节点多上游聚合、iterate carryVariable、`{{nodes.<id>.output}}` 模板引用都靠这个语义
- `buildEdgePlan(json)` 纯函数：edges 拆 `direct`（无条件）与 `conditional`（按 from 聚合 route 值→目标映射）
- `toDestination()` 把 `"END"` 哨兵翻译为 LangGraph END（"__end__"）；`addEdge(START, entry.id)` 直连（API 以 @langchain/langgraph@1.4.18 d.ts 为准，setEntryPoint 已废弃）
- `addConditionalEdges(from, state=>state.route ?? "__fallback__", pathMap)`：route 未映射（含运行期脏值）回落 `__fallback__→END`——LangGraph 对 pathMap 查不到的返回值按「不存在节点名」报错会炸整图，兜底走 END
- `GRAPH_RECURSION_LIMIT = 25`；recursionLimit 属 invoke 的 RunnableConfig 而非 compile 选项，故 `compileStateGraph()` 返回 `{ graph, config }`
- **checkpointer 未接**（executor 头注释原文：JS MemorySaver 只能挂 compile() 期，compileStateGraph（T7 冻结）不透出该口；v1 无 resume/interrupt 消费方，invoke 仍带 thread_id 供未来接入即换）

**执行器 `electron/domains/ai/orchestration/graph-executor.ts`**（4843 行）主链（函数名+行号）：

1. `executeGraphRun(params)`（300 行）→ `runGraphToResult(params)`（308 行，子工作流/循环节点复用的执行内核）：`createRunRow()`（336 行）先落 automationRun(status=running, triggerType, attempt, graphId, taskId?)；`onRunId` 回调让 webhook 异步模式在图完成前拿到 runId 即回 202
2. `parseGraphJson()`（474 行）：JSON.parse + validateGraph 二道校验，失败抛 `GraphRunFailure("graph_invalid", issues 码列表)`
3. `runGraph()`（364 行）：`buildNodeContext()`（494 行，装配 workspacePath/userId/codeAuthorized/subflowStack/skills/agent 上下文/modelCache）→ `makeNodeHandler(node, ctx)`（567 行）按 kind 大 if 链分流产出 handlers → 外层包装 `notifyNodeStatus(graphId, nodeId, "running"|"success"|"failed")`（3464 行，全窗 `win.webContents.send("orchestration:node-status")`——试运行画布实时高亮）→ `compiled.graph.invoke({inputs, nodes:{}}, {recursionLimit, configurable:{thread_id: "graph-<graphId>-run-<runId>"}})`
4. 成功路径：`appendSkippedEntries()`（1831 行，未执行节点显式落 skipped trace；start 不补防噪音）→ `finishRun({status:"success"})`；返回 `{status, output: finalOutputOf(), nodeOutputs: nodeOutputsOf(), runId}`——trace 只存 200 字 outputPreview，完整终点 output 从 invoke 返回的终态 state.nodes 取（`finalOutputOf` 464 行：trace 最后一个 success 节点的完整值；nodeOutputsOf 448 行：全节点 output 映射，webhook 响应模板消费）
5. 失败路径：`isUserCancelled()`（353 行，abort.reason.message==="USER_CANCELLED"）→ 归一 `user_aborted`（「已被用户中断」）；否则 `toRunError()`（1810 行，GraphRecursionError→`graph_recursion_limit`；isNodeError 解包还原 GraphNodeFailure）
6. **llm 节点失败重试** `runNodeWithRetry()`（727 行）：`AbortSignal.any([ctx.abort, AbortSignal.timeout(timeoutMs ?? 180_000)])` 整体超时含重试全程（对照 Coze「整体执行超时」）；signal 触发且非图中止归一 `llm_timeout`；retries 0-5 固定间隔（LLM_RETRY_INTERVAL_MS=0.5s）；GraphRunFailure 配置类错误不重试直接上抛。`onError:"defaultValue"` 分支（657-687 行）：重试耗尽仍失败 → 以 errorOutput 作输出继续下游（trace 带 fallback 标记、graphRunNode 落 fallbackJson）；**图中止（用户中断/退出）不降级**——中断意图优先于容错继续；branch 节点降级不写 route，条件边回落 __fallback__→END
7. 留痕：每节点成功 `writeNodeRecord()`（1702 行）/失败 `writeNodeFailureRecord()`（1721 行，output=失败全貌文本）upsert graphRunNode；trace `TraceEntry`（107 行：id/name/status/startedAt/durationMs/tokens/error{code,message,toolName?,detail?}/toolCalls/outputPreview 200 字/outputImage/hitsPreview/hitsTruncated/errorOutput/fallback）
8. `finishRun()`（1855 行）：graphTrace 序列化落 run、tokens 按 trace 聚合（sumTokens）、error 聚合 `node:<id> <code>: <msg>` 截 500；run 行可能已被删（在途删图先删 run）时仅 Log.warn 不抛；`advanceTaskAfterRun()`（1913 行）推进挂载任务——model_missing 置任务 error 停调度，其余复用 automation-runner 的 advanceTask
9. 错误分类：节点内异常经 `toNodeFailure()`（1787 行）映射——GraphTemplateError→`template_ref_missing`、GraphRunFailure 原样、兜底 `classifyError()`（@tianshu/core LLM 网络分类码）；detail 收集上限 64KB、透出取前 4KB（ERROR_DETAIL_LIMIT）
10. 监控：`recordGraphMonitorEvents(prisma, {graphId, userId, sessionId:null, trace})` 一次性写 llmCallEvent/toolCallEvent（fire-and-forget 吞错）

**agent 工具节点**：llm `tools:true` 走 `runToolNode()`（854 行）→ `createReactAgent`（@langchain/langgraph/prebuilt）+ `toLangChainTools` 适配（langchain-tool-adapter.ts）；`DEFAULT_AGENT_STEPS=10` 作 recursionLimit 形态的步数保险丝；`filterNodeTools()`（892 行）按 tools 白名单过滤。

### 3.3 SSRF 守卫与授权边界

- **HTTP 节点 URL 守卫** `packages/tianshu-core/src/graph-http-guard.ts`（安全审查 2026-11-02 S5+F1 批 + 2026-11-04 逃生口）：
  - 背景（头注释）：HTTP 节点 URL 可被 webhook 输入与 LLM 输出模板化（`{{input.x}}`）且响应体可经 responseTemplate 回显——不设守卫即完整 SSRF read-back，agent fetch 工具的 SSRF 清单曾被图节点整面旁路
  - 面上拦截：协议白名单（仅 http/https）+ 云 metadata 三元组（169.254.169.254 / metadata.google.internal / metadata.azure.com）+ 字面 IP 分类（环回 127/8、私网 A/B/C、CGNAT 100.64/10、192.0.x、保留段）+ **编码 IP 形态**（十进制 http://2130706433 与 0x 十六进制）+ IPv6（ULA fc/fd、v4 映射 ::ffff:）+ **DNS 解析级** `graphHttpUrlErrorDns()`（域名解析到内网即拒，多记录任一命中即拒，防 internal.corp→10.0.0.5 与 rebinding 基础面；解析失败放行，功能可用优先）
  - **逃生口两通道**：`allowPrivateNetwork`（内网面整体放开）或 `allowlist`（精确 IP/精确域名/IPv4 CIDR 如 192.168.1.0/24）；任一放行即放行；**硬边界白名单也不豁免**——协议白名单、metadata 三元组、链路本地段（IPv4 169.254/16 与 IPv6 fe8-eb，metadata 所在段，防云桌面场景偷凭证）
  - **两端差异化接线**：桌面执行器恒传 `allowPrivateNetwork: true`（graph-executor.ts 1163-1166 行注释「桌面端=用户本人机器，内网全权」）；server 部署态缺省严拦，经 `config.yml` **`tianshu.graph` 段**显式配 `allowPrivateNetwork: false`（缺省）/`allowlist` 列表——由 `src/core/chat-core.module.ts` 76 行 `installGraphHttpUrlPolicy()` 装配进 server 副本 executor 的 seam（`httpUrlPolicy` 闭包 228 行定义、`installGraphHttpUrlPolicy` 231 行装配、HTTP handler 1288 行 `graphHttpUrlErrorDns(url, httpUrlPolicy())` 消费）
- **code/fileWrite 授权**：`GraphRunParams.codeAuthorized`——试运行（用户显式触发，task=null）或任务 `accessMode=full` 才放行；default 任务的代码节点拒执行（对齐 bash write 审批语义）；webhook 等外部触发显式传 false 对齐 default 无人值守，图级 `fullAccess`（webhook 注册时用户显式授权）放行
- **workspace 沙箱**：fileRead/fileWrite/docExtract/excel*/csv*/sqlite database 均相对 workspacePath resolve 后校验前缀（`file_outside_workspace` / sqlite 限工作空间内文件），防 `../` 越界；未绑定目录的工作空间执行文件类节点报 `file_workspace_missing`
- **工具禁用统一口径**：`disabledTools` 闭包（Application 注入实时读安全配置，SP6 裁定 2）——调度/手动/事件/webhook 四触发路径同一注入层过滤（禁用=对模型不存在）
- **凭据安全**：webhook 注册配置经 `sealNamedSecret` 密封落 option 表（D1 批：读取路径 openNamedSecret 透明解封）；http auth 凭据存图 JSON（http 鉴权先例）；database 节点 dataSourceId 引用元库（凭据不进图定义/画布/聊天上下文，切片 B 2026-10-29）

### 3.4 编辑器前端：React Flow（确认用 @xyflow/react，非自研画布）

- **画布库 `@xyflow/react`（React Flow）**——`components/GraphCanvas.tsx`（333 行）：
  - 受控渲染：`toCanvas(graph, layouts)`（`lib/graph-canvas-model.ts`）产 nodes/edges；nodeTypes 模块级常量 `{card: NodeCard, end: EndMarker}`（RF 要求引用稳定）
  - END 虚拟节点 `END_NODE_ID`：不可删（终点语义由边声明）、可拖（落点持久化 graphJson.endPosition）
  - 拖拽落点：300ms 防抖批量 onMove + **本地镜像 liveNodes 实时 applyNodeChanges**（纯受控拖拽期间 props 不更新会不跟手，props 变化即弃镜像）；onNodeDragStop 松手立即落库不等防抖；卸载兜底 flush
  - 拖入建节点：AddNodeMenu 卡片 dataTransfer（`application/tianshu-node-kind`）+ drop 后 `screenToFlowPosition` 转流坐标；connectionRadius 30 放宽连线吸附
  - `focusNodeId` 变化 setCenter 定位+选中（校验错误条目点击定位节点）；试运行中节点挂 `node-running` class（globals.css 描边脉冲）
- **双模式**：canvas（默认主模式）⇄ JSON 源码（GraphJsonEditor/LargeEditorDialog），两模式共用 validateGraph 出口；结构化编辑纯函数收口 `lib/graph-editor-model.ts`（改节点 id 同步边引用、删节点级联删边、模板预填、保存可用性判定 DraftSnapshot）；右侧选中驱动 `NodePropertiesPanel`（节点属性面板）+ `HighlightTextarea`（prompt-highlight.ts 模板占位符高亮）
- **保存**：校验通过 + 相对基线有变更；update 携 version 乐观锁，`VERSION_CONFLICT` toast + 失效重拉；保存过的节点 id 锁定（重命名牵连边引用）；校验摘要行默认收起，保存被拦自动展开
- **试运行**：`GraphTestRunDialog`（inputSchema 变量表单 + workspace 下拉 + **可携 draftJson 试改后草稿**——runTest 覆盖库内版本执行，运行记录仍归属原图，合法性由 executor parseGraphJson 兜底）；`GraphRunHistoryDialog`（分页 RUN_PAGE_SIZE=20 + 行展开节点轨迹 GraphRunTraceView + runNodes 三层下钻）；cancelTestRun 手工中断在途试运行
- **单节点测试**：`orchestration:testNode`——轻量构造 ctx 单跑该节点 handler，返回输出或错误，**不落 run**（Coze 式节点调试；executor 3482 行附近）
- **导入导出**：`workflow-bundle.ts`——单图包裹格式 `{kind:"tianshu-workflow", version:1, name, description, graphJson}`，兼容裸 graphJson、文件名兜底名称；多图 bundle 批量建库（dedupeName 名称冲突加后缀、10MB 上限、逐项 validateGraph 前置校验失败列入 failed）；批量导出选中图聚合落盘
- **提示词 AI 润色**：`orchestration:polishPrompt(modelId, prompt)`（用当前节点所选模型改写，`{{}}` 占位符保留）；**HTTP binary 请求体文件选择** `orchestration:pickBinaryFile`（选择即固化——拷贝到 userData/workflow-assets/，源文件后续移动不影响执行，Coze 云上传同款语义）
- **内置模板** `graph-templates.ts` 7 个：`daily-brief-branch`（条件分支日报）、`research-report`（串行调研成文）、`intent-router`、`db-page-child`、`db-page-extract`、`csv-report`、`code-pipeline`；graphJson 的 modelId 为 0 占位（用户换模型后保存），每模板首节点为 start
- **聊天建图**（`create-workflow.ts`，901 行）：GraphRepository 构造时注册 4 个 agent 内置工具 `registerTools([...])`：
  - `makeWorkflowWriteTool`（create+update 二模式合一，走统一审批 kind=write；校验问题结构化回喂模型自纠重试 + 字段级 issue 展开 E1 + description 软检查）
  - `makeWorkflowReadTool`（清单态供 iterate/subflow 引用已有图查真实 graphId + typed 输入类型摘要）
  - `makeRunWorkflowTool`（fire-and-forget 经 `launchTestRun` 发射，输入按 inputSchema 归一校验）
  - `makeGetWorkflowRunTool`（graphRunNode 反查终点完整输出——trace 预览 200 字不够）
  - 模型按 workflow-creator 技能规范生成 graphJson（`graph-cookbook.ts` WORKFLOW_NODE_COOKBOOK）；会话应用作用域按 appId 收窄（切片 C）；写库经注入 notify 广播 graphs-changed（绕过 IPC CRUD 的 invalidate 链路）

### 3.5 仓储与 IPC（graph.repo.ts，966 行）

`GraphRepository`（构造器注入 disabledTools 闭包）注册 IPC 通道（鉴权 `handleUser` 解 token 得 userId；匿名通道仅 templates）：

| 通道 | 行号 | 语义 |
|---|---|---|
| `orchestration:list/create/update/delete/toggle` | 216-232 | CRUD；update 乐观锁；delete 先查任务引用拒悬空（`GRAPH_IN_USE:<任务名>` 前缀，前端解析清单提示先解除引用） |
| `orchestration:templates` | 235 | 静态模板，匿名（渲染端 token 被忽略） |
| `orchestration:runTest` | 238 | 试运行（互斥 GRAPH_ALREADY_RUNNING；draftJson 草稿覆盖；normalizeInputsFor 归一） |
| `orchestration:cancelTestRun` | 251 | 手工中断（GRAPH_NOT_RUNNING/GRAPH_NOT_FOUND 渲染端映射文案） |
| `orchestration:runs` / `orchestration:runNodes` | 254/262 | 运行历史分页 / 节点详情行（三层下钻第三层） |
| `orchestration:polishPrompt` / `pickBinaryFile` | 266/274 | 润色 / binary 固化 |
| `orchestration:exportWorkflow/importWorkflow/exportWorkflows` | 279-293 | 导入导出（对话框与文件 IO 在主进程） |
| `orchestration:webhookEnable/webhookDisable/webhookStatus` | 296-327 | 入站 webhook 三件（动态 import webhook-server） |

`launchTestRun()`（915 行）：**check→set 间无 await 防并发双跑**（graph-inflight 单图互斥 Map）；fire-and-forget；收尾清 inflight + `notifyGraphsChanged()`（全窗 GRAPH_CHANGED_EVENT 广播）+ 发布 `taskFinished(targetType=graph)` 事件（T10 留的图试运行发布点，链式任务由此续上）；run_workflow 工具异步触发共用此发射口。`listRunNodes()`（824 行）归属两段校验：run.graphId → graph.userId 精确匹配；prompt run/老 run/不属于本人一律空集（**不暴露存在性**）。`toGraphRunRecord()` 图侧轻量版（taskName 沿用图名）。

### 3.6 模板渲染与节点上下文

- **模板引擎** `graph-prompt.ts`（`@tianshu/core` 同源 re-export）：`renderNodePrompt(template, ctx: PromptRenderContext)` ——ctx 即 `{inputs, nodes, now}`：
  - `{{input.x}}` 取图输入变量（typed 输入 number/boolean 原生传递，database 参数直通驱动）
  - `{{nodes.<id>.output}}` 取上游节点输出（state.nodes 经 reducer merge 的终值）；`{{nodes.<id>.errorOutput}}` 取循环节点死信；`{{nodes.<id>.hits}}` 检索类结构化候选（模板取值不受影响）
  - `now` 执行时刻（variable 节点日期算子消费）
  - 未定义引用抛 `GraphTemplateError`（varName）→ `toNodeFailure` 映射 `template_ref_missing`——**编辑期不校验引用存在性**（引用的是运行态值），失败发生在执行期并落在该节点的 graphRunNode 行
- **节点上下文 NodeContext**（executor 241-261 行）：runId（null=单节点测试即席不落库）/abort/workspacePath/workspace/userId/codeAuthorized/disabledTools/subflowStack（顶层执行以自身 id 起栈，直接自引用第一层即拦）/skills（loadRunSkills：工作空间 skills 目录 + 数据根技能目录合并）/agent（AgentStreamOptions 权限四件+数据安全+unattended）/now/trace/modelCache（Map<number, Promise<ModelRuntime>> 模型行缓存，多节点同模型不重复查库）/deps（GraphExecutorDeps 注入 seam：createChatModel/toLangChainTools/compileStateGraph 三件，测试经模块 mock 替换）
- **imageGen 产物**：落 workflowAssetsDir（数据根 workflow-assets/），graphRunNode 存相对数据根路径（outputImage），trace 内缩略图展示——与聊天多模态 ImageBlock 的相对路径约定同源
- **monitor 埋点** `recordGraphMonitorEvents`：trace 一次性转 llmCallEvent（tokens/duration）+ toolCallEvent（toolCalls 摘要），fire-and-forget 吞错；用量监控页（/module/ai/monitor）聚合消费

### 3.7 server 副本摘取边界（graph.repository.ts 头注释登记）

server 摘取了 graph CRUD + run 行写入原语（createRun/finishRun 自 mirror executor 落库段），**未摘**（明确排除）：试运行触发链的 repo 层（runTest/launchTestRun/cancelTestRun——由 graph.service 重新实现）、导入导出与 binary 固化（dialog 文件 IO 属桌面）、testNode/polishPrompt、模板列表、webhook 端点（T7 另实现）、create-workflow 工具注册（spec §3.4 明确排除——聊天建图属桌面会话域能力）。deleteGraph 的 webhook 注册清理注入化：unregisterWebhook 闭包参数缺省 no-op。



### 3.8 运行记录三层下钻与前端视图

图运行留痕的三层消费链（2026-10-28 spec §4 设计）：

1. **第一层 run 列表**：`GraphRunHistoryDialog` / 移动端运行历史——run 行级状态/时长/tokens/triggerType/attempt，分页 20 条；错误列直显聚合 `node:<id> <code>: <msg>`
2. **第二层节点轨迹**：`GraphRunTraceView` 解析 run.graphTrace（TraceEntry 数组）——逐节点 status 三态（含 skipped）、耗时条、tokens、工具调用摘要、错误结构（code/message/detail）、outputImage 缩略图、hitsPreview 检索候选、errorOutput 死信、fallback 降级标记；trace 里 outputPreview 仅 200 字
3. **第三层节点详情**：`orchestration:runNodes` / server `automation/runNodes`——graphRunNode 行的 input/output 全文（64KB 截断）；归属两段校验不符返回空集（不暴露存在性）；老 run 无行时前端回落 trace 预览

老 run 兼容：graphRunNode 建表前（2026-10-28 之前）的 run 无节点行、保留策略置空 graphTrace 的 run 降级为元数据行——GraphRunTraceView 注释「老 run 无 trace」已容错。

### 3.9 图变量与「开始/结束」语义约定

- start 节点是**参数载体非执行节点**：`variables` 数组与 graph.inputSchema 同步（编辑回写单一事实源）；执行直通不写 state.nodes——引用其 output 的模板会抛未定义，正确引导从 `{{input.*}}` 取值（makeNodeHandler 首分支注释）
- END 是虚拟节点不是节点行：edges 的 `to:"END"` 哨兵在编译期翻译为 LangGraph END；画布上 END_NODE_ID 可拖（endPosition 落库）不可删（终点语义由边声明，删标记无意义）
- 节点 id 命名约束：`/^[a-z][a-z0-9-]*$/` kebab-case；保存后 id 锁定（重命名牵连边引用与模板 `{{nodes.<id>.*}}`——后者无静态检查，改 id 是用户自担风险项）

## 4. 三端布局

| 端 | 角色 | 关键路径 |
|---|---|---|
| 桌面 | **编辑 + 执行权威**（IPC 通道） | `electron/domains/ai/orchestration/` + `src-react/domains/ai/orchestration/` |
| 无头 server | 执行 + HTTP 遥控（**远程编排专属**） | `src/modules/graph/` + 执行副本 `src/core/graph/` |
| 移动端 | 纯遥控（无编辑器） | `src/transport/graph-api.ts` |

### 4.1 无头 server 端（apps/tianshu-server）

- **五端点** `src/modules/graph/graph.controller.ts`（全 POST + `@Public()` 豁免 JWT 守卫，静态 token 守卫 TIANSHU_TOKEN 仍生效）：
  - `graph/query`（分页 + keyword，keyword contains 下推 repo pageGraphs）
  - `graph/save`（全量 upsert：带 id 更新须携 version（缺席显式拦 VERSION_REQUIRED），否则创建）
  - `graph/delete`（GRAPH_IN_USE 引用拦 + run 级联）
  - `graph/run`（**202 受理即返回 {runId}**：graphTestInflight 互斥 GRAPH_ALREADY_RUNNING；executor createRun 后即回调 onRunId；执行流经 **graph.run.updated 事件**回传）
  - `graph/runAbort`（runId 反查 graphId 归属后经 inflight abort，reason=USER_CANCELLED 归一 user_aborted/aborted 投影）
- **userId 伴生写死 `COMPANION_USER_ID`**（tianshu-config.entity，单伴生用户面）；workspace 解析：缺省取用户最近空间（id desc），显式传入校验归属
- **executor 副本装配** `src/core/graph/executor-runtime.ts`：`installGraphExecutorRuntime(rt)` 进程级注入 PrismaService、run 落库原语 GraphRunStore（createRun/finishRun）、`publishRunUpdated` 事件出口（未注入不发——纯落库模式）、notify 桌面通知替代（无头端缺省无通道）、monitor 埋点（可选）、数据目录三件（skills/library/workflow-assets 缺省自数据根派生——`~/.tianshu-server`，TIANSHU_DATA_ROOT 优先）
- **GA-T6 审查修**：run 发射单链收口（catch 落终点后 finally 恒清 inflight）——分叉三链会让无 handler 的分支在拒绝时触发 unhandledRejection，Node 15+ 默认进程崩溃，无人值守端把一次 DB 抖动放大为整机重启
- e2e：`npm run test:e2e:graph`（`tests/ai/server/e2e-graph-smoke.ts` 本机起 server 打 HTTP 链）、`test:e2e:graphPg`（PG 变体）；桌面单测 30+ 文件（tests/ai/graph-*.test.ts：schema/compiler/executor 各节点族/http-guard/webhook 同步异步/run-nodes 端点/templates/intent-node/hybrid 等）

### 4.2 能力协商与遥控面板

- `CAPABILITIES`（无头端上报，protocol server-event.ts 190 行）：`chat/provider/graph/files/library/monitor`——graph 能力**仅无头端**报
- `DESKTOP_CAPABILITIES`（桌面被控面，220 行）：`chat/provider/ui-drive/files/mcp/monitor/library/project/skillhub/automation`——**无 graph**（GA-T6 裁定「远程编排属无头端专属」）；但 2026-10-27 移动端 CRUD 批增了 `automation` 半边（桌面 face 透出 automation 五段 + `graph/query` **只读**选图面，`electron/domains/server-face/automation-tap.ts`）
- 桌面主机页遥控：`src-react/domains/ai/server/components/GraphPanel.tsx`（GA-T8）——无头端 graph/query 列表（名称/节点数/run 状态徽标）+ run 触发（202 受理回 runId 行内转运行中）+ 中止 + webhook 管理 Popover；**run 状态是客户端投影**：初值 idle、受理即 running、graph.run.updated 事件流式更新（payload.graphId 定位行）、server.connected 重连复位 idle（断流期间终局事件已失无从补查）
- 伴生面板 `src-react/domains/ai/server/components/AutomationPanel.tsx`：无头端自动化任务遥控（列表+runNow+启停），与 GraphPanel 同挂在主机页右栏（选中连接 capabilities 含 graph 才展开）；两面板均不做编辑——图定义的创建与编辑在无头端本地完成（或经对话），控制端只遥控
- `onRemoteGraphEvent`（graph.api.ts）：远程事件流订阅封装，GraphPanel 消费 graph.run.updated 更新行内状态；`/module/ai/server` 路由的编排区即由这两面板组成
- 移动端 `src/transport/graph-api.ts`（M2c 批）：server 二期 graph/automation 九端点的移动端封装；判错统一 wireRequest（HTTP 200 亦可能业务错 4xxx 查 body.success，graph/run 的 202 受理同 success）；类型单源 @tianshu/protocol，行级必填门禁防畸形 wire 行（坏行丢弃不抛错）

### 4.3 共享层与双份纪律

- `@tianshu/protocol`：graph-contract.ts（端点契约 + GraphRecord/AutomationRunNodeRecord 等 wire 类型）、server-event.ts（graph.run.updated/automation.changed 载荷 + CAPABILITIES/DESKTOP_CAPABILITIES）
- `@tianshu/core`：graph-schema/graph-compiler/graph-http-guard/graph-prompt/graph-inputs（GA-T2 收编；桌面经 alias 直引 `packages/*/src` 源码，server 消费 dist——改包源码后须 sync:core 重建）
- 双份同构守护：`npm run check:drift`（基线 `packages/tianshu-core/scripts/drift-manifest.json`）守护 desktop↔server 双份文件；graph-executor 目前是**手动摘取 + 改造点登记**模式（server 副本头注释逐条登记），不在 drift 基线内（见 §6.5）

## 5. 业界主流做法对比

| 维度 | 天枢现状 | LangGraph 原生 | Coze 工作流 | Dify DSL | n8n | Temporal |
|---|---|---|---|---|---|---|
| DSL 形态 | GraphJson（zod 校验，结构化对象存库） | 代码即图（addNode/addEdge） | 私有画布协议 | **YAML DSL 文件**（.yml，版本化可 git 管理/导入导出） | 节点 JSON workflow 文件 | 代码（TS/Go/Java SDK workflow 函数） |
| 节点类型丰富度 | 30 种：LLM/数据/ETL/检索面广，**SaaS 连接器缺**（靠 http/database/code 自建） | 开发者自定义 | 数十种 + 插件/数据库节点市场 | LLM/知识检索/代码/HTTP/工具 + B 端集成 | **400+ 官方集成节点**（最大优势） | 无节点概念，Activity 为单元 |
| 执行引擎 | LangGraph StateGraph（invoke 单趟） | LangGraph 本尊 | 云端闭源 | 自研 Python 执行器 | 自研（主进程 + 队列） | **event-sourcing 持久化虚拟机** |
| Interrupt / HITL | **无**：delay 仅 1-600s 静默等待，schema 注释明言审批另立项 | `interrupt()` + checkpointer 原生支持，resume 走 thread_id | 「等待回复」节点（会话回填续跑） | Human 节点 + conversation 变量 | Wait/Webhook wait 节点 | **Signal/Update API**，任意 durable 等待 |
| Checkpoint/断点恢复 | **未接**（checkpointer 无；thread_id 已带备用）；失败整图重跑 | MemorySaver/SqliteSaver/PostgresSaver state 快照 | run 级重试 | run 级重试 | execution 可重跑 | **完整 event history + 重放**（time travel） |
| 版本化 | version=int 乐观锁；无发布/回滚/灰度；run 不绑定图版本快照 | — | 发布-草稿双态，发布版本可回滚 | DSL 版本 + 发布，export 可 diff | workflow 版本历史 UI | **代码版本 + determinism**，worker 升级不影响在途 run |
| 回放调试 | 单节点测试（testNode 不落 run）+ 试运行 draftJson + graphRunNode 三层下钻；无逐节点断点续跑 | LangSmith 全链 trace + Studio 可视化回放 | 画布逐节点运行态 + 试运行输入面板 | 运行日志节点级展开 + 单节点重跑 | **pin data**（固定输入单节点调试）+ execution 重放 | 完整历史查询 + replay + continue-as-new |
| 执行队列/并发 | 进程内 Map 互斥（试运行单图互斥；**webhook 触发无互斥**）；无队列/优先级/水平扩展 | — | 云端托管 | 云端队列 | **BullMQ（Redis）** 队列 + worker 水平扩展 + concurrency 限流 | task queue + worker 池，天然分布式 |
| 定时触发 | 挂 automationTask（见姊妹文档 automation-scheduled-tasks.md） | — | 触发器节点 | 定时编排（cron） | Schedule/Cron trigger 节点 | **durable cron workflow**（错过自动补） |

分系统详述（择与本项目决策最相关的点）：

- **LangGraph 的图执行与 checkpoint**：官方执行模型是「StateGraph + reducer 通道 + invoke(configurable.thread_id)」，配合 checkpointer（SqliteSaver/PostgresSaver）可获得每步状态快照，`interrupt()` 在任意节点挂起等人、`getState/timeTravel` 回放调试——这正是 HITL 与断点恢复的标准答案。天枢把 compile→invoke 这半边完整采用，把 checkpointer/interrupt 这半边显式搁置（executor 头注释登记了原因与预留口）。
- **Dify DSL 工作流**：最大特色是 DSL 即文件（YAML），天然 git 版本化、环境间导入导出、diff 审查；节点覆盖 LLM/知识检索/迭代/参数提取/HTTP。天枢的 graphJson 同样是可导出的 JSON（tianshu-workflow 包裹格式 + bundle），但存库为主、无版本历史。
- **Coze 工作流**：节点体系与试运行体验的标杆（画布实时节点状态、单节点试运行、运行记录节点级展开）。天枢的产品细节大量对照 Coze（含 HTTP 节点鉴权五型、Choice/Intent、循环 carryVariable、onError 默认值降级），并在运行记录上做到了同构三层下钻；差异是 Coze 有「等待用户输入」节点而天枢没有。
- **n8n 节点画布与执行队列**：400+ 集成节点 + 表达式体系（`{{ $json.field }}` 与天枢 `{{nodes.x.output}}` 同心智）+ pin data 调试 + BullMQ 队列水平扩展。天枢画布选 React Flow 而非自研（n8n 自研 Vue 画布），集成面靠 http/database/code 三类通用节点兜底。
- **Temporal 持久化执行**：workflow 代码即编排、event history 全量留痕、worker 崩溃任意续跑、cron schedule 错过自动补。天枢的 run/trace/graphRunNode 留痕体系在「可观测」上接近，但「可恢复」为零——进程重启即 failed(interrupted)。

要点解读：

1. **执行底座选 LangGraph 是最大差异化**：直接获得 reducer state、条件路由、recursionLimit 防环、ReactAgent prebuilt；但刻意止步于「单 invoke 执行器」形态——LangGraph 生态最有价值的 checkpointer/interrupt（HITL、断点恢复、time-travel）均未启用，invoke 已带 thread_id 预留接入位（一步之遥）。
2. **节点设计是最「Coze」的部分**：HTTP 节点（含 ACS3 签名这种本土化深度）、Choice/Intent 双路由、循环 carryVariable、onError=defaultValue 降级、Coze 式三层运行记录、单节点测试，均有明确 Coze 对照注释；相比 Coze 缺「等待用户输入」类人机交互节点。
3. **相比 n8n/Dify 的差距集中在集成生态与执行队列**：无连接器市场（http/database/code 节点是通用逃生门）、无 Redis 队列与多 worker；单机 Electron 与单实例 server 各自 inflight Map 已够当前规模，多副本部署是明确边界。
4. **相比 Temporal 的差距是持久化语义**：进程重启即丢在途 run（桌面 scheduler 的 recoverInterruptedRuns 直接置 failed(interrupted)；server executor 同款），无跨进程 resume——而 LLM 工作流恰恰是分钟到小时级长任务，这是后续最值得补强的方向（thread_id/checkpointer 已铺路）。

## 6. 改进空间

1. **checkpointer/断点恢复**：thread_id 已带，接入 SqliteSaver 后长图（iterate×subflow 大循环）可在节点边界持久化、失败断点续跑；recursionLimit=25 对多分支长链偏紧（iterate 子图算独立 invoke 不受此限，但顶层 25 步需评估）。
2. **HITL/Interrupt 缺位**：delay 节点注释已立项待做（「人在环审批需待审中心+持久化支撑，后续单独立项」）；审批类工作流（生成→人审→发布）当前只能拆两图 + taskFinished 事件链拼接，链深上限 5（MAX_CHAIN_DEPTH）。
3. ~~**版本化与运行绑定**~~ ✅ 已落地（批1C，2026-11-05）：run 落执行时快照——automationRun 新增 `graphJsonSnapshot String?` 列（桌面 v1 快照直改 + 指纹重放；server schema/PG 派生 + `1_automation_run_graph_snapshot` 双端成对迁移 + SQLite 存量库启动幂等补列 `ensureAutomationRunGraphSnapshotColumn`），createRunRow 写入截 64KB（对齐 graphRunNode input/output 上限）。未做 graphVersion 语义版（快照已可对照当时结构，发布/回滚语义仍不存在）。
4. ~~**webhook 触发无互斥**~~ ✅ 已落地（批1C）：`runForWebhook` 入口 check→set 相邻同步占位（launchTestRun 先例）新增图级 `graphWebhookInflight` 注册表（graph-inflight.ts，桌面/server 双份），同图并发 POST 第二个拒 `graph_inflight`（500，graph_not_available 同 code 形态）；同步/异步面同径，finally 全路径释放；中止仍走 activeRuns（runId 键）。
5. **双 executor 副本漂移风险**：桌面 4843 行与 server 副本是手动摘取+改造点登记模式（GA-T4 起 11 类授权面装配），drift-manifest 守护的是 automation-retention 等文件——executor 体量大、30 种节点持续增改，建议纳入 check:drift 基线或继续抽公共段入 @tianshu/core。
6. **编辑器体验**：旧图无 position 仅 autoLayout 兜底，缺 dag 自动布局；连线校验保存期才报（画布连线时可前置预检）；iterate/subflow 引用的子图不可视化展开（只能下拉选 graphId，GraphPanel/编辑器均无子图下钻）。
7. **移动端遥控深度**：GraphPanel/移动端只能触发与中止，图结构与 graphRunNode 节点详情在移动端不可见——协议面已备（graph/query 只读 + automation/runNodes），UI 未做展开，属低成本补齐项。
8. **图 HTTP 守卫 allowlist 无管理面**：server 侧 `tianshu.graph.allowlist` 只能手改 config.yml 重启生效；可考虑运维端点热载或图级白名单覆盖（当前只有全局 allowPrivateNetwork/allowlist 两档）。
9. ~~**notify 节点 server 降级静默**~~ ✅ 已落地（批1C）：无头端未注入 notify 钩子（缺省）时 trace 条目落 `notifySkipped` 标注（`no_channel` 无通道 / `send_failed` 发送失败，桌面端发送失败同款落点），节点仍 success（尽力而为语义不变）；桌面轨迹视图（GraphRunTraceView）展开行显示「通知未送达」+ 原因（i18n 双语）。
