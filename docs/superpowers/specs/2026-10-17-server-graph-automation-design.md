# 天枢服务端二期：graph/编排/自动化触发无头化设计

- 日期：2026-10-17
- 状态：已与用户对齐（移植策略 C 混合 / 定时触发含；待审阅）
- 前置：`2026-10-16-tianshu-server-design.md`（§11 二期首项）、`2026-10-17-shared-core-refactor-design.md`（共享包管道与巡检机制）
- 参照：mirror `electron/domains/ai/orchestration/`（graph-executor 4096 行等 15 文件）与 `automation/`（scheduler 333 行 + runner 等骨架）

## 1. 背景与目标

一期收缩掉的服务端编排能力（当时 graph-executor 131K 移植风险高）现在落地。调研更新了可行性判断：graph-executor 的 Electron 耦合仅 `BrowserWindow`×3 + `Notification`（通知类副作用，注入化即可），核心执行链无头可行；blocks/error-classify 已在 `@tianshu/core` 单份，chat-runner 管道已就绪（automation 的 prompt 分支依赖它）。

**目标**：tianshu-server 承载 graph 定义管理、run 触发（手动/webhook/定时）、运行状态流；控制端「服务端页」新增编排区遥控。
**非目标（后续批）**：graph 编辑器远程化（控制端仅列表/触发/状态，定义编辑仍在本地桌面端）；被控桌面端的 graph 触发（与 ui-drive/工具桥关联）；向量库能力升级（仅平移 vectorChunk 语义）。

## 2. 总体架构

```
控制端「服务端页·编排区」──graph/automation 端点──▶ tianshu-server
外部系统 ──POST /webhook/<token>──────────────────▶ tianshu-server
                                                    ├ GraphController（CRUD/run/abort）
                                                    ├ AutomationController（CRUD/runNow）
                                                    ├ WebhookController（@Public，token 派发）
                                                    ├ AutomationScheduler（30s tick，无人值守）
                                                    └ graph-executor 副本（重 IO）
                                                         ├ @tianshu/core（compiler/prompt/schedule/runChatStream…）
                                                         ├ @tianshu/protocol（graph.schema 契约类型）
                                                         └ db-client/vector-store/automation-runner 副本 + drift manifest
```

## 3. 移植策略 C 落地清单

### 3.1 进 `@tianshu/core`（纯逻辑，mirror 为源，原位 re-export）

| mirror 文件 | 说明 |
|---|---|
| `orchestration/graph-compiler.ts` | 图定义 → StateGraph 编译（纯逻辑） |
| `orchestration/graph-prompt.ts` | 节点提示渲染（renderNodePrompt，纯函数） |
| `automation/schedule.ts` | `computeNextRun` 调度决策纯函数 |

### 3.2 进 `@tianshu/protocol`（线上契约类型）

`src-react/domains/ai/orchestration/api/graph.schema` 的图定义/节点/边类型——graph 定义 JSON 是控制协议载荷（控制端保存到被控端），归协议包；mirror 原位 re-export。

### 3.3 server 副本 + drift manifest 入册（重 IO / 进程耦合）

| mirror 文件 | 无头化改造点 |
|---|---|
| `orchestration/graph-executor.ts`（4096 行） | `BrowserWindow`×3+`Notification` → 注入回调（默认 no-op，UI 关注事件经 EventBus）；prisma/db-client 指向 server 自有 |
| `orchestration/db-client.ts`/`vector-store.ts`/`graph-inflight.ts` | 直摘（指向 server Prisma） |
| `orchestration/graph.repo.ts`/`graph-templates.ts` | 直摘（templates 可选） |
| `automation/automation-runner.ts` | graph 分流 → server executor 副本；prompt 分流 → server chat-runner（已就绪）；`runChatStream` 引用改包 |
| `automation/automation-scheduler.ts` | `BrowserWindow` 推送 → EventBus；30s tick/setInterval 平移；启动即跑（NestJS onModuleInit/lifecycle） |
| `automation/automation.repo.ts`/`automation-inflight.ts`/`automation-stat*.ts` | 直摘（事件总线 → EventBus） |

### 3.4 不移植（本轮明确排除）

