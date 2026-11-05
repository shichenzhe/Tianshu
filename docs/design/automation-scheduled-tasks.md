# 自动化与定时任务技术方案

> 调研基线：main 分支 995bf652（2026-11-05）。
> 桌面端路径基准 `apps/tianshu-desktop/`（`electron/` 主进程、`src-react/` 渲染进程），server 端基准 `apps/tianshu-server/`。
> 调度纯函数与配置 schema 已物理收编 `packages/tianshu-core`（GA-T2 批），协议类型单源 `packages/tianshu-protocol`。

## 1. 模块定位与总览

自动化（automation）是天枢的**无人值守执行层**：把两种执行体交给多类触发源驱动，把结果落成可回看的运行记录与健康度统计。与工作流模块的关系：`targetKind=graph` 的自动化任务就是「给图挂触发器」——图执行内核（executeGraphRun）见姊妹文档 `docs/design/workflow-graphs.md`，本文只覆盖调度与任务面。

**执行体两类（产品口径的「定时任务两类」）**：

- `targetKind = "prompt"`：纯提示词定时执行——建 session → 引用注入 → 静默 runChatStream 一轮 agent 对话 → message 落库（聊天页可回看）
- `targetKind = "graph"`：挂 graphDefinition.id 执行编排图——run 行由 executor 落库带 graphId/graphTrace

> 「定时任务两类」的准确出处：2026-10-27 移动端二裁「**定时任务两类都要，现状不达标**——prompt 型移动端完全没做（/automation/new 强制选图 needGraph 只支持 graph 型）」。它指**执行体两类**（prompt/graph），不是 cron/间隔两类，也不是定时/webhook 两类。落地状态：移动端 CRUD+运行历史批已兑现两类双模式表单（`apps/tianshu-mobile/src/app/automation/new.tsx`）。

**触发源七值**（automationRun.triggerType 全集，前端 `automation.api.ts` TriggerType）：`schedule`（定时到点）、`catchUp`（进程重启前错过的补跑）、`retry`（失败重试扫描）、`manual`（手动 runNow，不消耗调度）、`event`（事件链）、`subflow`（图内子工作流）、`webhook`（图入站 HTTP 触发）。任务行层面 scheduleJson（定时）与 eventJson（事件）**可并存**——一个任务既定时又被链式触发。

前端入口（`src-react/routes/index.tsx` 255/279 行注册）：`/module/ai/automation`（`views/AutomationView.tsx` 主视图）、`/module/ai/automation/task/:id`（`views/TaskDetailView.tsx` 任务详情）、模板市场 `views/TemplateMarketView.tsx`、运行历史 `views/RunHistoryView.tsx`。

**触发源 × 执行体矩阵**（哪个触发源能驱动哪种执行体）：

| 触发源 | prompt 任务 | graph 任务 | 图试运行（无任务） |
|---|---|---|---|
| schedule / catchUp / retry | 是（scheduler.launch） | 是（executeGraphTask 分流） | — |
| manual（runNow / runTest） | 是 | 是 | 是（orchestration:runTest / graph/run） |
| event（appStarted / taskFinished 链） | 是 | 是（eventJson 目标可为图） | 间接（试运行收尾发 taskFinished(targetType=graph)） |
| webhook（入站 HTTP） | **否**（无任务级 token） | 是（直接挂图，不建任务行） | 是（同一机制） |
| subflow（图内子工作流） | — | — | 是（runGraphToResult 复用内核） |

桌面后端 `electron/domains/ai/automation/` 12 文件分工：

| 文件 | 职责 |
|---|---|
| `automation-scheduler.ts`（335 行） | 30s tick 调度器：决策树 + 重试扫描 + 启动恢复 |
| `automation-runner.ts`（563 行） | 执行器 executeTask/advanceTask/权限分流 |
| `schedule.ts` | re-export 兼容层 → `@tianshu/core`（GA-T2 搬入） |
| `automation.repo.ts` | CRUD + IPC 通道注册 |
| `automation-event-bus.ts` | 事件链（appStarted/taskFinished 匹配发布） |
| `automation-change-bus.ts` | 变更扇出（全窗广播 + face 桥订阅） |
| `automation-inflight.ts` | 进程级在途互斥（taskId → AbortController） |
| `automation-stats.ts` | 健康度总览纯函数 computeStats |
| `automation-stat.ts` | 创建行为埋点 recordAutomationEvent |
| `automation-retention.ts` | 运行历史保留策略（双限分级 + trace 降级） |
| `automation-templates.ts` | 内置模板纯数据 |
| `resolve-attachments.ts` | prompt 引用解析注入（文件/技能） |

## 2. 数据模型

schema 单源 `apps/tianshu-desktop/prisma/schema.prisma`；server 侧 PascalCase 模型（`AutomationTask/AutomationRun/AutomationStat`）`@@map` 同名物理表（`apps/tianshu-server/prisma/schema.prisma` 260/293/344 行，注释明言「逐字段复制自 mirror」）。

### 2.1 automationTask（任务）

| 字段 | 语义 |
|---|---|
| `prompt` / `workspaceId` / `modelId` / `temperature` | prompt 型执行体四件（graph 任务 modelId=0 占位提交） |
| `targetKind` | `"prompt" \| "graph"`；`graphId` 为 graph 型必填（引用 graphDefinition.id） |
| `scheduleJson` / `scheduleText` | ScheduleConfig JSON 序列 + 人读文案（列表行直显，编辑器 JSON.parse 还原） |
| `startAt` / `endAt` | 有效期窗口：startAt 未到 → 决策树 noop；endAt 已过 → expire |
| `missedPolicy` | `"skip"`（缺省：落一条 skipped run 后照常推进）\| `"catchUpOnce"`（进程重启前错过的触发补跑） |
| `catchUpLimit` | 错过补跑上限，缺省 1（=只补一次，批3A）；catchUpOnce 时生效，1-10 clamp（dto/表单/clamp 三面同口径，防补跑风暴）——多轮错过按触发点依次补，预算耗尽 advance 到未来触发点 |
| `accessMode` | `"default"`（只读执行：写类审批被拒不中断，agent 收拒绝反馈继续）\| `"full"`（完全访问+审批放行） |
| `enabled` / `status` / `statusNote` | status 三态：`active`（唯一参与调度的状态）/ `error`（系统级失败停调度，enabled 同置 false；重新启用时 repo toggleTask 置回 active 清 statusNote）/ `expired`（once 成功、endAt 过、once 重试耗尽收尾） |
| `lastRunAt` / `nextRunAt` | 调度相位。interval 模式以 lastRunAt 为相位基准（见 §3.1）；决策树核心比较字段 |
| `eventJson` | EventTriggerConfig JSON（appStarted / taskFinished×on），null=未配置事件触发 |
| `projectId` / `userId` / `templateSlug` | NULL=全局任务（子系统 E：项目任务会话归属 projectId + 项目 systemPrompt 注入）/ 多用户隔离 / 来源模板 |

