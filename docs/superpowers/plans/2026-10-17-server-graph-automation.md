# 服务端 graph/编排/自动化无头化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** tianshu-server 承载 graph 定义管理、run 触发（手动/webhook/定时）与状态流，控制端服务端页新增编排区遥控；纯逻辑进共享包（策略 C），重 IO 走 server 副本 + drift manifest。

**Architecture:** `@tianshu/protocol` 增 graph 契约类型、`@tianshu/core` 增 compiler/prompt/schedule 纯逻辑（mirror 原位 re-export）；server 摘取 executor/runner/scheduler 副本（Electron 副作用注入化）+ NestJS controllers（graph/automation/webhook）+ 30s tick 调度器；capability 合并 `"graph"`。

**Tech Stack:** 既有管道（CJS 双包/file: 消费/四处 alias/check:drift/Jest+Vitest）。

**Spec:** `docs/superpowers/specs/2026-10-17-server-graph-automation-design.md`

## Global Constraints

- 铁律不触碰：mirror 根 package.json dependencies/external 零增删；包消费沿用 alias（mirror）/file:（server）与 `sync:core` 流程（自带双包 build）。
- mirror 侧编排/自动化域代码零逻辑改动（仅 3.1/3.2 的原位 re-export 改造，同共享 core 模式：原导出名不变、老 import 链零破坏）。
- server 副本改造的授权面：Electron 符号注入化（默认 no-op/EventBus）、prisma 指向 server 自有、`@tianshu/*` 包引用、事件出口 EventBus 化——**除此之外不得改逻辑**，改造点在文件头注释登记。
- 无人值守权限：accessMode 高危默认拒绝（chunk 记录拒绝原因），联动 config `chat.allowDangerousTools`。
- 双仓路径与风格、每任务开工哨兵（git log/status 无外来重叠改动）、git add 精确——同前一计划规程。
- 测试基线：mirror `npx vitest run`（现 3603+）+ `npm run typecheck`（含 witness 双链）+ `npm run check:drift`；server `npm test`（现 231）。改动前跑基线留档。

---

### Task 1: graph 契约类型入协议包

**Files:**
- Create: `packages/tianshu-protocol/src/graph-contract.ts`（自 mirror `src-react/domains/ai/orchestration/api/graph.schema` 收编类型；纯类型，运行时不收）
- Modify: `packages/tianshu-protocol/src/index.ts`（聚合导出）、mirror `src-react/.../graph.schema`（原位 re-export，原导出名不变）
- Test: `tests/ai/core-package.test.ts` 补 graph 契约类型 re-export 等价断言（沿用 identity 模式）

**Interfaces:**
- Produces: `@tianshu/protocol` 导出 GraphDefinition/GraphNode/GraphEdge 等（以 graph.schema 实际导出面为准全量收编）。

**Steps:** 哨兵+基线 → 失败测试先写（import 自包，断言老路径 re-export 同源）→ 收编+re-export → mirror vitest+typecheck 绿 → 包 build → server `npm run sync:core` 后 server 测试绿 → Commit 两仓（mirror `feat(protocol): graph 契约类型收编`；server 仅 lock 变化则不 commit）

### Task 2: 编排纯逻辑入核心包

**Files:**
- Create: `packages/tianshu-core/src/graph-compiler.ts`、`graph-prompt.ts`、`schedule.ts`（自 mirror `orchestration/{graph-compiler,graph-prompt}` 与 `automation/schedule` 物理搬移；包内依赖仅协议包/第三方/包内相对）
- Modify: mirror 三文件原位 re-export；`packages/tianshu-core/src/index.ts` 导出
- Test: mirror 既有编排纯逻辑用例（如有）不迁移照跑；无则补 `tests/ai/core-package.test.ts` 行为抽查（renderNodePrompt 模板替换、computeNextRun 边界）

