# 移动端工作空间管理批（A8）设计 spec

日期：2026-10-26
状态：调研完成（Explore A8–A11 合并摸底），按最小增量实施
关联：差集 spec `2026-10-25-mobile-desktop-gap.md`（A8 条目）；A1 掩码范式、A5/A7 三段式先例、P1 session 组扩展先例

## 0. 调研关键发现

- **桌面本地写面**（session.repo.ts:308-374 + chat.service.ts）：`workspace:create`（name/icon/defaultModelId/directoryPath）、`workspace:update`（name/icon/defaultModelId，归属校验）、`workspace:delete`（**硬级联**：消息→会话→工作空间，回收会话级路径授权，不删磁盘目录，无事务无最后空间保护）、`workspace:bindDirectory`（**主进程弹系统目录选择框**，IPC 只收 id，渲染层不传路径——防任意路径直写）；解绑=同 repo 方法写 null。
- **directoryPath 双端已透出**：桌面 face（ipc.ts:382-395）与无头端（workspace.service.ts:14-31）的 workspace/query 都返回 `{id,name,directoryPath,defaultModelId}`；协议 `RemoteWorkspaceBrief` 已声明——**移动端 store 映射只取 id/name 丢弃了其余字段**（sessions.store.ts:40-44,271-285）。
- **绑定目录的 GUI 语义不可远程化**：桌面是系统目录选择框；移动端无宿主 GUI，自由传 directoryPath = 远程主机任意路径写面。
- **移动端无 workspace CRUD**：组头只有折叠/组内新建会话；设置页入口现有监控/服务商/资料库/项目/技能/专家/MCP，无工作空间。
- **SDK 契约**：workspace 不在 sdk-contract 自动覆盖组（仅 session/provider/graph/automation+tool/webhook）——新增 workspace 端点须**显式**加 OpenAPI 覆盖期望；ENDPOINTS 任何新段同步 mirror 的 protocol-package 钉测试。

## 1. 本批裁定

### 1.1 端点（workspace 组 4 新段，两端同批）
- `workspace/create {name, icon?, defaultModelId?}` → 概要四字段。**不带 directoryPath**——移动端建空间=库行创建，不涉宿主目录。
- `workspace/update {id, name?, icon?, defaultModelId?}` → 概要四字段；归属校验。
- `workspace/delete {id}` → `null`；**沿用桌面级联语义**（消息→会话→工作空间行，不删磁盘文件）；两级确认文案明示不可恢复。无头端补同语义写面（其 workspace 模块现为只读）。
- ~~`workspace/bindDirectory`~~ **不做**：绑定/解绑留桌面端（系统选择框语义 + 任意路径写面，spec 非目标）。

### 1.2 双端实现
- **桌面 face**：workspace-tap 新建（参照 library-tap/project-tap 模式：withUserId、形状校验、FaceWorkspaceError 码透传）。repo 复用：createWorkspace/updateWorkspace/deleteWorkspace 已是公开方法（session.repo.ts）；delete 前无保护——移动端 UI 用两级确认承担（与桌面 UI 同）。
- **无头端**：workspace module 补 create/update/delete service+controller；**级联语义与桌面对齐**（删消息→删会话→删空间；workspaceId 是 session 列，message 经 sessionId 级联）；SDK 显式覆盖。
- **错误码**：WORKSPACE_NOT_FOUND（归属）、WORKSPACE_INVALID（name 空等）、WORKSPACE_NAME_EXISTS（重名，若桌面 repo 有同名校验则透传其语义）。

### 1.3 移动端
- sessions.store workspace 类型扩 `directoryPath/defaultModelId` 映射（wire 已有，纯投影补齐）；新增 workspace 写面 actions（enqueueWrite 串行 + 防迟到，照 library/project store 模式）。
- **入口放设置页**（workspace 管理子页 /workspaces）：列表（名/icon/默认模型标记/已绑定目录名展示——basename 展示，路径截断）+ 新建（name/icon）/ 重命名 / 删除（Alert 二键确认，文案明示级联不可恢复）/ 点击组头跳转该组。绑定目录行展示「桌面端绑定」标注（不可远程操作）。
- 会话页组头长按/更多菜单加「空间管理」跳转（可选，v1 以设置页入口为准）。

### 1.4 非目标
绑定/解绑目录、openLocal（系统选择框）、默认模型远程切换（defaultModelId 可传但 v1 UI 不做选择器，避免模型列表联动复杂度——只透传字段）。

## 2. 测试与验收
- 桌面：workspace-tap 用例（三字段投影无路径泄露——directoryPath basename？**否**：RemoteWorkspaceBrief 既有契约已透出 directoryPath 原值（A1 前已如此），保持不动；归属校验/删除级联/重名校验）；routes fake 同步。
- 无头端：workspace 写面用例 + sdk 显式覆盖 + sdk:generate 重出。
- 移动端：store 用例（端点映射/串行/防迟到/投影补齐）+ 管理页；既有 407+ 零红。
- 根 typecheck + 双仓全量绿；分提交。

## 3. 风险
- **级联删除不可逆**：两级确认 + 文案明示；与桌面 UI 同语义不新增保护（保持一致性，避免两端行为分叉）。
- **重名语义**：以桌面 repo 现状为准（若无唯一约束则允许重名，不新造校验）。
- **directoryPath 透出**：既有契约行为，本批不动；移动端仅展示 basename。