索引：`@@index([enabled])`、`[projectId]`、`[userId]`。

### 2.2 automationRun（运行记录，图运行共用）

| 字段 | 语义 |
|---|---|
| `taskId Int?` | null = 图试运行（taskName 取图名） |
| `sessionId` | **仅 prompt 型**关联会话——运行记录「查看会话」跳回聊天的依据；graph 型 2026-10-28 去会话化后不再写（列保留） |
| `attempt` | 默认 1；retry 递增，上限 3（MAX_ATTEMPT） |
| `triggerType` | 七值见 §1 |
| `status` | `running \| success \| failed \| skipped`（skipped 三来源：missedPolicy=skip、事件链深超限 chain_depth_exceeded、事件触发撞在途 event_skipped_running） |
| `durationMs` / `promptTokens` / `completionTokens` | 图运行 tokens 按 trace 聚合；prompt 型从 usage block 提取 |
| `graphId` / `graphTrace` | 图运行归属 + 节点级轨迹 JSON（保留策略超 3 天置空降级） |
| `error` | 截 500 字；图运行聚合形 `node:<id> <code>: <msg>` |
| `startedAt` / `finishedAt` | startedAt 有索引（保留裁剪/重试冷却判定） |

### 2.3 automationStat（事件埋点表——不是运行统计）

仅三列 `event` / `detail` / `createdAt`（+createdAt 索引）。写入方 `automation-stat.ts` 的 `recordAutomationEvent(prisma, "create", detail)`：detail JSON `{mode, kind, hasEndAt, tabSwitchCount}`——PRD《执行频率》§5 三项**创建行为**统计（fire-and-forget、吞错、prisma 缺席静默）。**运行健康度统计是即时聚合不落表**：IPC `automation:stats` 由 `automation-stats.ts` 的 `computeStats()` 现算（§3.5）。索引由 `ensureEventStatMaintenance` 启动幂等补建（不走 v1 快照，保留期裁剪用）。

**每日 rollup 行（批3A §6-6 已落地）**：`event="dailyRollup"` 新 bucket 类型（免 schema 迁移），`detail` = `{date, byUser: {"<userId>": {total, success, failed, skipped}}}` JSON。写方 `automation-stat.ts maybeRollupAutomationStats`（调度器 tick 收尾 1h 节流、吞错）：窗口 7 天重算、`mergeRollupDetail` 逐用户单调合并（保留策略先于出窗裁掉 run 时重算缩水、旧桶保底防历史回退）、窗口外行冻结、零运行日不建行；聚合纯函数单源 `@tianshu/core/automation-rollup`。桌面端 `automation:stats` 读取当前用户桶：过去趋势日单调补全（今日恒用即时聚合）——run 被裁剪后「上周成功率」仍可回溯。行随 automationStat 90 天保留期统一裁剪。

## 3. 核心技术方案

### 3.1 触发器类型与下次触发时间计算

**（A）定时调度 ScheduleConfig**——单源 `packages/tianshu-core/src/schedule-schema.ts`（zod discriminated union；桌面 `src-react/domains/ai/automation/api/schedule.schema.ts` 与 `electron/.../schedule.ts` 均 re-export 兼容）。两 mode 七 kind：

| mode | kind | 字段 |
|---|---|---|
| periodic | `once` | runAt（ISO datetime，过去时刻校验 timeInPast） |
| periodic | `daily` | time "HH:mm"（TIME_RE 校验） |
| periodic | `weekly` | weekdays 1-7（ISO：1=周一…7=周日）+ time |
| periodic | `biweekly` | anchorDate "YYYY-MM-DD" 锚点 + weekday + time |
| periodic | `monthly` | dayOfMonth 1-31 + time |
| periodic | `yearly` | month 1-12 + day + time |
| interval | — | value（正整数）+ unit `minute\|hour`（换算分钟，**下限 5 分钟** INTERVAL_MIN_MINUTES 防高频打爆）+ weekdays 可选限定 |

**不用 cron 表达式、不用 cron-parser 库**——`computeNextRun(config, from, lastRunAt?)` 纯函数（`packages/tianshu-core/src/schedule.ts`，date-fns，from 显式注入不依赖系统时钟可测）手写推进，语义细节（schema 头注释 §3）：

- 月末无该日（31 日遇 30 天月）跳过当月；2/29 非闰年回读校验不一致跳过该年（`nextPeriodic` yearly 分支）
- weekly 七日窗口扫描 `atTime > from && weekdays.includes(isoWeekday)`，全不中回落第 8 日同刻
- biweekly 用 `FORTNIGHT_MS` 毫秒常量推进相位（避免月末 DST 争议）：anchor 先回退到 from 之前最近双周点再前推，保证返回恒为未来时刻
- interval 相位累加 `do { next = addMinutes(next, step) } while (next <= from)`——**不堆积补跑**（休眠多轮只顺延到未来一个点）；相位基准 lastRunAt（无则 from）；落在未选星期顺延至下一允许日 00:00（相位基准同步重置）；weekdays 空数组视同不限制（防顺延循环死循环）

