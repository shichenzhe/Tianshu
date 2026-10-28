# 图执行留痕去会话化设计（对齐 Coze 运行记录体系）

- 日期：2026-10-28
- 状态：已批准（用户裁定：不污染会话列表，执行过程由工作流自有页面承载，参照 Coze）
- 影响面：`electron/domains/ai/orchestration/graph-executor.ts`（双份）、`prisma/schema.prisma`、`electron/domains/ai/agent/tool-gate.ts`、orchestration 前端、apps/tianshu-server 同批

## 1. 背景与问题

图执行（试运行 / 定时任务 / webhook 触发共用 `runGraph`）无条件创建聊天会话（`createGraphSession`，mode=agent、标题=图名），每个节点以【节点名】前缀消息对落 message 表——即使图内没有 LLM 节点。会话列表被这些执行留痕会话污染。

用户裁定：不要污染会话列表；要看执行过程应走工作流自己的执行详情页面。参照 Coze：工作流运行记录独立成体系（节点级输入/输出/耗时/token 的调试详情），会话只属于对话型交互。Dify 同构佐证：Workflow 应用=运行日志（无会话），Chatflow/Chatbot=会话（工作流过程是对话的附属）。

### 探索确认的关键事实

- 运行历史前端三分支已就位（`RunHistoryPanel`）：graph run → `GraphRunHistoryDialog`（吃 `graphTrace`，**不依赖会话**）；「查看会话」仅 prompt 型 run 消费。前端主体无需改动。
- LLM 节点 agent（`createReactAgent`）轮次只在内存 state 流转，**从不落 message 表**——message 表里图运行只有节点级消息对。去会话零信息损失。
- `automationRun.graphTrace` 已存节点轨迹 JSON，但输出仅 200 字预览（`outputPreview`）；完整输入/输出目前只在消息对里。
- `AgentStreamOptions.sessionId`（`agent/tool-gate.ts`）为必填 number，消费点：工具 ctx 透传（`automation-tool.ts` 不消费它，实际依赖 workspaceId/modelId）、安全事件 payload、open_browser 面板联动 payload（图执行场景无面板）。
- core 纯函数层（run-chat-stream / agent-chunk-emitter / monitor-events）sessionId 均可空或零消费。
- 协议 `AutomationRunRecord.sessionId?: number`（`tianshu-protocol/graph-contract.ts`）已可选，置 null 无破坏；移动端 runPage 本就剔除 graphTrace。
- `graph-executor.ts` 为 drift 双份基线文件（mirror ↔ `apps/tianshu-server/src/core/graph/graph-executor.ts`），改动须双改并复核容差。

## 2. 架构

图执行留痕三层（Coze 同构）：

```
automationRun   run 摘要（状态/耗时/tokens/触发方式/error）        —— 已有，不动
 ├─ graphRunNode 节点级完整执行详情（新表，本次核心交付）
 └─ graphTrace  轻量预览 JSON（200 字 outputPreview 等）          —— 已有，保留作列表/弹窗快览
```

会话列表回归纯对话语义：手动聊天 + prompt 型定时任务。图执行在任何触发方式下都不再产生会话。

## 3. 数据层

### 3.1 新表 `graphRunNode`

| 字段 | 类型 | 说明 |
|---|---|---|
| id | Int PK | |
| runId | Int | → automationRun.id，联合唯一 |
| nodeId | String | 节点 id（与 trace 条目一一对应） |
| nodeName | String? | 冗余节点名（run 后图可改名，留历史名） |
| status | String | success / failed / skipped |
| input | String? | 渲染后完整输入正文（现消息对 user 侧内容，不含【节点名】前缀），截 64KB |
| output | String? | 完整输出正文，截 64KB |
| errorJson | String? | { code, message, toolName?, detail }，同 trace error 结构 |
| toolCallsJson | String? | 工具调用摘要数组，同 trace |
| promptTokens / completionTokens | Int? | LLM 节点 tokens |
| durationMs | Int | |
| startedAt | — | 执行开始时间（形态与 trace 条目同构） |
| outputImage | String? | imageGen 产物相对数据根路径 |
| errorOutput | String? | 循环节点死信（onItemError=continue） |
| fallbackJson | String? | 降级继续标记 { code, message } |