**Interfaces:**
- Produces: `compileGraph`/`renderNodePrompt`/`computeNextRun` 等与 mirror 同名导出（以源文件实际导出面为准）。

**Steps:** 哨兵+基线 → 读源核闭包（不纯则 no-go 报告裁定）→ 搬移+re-export → mirror 全量绿 → 包 build+server sync → server 绿 → Commit（mirror `feat(core): 编排纯逻辑三件入包`）

### Task 3: Prisma 摘表与仓储副本

**Files:**
- Modify: server `prisma/schema.prisma`（+graphDefinition/automationTask/automationRun/automationStat/vectorChunk，逐字段以 mirror 为准）
- Create: server `src/modules/graph/graph.repository.ts`、`src/modules/automation/automation.repository.ts`（自 mirror `orchestration/graph.repo.ts`、`automation/automation.repo.ts` 摘取，prisma 指 server 自有；userId 关联 server user）
- Test: `test/modules/graph.spec.ts`（CRUD 闭环）

**Steps:** 哨兵+基线 → 摘表 `prisma:generate`+`db push` → 仓储副本+头注释登记 → CRUD 用例先红后绿 → Commit（server `feat(graph): 摘表与仓储副本`）

### Task 4: graph-executor 副本

**Files:**
- Create: server `src/core/graph/graph-executor.ts`、`graph-inflight.ts`、`db-client.ts`、`vector-store.ts`、`model-factory.ts`（消费既有 `src/core/provider/model-factory` 或直摘——按现状最小路径）、`graph-templates.ts`（可选，executor 依赖才摘）
- Modify: executor 副本内——`BrowserWindow`×3+`Notification` → 注入 `sideEffects?` 参数（默认 no-op；UI 关注点经 EventBus `graph.run.updated`）；`../chat/*`→`@tianshu/core`；`../../security/*`→server 既有副本；`src-react graph.schema`→`@tianshu/protocol`
- Test: `test/core/graph-executor.spec.ts`（fake model 跑两节点图：开始/节点完成/终态事件序列与 run 表状态机）

**Steps:** 哨兵+基线 → 摘取+改造点登记 → executor 用例先红后绿 → server 全量绿 → drift manifest 预登记（本对先记 note，T9 固化）→ Commit（server `feat(graph): executor 副本（Electron 副作用注入化）`）

### Task 5: automation-runner/scheduler 副本

**Files:**
- Create: server `src/modules/automation/automation-runner.ts`、`automation-scheduler.ts`、`automation-inflight.ts`、`automation-stat.ts`（EventBus 化：`AUTOMATION_CHANGED` → `graph.run.updated` 语义或独立 automation 事件——以 run 表状态机为单一事件源）
- Modify: scheduler——`BrowserWindow` 推送删、NestJS lifecycle（module `onModuleInit` 启 tick / `onModuleDestroy` 停+abort 全部在途）、tick 间隔可配（config `tianshu.automation.tickMs` 默认 30_000，E2E 用）
- Test: `test/modules/automation-scheduler.spec.ts`（tickMs=50 快进：到期触发/错过 catchUp/互斥 inflight/手动 runNow 不耗调度字段）；prompt 分支用 fake model 断言建会话+落 message；无人值守高危拒绝路径

**Steps:** 哨兵+基线 → 摘取+改造 → 用例先红后绿 → server 全量绿 → Commit（server `feat(automation): runner/scheduler 副本（EventBus+可配 tick）`）

### Task 6: graph/automation 端点与事件

**Files:**
- Create: server `src/modules/graph/graph.controller.ts`、`src/modules/automation/automation.controller.ts`（§4.1 九端点）、`dto/`；`graph.module.ts`/`automation.module.ts`
- Modify: `src/protocol`（经包）`CAPABILITIES` 增 `"graph"`——**注意常量在协议包**：改 `packages/tianshu/protocol/src/server-event.ts`（mirror re-export 零感）+ 包 build+server sync；`EventBus` publish `graph.run.updated`
- Test: `test/modules/graph-api.spec.ts`（九端点 contract：202/包装/权限 401；run→事件序列）