**（B）事件触发 EventTriggerConfig**——宿主 `@tianshu/core/graph-schema.ts` 尾部 `eventJsonSchema`（前后端共享校验）：`{source:"appStarted"}` 或 `{source:"taskFinished", targetType:"task"|"graph", targetId, on:"success"|"failed"|"any"}`。匹配纯函数 `matchEventTasks(tasks, event)`：坏 eventJson 行静默跳过；taskFinished 按 targetType/targetId/on 三级过滤，命中注入输入变量 `{outcome: "success"|"failed"}`（graph 任务的 inputs 变量，prompt 任务不消费）。

**（C）webhook 触发**（图专属，不挂任务行）——见 §4.4。

**（D）手动 manual**——`automation:runNow` / server `automation/runNow`（202 受理触发即返回），**不消耗调度字段**。

### 3.2 调度器：30s tick 决策树（桌面与 server 同构；均不用 @nestjs/schedule）

**桌面 `electron/domains/ai/automation/automation-scheduler.ts`**：

常量：`TICK_MS=30_000`、`MAX_ATTEMPT=3`、`MAX_CATCH_UP_LIMIT=10`；冷却序列单源 `@tianshu/core/automation-retry`（`nextRetryDelay`：60/180/540s 指数退避）；实例字段 `processStartTime = new Date()`。

启动序（`start(disabledTools?)`，Application.ts 102/144 行装配；disabledTools 为 SP6 裁定 2 的工具禁用闭包——类字段初始化早于 registerServices 建 securityService，故 start 时注入）：

1. `recoverInterruptedRuns()`：崩溃残留 running run 全置 `failed(interrupted)` + finishedAt（catch 兜底防启动期 DB 抖动产生 unhandled rejection）
2. `maybeTrimAutomationRuns(prisma)` 启动即裁一次保留策略（option 配置实时读，改配置无需重启）
3. `setInterval(tick, TICK_MS)`
4. `publishAutomationEvent({source:"appStarted"})`——启动即发的事件触发任务在本次发布中拉起

`stop()`：清定时器 + **abort inflight 全部在途**（Electron 退出时运行中任务收口 interrupted）。

**决策树 `decideTick(task, now, processStartTime): TickDecision`** 纯函数（可单测主体），六态判定顺序：

```
startAt 未到                    → noop
endAt 已过                      → expire（status→expired）
nextRunAt 为空                  → expire（once 已跑/无下个触发点，到期回收）
now < nextRunAt                 → noop
lastRunAt >= nextRunAt          → once 已跑过：isOnceSchedule ? expire : advance
到期（now >= nextRunAt）:
  nextRunAt < processStartTime  → missedPolicy === "catchUpOnce"
                                   ? (本进程已补跑次数 < catchUpLimit ? catchUp : advance)
                                 : skip
  否则                          → execute
```

tick 主循环（每 30s）：

- 只查 `enabled:true 且 status:"active"`（注释详述：不滤 status 会让 expire 分支每 30s 重写该行引发 updatedAt 抖动 + 全窗无谓广播；error 任务已被 enabled=false 滤掉，重新启用 toggle 置回 active——active+enabled 是唯一应参与调度的集合）
- `loadRunSnapshots()`（批3A 起）：automationRun 按 id 倒序取 **500 行**、`select` 取决策七列（taskId/status/attempt/finishedAt + error/triggerType/startedAt——graphTrace 单条可达数十 KB 不搬）聚合两份：per-task 最新 run Map + **本进程 catchUp 补跑计数**（triggerType="catchUp" 且 startedAt ≥ processStartTime 的行数，错过窗口补跑上限判定依据；上一进程的补跑不占本窗口预算）
- 在途任务（inflight.has）跳过决策——防重试运行中被过期快照误 expire/重复触发
- 重试预算集 `pickRetryTaskIds(latestRun, now, delay=0)`（delayMs=0：冷却期内同样不许 expire 抢跑）——expire 决策让路给待重试任务
- 决策执行 `applyDecision`：expire→update status；advance→nextRunAt=computeNextRun；skip→**落一条 skipped run 留痕** + 推进 nextRunAt；execute/catchUp→launch
- **重试扫描 `pickRetryTaskIds`**（批3A §6-4 已落地指数退避 + 分类可重试面）：最新 run `failed && attempt<3 && 冷却到期 && isRetryableRunError(error)` → `scanRetries()` 按独立查询取任务行（不复用调度快照——once 失败任务 nextRunAt 已推进仍需可重试）→ `launch(task, "retry", attempt+1)`。冷却按 attempt 指数退避（`nextRetryDelay`：1→60s、2→180s、3→540s）；可重试面按 classifyError 分类——RATE_LIMITED/TIMEOUT/NETWORK/UNKNOWN 等瞬时态重试，AUTH_FAILED/MODEL_NOT_FOUND/IMAGE_UNSUPPORTED 配置类不重试（重试无益；本机配置缺失三元组走 failRun 停调度先例），run.error 取码兼容图运行聚合前缀 `node:<id> CODE: msg`，未收录码/error 缺席默认可重试（保留既有行为）
- 变更聚合：本轮有任何决策变化才 `emitAutomationChanged()`（CRUD 批 taskId=0 列表级刷新信号）

**launch 互斥**：进程级 `automation-inflight.ts`（Map taskId→AbortController），**与 repo runNow 手动触发共享**——调度执行中连点播放直接拒发 `TASK_ALREADY_RUNNING`；fire 不 await（单次执行可达分钟级），收尾 `.then(publishAutomationEvent(taskFinishedEvent(task, outcome))).finally(inflight.delete + emitAutomationChanged(taskId))`。triggerType 不含 event：事件触发由 event-bus 直调 executeTask（chainDepth 防环在彼处），误经 launch 会以链深 1 重置防环。

**调度相位重放 replayAt（批3A §6-1 已落地）**：catchUp 决策 launch 携 `replayAt=task.nextRunAt`（正在补跑的错过触发点），错过窗口内的 retry 同样携带——advanceTask 以 replayAt 为基点推进 `lastRunAt/nextRunAt`（仿佛该次运行发生在错过的触发点），多轮错过窗口因此能按触发点依次补（上限 catchUpLimit），interval 相位与 periodic 触发点语义均不漂移；正常触发点 replayAt 缺省按 now 常规推进。missedPolicy=skip 与「补跑预算耗尽」都走 advance 跳到未来触发点（skip 另落一条 skipped run 留痕）。已知口径：补跑计数以 processStartTime 为窗（重启即新窗口）——**补跑收敛过程中重启应用可再获得一次完整预算**（catchUpLimit 计数清零），属可接受的运维面语义而非缺口。

