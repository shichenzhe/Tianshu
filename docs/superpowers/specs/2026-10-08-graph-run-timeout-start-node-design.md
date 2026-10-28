# 图编排三项改进设计（试运行异步化 / 节点超时修复 / 开始节点）

日期：2026-10-08
状态：已批准（设计对话），待实施
关联：`2026-10-03-langgraph-orchestration-design.md`（图执行内核）、`2026-10-04-graph-canvas-editor-design.md`（画布编辑器）

## 背景与目标

三项独立改进，同属 orchestration 域：

1. **`run_workflow` 工具同步等待整图执行**（最长 600s），AI 建完工作流试跑时整个 agent 轮次被卡住。
2. **节点超时两处失效**：agent 工具步不响应节点超时；vectorize/vectorSearch 节点无超时。
3. **图级参数（inputSchema 变量）只在右侧面板「未选中节点」分支可编辑**，画布不可见；改为开始节点承载（Dify/Coze 式）。

非目标：变量类型系统扩展（维持 string）；图级总超时机制；start 节点参与执行语义。

## 1. `run_workflow` 工具异步化

### 现状

`makeRunWorkflowTool`（`electron/domains/ai/orchestration/create-workflow.ts:350`）`await deps.runGraph(...)` 同步等待，`AbortSignal.timeout(600_000)` 兜底。画布/列表页试运行入口（`GraphApi.runTest`）已是触发即返回，无需改动。

### 方案

- `RunGraphFn` 注入替换为 **launch 型**：`GraphRepository.launchTestRun` 提为公共方法，repo 构造 `makeRunWorkflowTool` 时直接包装注入，签名 `launch(graph, inputs, workspace): void`，fire-and-forget。
- `run_workflow` 校验（图归属/workspace/互斥 `GRAPH_ALREADY_RUNNING`）后立即返回文案「已启动试运行，可稍后用 get_workflow_run 查询结果」；互斥等错误照旧前置抛出。
- **新增 `get_workflow_run` 工具**：参数 `{ id: 工作流 id }`，查 `automationRun` 中该 graphId 最近一条（status/output 摘要 500 字/durationMs/startedAt），无记录时明确说明。工具描述写明「长任务勿高频轮询，建议间隔一轮对话再查」。
- 触发时拿不到 runId（run 行由执行内核异步落库），查询按 graphId 取最近一条——runId 不进返回文案。

### 数据流

```
AI → run_workflow(id, inputs) → 校验+互斥 → launchTestRun（fire-and-forget）→ 返回「已启动」
AI → get_workflow_run(id) → automationRun 最近一条 → status/output 摘要
```

### 手工中断（用户补充需求）

现状：`graphTestInflight` 注册表只用于互斥与悬挂回收，**无用户可触发的中断通道**；执行内核 abort 语义已完整（中断 → 在途节点抛 AbortError → run 落 failed → 收尾清 inflight、推 `graphs-changed`、发布 taskFinished，前端自动刷新）。

- **IPC `orchestration:cancelTestRun`**（handleUser）：先校验 graphId 归属 userId；`graphTestInflight.get(graphId)` 存在则 `abort()` 返回，无在途抛 `GRAPH_NOT_RUNNING`（前端 toast）。
- **run 终态**：status 沿用 `failed`（不新增 canceled 取值，避免牵动运行历史/统计口径）；`runGraph` 收尾 error 归一——`params.abort.aborted` 且异常为 AbortError 族时 error 写「已被用户中断」，否则保持原样。
- **UI 入口**：`GraphRunHistoryDialog` 中 status=running 的行加「中断」按钮（调 cancelTestRun，`graphs-changed` 推送自动刷新行状态）；运行历史弹窗打开期间订阅既有失效链。
- 非目标：AI 侧 `stop_workflow` 工具（用户说「手工」= 用户操作，YAGNI）；自动化任务 run 的中断（走任务禁用，另一语义）。

## 2. 节点超时修复

### 审计结论

| 节点 | timeoutMs 链路 | 结论 |
|---|---|---|
| llm（纯模型） | `runNodeWithRetry` signal → `generateText`/`invoke` | ✓ 完整（含重试全程） |
| code | exec kill group + timeoutMs | ✓ 完整 |
| http | fetch signal | ✓ 完整 |
| intent | invoke signal | ✓ 完整 |
| docExtract / imageGen | 有 signal 挂接 | ✓ 完整 |
| **llm（agent 工具模式）** | 工具注入 `abortSignal: ctx.abort`（仅图中止） | **✗ 工具步不受节点超时** |
| **vectorize / vectorSearch** | schema 无 timeoutMs，`embedTexts` fetch 无 signal | **✗ 无超时** |

