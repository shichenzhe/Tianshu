# 项目计划模块 · 子系统 E：项目级定时任务 — 设计文档

- **日期**：2026-09-15
- **状态**：已与用户确认（方案 a + WorkBuddy 实现佐证）；端到端授权自动执行
- **来源 PRD**：§5.5 定时任务「让 AI 按计划自动执行任务」
- **范围**：子系统 E（最后一个）；A–D 已交付合并 master
- **参考**：WorkBuddy（本机解包）——结果走独立可回看线程而非主对话流；项目关联用引用列；逐版 ADD COLUMN 演进

## 已确认的关键决策

1. **方案 a 浅集成**：`automationTask` 加 `projectId`；动态流单会话模型不动；运行结果独立会话（归属项目，AI 侧边栏不可见=隔离约定），回看经任务详情运行历史。
2. **项目指令注入**：executeTask 在 task.projectId 非空时读 project.systemPrompt 注入 system prompt（buildSystemPrompt 既有 prompt 通道，执行时核对接线）。
3. **list 通道不改**：hydration 带出 projectId，前端过滤（FilterMenu 先例）。
4. **级联删除**：删项目 → 级联删项目 automationTask。
5. **不换调度格式**（scheduleJson/scheduler 保持），不做推送渠道/多工作目录（YAGNI）。

## §1 数据模型与运行链路（v7）

- v7：`ALTER TABLE automationTask ADD COLUMN projectId INTEGER NULL` + 索引 `automation_task_projectId_index`；prisma schema 同步；DATABASE_VERSION 6→7。
- `TaskRecord` hydration 带出 `projectId: number | null`；`TaskCreateParams/TaskUpdateParams` 加 `projectId?: number | null`（update null = 解除项目关联）。
- runner `createSession`：`projectId: task.projectId ?? null`。
- runner system prompt：`task.projectId` 非空 → `prisma.project.findUnique({ where: { id } })` 取 systemPrompt → `buildSystemPrompt(project.systemPrompt || undefined, skills)`；null → 原行为（`buildSystemPrompt(undefined, skills)`）。
- `project.repo.remove()`：级联链补 `prisma.automationTask.deleteMany({ where: { projectId: id } })`（置 planItemAttachment 级联后）。

## §2 ConfigPanel 定时任务区块

- 数据：`useAutomationTasks()`（`AutomationApi.list()` 缓存）按 `task.projectId === detail.project.id` 前端过滤。
- UI：区块头（Clock + 「定时任务」+ 新建按钮 + 「前往自动化」链接）；列表行 = 名称（点击 navigate `/module/ai/automation/task/:id`）+ scheduleText + 状态徽标（运行中/已暂停/错误）+ 上次运行相对时间 + 启停 Switch（`AutomationApi.toggle` + 失效 `automation` 缓存键 + 失败 toast）+ 立即运行按钮（`AutomationApi.runNow`；TASK_ALREADY_RUNNING 冲突 toast 中文映射）。
- 空态：muted「暂无定时任务」+ 新建按钮。
- i18n：`panel.automationEmpty` 等 key 双语言；复用 automation 域既有状态文案 key（跨命名空间引用 `ai:automation.*` 或复制——执行时按现有跨域引用先例定）。

## §3 CreateTaskDialog 项目预设

- 可选 prop `projectId?: { id: number; workspaceId: number; workspaceName: string }`（ConfigPanel 由 detail 组装传入）。
- 传入时：workspace Select 禁用且显示 `workspaceName`（跳过 workspace:list 查询，值直接锁 `workspaceId`）；默认模型联动跳过（锁定空间无 defaultModelId 时维持现必选交互）；create/update 载荷携带 `projectId: id`。
- 未传：行为完全不变（AI 模块零 diff）。
- prompt @ 资产文件：TaskPromptInput 的 workspaceId 即项目资产空间，天然支持。

## §4 测试与验收

- `automation-v7-schema.test.ts`：列存在/索引/幂等。
- automation-repo 测试追加：create/update 透传 projectId、hydration 带出；runner 测试追加：projectId 非空 → project 查询 + buildSystemPrompt 收到项目指令 + session.create data 含 projectId；null → 不查 project、行为不变。
- project-repo 级联断言追加。
- ConfigPanel 组件测试：过滤（他项目/无项目任务不显示）、启停（toggle 调用+失效）、立即运行（runNow/冲突 toast）、新建（弹窗打开且 workspace 锁定）、任务名跳转、空态。
- CreateTaskDialog 预设测试：锁定/载荷/未传回归。
- 手动验收：项目下建「每日汇报」→ 立即运行 → 运行会话属项目（AI 侧边栏不可见、任务详情可回看）、system prompt 带项目指令、@ 资产文件可引用；ConfigPanel 状态实时同步；删除项目任务级联清理。

## 与既有子系统的衔接

无后置子系统；PRD §1–6 至此全部覆盖（§5 其余四项已于 A 阶段交付）。