**每日统计 rollup 挂点（批3A §6-6）**：tick 收尾 `maybeRollupAutomationStats(prisma)`（1h 节流、吞错——与保留裁剪同款 fire-and-forget 形态），见 §2.3。

**桌面休眠/关机场景**（如实记录，无显式处理）：

- 无 Electron `powerMonitor` 集成、无 suspend/resume 监听
- 睡眠：setInterval 冻结，唤醒后首个 tick 中 `now > nextRunAt` 且 `nextRunAt >= processStartTime`（进程未重启）→ 直接 **execute**——等效隐式补跑一次；interval 相位顺延不补轮次
- 关机/重启：processStartTime 更新，错过的触发走 missedPolicy 分叉（catchUpOnce 补一次 / skip 留痕跳过）

**server 副本 `apps/tianshu-server/src/modules/automation/automation-scheduler.ts`**（489 行，GA-T5 自 mirror 摘取「逐行保持 + 11 条改造点登记」）：

- BrowserWindow 推送 → `deps.publishAutomationChanged`（协议 `AutomationChangedPayload {taskId, enabled?, nextRunAt?}` 经 EventBusService 发 `automation.changed`；未注入不发——纯落库模式）
- Application 手动 start/stop → **NestJS lifecycle**：`onApplicationBootstrap` 启 tick / `onModuleDestroy` 停 + abort 全部在途（start/stop 公开面保留）
- `TICK_MS` 常量 → **可配 `config.yml tianshu.automation.tickMs`**（缺省 30_000，E2E/测试可缩短；deps.config 显式注入优先）
- prisma 单例 → 构造注入 PrismaService；`./schedule` → `@tianshu/core`
- 无人值守安全装配：launch 透传 safety（config `tianshu.chat.allowDangerousTools/deleteProtection` + dataRoot 联动）
- 装配点 `automation.module.ts`：scheduler/repo 两 deps 共享 `createAutomationEventBus` 单实例（EB 批 2026-10-27 接线：appStarted + launch/runNow 收官三发布点生效）；import GraphModule 保证 executor 运行时就位（模块依赖序）

### 3.3 执行链路（automation-runner.ts）

`executeTask(task, opts)` 头注释承诺：**所有异常吞掉落库，绝不向调度器抛出**；返回值仅测试断言（终态 run.status）。opts：triggerType/attempt/abort/dataSafety?/disabledTools?/inputs?（graph 任务输入变量：事件触发={outcome}，定时/手动=空对象）。

prompt 型主链（`streamAndRecord`）：

1. `executeTask` 先校验 workspace（缺失 → `failRun(workspace_missing)` 系统错误停调度）；targetKind=graph 分流 `executeGraphTask()`（图缺失=graph_missing 停调度；图停用=graph_disabled failed 不置 error——重新启用图后调度自然恢复；run 行由 executor 落库防双行）
2. model/provider 校验（`model_missing` 停调度）；项目任务读 `project.systemPrompt`（trim 非空作 buildSystemPrompt base，子系统 E）
3. `createRunningRun()` 落 running run 行 → `createSession()`（mode="agent"、currentModelId、projectId 显式 null/归属、**userId 必须补写**——漏写则运行历史「查看会话」按 userId 过滤找不到落空态）
4. `resolveAttachments(task.prompt, workspacePath, now)` 引用解析注入：prompt 中文件/技能引用展开为内容前缀 + 技能聚焦清单；失败短路 failRun；成功取注入文本与聚焦技能
5. user message 落库（注入后文本）→ `runChatStream()` **静默无人值守**（不经渲染层 onChunk）：
   - 模型构造收口 `createChatModel`（langchain-model-factory，采样参数随构造注入）
   - 工具集 `collectTools()`：registry 全集剔除 `plan_*`（定时任务 agent 不带 projectId，带上只会得到未关联项目拒绝）与专家推荐两跳组（无人值守语境无推荐卡消费方）；无 workspacePath 时仅白名单（mcp__*、bash、create_skill）；read_skill 常驻
   - **权限分级 `resolveAutomationPermissions(accessMode, rememberedTool?)`**：full=fullAccess()+isToolAllowed 恒 true+requestApproval 放行；default=isToolAllowed 仅命中审批记忆 true（`rememberedToolOf(workspaceId)` 查 toolPermission 表工作空间已记忆工具——F3 批收口，chat 链同语义）、requestApproval 恒 false（写类审批被拒不挂起，agent 收拒绝反馈继续）
   - 命令/文件判定门：`commandGate`/`fileGate` 共享模块单例（无人值守 ask 强拒不挂审批，SP2/SP3）
   - 数据安全（SP4）：opts 显式透传优先，缺省回落模块级 `setAutomationDataSafety` 注入（Application 一处装配三触发路径生效：删除保护 deleteProtection、批量阈值 bulkDeleteThreshold、备份 onBackupFile）
   - `unattended: true`；监控埋点 `recordToolCall(scene:"automation")` / `recordLlmCall`
6. 收尾：assistant message 落库（blocks + error + durationMs）→ run 终态（success=!errorCode；error=`${errorCode}: ${errorMessage}` 截 500）→ **`advanceTask(task, now, outcome, triggerType)`**

`advanceTask` 关键语义：

- `manual`/`event` 触发**直接 return 不消耗调度**——lastRunAt 若被推进，决策树 `lastRunAt>=nextRunAt` 会把未到触发点的 once 任务提前回收（事件对齐手动，spec §5）
- 第 5 参 `replayAt`（批3A）：调度相位重放基点——`lastRunAt=replayAt、nextRunAt=computeNextRun(schedule, replayAt, replayAt)`（错过补跑按触发点依次补，见 §3.2）；缺省基点=now（既有行为）
- schedule/catchUp/retry：lastRunAt=now、nextRunAt=computeNextRun(schedule, now, now)；once 且 success → status=expired
- once 的 expired **只在成功路径置位**：非系统失败需先走重试扫描（nextRunAt=null 但 status 保持 active），重试耗尽后由调度器决策树收尾——不得首次失败即 expired（否则被 tick 的 active 过滤出局零重试）

