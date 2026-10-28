# 无头端工具记忆批（MR）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐审批记住批的无头端缺口——tianshu-server 加 `toolPermission` 表 + approve 记住写表 + `isToolAllowed` 从恒 false 改查表。移动端连无头端时「允许并记住」不再被 DTO strip 静默失效。

**Architecture:** 全部改动落在 drift 免疫区（schema pair skip:true、controller/service/dto/chat-runner 均 server 独有）；`approval.ts` 同构对**不动**（控制端上送 toolName 先例）。DDL 单一事实源 schema.prisma，测试临时库自动获表。

**Spec:** 本计划自含；侦察报告（2026-10-24 无头端审批与建库链路）为依据。mirror 参照：`chat.service.ts:2380-2411`（approveRemember）、`chat.service.ts:1514-1523`（isToolAllowed 查表）。

## 裁定

1. remember 写表升格归属校验：`findById(sessionId, COMPANION_USER_ID)`（无头端静态令牌单用户语义，userId=1 写死——与 resolveWorkspaceId 同口径）；纯应答不校验（4040 原口径）。
2. 记忆先落防竞速（upsert → approvals.respond，mirror 同序）。
3. `isToolAllowed` 闭包用装配段已解出的 `session.workspaceId` 查表；头注释「不移植」段同步更新。
4. standalone 打包副本（standalone/prisma/schema.prisma）发布时重打，本批不打包（标注）。
5. pretest openapi 门禁：仓内无 openapi.json 为跳过态，跑了验证；若 fail 则 `npm run sdk:generate`。

## Global Constraints

- 主干直接提交；cd 显式；rtk 吞输出用 node 复核；Edit 后盘上验证再提交（reset 事故防复发纪律）。
- `npm run prisma:generate` 必须在改 schema 后立即跑（client 出 `toolPermission` 属性，否则 TS 编译错）。
- 测试：`npm run test -w apps/tianshu-server`（Jest，rootDir test）；测试零 schema 改动（test-db 临时库 db push 重建）。
- 提交信息 `feat(server): …（审批记忆批）`。

---

### Task MR-1: schema 加 ToolPermission 表 + prisma generate

**Files:** `apps/tianshu-server/prisma/schema.prisma`（按 :193/:235/:358 摘表注释先例）

- [ ] **Step 1** 追加 model（逐字段复制 mirror prisma/schema.prisma:165-172）：

```prisma
/// 工作空间级工具记忆（审批记忆批——逐字段复制自 mirror prisma/schema.prisma
/// toolPermission；@@map 保留原表名；approve remember 写入，tool-gate 免审消费）
model ToolPermission {
  id          Int      @id @default(autoincrement())
  workspaceId Int
  toolName    String
  createdAt   DateTime @default(now())

  @@unique([workspaceId, toolName], map: "idx_tool_permission_ws_tool")
  @@map("toolPermission")
}
```

- [ ] **Step 2** `cd apps/tianshu-server && npm run prisma:generate`（client 出属性）+ 盘上验证。
- [ ] **Step 3** 提交 `feat(server): schema 加 toolPermission 工具记忆表（审批记忆批）`。

### Task MR-2: DTO + controller/service 链路

**Files:**
- `src/modules/session/dto/session-approve.dto.ts`（加 remember?/toolName? 可选，@IsBoolean/@IsString 可选校验）
- `src/modules/session/session.controller.ts:91-104`（改调 `sessionService.approve(dto)`；返回 `{responded, remembered}`——responded 恒 true 保旧契约）
- `src/modules/session/session.service.ts`（新增 `approve(dto)`：remember 时 findById 归属校验 4040 → chatRunner.approveRemember；需注入 ChatRunnerService——执行时核对 SessionModule providers/imports 补注册）

### Task MR-3: chat-runner approveRemember + isToolAllowed 查表

**Files:** `src/core/chat-runner.service.ts`

- [ ] approve（L504-507）旁加 `approveRemember`（sessionRecord.findFirst 取 workspaceId → toolPermission.upsert 先落 → approvals.respond；签名 `(sessionId, toolCallId, approved, remember, toolName) => Promise<{hit, remembered}>`）。
- [ ] 装配段（L770-771）`isToolAllowed: () => Promise.resolve(false)` 改查表闭包（`session.workspaceId`；签名以 tool-gate.ts AgentStreamOptions.isToolAllowed 现场为准）。
- [ ] 头注释 L22-23「toolPermission 表不移植」段更新。

### Task MR-4: 测试扩展

**Files:**
- `test/modules/session-approve.spec.ts`（approveStub 扩 approveRemember 形态；加 3 用例：remember+toolName → remembered true；remember+拒绝 → remembered false；remember+会话不存在 → 4040）
- `test/core/chat-runner.spec.ts`（approveRemember 单测：临时库造 session/workspace 行 + 未命中 pending 返 hit:false 不写表；命中写表断言 toolPermission 行存在——执行时按 fixture 现场写）

- [ ] 全链闸：`npm run test -w apps/tianshu-server` 全绿 + `npm run typecheck -w apps/tianshu-server` + 逐任务提交。

---

## Self-Review

- 范围：无头端单侧四任务；standalone 重打包/openapi 生成按需（裁定 5）。
- drift：六文件全免疫区已核；approval.ts 零触碰。
- 类型一致：approveRemember 签名与 controller/service 消费一致；DTO 对齐 protocol ApproveParams。
