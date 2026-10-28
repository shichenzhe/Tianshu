# 移动端审批记忆管理批（A10）设计 spec

日期：2026-10-26
状态：调研完成（Explore A8–A11 合并摸底），按最小增量实施
关联：差集 spec `2026-10-25-mobile-desktop-gap.md`（A10 条目）；A2/A3/A4 三段式先例

## 0. 调研关键发现

- **toolPermission 表双端同物理表**：桌面 `toolPermission(id/workspaceId/toolName/createdAt)`，唯一键 `(workspaceId,toolName)`；无头端同表（`@@map("toolPermission")`，schema 注释自承「无查看/撤销端点」）。
- **桌面记忆管理 IPC**（chat.service.ts:911-965）：`permission:listRemembered` → `{id,workspaceName,toolName,createdAt}[]`（仅本人空间，createdAt 倒序）；`permission:revokeRemembered(id)`（不存在/非本人幂等 no-op）；`permission:revokeAllRemembered`。
- **完全授权是运行态不是表**：`permission:listFullGrants`/`permission:revokeAllFull`（chat.service.ts:520-542）——会话级 full 授权的运行态列表/清空。
- **rememberTool 上送已有**：复用 `session/approve`（remember+approved+toolName 三真时 upsert 记忆），双端同语义实现，返回 `{responded,remembered}`——本批不动。
- **移动端审批 UI 已有**（Banner 批准/拒绝/允许并记住），设置页只有「审批通知」开关，无记忆管理入口。
- **SDK**：permission 不在 sdk-contract 自动覆盖组——显式补期望；ENDPOINTS 新 namespace 同步 mirror protocol-package 钉测试。

## 1. 本批裁定

### 1.1 端点（permission 新 namespace 5 段，两端同批）
- `permission/listRemembered {}` → `PermissionRememberedItem[] {id, workspaceName, toolName, createdAt(ISO)}`（仅当前用户空间，createdAt 倒序）。
- `permission/revokeRemembered {id}` → `null`（不存在/非本人幂等成功——对齐桌面 no-op 语义）。
- `permission/revokeAllRemembered {}` → `{revoked: number}`（桌面 IPC 返 void——被控面给出实际撤销条数更有用，属被控面增强）。
- `permission/listFullGrants {}` → `{grants: {sessionId, toolName, createdAt?}[]}`（运行态；形状以桌面 listFullGrants 实际返回为准，读代码后定，DTO 不泄本机敏感面）。
- `permission/revokeAllFull {}` → `{revoked: number}`。

### 1.2 双端实现
- **桌面 face**：permission-tap 新建。listRemembered/revoke 复用 chat.service 既有实现（读代码确认是否挂在 service 上可直接调——注意被控面 deps 注入的是具体子集，可能要经 chatService 公开方法或 repo 直取；若 chat.service 的这三个方法是私有/IPC 内联，则在 deps 注入对应公开方法，勿在 tap 内 new）。full grants 同理。
- **无头端**：toolPermission 表读/删 service+controller（级联：revokeAll=按本人全部空间删除）；full grants 运行态在其 chat-runner/approval 侧——找其 full 授权存储（读代码），补 list/clear。
- 全部 withUserId + 形状校验 + FacePermissionError 码透传（PERMISSION_NOT_FOUND 不需要——幂等 no-op；仅参数非法 INVALID 码）。

### 1.3 移动端
- settings.store 或新 permission.store：list/revoke 两写面（enqueueWrite 串行+防迟到）。
- 设置页「审批通知」区下加「审批记忆」入口 → /permissions 子页：已记住列表（workspaceName/toolName/相对时间）+ 单条撤销 + 全部撤销（Alert 确认）；完全授权区同页下半（list + 全部清空确认）。
- 撤销后本地移除行（不必整页重拉；revokeAll 清空）。

### 1.4 非目标
按工具/空间编辑记忆规则（桌面亦无）；审批通知设置增强；remember 上送改动。

## 2. 测试与验收
- 桌面 tap 用例（列表归属过滤/排序/撤销幂等/全部撤销计数/full grants 形状）。
- 无头端用例 + SDK 显式覆盖 + sdk:generate 重出。
- 移动端 store 用例 + 子页；既有测试零红。
- 根 typecheck + 双仓全量绿；分提交。

## 3. 风险
- **full grants 形状两仓运行态存储不同构**：先读双端代码定最小公共形状，缺的字段可空——不做跨仓重构。
- **幂等语义**：单条撤销不存在也成功是桌面既定行为，两端保持一致（移动端 UI 无需特殊处理）。