`failRun` 失败收尾：run failed + error 码；系统错误码三元组（workspace_missing/model_missing/graph_missing）置 `status=error, enabled=false, statusNote`（重试无益停调度）；非系统失败走 advanceTask 留 active 待重试。

server 副本 `automation-runner.ts` 11 条改造点：runChatStream → `src/core/chat-runner.service`；blocks/error-classify/schedule → @tianshu/core；graph-executor → GA-T4 副本（advanceTask 等 4 符号 ruling 8 单向引自副本尾段断环摘取）；monitor 埋点不移植（server 无 monitor 域）；dataSafety → config 值面；`unattended:true` → `autoDenyApprovals:true` 等价适配。

### 3.4 变更通知与事件链

- **`automation-change-bus.ts`**（移动端 CRUD 批）：`emitAutomationChanged(taskId=0)` 双扇出——渲染层全窗 `AUTOMATION_CHANGED_EVENT`（"automation:tasks-changed"，前端 use-automation-tasks 据此失效 React Query 重拉）+ 进程级订阅者（`onAutomationChanged`，face 事件桥 → `automation.changed` 推远程控制端）；订阅者异常隔离；taskId 未知传 0（列表级刷新信号，协议载荷 taskId 必带的占位语义）。独立小模块破 repo↔event-bus 循环依赖（**rolldown 打包后模块顺序不可依赖**——各消费方单向下引）
- **`automation-event-bus.ts`**：`publishAutomationEvent(event, chainDepth=1)` 查 enabled+active+eventJson 任务 → `matchEventTasks()` 逐个执行；**防环 `MAX_CHAIN_DEPTH=5`**（超限落 skipped run `chain_depth_exceeded` 终止传播）；撞在途互斥落 skipped `event_skipped_running`；事件触发的 run 完成同样成为 taskFinished 源（chainDepth+1 递归发布，spec §5 链式）；`taskFinishedEvent(task, outcome)`——graph 任务以图为目标（targetId=graphId），prompt 任务以任务自身为目标；异常全吞绝不向发布方抛。依赖单向：event-bus → runner

### 3.5 运行记录、统计与保留

- **健康度总览 `computeStats(runs, errorTasks, now)`**（`automation-stats.ts` 纯函数；IPC `automation:stats` 由 repo 聚合查询喂入，名称联查补位：任务 run 取任务名、图试运行取图名）：
  - today：total/success/failed/running + successRate = success/(success+failed)——**skipped 不进分母**
  - trend：7 天逐日 success/failed（本地日键 `localDateKey`，设备时区「今日」与用户直觉一致）；批3A 起可选 `rollups` 参——过去趋势日以每日 rollup 行（§2.3）单调补全（`max`——run 仍在即以即时聚合为准），今日恒用即时聚合（rollup 每小时节流必然滞后）
  - attention：error 任务全列（kind=taskError，跳任务编辑）+ 近 24h failed run（kind=failedRun，跳运行记录/轨迹，startedAt 倒序）；errorTaskCount
- **保留策略 `automation-retention.ts`**（方案 A，2026-10-22 裁定）：
  - 配置 `RunRetentionConfig`（option 表 `type=app, name=automation.runRetention` 实时读）：enabled/traceDays=3/successDays=7/successKeep=200/failureDays=30/failureKeep=500，逐字段 clamp 防非法值
  - 裁剪五步 `trimAutomationRuns`：graphTrace 超 traceDays **先行降级**（updateMany 置 null 保行清大字段）→ 成功态按天（`status NOT IN (failed,running)`——running 永不裁、expired/skipped 归成功档）→ 失败态按天（保留更久）→ 成功/失败**每任务条数窗**（窗口函数 `ROW_NUMBER() OVER (PARTITION BY taskId ORDER BY id DESC)`，SQLite ≥3.25；taskId NULL 图试运行同组自成一组；$executeRawUnsafe 参数化）
  - **run 行删除前级联删 graphRunNode**：条数窗用同窗子查询 SQL 先行（trimKeepNodesSql）；按天档先 findMany 取 id 集合再 deleteMany
  - 调度：启动裁一次 + 每 tick 调 `maybeTrimAutomationRuns`（**TRIM_INTERVAL_MS=6h 节流**，命中时开销仅一次时间比较）；吞错——清理失败不阻塞调度
  - **双份同构文件**：`apps/tianshu-server/src/modules/automation/automation-retention.ts`（唯一授权差异：引号风格 + Log→Nest Logger + 头注释），`npm run check:drift` 基线守护（`packages/tianshu-core/scripts/drift-manifest.json`，serverRoot 指向 apps/tianshu-server）
- 前端：`RunHistoryPanel/RunHistoryView`（分页/任务/状态过滤）、`run-display.ts` 展示纯函数、`use-automation-tasks.ts`（React Query + AUTOMATION_CHANGED_EVENT 失效重拉）、`AutomationStatsPanel`（健康度）、`automation.store.ts`

### 3.6 IPC 通道、模板与表单

`AutomationRepository.registerIpc()`（`handleUser` 解 token，userId 隔离）：

| 通道 | 行号 | 语义 |
|---|---|---|
| `automation:list/create/update/delete` | 247-256 | CRUD；删除走 prisma.$transaction 连带删 run（应用层级联，SQLite 无外键） |
| `automation:toggle` | 259 | 启停；重新启用置回 active 清 statusNote |
| `automation:runNow` | 262 | 手动触发（inflight 互斥 TASK_ALREADY_RUNNING；触发即返回不 await；收尾发 taskFinished 事件） |
| `automation:templates` | 267 | 静态模板匿名通道 |
| `automation:stat` | 280 | 创建埋点（CreateStatDetail） |
| `automation:stats` | 283 | 健康度即时聚合 |
| `automation:runs:page` | 270 | 运行历史分页（page=20，taskId/status 可选过滤） |

