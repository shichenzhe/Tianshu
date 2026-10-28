# 审批「允许并记住」跨端批（MP）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移动端审批 Banner 加「允许并记住」——批准同时写工作空间级 toolPermission 持久记忆（Autonomy Dial 信任积累核心）；打通协议+桌面被控面+桌面控制端，桌面连远程被控端的同款按钮一并解锁（现因端点缺失刻意隐藏）。

**Architecture:** remember 融进现有 `session/approve`（载荷加可选布尔，免新端点）；被控端写入收口在 ChatService 新方法（pending 取 toolName → 归属校验 → upsert → 审计 → respond，记忆先落防竞速），face 路由保持薄转发。无头端 tianshu-server **本批不动**（无 toolPermission 表、isToolAllowed 恒 false——最大缺口单独批；其 DTO 校验会 strip 未知字段，前向兼容）。

**Tech Stack:** @tianshu/protocol（改后须 build dist——mobile 经 dist 消费）/ electron server-face 桥模式 / 移动端 ApprovalBanner。

**Spec:** 本计划自含；侦察结论（2026-10-24 权限链路侦察报告）为依据，关键锚点：`chat-contract.ts:103-108`、`server-face/routes.ts:393-408`、`deps.ts:98-105`、`chat.service.ts:483-505`、桌面 `ApprovalBanner.tsx:49-58/84-92`、`MessageList.tsx:431-433`、移动端 `ApprovalBanner.tsx:46-66/96-121`。

## 安全裁定（持久权限写入的硬约束）

1. **归属校验必须**：remember 写的是持久行，face 侧原「不校验归属（toolCallId 一次性）」的理由不成立——比照 chat.service `permission:rememberTool` 的 assertWorkspaceOwned 口径（会话→workspaceId→归属用户）。face 单用户语义用 `resolveUserId()`。
2. **审计事件并发记**：比照 chat.service.ts L494-501 先例（`*.remembered` 事件）。
3. **顺序防竞速**：记忆先落、respond 后行（本次放行后同工具再触发即命中直执行，对齐桌面 handleApproveRemember 顺序）。
4. `remember===true && approved===true` 才写；拒绝+记住是矛盾组合，参数层忽略（校验放行 approved 单独布尔组合）。

## Global Constraints

- 主干直接提交；cd 显式；rtk 吞输出用 node 复核；Edit 后盘上确认再提交（本日 index.tsx 改动曾被外部还原丢失，防复发）。
- 协议包改后必须 build dist（`npm --prefix packages/tianshu-protocol run build`），mobile 消费 dist、mirror 经 alias 消费 src 双通。
- drift manifest：本批不动 approval.ts/tool-gate/permission-mode 同构对（face 与 ChatService 属 mirror 独有面，不在对内）；prisma-schema 不动（toolPermission 表已存在 mirror 侧）。
- 移动端 i18n 双语同步（locales.test parity 兜底）；桌面 i18n 双 namespace 同步。
- 每任务三闸（typecheck + vitest 全量 + prettier）后提交；**任何 install 后全量 vitest**（nativewind 事故教训）。

---

### Task MP-1: 协议 ApproveParams.remember

**Files:**
- Modify: `packages/tianshu-protocol/src/chat-contract.ts:103-108`

- [ ] **Step 1** `ApproveParams` 加 `/** 批准并写工作空间级工具记忆（被控端持久 toolPermission；拒绝时忽略） */ remember?: boolean;`，注释保留原口径并补记 face 面语义。
- [ ] **Step 2** `npm --prefix packages/tianshu-protocol run build`（dist 重建；mobile/桌面两端消费同步生效）。
- [ ] **Step 3** 三闸：`cd apps/tianshu-mobile && npm run typecheck`（消费端类型可见）+ 根 `npm run test -w apps/tianshu-server` 不跑（无头端不动，但协议包自身若有测试则跑）。
- [ ] **Step 4** 提交 `feat(protocol): session/approve 载荷加 remember 可选布尔——审批记住授权跨端批第一层`。

### Task MP-2: ChatService.respondApprovalRemember + face 桥与路由

**Files:**
- Modify: `electron/domains/ai/chat/chat.service.ts`（新方法 + IPC handler 复用）
- Modify: `electron/domains/server-face/deps.ts:98-105`（approvals 桥签名扩展）
- Modify: `electron/domains/server-face/routes.ts:393-408`（handleApprove 透传 remember）
- Modify: `electron/Application.ts`（attachServerFace 装配处若需调整——桥由 ChatService 实现自然满足）

**Interfaces:**
- Produces: `respondApprovalRemember(toolCallId: string, approved: boolean, userId: number): Promise<{ hit: boolean; remembered: boolean }>`（ChatService 公开方法；approvals 桥签名同步）。

