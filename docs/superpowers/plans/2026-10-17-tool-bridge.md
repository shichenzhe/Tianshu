# 桌面工具桥实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** browser 四工具桥接闭环——无头 server 遇桥工具回调控制端桌面执行（隐藏桥窗+审批分级），结果回传继续工具循环。

**Architecture:** tool.request 事件广播（现有 SSE/relay 通道）+ tool/respond 端点（一次性 requestId 匹配）；server 桥工具定义副本+挂起注册表；控制端 bridge-executor 复用 mirror GuestControl 工具函数。

**Tech Stack:** 既有管道（协议包/EventBus/端点/连接事件流/IPC 白名单）。

**Spec:** `docs/superpowers/specs/2026-10-17-tool-bridge-design.md`

## Global Constraints

- 铁律不触碰；两仓风格；哨兵规程（并行会话活跃——皮肤/移动端面）；git add 精确。
- 桥工具定义/执行函数与 mirror `agent/browser-tools.ts` 同构（定义副本入 drift manifest；执行体**复用 mirror 函数零改动**——server 侧只有定义+桥执行）。
- write 类审批拒绝为默认安全态；requestId 一次性；超时 config `tianshu.bridge.timeoutMs` 缺省 30_000。
- 基线：mirror 3662 过/1 外来预存红（library-repo）；server 287 绿（含 UD 7d8b5c3）。

---

### Task 1: 协议扩展 + server 桥执行链

**Files:**
- Modify: `packages/tianshu-protocol/src/server-event.ts`（ServerEvent 加 tool.request 成员——`ToolRequestPayload {requestId,sessionId,tool,args}`；tool 枚举四值）
- Create: server `src/core/tools/bridge/browser-bridge-tools.ts`（四工具桥版定义：zod schema/描述自 mirror browser-tools 同构副本+头注释登记；执行=emitToolRequest+挂起）
- Create: server `src/core/tools/bridge/bridge-registry.ts`（requestId→{resolve,timer} 挂起表；respond 收敛/超时/订阅者计数零时立即拒/进程关闭全 abort；EventBus 广播出口）
- Modify: `src/core/tools/tool-registry.ts`（注册四桥工具）、`tianshu-config.entity.ts`（bridge.timeoutMs 段）
- Create: server `src/modules/tool/`（tool.controller：`POST tool/respond`——requestId 校验一次性 4005；module 装配）
- Test: server `test/core/bridge-registry.spec.ts`（挂起-respond/超时/未知 4005/零订阅者立即拒/重复 respond 4005）+ `test/modules/tool-api.spec.ts`（端点 contract）

- [ ] 哨兵+基线 → 协议包 TDD 先红 → server 桥链 TDD → 双仓绿+包 build+sync → Commits（mirror `feat(protocol): tool.request 事件（TB-1）`；server `feat(bridge): browser 四工具桥执行链+respond 端点（TB-1）`）

### Task 2: 控制端执行面（桥窗+审批链）

**Files:**
- Create: mirror `electron/domains/server/bridge-executor.ts`（隐藏 BrowserWindow 单例=GuestControl；resolver 注入 mirror browser 工具函数——**读 agent/browser-tools.ts 确认工具函数导出形态后接线**；write 类经审批门；执行结果回调）
- Modify: `electron/domains/server/connections.ts`+`ipc.ts`（eventSink 过滤 tool.request→bridge-executor；respond 经 requestRemote POST tool/respond）
- Modify: `electron/commons/ipc-channels.ts`（EVENT `server:bridgeApproval`；INVOKE `server:bridgeDecision`）
- Create: `src-react/domains/ai/server/components/BridgeApprovalCard.tsx`（全局审批卡——工具名/参数摘要/允许/拒绝；挂 ServerConsoleView 或全局通知位）
- Modify: i18n 双语 `server:bridge.*`
- Test: `tests/ai/server/bridge-executor.test.ts`（mock BrowserWindow：executeJavaScript 调用/单例/read 直接执行/write 经审批门两态/拒绝回 error）+ `bridge-approval.test.tsx`（事件→卡→decision→执行/拒绝）

- [ ] 哨兵+基线 → TDD → 全量绿（除外来预存红）+typecheck → Commit（mirror `feat(server): 桥执行面——隐藏桥窗+审批链+respond 通道（TB-2）`）

### Task 3: 收尾——E2E+manifest+终审

**Files:**
- Create: `tests/ai/server/e2e-bridge-smoke.ts`+`test:e2e:bridge` script（直连：起 server+SSE 订阅+fake model 发 browser_snapshot 调用→收 tool.request→脚本 respond→断言 chunk 流含工具结果；write 类审批路径 E2E 可选）
- Modify: `packages/tianshu-core/scripts/drift-manifest.json`（+browser-bridge-tools 对：server src/core/tools/bridge/browser-bridge-tools.ts ↔ mirror electron/domains/ai/agent/browser-tools.ts——note 注明「仅定义段同构，执行体为桥」；--rebase 固化）
- [ ] E2E 跑通 → final review（fable）→ 修复轮 → 收官

---

## Self-Review

- Spec §2/§3（T1）、§4（T2）、§5/§6 由各任务测试承载、§7 假设由边界承载。
- 类型一致：ToolRequestPayload T1 产出 T2 消费；browser 工具名四值全文统一。
- T2「读导出形态后接线」为带准绳查证步骤。