- 内置模板 7 个（`automation-templates.ts` 纯数据不走远端）：`daily-ai-news`/`weekly-report`/`biweekly-review`/`monthly-billing`/`yearly-reminder`/`workdir-monitor`/`standup-prep`——各带 prompt + scheduleJson + temperature；前端 `TemplateMarketView` 映射 lucide 图标与 i18n 文案
- 调度编辑：`SchedulePicker`（受控）内嵌 `ScheduleDialog`（频率+有效期实时回写）——结构化选 kind/时间/星期/间隔，**无 cron 表达式高级输入**；`schedule-text.ts` 的 `describeSchedule()` 人读文案（i18n，列表行与摘要栏同一实现）+ 校验 `ScheduleValidation: ok | timeInPast | intervalTooSmall | incomplete`；批3A 起 `describeMissedPolicy()`（catchUpOnce 追加「错过补跑最多 N 次」，skip 不追加防噪音）拼入 `buildTaskParams` 的 scheduleText——错过补跑语义向用户明示；CreateTaskDialog 在 catchUpOnce 选中时透出补跑上限输入（1-10）
- 事件触发编辑：`lib/task-form.ts`（`toEventJson/parseEventDraft`；taskFinished 允许 targetId 暂缺——目标必选校验在提交层）；`use-task-form.ts` 表单状态
- 运行时变量：`replaceVariables(prompt, now)`——`{{date}}`（yyyy-MM-dd）/`{{weekday}}`（中文「一」…「日」）/`{{time}}`（HH:mm），**语言不跟随 i18n 固定中文格式**

## 4. 三端布局（桌面调度 vs server 调度差异）

| 维度 | 桌面（Electron 常驻） | 无头 server（NestJS 常驻） |
|---|---|---|
| 调度器 | AutomationScheduler，Application.start 手动启停 | 同款摘取副本 + **onApplicationBootstrap/onModuleDestroy lifecycle** |
| tick 间隔 | 写死 30s（TICK_MS） | **config.yml tianshu.automation.tickMs 可配**（缺省 30_000） |
| 数据库 | `~/.tianshu/<分组>/database/local.db` | 独立库（`~/.tianshu-server` 或 PG 变体 prisma/pg）——**两端各自的库各自的调度器，同一任务天然不会双端双触发** |
| 控制面 | IPC（handleUser 解 token 多用户隔离） | HTTP 六端点（@Public + TIANSHU_TOKEN 静态 token 守卫） |
| 安全配置 | Application 闭包注入（安全中心 UI：审批模式/数据安全/工具禁用） | config.yml `tianshu.chat` 段（allowDangerousTools/deleteProtection/accessMode） |
| 变更通知 | BrowserWindow 全窗广播 + face 桥 | EventBusService `automation.changed`（relay 链路推远程端） |
| userId | token 解出 | 伴生单用户 COMPANION_USER_ID 写死 |
| 事件链总线 | automation-event-bus.ts（进程内） | createAutomationEventBus 单实例（automation.module 装配） |

**server 六端点**（`src/modules/automation/automation.controller.ts`）：`automation/query`（分页+keyword）、`automation/save`（**全量 upsert，无 toggle 端点**——启停走 save 携翻转后 enabled，Ruling 12；无头端 Ruling 12/14 enabled 显式携带才写）、`automation/delete`（批量，run 级联）、`automation/runNow`（**202 受理**，不消耗调度字段，收尾经 automation.changed）、`automation/runPage`（**载荷剔 graphTrace** 省流量，移动端 CRUD 批）、`automation/runNodes`（节点级执行详情：图 run 专有，归属两段校验不符/prompt run/老 run 一律空集，空集语义不暴露存在性）。

**移动端**（纯控制端，2026-10-27 二裁后两类齐备）：

- 页面：`src/app/automation/new.tsx`（**prompt/graph 双模式表单**——targetKind 切换，graph 模式选图）、`history.tsx` / `history/[id].tsx`（运行历史 + 节点级详情消费 automation/runNodes）
- 调度纯函数层 `src/logic/automation-schedule.ts`：**七 kind 全集**（once/daily/weekly/biweekly/monthly/yearly/interval，@tianshu/core ScheduleConfig 同源）；表单值 ↔ wire ScheduleConfig 双向转换 + 校验 + 人读文案 + 编辑载荷组装；**透传纪律**：UI 不暴露的字段（eventJson/templateSlug/projectId/temperature/interval weekdays）原样回传，防全量 save 丢配置
- transport `src/transport/graph-api.ts`：九端点封装（automation 面 + graph 面）；判错统一 wireRequest（HTTP 200 亦可能业务错 4xxx 查 body.success，runNow 的 202 受理同 success）；行级必填门禁防畸形 wire 行（坏行丢弃不抛错）
- 连桌面端也可用：`DESKTOP_CAPABILITIES`（protocol server-event.ts）含 `automation`（2026-10-27 移动端 CRUD 批增）——桌面被控面 `electron/domains/server-face/automation-tap.ts` 消费本地 AutomationRepository/GraphRepository 单源，透出五段 + `graph/query` 只读选图面，变更经 automation-change-bus → face 桥扇出

### 4.4（补）webhook 触发（图专属，两端口径）

