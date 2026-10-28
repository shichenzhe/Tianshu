# LangGraph 编排与多触发方式自动化设计

> 上游需求:定时任务支持 LangGraph 的编排定义与执行;触发方式扩展为定时/手动/事件三种。
> 核心决策:编排独立 `orchestration` 子域全 LangChain 化(方案 2),`automation` 退化为
> 触发层;运行记录统一 `automationRun`;LangChain 栈起初只活在 orchestration 域,
> 2026-10-15 起全应用统一 LangChain 单栈(spec `2026-10-15-unify-langchain-design.md`
> 收敛,见 §0)。

## 0. 已确认的产品决策(澄清结论)

| 问题 | 结论 |
|------|------|
| LangGraph 语义 | 引入 `@langchain/langgraph` 库(非自研 DAG);版本 1.4.x,peer `@langchain/core` ^1.1.48,zod `^3.25.32 \|\| ^4.2.0` 与项目 zod ^4.5.4 兼容 |
| 模块归属 | 编排独立 `electron/domains/ai/orchestration/` 域;`automation` 保持但退化为「触发层」;同一图可被多个触发器复用 |
| 集成深度 | 方案 2 全 LangChain 化:节点 = LangChain ChatModel + `createReactAgent`/ToolNode;代价 = 工具桥接层 + 安全门禁接线 + LangChain 版 provider 工厂(知情接受) |
| LLM 栈边界 | 全应用统一 LangChain 单栈(2026-10-15 spec `2026-10-15-unify-langchain-design.md` 收敛),模型构造唯一入口 `langchain-model-factory.createChatModel` |
| 事件源 | v1 仅两种:appStarted(应用启动)/ taskFinished(任务·图运行完成,链式);文件 watch、webhook、会话完成不在本期 |
| 手动触发 | 已存在(`runNow` + `triggerType=manual` 不消耗调度),查漏补缺即可 |
| 触发器并存 | 一个任务可同时挂定时(scheduleJson)+ 事件(eventJson),互不干扰 |
| 事件 payload | v1 仅注入 outcome;不带上游输出内容 |
| Checkpointer | v1 内存 `MemorySaver`,失败整次重试(对齐现有重试语义);SqliteSaver 断点续跑留 v2 |
| 运行记录 | 复用 `automationRun`:`taskId` 改可空(图试运行)+ 新增 `graphId`/`graphTrace` |
| 图编辑器 | 结构化节点/边列表 + JSON 源码双模式;不做拖拽画布(v2 议题) |
| 条件路由 | LLM 节点输出结构化分支标签(outputMode=branch),条件边按标签匹配(Dify 式,免单独路由调用) |
| 节点类型 | v1 仅 `kind:"llm"`;schema 预留 tool/subgraph/humanApprove |
| 图试运行 | 图详情页直接运行,落 `automationRun(taskId=null, graphId, triggerType=manual)`,不建任务 |
| 数据库迁移 | 项目未发布(v0.1.0/DATABASE_VERSION=1),按既有规则直接并入 v1 快照(指纹守卫自动重建开发库);若实现时发现已发布则改走 `script/v2`(taskId 去 NOT NULL 需 SQLite 表重建) |

## 1. 架构与模块划分

```
electron/domains/ai/orchestration/            # 新增:编排域(LangChain 栈唯一存活区)
├── graph.repo.ts                # 图 CRUD IPC + zod 校验 + userId 隔离
├── graph-json.schema.ts         # GraphJson zod schema(节点/边/条件边/输入变量)
├── graph-compiler.ts            # GraphJson → StateGraph 编译(纯函数,重点单测)
├── graph-executor.ts            # 执行编排:session 创建→逐节点落 message→graphTrace→run 收尾
├── langchain-model-factory.ts   # provider/model DB 行 → ChatOpenAI/ChatAnthropic/ChatGoogle/ChatOllama
├── langchain-tool-adapter.ts    # AI SDK 工具(含 mcp__*)→ LangChain Tool,执行点内嵌安全门禁
└── graph-templates.ts           # 内置图模板(先例 automation-templates.ts)

electron/domains/ai/agent/tool-execution.ts   # 新增:从 chat.service 抽出的安全工具执行公共模块
                                               # (commandGate/fileGate/审批分流/审计接线),
                                               # chat.service 与 langchain-tool-adapter 共用

electron/domains/ai/automation/  # 改造:触发层
├── automation-scheduler.ts      # 30s tick 决策树不变;start() 末尾发 appStarted 事件
├── automation-event-bus.ts      # 新增:事件发布/匹配/触发(防环在此)
└── automation-runner.ts         # executeTask 分流:targetKind=graph → graph-executor
```

