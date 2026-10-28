# 项目计划模块 · 子系统 D：弹窗增强 + 底部全局操作栏 — 设计文档

- **日期**：2026-09-14
- **状态**：已与用户逐节确认；用户授权端到端自动执行（spec 审阅与合并按既定模式自动走）
- **来源 PRD**：项目计划模块（补充与进阶功能）§4 / §6
- **范围**：子系统 D（A–E 五个子系统中的第四个）；A/B/C 已交付合并 master

## 背景

PRD §4 要求新建待办弹窗增强（描述/属性胶囊化/附件/全屏），§6 要求贯穿全部 Tab 的底部 AI 输入栏。现状：PlanItemDialog 已有全属性表单式编辑（无描述无附件）；动态流 Tab 内 ChatInput 已具备 @ 文件/⚡技能、PlusMenu、权限胶囊、模型选择——与 PRD 操作栏能力几乎重合，缺 @ 项目待办。

## 已确认的关键决策

1. **附件 = `planItemAttachment` 新表 + 资产空间 `attachments/` 子目录**：上传与从资产树挑选同构（都是一行关联记录）；文件实体走 asset 域既有上传通道；删事项级联删关联但**保留实体文件**；上传后取消新建产生的孤儿文件可接受。
2. **描述 = textarea + Markdown 预览开关**：存 Markdown 原文（v6 `description` 列）；预览复用 ai 域 MarkdownView；描述仅在弹窗内编辑/查看。
3. **操作栏 = ChatInput 工作台级提升（方案一）**：从 ChatPane 拆出、提到 ProjectWorkspaceView 底部贯穿四 Tab；发送进入本项目动态流会话；新增 @ 项目待办引用；「本地任务」做 PlusMenu 开关（prompt 注入）；权限胶囊=PRD「默认权限」；「工作空间」即当前项目不做选择器。
4. **发送链路单一来源**：同一会话同一输入框，ChatPane 退化为消息列表区。

## §1 数据模型（v6 迁移）

```sql
ALTER TABLE planItem ADD COLUMN description TEXT NULL;
CREATE TABLE IF NOT EXISTS planItemAttachment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    planItemId INTEGER NOT NULL,
    fileName TEXT NOT NULL,          -- 展示名（含扩展）
    assetPath TEXT NOT NULL,         -- 项目 workspace 相对路径
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS plan_item_attachment_planItemId_index ON planItemAttachment (planItemId);
```

- entity：`PlanItemRecord.description: string`（null 容错归一空串）；Create/Update 加 `description?: string | null`（update null = 清空）。
- `PlanItemAttachmentRecord { id; planItemId; fileName; assetPath; createdAt(ISO) }`。
- 通道（plan-item.repo）：`planItem:attachments:list(planItemId)` / `planItem:attachments:create(planItemId, { fileName, assetPath })` / `planItem:attachments:delete(id)`。
- 级联：删事项 → 关联级联删（plan-item.repo.remove）；删项目 → 级联（project.repo 补一行）。
- 新建态附件本地暂存，保存事项成功后批量 create。
- prisma schema 同步（planItem.description + planView 后新 model）；DATABASE_VERSION 5→6。

## §2 弹窗增强（PlanItemDialog 改版）

1. 标题（不变）。
2. 描述 textarea（4 行）+ 右上「预览」开关 → MarkdownView（`@/domains/ai/chat/components/MarkdownView`）。
3. **属性胶囊行**（替代表单 grid）：状态/处理人/优先级/标签/时间规划五胶囊，各点开 Popover 收纳原控件；胶囊显示当前值摘要（无值显示字段名 muted）；本地任务处理人仍只读「我」。
4. 自定义字段动态区（保留）。
5. 附件区：回形针菜单「上传文件 / 从资产挑选」；chips（文件名 + 删除）；新建暂存/编辑直连（§1）。
6. 右上全屏切换：`maximized` state 切 Dialog className（全屏 `h-[100dvh] w-screen max-w-none rounded-none`）；Esc 在全屏态先退全屏、非全屏态关弹窗。
7. footer 不变（form Enter 提交）。
8. 顺带：私有 `toIsoOrNull` 替换 `dateKeyToIso`（消重复，D backlog）。

## §3 底部全局操作栏

- ProjectWorkspaceView 主区改 flex-col：Tab 内容区 flex-1 + 底部输入栏（border-t border-border/50）。
- ChatInput 从 ChatPane 提升；ChatPane 退化为消息列表区；ActivityPane/ChatPane props 接线同步；输入状态单一来源。
- ChatInput 增强：
  - **@ 项目待办**：@ 子菜单新增引用类（与 @ 文件/⚡技能并列），数据源 `PLAN_ITEMS_KEY(projectId)` 缓存（标题列表），选中成 pill token 进输入随 prompt 发送。
  - **「本地任务」开关**：PlusMenu toggle（默认关 = 存项目）；开启时发送 prompt 注入「用户要求：本次创建的待办存储为本地任务」。
  - placeholder 换 PRD 文案（今天帮你做些什么？@ 引用资产文件、项目待办或调用技能）。
- 动态流 Tab：消息区占满。

## §4 测试与验收

**测试**：

- `plan-item-v6-schema.test.ts`：description 列、建表幂等、索引；级联断言（repo 测试：删事项关联删；project.repo 级联）。
- plan-item-repo.test.ts 追加：attachments 三通道、级联；entity description 透传（create/update/null 清空）。
- plan-item-dialog.test.tsx 扩展：描述/预览切换；五胶囊开合与摘要；全屏 class；附件 chips/删除；新建暂存→保存批量 create；编辑直连。
- ai 域 ChatInput 相关测试：@ 待办菜单与 pill、PlusMenu 本地任务开关；ChatPane 拆分后的回归更新。
- project-workspace.test.tsx：底栏贯穿（计划 Tab 下输入框在）、动态流 Tab 无第二输入、消息区在。

**手动验收**：

1. 弹窗：Markdown 预览、五胶囊、全屏、附件上传/挑选/删除、保存重开一致；删事项资产文件仍在。
2. 底栏：四 Tab 恒在；@ 含项目待办成 pill；本地任务开关 → AI 建待办落任务 Tab 本地；权限胶囊照常。
3. 动态流：消息区占满、单输入源。

## 与后续子系统的衔接

- **E**（项目级定时任务）：无依赖；操作栏的 @ 引用后续可扩展 @ 自动化任务。