- **桌面** `electron/domains/ai/orchestration/webhook-server.ts`：本地 `node:http` server 仅监听 **127.0.0.1:27400**（DEFAULT_PORT；option `webhook.port` 可配，`setWebhookPort` 绑定失败回滚 option 与原端口并抛占用信息）；每图随机 token `randomBytes(24).toString("hex")`（option 表 `type=webhook, name=graph:<id>`，`sealNamedSecret` 密封存储，**重开换 token 旧 token 立即失效**——内存旧条目同步清防运行期旧 token 可达）；`POST /webhook/<token>`：同步模式挂起至完成（**SYNC_TIMEOUT_MS=120s 强杀**）或异步模式 202+{jobId,statusUrl}（内存 `jobResults` 有界 200 FIFO 逐出；重启后 `GET /webhook/<token>/jobs/<id>` 回落 run 表状态，output 不回）；响应模板 `renderNodePrompt` 渲染 `{{nodes.x.output}}/{{input.y}}`（空模板回默认 `{status,output}` JSON，自定义模板原样文本不再 stringify）；JSON body 顶层字符串值展平为 inputs（≤1MB，非字符串 JSON 化）；workspace 取该用户最新一个
- 触发链 `runForWebhook`：`runGraphToResult(triggerType:"webhook", attempt:1, codeAuthorized: reg.fullAccess)`——外部触发（token 即可达）对齐 default 任务无全权语义，图级 fullAccess（注册时显式授权）放行；完成发布 `taskFinished(targetType=graph)`（同步/异步同径，链式任务对 webhook 运行续上）；**无 inflight 互斥**（activeRuns 仅管 abort——注销/删图/停服时统一中止）
- **server** `src/modules/webhook/`（GA-T7 无头等价）：触发面收敛为 Nest 路由 `POST /webhook/:token` + `GET /webhook/:token/jobs/:id`（生命周期随应用，无端口/启停面；Fastify @Res() 直发真实状态码与原样体，绕开统一包装拦截器）；**管理三端点路径带 graph/ 前缀是安全裁定**（`graph/webhook/{enable,disable,status}`）——触发面豁免静态 token 守卫（外部系统语义），管理面含 fullAccess 全权开关必须受守卫保护且语义挂图域；注册返回**相对 URL** `/webhook/<token>`（部署 host 不定，statusUrl 按请求自身 origin 拼）；单伴生用户面（starter option 模型无 userId 列）；publishAutomationEvent(taskFinished) 未摘（Ruling 10——「图运行完成」事件投影已由 executor 内部 graph.run.updated 承担）
- **任务级无 webhook 触发**：automationTask 不挂 webhook；2026-10-27 移动端一裁「不做 webhook 配置面」指移动端（纯控制端，配置留桌面），桌面/server 的图 webhook 已全量落地

## 5. 业界主流做法对比

| 维度 | 天枢现状 | cron 表达式体系（crontab/Quartz） | n8n schedule trigger | GitHub Actions schedule | 系统级（launchd/Windows 任务计划） | Temporal durable timer | LLM 定时智能体（cron agent 范式） |
|---|---|---|---|---|---|---|---|
| 触发表达 | 结构化 ScheduleConfig（两 mode 七 kind）+ 人读文案 | 5/6 段表达式（分-时-日-月-周），表达力强、可读性差 | Schedule/Cron Trigger 节点（cron 输入框或 interval UI） | **cron（强制 UTC）** | launchd StartCalendarInterval/StartInterval；任务计划 daily/weekly/logon 触发器 | **durable cron workflow**（ScheduleSpec，含 jitter/timezone） | cron 触发 + prompt 注入时间上下文——天枢 `replaceVariables` 的 {{date}}/{{weekday}}/{{time}} 正是此范式 |
| 精度 | 30s tick，触发迟到 ≤30s | 分钟级 | 秒级可配 | **最短 5 分钟且不保证准时**（高峰延迟可达小时级） | 分钟级 | 精确 | 随宿主 |
| 错过补偿 | 进程重启错过：missedPolicy skip/catchUpOnce + **补跑上限 catchUpLimit（缺省 1，批3A）按触发点依次补**；睡眠唤醒隐式补一次；interval 顺延不补轮次 | crontab 无补；anacron 按日粒度补 | 无补 | **不补**（错过即丢） | **可配 StartWhenAvailable**（任务计划）/macOS 唤醒补跑 | **自动补**（catchup window 可配，默认全补） | 随宿主 |
| 重试 | **指数退避 60/180/540s ×3 上限 + classifyError 分类可重试面（配置类不重试，批3A）**；attempt 逐次落 run 行 | 无（脚本自理） | 每节点 retry（固定/指数 backoff）+ workflow 级 error workflow | job 级手动 re-run / workflow 自动重试策略 | 无 | **RetryPolicy（指数+抖动）+ 活动心跳+超时分离** | 随宿主 |
| 执行队列/并发 | 进程内 inflight Map（per-task 互斥）；无队列/优先级 | 无 | **BullMQ（Redis）队列** + 多 worker 水平扩展 + concurrency 限流 | 托管队列 + **concurrency group**（同组取消旧跑） | 每任务独立进程 | task queue + worker 池 | 随宿主 |
| 防双触发 | 单进程 inflight；**桌面/server 各自独立库天然不冲突**；无分布式锁（多副本未考虑） | flock 文件锁 | Redis 锁 + 队列串行化 | 平台保证 | 系统级单实例策略（任务计划 InstancePolicy） | **workflow ID 唯一性**（同 ID 不重复起） | 随宿主 |
| 休眠/离线 | 无 powerMonitor；依赖 Electron 常驻进程 | 进程不在即不跑 | 云服务常驻 | 云 | **系统集成最深**：电源事件、唤醒、电池/网络条件触发 | 常驻集群免疫 | 随宿主 |
| 可观测 | run 表全留痕 + 健康度总览 + attention 清单 + 分级保留 | 邮件 | execution 全链 + queue metrics | run 日志 + insights | 系统日志 | **全量 event history + Web UI** | 多为黑盒 |
| 无人值守安全 | **accessMode 分级 + 审批记忆 + 命令/文件门 + 数据安全闭包**（SP2-SP6 五批裁定，写面强拒不挂起） | 无 | 假设执行即授权 | GITHUB_TOKEN 最小权限 | 账户权限 | 假设执行即授权 | 普遍缺位（业界痛点） |

分系统详述（择与本项目决策最相关的点）：