依赖新增(锁次版本,LangChain JS 有小版本 API 变动口碑):`@langchain/langgraph`、
`@langchain/core`、`@langchain/anthropic`、`@langchain/google-genai`、`@langchain/ollama`。

**安全接线要点**(方案 2 的红线):现有工具安全执行逻辑(commandGate 判定、fileGate
判定、审批分流、审计、备份钩子)织在 chat.service 的 runToolCall 内部;抽取为
`agent/tool-execution.ts` 导出函数后,langchain-tool-adapter 的工具 func 必须经它执行,
保证图内工具与聊天工具走同一条门禁链。此抽取是本期对现有代码的唯一结构性重构,
chat.service 行为不得变化(现有测试守护)。

## 2. 数据模型

```prisma
model graphDefinition {
  id          Int      @id @default(autoincrement())
  name        String
  description String?
  graphJson   String   // GraphJson,保存期 zod 校验
  version     Int      @default(1)   // 乐观锁,防编辑覆盖
  enabled     Boolean  @default(true)
  userId      Int?                     // 多用户隔离
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

`automationTask` 加列:

- `targetKind String @default("prompt")`——prompt | graph;
- `graphId Int?`——targetKind=graph 时必填,创建/编辑期校验存在;
- `eventJson String?`——事件触发配置,与 scheduleJson 可并存;

```ts
// eventJson(zod discriminated union)
{ source: "appStarted" }
| { source: "taskFinished"; targetType: "task" | "graph"; targetId: number; on: "success" | "failed" | "any" }
```

`automationRun` 变更:

- `taskId` 改可空(图试运行无任务;仅 graphId 非空时允许 null);
- 新增 `graphId Int?`、`graphTrace String?`(节点级轨迹 JSON,见 §4);
- `triggerType` 枚举扩 `event`(schedule | catchUp | retry | manual | event)。

删除语义:删图时后端事务内检查被引用的任务(`targetKind=graph && graphId=X`):
存在引用则拒绝删除并返回引用清单(与 SQLite 无外键、级联删走应用层的既有约定一致)。

## 3. GraphJson 结构与编译

```ts
{
  version: 1,
  inputSchema: { [varName: string]: "string" }  // 试运行/触发时注入的输入变量声明
  nodes: [{
    id: string          // kebab-case,唯一
    name: string        // 展示名
    kind: "llm"         // v1 仅 llm;schema 预留 tool|subgraph|humanApprove
    modelId: number     // 每节点独立选模型
    systemPrompt?: string
    prompt: string      // 模板:{{input.x}} / {{nodes.<id>.output}} / {{date}}/{{weekday}}/{{time}}
    temperature?: number
    tools: boolean | string[]   // agent 步骤开关 + 可选工具白名单
    maxSteps?: number   // agent 循环上限,缺省 10
    outputMode: "text" | "branch"
    branchOptions?: string[]    // outputMode=branch 时的枚举标签
  }]
  edges: [{ from: string; to: string | "END"; condition?: { type: "branch"; value: string } }]
}
```

**编译(graph-compiler.ts)**:LangGraph State 用 Annotation 定义:

- `inputs: Record<string, string>`——初始输入;
- `nodes: Record<nodeId, { output, usage }>`——merge reducer,各节点产物;
- `route: string | undefined`——最新 branch 标签,供条件边判定。

节点 → `addNode`;无条件边 → `addEdge`;同一 `from` 的条件边聚合 →
`addConditionalEdges(from, s => s.route, 映射表)`。环允许(LangGraph 特性),
`recursionLimit: 25` 兜底。

**保存期校验(阻断)**:节点 id 唯一且 kebab-case;START 出边唯一(单入口);无悬空边
(from/to 均须指向存在节点或 END);`outputMode=branch` 节点的出边若带 condition,其
value ⊆ branchOptions;非 branch 节点不得挂条件出边;`tools` 白名单内的工具名合法。

## 4. 编排执行与节点级可观测性

### 执行流程(graph-executor.ts)

1. 落 run(running, triggerType, attempt, graphId);校验图存在且 graphJson 合法 →
   失败:`graph_missing`(task error+enabled=false,对齐 workspace_missing 先例)/
   `graph_invalid`;
2. 建 session(workspaceId 取任务绑定,试运行取用户所选 workspace);后续每个 llm 节点
   在该 session 落一对 user/assistant message(复用 `serializeBlocks`,聊天页可回看
   整图过程);
3. 每节点:模板替换 → langchain-model-factory 造模型 → tools 开则
   `createReactAgent(model, adaptedTools)`(工具经 adapter 过安全门禁),关则
   `model.invoke` → outputMode=branch 用 `withStructuredOutput(zod enum(branchOptions))`,
   结果写 `state.route`;

**inputs 取值来源**(消除歧义):试运行 = 表单填写;事件触发 = `{ outcome }`
(§0 决策);定时/手动触发 = 空对象。模板引用未定义的 input 变量 → 节点失败
`template_ref_missing`(错误信息含变量名)。
4. graphTrace 逐节点追加;全部完成 → run success(failed 任一节点即中断);
5. 收尾:更新 run + task.lastRunAt/nextRunAt(复用 advanceTask 语义:manual/event 触发
   是否推进调度,见 §5)→ publish taskFinished。

### graphTrace 结构(可观测性核心)

```ts
[{
  nodeId: string
  name: string
  status: "success" | "failed" | "skipped"   // 失败节点之后的节点显式落 skipped
  startedAt: string
  durationMs: number
  tokens?: { promptTokens: number; completionTokens: number }
  error?: {
    code: string      // 分类码:classifyError 复用 + 图专属码
    message: string   // 摘要(截断)
    toolName?: string // 工具失败时定位到具体工具
  }
  toolCalls?: [{ name: string; ok: boolean; durationMs: number }]  // agent 节点工具调用摘要
  outputPreview?: string
}]
```

图专属错误码:`template_ref_missing`(`{{nodes.x.output}}` 引用不存在)、
`branch_parse_error`(结构化输出不合 schema)、`graph_recursion_limit`、`model_missing`、
`graph_invalid`、`graph_tool_error`;LLM/网络类沿用 `classifyError` 分类码。

run 级 error 聚合格式:`node:<nodeId> <code>: <message>`——运行记录列表行内即可见
「哪一步 + 什么错」。

**失败语义澄清**:agent 节点内单次工具执行失败不导致节点失败(错误作为反馈喂回模型
继续,与现有 chat 一致);节点 failed = LLM 调用失败 / branch 解析失败 / 引用缺失 /
达 maxSteps。「节点失败」始终意味着该步 AI 推理本身出了问题,不把可恢复的工具抖动
误报为编排失败。工具级软失败在 toolCalls 摘要与 session 消息 blocks 两层可见。

**三层下钻**:运行记录列表行(错误码速览)→ GraphRunTraceView(节点时间线:前序绿、
失败红展开「错误码+摘要+节点输入 prompt+已产生消息」、后续灰 skipped)→ 点击跳
session(该节点完整 user/assistant message,含每次工具调用的参数/结果/耗时)。

## 5. 触发层(定时/手动/事件统一)

| 触发 | 实现 |
|------|------|
| 定时 | 现有 scheduleJson + 30s tick 决策树零改动 |
| 手动 | 现有 runNow(manual 不消耗调度语义保留)+ 图详情「试运行」 |
| 事件 | automation-event-bus:`publish(event)` → 查 eventJson 匹配且 enabled/active 的任务 → 复用 scheduler `launch()`(inflight 互斥、notifyChanged、重试扫描全部继承) |

- **appStarted**:`scheduler.start()` 末尾 publish 一次(进程生命周期内天然幂等);
- **taskFinished**:`executeTask` 与 graph-executor 收尾时 publish
  `{targetType, targetId, outcome}`(event/retry 触发的 run 也发布,链在 retry 成功后
  正常续上);
- **事件触发是否推进调度**:对齐 manual——event 触发不推进 nextRunAt/lastRunAt,不
  消耗定时调度;
- **防环**:创建/编辑任务时禁止自引用(`eventJson.targetType=task && targetId==task.id`
  拒绝);运行期链深 >5 不再触发、落 `skipped(error=chain_depth_exceeded)`(内存计数,
  重启清零可接受——最坏重启后再触发一层);
- **运行中收到事件**:inflight 互斥跳过,落 `skipped(error=event_skipped_running)`;
- **重试**:事件触发的失败 run 照常进重试扫描(≤3 次),与现有语义一致。

## 6. 健康度总览(统一统计展示)

**位置**:任务 Tab 顶部统计卡片区。**数据源**:automationRun 统一聚合(prompt+图全
口径),新增 IPC `automation:stats` SQL 即时聚合,**不建新表不预聚合**(SQLite 本地
数据量小)。

- **KPI 行**:今日运行 N 次 | 成功率 `success/(success+failed)`(skipped 不计分母) |
  失败 N 次 | 进行中 N | 异常任务 N(近 7 天每日成功/失败迷你柱状,
  `GROUP BY date(startedAt)`,图表用主题色变量);
- **「需要关注」清单**(每条可点击下钻):
  - 任务级异常:`status=error` + statusNote(如 model_missing/graph_missing)→ 跳任务
    编辑弹窗;
  - 近 24h 失败 run(含图 run 的节点级摘要,复用 `node:<id> <code>` 聚合格式)→ 图
    失败跳 GraphRunTraceView,prompt 失败跳运行记录;
- **运行记录视图补状态筛选**:全部/成功/失败/跳过(当前没有);
- 任务 Tab 状态 pill(全部/异常/已过期…)保持,「异常任务 N」卡点击激活该筛选,口径
  一致。

## 7. 前端视图

```
src-react/domains/ai/orchestration/
├── api/orchestration.api.ts
├── views/GraphListView.tsx        # 图列表(名称/节点数/启停/最近运行)+ 新建 + 模板入口
├── views/GraphEditorView.tsx      # 双模式:结构化(节点卡片+边列表表单)⇄ JSON 源码
├── views/GraphDetailView.tsx      # 版本/运行历史/试运行(填 inputSchema 变量)
└── components/GraphNodeEditor.tsx / GraphEdgeEditor.tsx / GraphJsonEditor.tsx /
   GraphRunTraceView.tsx / AutomationStatsPanel.tsx