- 唯一索引 `(runId, nodeId)`；循环节点聚合一行（与 trace 条目语义一致）。
- 截断上限 64KB/字段对齐 code 节点 `CODE_OUTPUT_LIMIT`。
- 建表方式：`ensureGraphRunNodeTable` 启动幂等补建（artifact 表 H7a 先例），**不动 v1 快照指纹**。
- 删 run 时级联删节点行（在途删图先删 run 的路径同步补）。

### 3.2 session 解耦（执行器改造）

- 删除 `createGraphSession`；`runGraph` 不再建会话，`NodeContext.sessionId` 字段移除。
- `writeNodeMessages` / `writeNodeFailure` 的 message 落库改为 graphRunNode 落库（成功/失败同径，skipped 不落行——与 trace 补齐逻辑对齐，skipped 仍仅在 trace）。
- `automationRun.sessionId` 列保留（prompt 型任务仍写），graph run 收尾写 null。
- `AgentStreamOptions.sessionId` 放宽为 `number | null`，图执行装配（`buildAgentContext`）传 null；chat 交互通道不变。已核实的容忍点：工具 ctx 透传、安全事件、面板联动、monitor-events（core 类型已 `number | null`）。
- `recordGraphMonitorEvents` sessionId 传 null。
- `testSingleNode`：不建临时会话、不落消息对，结果仅返回调用面板（对齐 Coze 即席试跑，不留历史）。

### 3.3 历史遗留清理（启动幂等）

`automationRun` 中 `graphId 非空 && sessionId 非空` 的行 → 删除对应 session 及其 message，run.sessionId 置 null。幂等：清后判据不再命中，二跑无副作用。与 ensureGraphRunNodeTable 同一启动序列执行。

## 4. 前端

- `GraphRunTraceView` 行展开升级：输出区从 `outputPreview` 改为下钻展示 graphRunNode 全文（新增节点详情查询：按 runId 拉取节点行，展开行时按需查询）。
- `RunHistoryPanel` / `RunHistoryView` 三分支零改动：graph run 行 sessionId=null 后「查看会话」入口自然消失（存量清理后同样如此）；头注释中「executor 落库无 sessionId」的表述与实现重新对齐。
- 试运行画布节点高亮（node-status 推送）不动。
- i18n：新增文案 key 双语同补。

## 5. 双份与协议

- `apps/tianshu-server/src/core/graph/graph-executor.ts` 同批同步双改；drift 容差提前核算（保留策略批教训），基线变化走 `--rebase` 人工复核。
- 协议 `AutomationRunRecord.sessionId` 保持可选；graph run 置 null，移动端无感。
- graphRunNode 不透出移动端（runPage 维持现状，桌面独占详情）。
- server-face runPage 同构产出路径同步核对。

## 6. 测试

- executor 单测：图执行全程零 session/message 写入；graphRunNode 落行覆盖 success / failed / skipped（不落行断言）/ 循环死信 / 降级 fallback / imageGen outputImage；trace 结构与预览语义不回归。
- 清理幂等测：删 session+message、run.sessionId 置 null、二跑无副作用；prompt 型 run 的 session 不被误删。
- `AgentStreamOptions.sessionId: null` 路径测：图内 agent 调工具（create_automation_task 等）行为不回归。
- 双端同步与 drift 容差核算；vitest 替身法沿用（Electron ABI 真库不可行）。

## 7. 风险与边界

- graphRunNode 单行上限 64KB×2 字段 + 图节点数有限，膨胀可控；列表查询不 join 节点表，列表性能不受影响。
- 落库点收在与现消息对同位置（节点收口），不新增锁竞争。
- 存量 graph run 的 trace 预览仍在（graphTrace 保留），老 run 无节点全文属预期（与现状 200 字预览同视）。

## 8. 明确不做

- prompt 型定时任务的会话归属不动（会话是它的产物本体）。
- 移动端不新增执行详情视图。
- webhook / 触发器语义、监控面板结构不变。
- agent 内部轮次落库（现状本就不落，维持）。