webhook-server.ts（mirror 桌面端被控场景继续自用；无头端 webhook 由 NestJS controller 原生实现）、create-workflow/workflow-bundle/doc-extract/acs3-sign（工作流创建器等周边，按需后续）、orchestration/langchain-model-factory 与 langchain-tool-adapter（server 已有副本，已入 manifest——executor 副本消费现有副本）。

## 4. 控制协议扩展

### 4.1 端点（POST 风格，沿用统一包装）

| 端点 | 入参 | 语义 |
|---|---|---|
| `graph/query` / `graph/save` / `graph/delete` | QueryFilter / 全量定义 JSON | 图定义管理（save 为全量 upsert） |
| `graph/run` | `{graphId, inputs?}` | → `{runId}`，状态经事件 |
| `graph/runAbort` | `{runId}` | 中止 |
| `automation/query` / `automation/save` / `automation/delete` | 同左 | 自动化任务管理（含 schedule/catchUp/retry/accessMode 字段） |
| `automation/runNow` | `{taskId}` | 手动触发（不消耗调度字段，mirror 语义） |

### 4.2 事件与 capability

- 新事件：`graph.run.updated {runId, graphId, state: queued|running|succeeded|failed|aborted, output?, error?, progress?}`（run 表状态机为准）
- `GET /info` capabilities 增 `"graph"`（编排+自动化+webhook+定时归并为单一 graph 能力域，控制端据此渲染编排区）

### 4.3 webhook（无头端）

NestJS `@Public` controller：`POST /webhook/:token`，语义对齐 mirror webhook-server（每图随机 token、同步挂起 120s 上限 / 异步 202+jobId 轮询、响应模板 `{{nodes.x.output}}`/`{{input.y}}`、自定义状态码）；token 存 server option 表（同 mirror 键位语义）。`GET /webhook/:token/jobs/:id` 轮询。

## 5. 数据模型

Prisma 摘表（逐字段以 mirror schema 为准）：`graphDefinition`、`automationTask`、`automationRun`、`automationStat`、`vectorChunk`。userId 关联 server 自有 user。

## 6. 无人值守权限语义

automationTask.accessMode（mirror 语义）平移：无人值守任务的工具权限与 config `chat.allowDangerousTools` 联动——高危工具在无人值守 run 中默认拒绝（chunk 记录拒绝原因），显式放行走 config。与一期偏离项 2 同源同治。

## 7. 控制端（mirror 增量）

- IPC/白名单：`server:graph*`/`server:automation*` 透传（复用连接注册表与 Transport，零新传输层）
- 「服务端页」新增**编排区**：graph 列表（只读定义摘要+触发按钮+run 状态流）+ automation 任务列表（启停/runNow/下次运行时间）；run 状态经现有 `server:chunk` 式事件通道（`server:event` 二次桥）
- i18n 双语；图定义编辑不做（本地编辑器继续用，远程保存留后续）

## 8. 测试策略

- tianshu-server（Jest）：graph CRUD、run 触发-状态机事件序列（fake model 注入）、scheduler tick 决策（computeNextRun 已在包内随 mirror 用例守护 + server 侧时序用例）、webhook 同步/异步路径、无人值守权限拒绝路径
- mirror（Vitest）：编排区 UI（mock IPC）、graph.schema 类型经协议包 re-export 等价、executor/runner 副本与 mirror 同构性交给 drift manifest
- E2E：直连链路跑一个两节点 graph（真模型）+ 一个定时任务到期触发（tick 可缩短配置）+ webhook 调用往返

## 9. 部署

无新部署形态（沿用 file: 包消费与 sync:core 流程）；drift manifest 新增 3.3 表全部对（首跑固化基线）。

## 10. 假设与偏离

1. 控制端不远程编辑图定义（MVP 只读+触发）——编辑器远程化列后续。
2. `graph` 单 capability 合并四个触发域（编排/自动化/webhook/定时）——若控制端 UI 需要细分再拆。
3. mirror 侧编排/自动化域代码零改动（除 3.1/3.2 原位 re-export 改造，同共享 core 重构模式）。
4. scheduler 在 server 常驻（无头端永跑）；多实例部署的调度互斥沿用进程级 inflight（跨进程锁不做，单实例部署假设）。
5. vectorChunk 平移不做能力升级（embedding 模型配置沿用 mirror 语义）。