### 修复

- **agent 工具步**（`graph-executor.ts` `runToolNode`）：`toLangChainTools` 的 `abortSignal` 从 `ctx.abort` 改为 `AbortSignal.any([ctx.abort, signal])`（signal 即 `runNodeWithRetry` 传入的带超时信号）。LLM 调用已受 signal 约束，无需改。
- **vectorize/vectorSearch**：两个节点 schema 加 `timeoutMs`（int，min 1s，max 600s，default 120_000）；`embedTexts` 增加 signal 参数（`AbortSignal.any([ctx.abort, AbortSignal.timeout(node.timeoutMs)]）` 在 handler 侧组装传入）；GraphNodeEditor 两个字段区加超时秒输入（对齐 http 节点样式）。

## 3. 开始节点（start）

### Schema 与校验

```ts
export const startNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("start"),
  /** 图输入变量（编辑回写 graph.inputSchema，单一事实源不变） */
  variables: z.array(z.string().min(1)).default([]),
});
```

- 加入 `graphNodeSchema` union。
- `validateGraph` 新增规则：全图至多一个 start；start 禁止入边（结构化 issue，走既有 GraphIssue 通道）。

### 数据单一事实源

- **`graph.inputSchema` 仍是执行/试运行/AI 协议的唯一读取源**，start 节点是它的编辑载体：
  - 编辑器：`StartNodeFields` 修改变量列表 → 编辑器层同步把 `variables` 与 `inputSchema` 一起 patch（`commitGraph` 收口，二者由同一次提交保持一致）。
  - 反向：JSON 模式手改 inputSchema、或 AI `create_workflow` 只写图级 inputSchema 不带 start 节点——都合法；start 节点仅在其存在且被编辑时回写。出现不一致（节点 variables ≠ inputSchema keys）时以 inputSchema 为准显示（字段区初始值从 inputSchema 读）。
- 执行器：start 节点 handler = 直通（不产出 output、不写消息、不写 trace）；超时/重试等执行参数不适用于 start。

### 编辑器与画布

- 新建图默认放一个 start 节点（`graph-editor-model` 初始图 + `graph-templates` 模板同步带 start）。
- `GraphNodeEditor` 新增 `StartNodeFields`：变量 key 列表（复用 `StringListInput`），无模型/超时字段。
- `NodeCard` start 专用样式（如绿色描边 + Play 图标），对齐「入口」视觉。
- `AddNodeMenu` 不提供手动再加 start（已存在时）；无 start 的旧图允许手动补一个（菜单动态禁用）。
- **右侧面板图级分支的变量编辑区移除**（图名称/描述保留）；变量唯一编辑入口 = start 节点。
- AI 生成协议：`graph-prompt.ts` 提示词教模型生成 start 节点（variables 与 inputSchema 同时写，保持一致）。

### 兼容

- 旧图无 start：照常运行、照常编辑（inputSchema 图级仍在）；试运行变量表单不受影响。
- 旧图添加 start 节点：字段区初始值取 inputSchema keys。

## 测试策略

- **工具**（`create-workflow.test.ts` 扩展）：run_workflow 触发即返回（launch 被调一次、不等待）、互斥错误前置；get_workflow_run 查询/无记录文案。
- **中断**：cancelTestRun 有在途时 abort 且 inflight 清理、无在途抛 GRAPH_NOT_RUNNING、归属校验拒绝他人图；中断的 run 落 failed 且 error=「已被用户中断」；GraphRunHistoryDialog running 行渲染中断按钮。
- **超时**：runToolNode 工具 abortSignal 含超时信号（mock 工具捕获 signal 断言）；vectorize 超时传递（embedTexts 注入 stub 断言 signal）；schema 校验用例。
- **start 节点**：schema（至多一个/禁入边/variables 默认）、editor-model（新建默认带 start、变量编辑回写 inputSchema）、StartNodeFields 渲染与回写、执行器直通（不产出 output）、模板/AI 提示词快照测试更新。
- 回归：`npm run test` / `lint` / `typecheck` 全绿。

## 风险与权衡

- 工具步超时中断属 cooperative cancel：正在跑的子进程/HTTP 由工具自身的 abort 处理收口（`abortSignal` 通道已存在），个别工具若不响应 signal 则仍等其自然结束——可接受，不为本次加固每个工具。
- start 节点与 inputSchema 双写存在短暂不一致窗口（同一 commitGraph 提交内原子更新，实际无窗口）。
- `run_workflow` 异步化后 AI 拿不到即时结果，靠 get_workflow_run 补——工具数量 +1，描述教其节制轮询。