- **cron 表达式体系**：5 段（分-时-日-月-周）/6 段（含秒）表达式 + 特殊语法（`*/5`、`L`、`W`、`#`）是事实标准，Quartz 补齐了 misfire 策略（fire-and-proceed/ignore/do-nothing 三态——与天枢 missedPolicy 二值同族但更细）。天枢用结构化配置换可读性与校验友好（前端表单直接约束合法值域），表达力上 `weekly+time` 等常规场景无损，`每 45 天`这类非常规周期表达不出。
- **n8n**：Schedule Trigger（cron 输入框 + interval UI 双形态）+ 执行队列（main 队列/manual 队列分离、BullMQ、concurrency per worker）+ 每节点 retry 与 workflow error 分流（error workflow）。它是「触发器+队列+集成」的全家桶标杆；天枢取其触发器心智，未取队列（单机规模不需要）。
- **GitHub Actions**：schedule 只支持 cron 且 **UTC 强制**、最短 5 分钟、高峰不保证准时、**错过不补**——官方文档明示「不适用于准时场景」；concurrency group 的「同组取消旧跑」对幂等性差的 LLM 任务是好的防重手段（天枢 inflight 互斥是「拒绝新跑」，方向相反但目的一致）。
- **系统级（launchd/Windows 任务计划）**：与电源管理集成最深——任务计划 StartWhenAvailable（错过后开机补跑）、电源条件、仅交流电时跑；launchd 的 StartCalendarInterval 在 Mac 睡眠错过时合并触发一次。天枢桌面端是应用内调度（进程死了不跑），若追求「任务跟机器不跟应用」，可以把调度下沉系统级再唤起应用——当前未做也未见规划。
- **Temporal durable timer**：`sleep()` 任意时长且 worker 重启不丢（timer 状态落 event history）；Schedule 支持错过自动 catchup（窗口可配）；RetryPolicy 指数退避+抖动+最大间隔。这是「重调度」的形态——天枢的「轻调度 + SQLite 状态行」在其覆盖面内已完备，超出面（跨进程恢复、分布式）是它的领地。
- **LLM 定时智能体（cron agent 范式）**：业界做法是 cron 触发 → 注入时间/上下文到 prompt → agent 自主执行 → 结果沉淀（邮件/IM/文档）。天枢的 `replaceVariables`（{{date}}/{{weekday}}/{{time}}）+ 项目 systemPrompt 注入 + 建会话留痕正是此范式的完整实现；独有增强是「同一触发器可直接挂 graph」把自由 prompt 升级为确定性流程。

要点解读：

1. **结构化调度优于 cron 表达式**是 Coze/n8n 一脉的产品共识，天枢跟进彻底（连 yearly 的 2/29、biweekly 的 DST 争议都处理了）；代价是 crontab 习惯的高级用户没有表达式入口——n8n/Dify 均保留 cron 输入框可借鉴。
2. **missedPolicy 双值语义清晰但粒度粗**：Temporal 的 catchup window、任务计划的 StartWhenAvailable 都比「补一次/跳过」细。hourly 任务休眠一晚：catchUpOnce 只补一次、skip 只留一条 skipped run——不存在「补齐 N 轮」选项（对 LLM 任务这通常是对的：避免唤醒后的调用风暴与账单）。
3. **重试无 backoff**：固定 60s×3 对 LLM 限流（429）场景偏弱；n8n/Temporal 的指数退避+抖动是标准解，且可按 classifyError 分类区分可重试面。
4. **无人值守安全分级是天枢独有优势**：n8n/GHA/Temporal 均假设「触发即授权」；LLM agent 无人值守的「default 档写面强拒不挂起 + full 档显式放行 + 审批记忆查表」三层语义是业界普遍缺位的部分，值得保持并在文档层面对外讲清。

## 6. 改进空间

1. ✅ 已落地（批3A）：**错过触发补偿参数化**——automationTask 新列 `catchUpLimit`（缺省 1 = 既有 catchUpOnce 只补一次，1-10 clamp）；多轮错过按触发点依次补（调度相位重放 replayAt，§3.2），预算耗尽 advance 到未来；scheduleText 经 `describeMissedPolicy` 明示「错过补跑最多 N 次」、CreateTaskDialog 透出上限输入。残余：移动端表单未透出该字段（server save 显式携带才写，移动端编辑不碰既有值）。
2. **分布式锁防双触发**：单实例假设目前成立（桌面/server 各自库）；server 未来多副本部署时 scheduler tick 无租约锁会双触发——建议 tick 前抢库级锁（option 表心跳行或 `BEGIN EXCLUSIVE`），与 webhook 面（同样无互斥）一起收口。
3. **桌面休眠**：接 Electron `powerMonitor` 的 suspend/resume——suspend 时快照在途与 nextRunAt、resume 时显式决策（补/跳）并打点，替代现在「唤醒后首个 30s tick 隐式 execute」的隐式行为；长期看休眠免疫只有把任务托管 server 端（两端口径已同构，迁移成本主要在数据面）。
4. ✅ 已落地（批3A）：**重试指数退避 + 分类可重试面**——`nextRetryDelay(attempt)` 60/180/540s 单源 @tianshu/core；`isRetryableRunError` 按 classifyError 分类（RATE_LIMITED/TIMEOUT/NETWORK/UNKNOWN 重试，AUTH_FAILED/MODEL_NOT_FOUND/IMAGE_UNSUPPORTED 不重试；本机配置三元组停调度先例不变）。残余：抖动（jitter）未加——单机任务量级下非必需。
5. **调度精度与 tick 开销**：30s tick 全表扫 active 任务 + 最近 500 行 run 四列（已 select 裁剪）；任务量大时可改「下次触发时间堆」或 nextRunAt 索引范围查询；tickMs 仅 server 可配，桌面写死 30s（测试需等真实 30s 或注入）。
6. ✅ 已落地（批3A）：**统计每日 rollup**——automationStat 新 bucket `event="dailyRollup"`（免 schema 迁移），按日 × 按用户聚合桶，1h 节流重算 + 单调合并（保留策略裁剪后历史不回退）、窗口外冻结；桌面 computeStats 过去趋势日单调补全，「上周成功率」可回溯（行随 90 天保留期裁剪——更久归档未做）。
7. **时区**：computeNextRun 全本地时区（date-fns），runAt 存 UTC ISO 由前端按本地展示；任务无 tz 字段——server 部署跨时区或用户旅行时 daily 语义漂移，Coze 的时区选择器可借鉴。
8. **webhook 任务级触发**：webhook 只能触发图不能触发 prompt 任务（无任务级 token）；需要「外部事件→prompt 任务」当前只能建单节点图绕行。
