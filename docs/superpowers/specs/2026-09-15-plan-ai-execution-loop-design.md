# 项目计划模块 · 子系统 F：AI 执行闭环 — 设计文档

- **日期**：2026-09-15
- **状态**：已与用户逐节确认；端到端授权自动执行
- **来源**：PRD 后续深化（用户提出「任务只是记录清单，如何让 AI 推进」）；WorkBuddy 解包佐证（todo_write 全量写入 + workSummary 跨会话携带 + @todo 引用注入）
- **范围**：子系统 F（A–E 已交付合并）；产品定位升级——**「AI 驱动为主，人维护为辅」**：计划清单从人工台账转为 AI 的任务看板，人轻维护

## 已确认的关键决策

1. **工具范围（增量写、永不删）**：`plan_create_item` / `plan_update_status` / `plan_append_summary` 三工具；AI 可建可推进，**删除权独占归人**；append_summary 只增不改（审计轨迹）。不采用 WorkBuddy 的全量替换单工具——天枢 planItem 是用户手工维护的一等实体，全量替换一次幻觉即覆盖全清单且级联附件。
2. **工具注册门槛**：仅 `session.projectId` 非空的项目会话注册三工具（AI 模块全局会话零暴露）。
3. **aiSummary 只归 AI**：v8 加列；人的编辑路径（弹窗/行内/表格）不含此字段；只能经 append_summary 工具追加。
4. **双入口**：底栏对话主场（#N 引用 + 工具自主调用）+ 任务行「AI 推进」按钮（列表行 hover Sparkles + 表格行尾菜单项）→ 预填 store → ChatInput 消费聚焦（底栏贯穿四 Tab 无需切页）。
5. **#待办引用增强**：PendingFile content 追加 `[进展]` 块（aiSummary 全文，超长取最近 10 行）；无 aiSummary 行为不变。
6. **呈现**：列表行 aiSummary 徽标（Sparkles，title 悬浮最近一行）+ source==="ai" Badge（列表行首/表格标题旁）；弹窗只读「AI 进展」折叠区；AI 写入经 PLAN_ITEMS_KEY 失效全视图实时反映。

## §1 工具组与权限（agent 工具层）

```ts
// 仅项目会话注册（session.projectId 非空）；projectId 一律取 session.projectId（防跨项目写入）
plan_create_item({ title, priority?, dueDate?, tags? })
  → planItem:create（source: "ai"，assignee 默认当前用户=会话归属）
  → 结果：{ id, title }（供 AI 后续 #N 引用）

plan_update_status({ id, status })
  → 校验任务属本项目；走 planItem:move（sortOrder 列尾）
  → 结果：流转确认；不存在/跨项目 → 中文错误返回模型

plan_append_summary({ id, text })
  → aiSummary = (旧值 ? 旧值 + "\n" : "") + `[${yyyy-MM-dd}] ${text}`
  → 结果：追加后摘要
```

- 三工具均按**写工具**归档走既有权限框架（toolPermission + 权限胶囊）：默认模式首次确认、全权放行。
- 工具 schema 描述写明闭环习惯：「推进后应调用 append_summary 记录进展；任务以 #<id> 引用」。
- 每次写后失效 `PLAN_ITEMS_KEY(projectId)` + `PLAN_ITEMS_MINE_KEY`（双 key，T4 契约）。

## §2 数据层与引用增强

- v8：`ALTER TABLE planItem ADD COLUMN aiSummary TEXT NULL` + prisma 同步 + DATABASE_VERSION 7→8。
- `PlanItemRecord.aiSummary: string`（null 容错归一空串）；Create/Update 参数**不加**该键（负向保证）。
- `#待办` PendingFile：`【待办】标题｜状态…` 后追加 `\n[进展]\n${aiSummary 末 10 行}`（非空时）。

## §3 双入口与呈现

- **plan-advance.store.ts**（zustand）：`{ prompt: string | null; setPrompt; consume }`；ChatInput 挂载 + subscribe 消费一次即清，预填 content 并 focus（consumePendingPrompt 先例模式）。
- 列表行：hover Sparkles 按钮（aria-label AI 推进）→ `setPrompt("请推进 #<id>《title》：结合项目上下文与此任务的进展记录，推进下一步工作，并更新任务状态与进展。")`；PlanListView 加 `onAiAdvance(item)` 回调，PlanPane 接 store。
- 表格：行尾菜单加「AI 推进」项（同回调）。
- 徽标：列表行 aiSummary 非空 → 常驻 Sparkles（title=最近一行）；source==="ai" → 行首/标题旁 `AI` Badge（secondary）。
- 弹窗：描述区下只读「AI 进展」折叠区（aiSummary 非空才渲染，whitespace-pre-wrap）。

## §4 测试与验收

测试：v8 schema；entity/repo aiSummary 透传 + 人路径负向；工具组（注册门槛/create-source/move/追加语义/中文错误/双 key 失效/权限两态）；#待办 [进展] 块与 10 行截断；入口（store 写入/消费即清/预填聚焦/列表按钮/表格菜单）；呈现（徽标/Badge/弹窗折叠区）；回归（全局会话工具集不变/五视图/底栏）。

手动验收：对话推进任务全链路（状态变+徽标+进展入 prompt）；批量建任务带 AI Badge；行按钮预填聚焦；弹窗进展区；全局会话无 plan-item 工具；默认权限弹确认。

## 与既有模块的衔接

- E 定时任务：可后续组合（定时任务触发时 AI 也可用 plan-item 工具推进清单——工具注册门槛已覆盖，本阶段不专门做）。
- 遗留 backlog（孤儿清理/本地化/a11y）不受影响，继续排队。