- [ ] **Step 1**: chat.service.ts 抽 `rememberTool` 公开方法（现 IPC handler L483-505 内联逻辑上提：assertWorkspaceOwned → prisma.toolPermission.upsert → 审计事件，IPC handler 改调）；再新增 `respondApprovalRemember`：pending 队列查 toolName（ChatService.respondApproval 现实现内已有 pending 结构——执行时读 `respondApproval` 与 pending 存储，取 toolName 不删除）→ `remember===true` 时 rememberTool(会话 workspaceId, toolName, userId)（会话行查 session 表取 workspaceId；无 workspace 跳过记忆 remembered=false）→ respondApproval(toolCallId, approved)。执行时以现场 respondApproval/pending 实现校准方法拆分。
- [ ] **Step 2**: deps.ts `ServerFaceApprovals` 改：
```ts
/** 审批应答桥（ChatService.respondApprovalRemember 满足；remembered=
 *  remember 请求但无工作空间/未写入时 false） */
export interface ServerFaceApprovals {
  respondRemember(
    toolCallId: string,
    approved: boolean,
    userId: number,
    remember: boolean,
  ): Promise<{ hit: boolean; remembered: boolean }>;
}
```
- [ ] **Step 3**: routes.ts handleApprove 改：参数校验补 `remember` 可选布尔；调 `approvals.respondRemember(...)`（userId 经 `resolveUserId()`，null 时 remember 降级 false 走纯应答）；4040 口径不变；返回 `{ responded: true, remembered }`。
- [ ] **Step 4**: ChatService.respondApprovalRemember 单测（若 chat.service 现有测试模式支持 mock prisma——执行时查现有 chat.service 测试面；无既有模式则 face routes 层用内存替身 deps 测：hit/4040/remember 写桥被调/拒绝不写记忆四例，routes.ts 是纯函数+deps 注入天然可测）。
- [ ] **Step 5**: 三闸 + 提交 `feat(ai): 审批记住授权被控面——respondApprovalRemember 收口+face 透传（归属校验+审计，跨端批）`。

### Task MP-3: 移动端 ApprovalBanner 第三键

**Files:**
- Modify: `apps/tianshu-mobile/src/components/ApprovalBanner.tsx:46-66,96-121`
- Modify: `apps/tianshu-mobile/src/app/session/[id].tsx:524-533`（传 workspaceId）
- Modify: i18n `zh-CN/chat.json` + `en-US/chat.json`（approveRemember 1 key）

- [ ] **Step 1**: `respond(approved, remember = false)` 载荷加 `remember`（ApproveParams 类型经 dist 已含——MP-1 产物）；新增 `handleRemember`：`tapSuccess(); void respond(true, true)`。
- [ ] **Step 2**: props 加 `canRemember?: boolean`（挂载点以 `entry?.sessionWorkspaceId != null` 判定传入，对齐桌面 workspaceId===null 隐藏语义）；busy 态三键：拒绝（描边）/ 允许（主色）/ 允许并记住（主色描边 + Sparkles 图标）——宽度 flex-1 三分。
- [ ] **Step 3**: i18n：zh `"approveRemember": "允许并记住"`、en `"approveRemember": "Allow & remember"`（approve 附近同位）。
- [ ] **Step 4**: 三闸 + 提交 `feat(mobile): 审批第三键「允许并记住」——workspace 绑定门控（审批记住批）`。

### Task MP-4: 桌面控制端解锁（远程态记住键）

**Files:**
- Modify: `src-react/domains/ai/server/api/server.api.ts:626-636`（approveSession 加 remember 可选参）
- Modify: `src-react/domains/ai/api/chat.api.ts:175-186`（approveToolCall 加 remember；远程分支透传）
- Modify: `src-react/domains/ai/chat/components/ApprovalBanner.tsx:49-58`（handleApproveRemember：workspaceId 有→本地两步（原样）；无→单次 approveToolCall(..., true, remember=true)）
- Modify: `src-react/domains/ai/chat/components/MessageList.tsx:427-445`（L431-433 门控放开：远程态也渲染记住键——执行时读现场判定远程态的既有信号（数据源路由层 host 上下文），若 Banner 内已可判 host 则门控改 `workspaceId !== null || isRemote`）
- Modify: 桌面 i18n（若「允许并记住」文案已有 key 复用；新 key 双语同步——执行时查 chat ns 现有 approveRemember 类 key）

- [ ] **Step 1-3**: 按 Files 逐层改（锚点行号见侦察报告；执行时读现场校准远程态判定信号）。
- [ ] **Step 4**: 桌面测试三闸（根 `npm run typecheck`；tests/ai 相关测试跑；Banner 若有测试更新）。
- [ ] **Step 5**: 提交 `feat(ai): 桌面控制端远程审批记住解锁——approve 链 remember 透传（审批记住批，兼收移动端同款协议红利）`。

---

## Self-Review

- 范围：四层全链（协议→被控→两端控制面）；无头端明确不动且前向兼容（DTO strip）；工具记忆查看/撤销的远程透出（permission:listRemembered 面上被控端）不在本批——远程写入的记忆回桌面安全中心管理，计划头部已注。
- 安全：归属校验/审计/顺序/组合校验四裁定成节；face 单用户 resolveUserId 口径。
- 类型一致：`respondRemember` 桥签名与 ChatService 方法一致；ApproveParams.remember 三端消费同名。
- 占位符：MP-2 Step 1 的 pending 结构与 MP-4 的远程态判定信号标注「执行时读现场校准」（有行号锚点，非 TBD）。
