# 无头端事件总线副本（链式推进）批设计 spec

日期：2026-10-27
状态：直接开工（用户「继续」滚动授权；缝已预埋，先例与蓝本齐备）
关联：无头服务端待办盘点（README「事件总线副本待后续批」/ automation.module 头注释 Ruling 10 之兑现）；GA 批（2026-10-17 graph-automation）

## 0. 事实基线

- **蓝本**：mirror `electron/domains/ai/automation/automation-event-bus.ts`——`publishAutomationEvent`（查 enabled+active+eventJson 任务 → `matchEventTasks` 匹配 → 逐个 `executeTask`（互斥复用 inflight）→ 收官广播 + 链式递归 `taskFinishedEvent`，链深 >`MAX_CHAIN_DEPTH`(5) 落 skipped(chain_depth_exceeded)；异常全吞）；测试参照 `tests/ai/automation-event-bus.test.ts`（11 用例）。
- **server 缝已全预埋**（GA 批改造点 7/11）：
  - `automation-runner.ts:71-83` 已摘 `AutomationChainEvent` 类型 + `taskFinishedEvent` 函数；
  - `automation-scheduler.ts:251`（appStarted 启动发布）/`:476`（launch 收官）与 `automation.repository.ts:342`（runNow 收官）三处 `deps.publishAutomationEvent?.()` 可选钩，deps 类型字段已声明（scheduler:94 / repository:54）；
  - `ExecuteTaskOptions.triggerType` 枚举含 `'event'`、`inputs` 注释已写「事件触发={outcome}」；
  - `eventJsonSchema` 自 `@tianshu/core` 可引（repository 同款）。
- **mirror 发布点三处**：scheduler.start（appStarted）/ scheduler.launch 收官 / repo runNow 收官——server 三缝一一对应。
- **Ruling 10 语义**：EventBusService（协议推送总线）承担收官广播；本批总线副本只管链式触发，二者不混。
- **scheduler 收官时序**：publish 在 `.finally(inflight.delete)` 前——同任务自环监听落 skipped(event_skipped_running)，与 mirror 同序（防环保护面）。

## 1. 本批裁定

1. **新建 `modules/automation/automation-event-bus.ts`**（mirror 副本逐段移植，头注释登记适配点）：
   - 保留：`MAX_CHAIN_DEPTH=5`、`EventMatchableTask`/`EventTaskMatch`、`matchEventTasks` 纯函数（eventJsonSchema 解析坏行静默跳过；taskFinished 按 targetType/targetId/on 过滤注入 `{outcome}`；enabled/status 双保险）、`recordSkippedRun`（triggerType:'event' status:'skipped'）、`publishAutomationEvent(event, chainDepth=1)`（递归链式 + 异常全吞）。
   - 适配：prisma → deps 注入（PrismaService）；Log → Nest Logger；mirror BrowserWindow `notifyChanged()` → `deps.publishAutomationChanged({taskId})`（automation.changed 协议事件，事件路径自补——scheduler notifyChanged 同语义）；`executeTask` 透传 `deps.safety?.()`（与 runNow 手动触发同源安全口径；disabledTools 不引入——SP6 裁定 2 缺省不滤）。
   - 形态：`createAutomationEventBus(deps)` 工厂返回 publish 函数（module 工厂装配，直连单测免 Nest 容器）。
2. **module 接线**：`AUTOMATION_SCHEDULER_DEPS` / `AUTOMATION_REPO_DEPS` 两工厂各注入同一 bus 实例的 `publishAutomationEvent`（deps：prisma + publishAutomationChanged + safety——与 repository deps 同源装配）。
3. **测试** `test/modules/automation-event-bus.spec.ts`（jest.mock `automation-runner` 的 executeTask，纯函数面直测）：
   - matchEventTasks：appStarted 命中 / taskFinished 过滤（targetType/targetId/on）+ outcome 注入 / 坏 eventJson 行静默 + disabled/error 容错 / 链深常量 5；
   - publish：链深超限 skipped(chain_depth_exceeded) 不调 executeTask / 在途互斥 skipped(event_skipped_running) / appStarted 拉起空 inputs / 收官广播 automation.changed / 链式递归向下游发布 taskFinished / executeTask 抛错吞且续链（outcome=failed）。
4. **README**（apps/tianshu-server）：编排能力段护栏行更新（eventJson/appStarted 触发支持链式推进——事件总线副本已接线）；automation.module.ts 头注释同步（disabledTools 保持待办标注）。

## 2. 非目标（留档）

- disabledTools 注入（无全局安全配置面，后续按需——SP6 裁定 2 缺省不滤语义保持）。
- mirror 侧零改动（蓝本不动）；协议包零改动（无新端点/事件——automation.changed 已在）。
- 桌面端编排遥控 UI 的事件触发器配置面（现有 graph/automation 面已够）。

## 3. 风险

- 链式递归的风暴面：MAX_CHAIN_DEPTH=5 + inflight 互斥 + 异常全吞三重护栏随副本移植；run 表 skipped 留痕不静默。
- scheduler.launch 收官 publish 与 finally 时序——保持 mirror 同序（缝位置已定，不自作主张调序）。
- 一处工序纪律：本批 server 侧改动后需重建（协议包本批不动，无需 sync:core）。