```

- automation 页 Tab 扩为「任务 | 编排 | 运行记录」;图编辑走子路由
  `/module/ai/automation/graphs/:id`;
- **创建任务弹窗扩展**:执行体类型「Prompt | 编排图」(选图后 prompt 区换成图选择
  器);触发配置区在 SchedulePicker 之外加「事件触发」块(应用启动 / 任务完成→选目标
  任务或图 + 成功|失败|任意);
- 双模式编辑器切换时双向同步,保存前 zod 校验,错误内联提示;
- i18n:`chat:orchestration.*`(沿用 automation.* 进 chat ns 先例),zh-CN/en-US 同步。

## 8. IPC 契约

```
orchestration:list                    → GraphRecord[]
orchestration:create / update / delete(引用检查) / toggle(id, enabled)
orchestration:templates               → GraphTemplateRecord[]
orchestration:run-test(graphId, inputs, workspaceId) → runId
orchestration:runs(graphId, page)     → { total, items: RunRecord[] }
automation:stats                      → { today: {…}, trend: […], attention: […] }
automation:graphs-changed             → 主进程 → 渲染层事件(图 CRUD/启停后)
automation:tasks-changed              → 现有,不变
```

## 9. 异常处理汇总(增量)

| 场景 | 处理 |
|------|------|
| 图 JSON 非法 | 保存期 zod 阻断;执行前二次校验,run failed(graph_invalid) |
| 被引用图删除 | 删图有引用检查拒绝;运行前校验 → task error + enabled=false(graph_missing) |
| 节点模型/工具/MCP 缺失 | 节点失败:classifyError/graph_tool_error,走重试 |
| 节点 LLM 失败/断网 | 图中断,run failed,60s 重试 ≤3 次(现有机制覆盖) |
| 死循环/环 | recursionLimit 25 → run failed(graph_recursion_limit) |
| 链式触发环 | 创建期禁自引用 + 运行期链深 >5 落 skipped(chain_depth_exceeded) |
| 事件到达时任务运行中 | inflight 互斥跳过,落 skipped(event_skipped_running) |
| 崩溃 run 悬挂 | recoverInterruptedRuns 已覆盖(图 run 同置 failed/interrupted) |
| 表单防呆 | 图保存校验(§3);任务挂图时 graphId 必选存在;事件配置完整 |

## 10. 测试策略(Vitest,纯函数/mock)

- **graph-json.schema**:合法/非法矩阵(重 id、悬空边、多入口、branch 不匹配、条件边
  挂非 branch 节点);
- **graph-compiler**:JSON → 节点集/条件边映射/aggregation 正确性;
- **模板替换**:`{{input.*}}`/`{{nodes.*.output}}`/日期变量/缺引用报
  template_ref_missing;
- **事件匹配**:eventJson × event 匹配矩阵(含 on 条件)、链深防环、运行中跳过;
- **langchain-tool-adapter**:zod 参数透传 + 门禁调用断言(mock gate,守护安全接线
  红线);
- **langchain-model-factory**:provider 行 → 模型实例类型映射(mock);
- **tool-execution 抽取回归**:chat.service 现有工具执行测试全绿(行为不变);
- **集成**:2 节点 + 分支小图用 FakeChatModel 跑通,断言 graphTrace/session message/
  run 收尾形态;
- **stats 聚合**:口径(成功率分母不含 skipped)、trend 分组。

## 11. 范围外(v2 议题)

拖拽画布编辑器;SqliteSaver 断点续跑/thread 管理;humanApprove 节点(LangGraph
interrupt);文件 watch/webhook/会话完成事件源;聊天栈全量迁移 LangChain;LangSmith
追踪;子图节点;事件 payload 携带上游输出。