**Steps:** 哨兵+基线 → 端点+事件 → 用例先红后绿（含 capability 断言 `/info` 含 graph）→ mirror+server 双绿 → Commits（mirror `feat(protocol): capability graph`；server `feat(graph): 端点与事件`）

### Task 7: webhook controller

**Files:**
- Create: server `src/modules/webhook/webhook.controller.ts`（`@Public`：`POST /webhook/:token` 同步挂起 120s 上限/异步 202+jobId、`GET /webhook/:token/jobs/:id`；token 存 option 表 `webhook:<graphId>` JSON，兼容读旧裸 token——语义逐条对齐 mirror `orchestration/webhook-server.ts` 头注释）、`webhook.service.ts`（模板渲染复用包内 renderNodePrompt）、`webhook.module.ts`
- Test: `test/modules/webhook.spec.ts`（同步模板渲染/异步 job 轮询/404 token/120s 超时用假 timer 或缩短配置）

**Steps:** 哨兵+基线 → controller+service → 用例先红后绿 → server 全量绿 → Commit（server `feat(webhook): 无头端 webhook 端点`）

### Task 8: 控制端编排区

**Files:**
- Modify: mirror `electron/domains/server/ipc.ts`+`connections.ts`（透传 9 端点+`graph.run.updated` 事件桥 `server:event`）、`electron/commons/ipc-channels.ts`（INVOKE `server:graph*`/`server:automation*`）
- Create: `src-react/domains/ai/server/api/graph.api.ts`、`components/GraphPanel.tsx`（graph 列表+触发+run 状态流）、`components/AutomationPanel.tsx`（任务列表+启停+runNow+下次运行时间）
- Modify: `ServerConsoleView` 编排区挂载、i18n `ai.json` 双语（`server:graph.*`/`server:automation.*` 全量）
- Test: `tests/ai/server/graph-panel.test.tsx`（mock IPC：列表渲染/触发调用/run 事件上屏/无 graph capability 时编排区隐藏）

**Steps:** 哨兵+基线 → IPC+api → 面板组件+i18n（主题色/弹层规范遵守）→ 用例先红后绿 → mirror 全量绿 → Commit（mirror `feat(server): 编排区遥控（graph+automation）`）

### Task 9: 巡检入册 + E2E + 终审

**Files:**
- Modify: `packages/tianshu-core/scripts/drift-manifest.json`（+T4/T5 全部副本对，首跑 `--rebase` 固化）
- Create: `tests/ai/server/e2e-graph-smoke.ts`（直连链路：建两节点 graph（真模型）→ run → 事件序列到 succeeded；定时任务 tickMs=200 到期触发；webhook POST 往返）+ package.json scripts `test:e2e:graph`
- 终审：controller 派 final reviewer（双仓本计划全部提交 + deferred triage）

**Steps:** 哨兵 → manifest 入册 rebase（基线数记录 ledger）→ E2E 跑通（无真模型则 SKIP 如实记录）→ 文档（server README 编排节一句话 + CLAUDE.md 若需）→ final review 与修复轮

---

## Self-Review 结论

- Spec 覆盖：§3.1/3.2（T1/T2）、§3.3（T4/T5）、§3.4 排除（未列任务=不做）、§4（T6/T7）、§5（T3）、§6（T5 测试）、§7（T8）、§8（各任务+E2E）、§9（T9 manifest）。假设 1/2/4/5 由任务边界承载。
- 类型一致性：`graph.run.updated` payload 与 state 枚举在 T4/T6/T8 一致引用协议包（事件类型若包内已有 ServerEvent 联合——T6 扩展联合成员，双仓同构经包单份化天然一致）。
- 占位符扫描：副本改造「以现状最小路径」「以实际导出面为准」为带准绳的查证指令，非占位。
