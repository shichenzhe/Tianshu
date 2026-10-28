# 项目模块三期实施计划（计划与任务）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 「计划」「任务」两个 Tab 落地：单表 `planItem` 双视图（表格 + dnd-kit 看板）、个人任务聚合清单（本地/项目来源）、自定义字段（option 域复用）。

**Architecture:** 一张 `planItem` 表（projectId null = 本地任务）；计划 Tab = 项目全量（表格默认/看板可切，`?view=`），任务 Tab = `assignee=me ∪ createdBy=me` 聚合；字段定义存 option（type=`planFields:<projectId>`），值存行内 JSON。

**Tech Stack:** 同二期 + **dnd-kit**（`@dnd-kit/core` + `@dnd-kit/sortable`，唯一新依赖）。

**Spec:** `docs/superpowers/specs/2026-09-13-project-module-phase3-design.md`（执行者必读）

## Global Constraints

- 同一/二期：i18n 双语同步、语义色、弹出层 `border-border/50 rounded-lg shadow-lg`、Prettier、IPC 通道进 `IPCChannel` 联合类型、函数 ≤20 行、异常有用提示
- status/priority 枚举校验在 repo 层（裸 IPC 防线）
- 拖拽乐观更新必须可回滚（move 失败还原 + toast）
- `?view=` 与 `?tab=` 共存于同一 query 串——**所有 searchParams 写入必须用合并形式**（`prev => { ...; return prev }`），禁止整串替换（本计划顺带修复既有 switchTab 整串替换的二期 minor）
- 测试基线：当前 master 全量 1034/1034、typecheck/eslint 全绿——每任务保持
- 工作目录：以执行时 controller 指定的 worktree 为准

## 文件结构总览

```
prisma/schema.prisma                                     [改] model planItem
electron/infrastructure/script/v4/upgrade-table.sql      [新]
electron/Constants.ts                                    [改] DATABASE_VERSION 3→4
electron/domains/project/plan-item.entity.ts             [新]
electron/domains/project/plan-item.repo.ts               [新] 8 通道
electron/domains/project/project.repo.ts                 [改] remove 级联 planItem
src-react/lib/ipc.ts                                     [改] 8 通道
src-react/domains/project/api/plan-item.api.ts           [新]
src-react/domains/project/components/PlanPane.tsx        [新]
src-react/domains/project/components/PlanTableView.tsx   [新]
src-react/domains/project/components/PlanKanbanView.tsx  [新]
src-react/domains/project/components/PlanItemDialog.tsx  [新]
src-react/domains/project/components/TasksPane.tsx       [新]
src-react/domains/project/components/CustomFieldsEditor.tsx [新]
src-react/domains/project/views/ProjectWorkspaceView.tsx [改] 两 Tab 接入 + switchTab 合并式
src-react/i18n/locales/{zh-CN,en-US}/project.json        [改] plan.*/tasks.*
package.json                                             [改] dnd-kit 依赖
tests/project/plan-item-repo.test.ts 等                  [新]
```

---

### Task 1: v4 迁移 + dnd-kit 依赖 spike

**Files:**
- Modify: `prisma/schema.prisma`（model planItem，字段/索引照 spec §3.1 逐字）
- Create: `electron/infrastructure/script/v4/upgrade-table.sql`（CREATE TABLE IF NOT EXISTS + 两索引，`--/p`/`--/ignore` 惯例）
- Modify: `electron/Constants.ts`（DATABASE_VERSION = 4）
- Modify: `package.json`（`npm i @dnd-kit/core @dnd-kit/sortable`——spike：安装成功 + 一个最小 jsdom DnD 测试跑通即通过；失败报告 BLOCKED 由 controller 启动退路）

**Interfaces:**
- Produces: planItem 表 + dnd-kit 可用（T7 依赖）

- [ ] schema/SQL/Constants 三处 + prisma generate + typecheck
- [ ] dnd-kit 安装 + 冒烟（临时 minimal 测试验证 import 与核心 API 在 vitest/jsdom 可用，跑通后删除临时代码）
- [ ] 提交 `feat(project): 数据库 v4——planItem 表 + dnd-kit 依赖`

---

### Task 2: plan-item.entity + repo 核心（TDD）

**Files:**
- Create: `electron/domains/project/plan-item.entity.ts`、`electron/domains/project/plan-item.repo.ts`
- Modify: `electron/Application.ts`（接线）、`src-react/lib/ipc.ts`（8 通道）、`electron/domains/project/project.repo.ts`（remove 级联 +1 行）
- Test: `tests/project/plan-item-repo.test.ts`

**Interfaces（前后端契约，T4/T5+ 消费）:**

```ts
export const PLAN_STATUSES = ["not_started", "in_progress", "paused", "done"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export const PLAN_PRIORITIES = ["P0", "P1", "P2"] as const;
export type PlanPriority = (typeof PLAN_PRIORITIES)[number];
export interface PlanItemRecord {
  id: number; projectId: number | null; title: string;
  status: PlanStatus; priority: PlanPriority; assigneeId: number | null;
  tags: string[]; customFields: Record<string, string | number>;
  sortOrder: number; createdById: number;
  createdAt: string; updatedAt: string; // ISO
}
export interface PlanItemCreateParams {
  createdById: number; title: string; projectId?: number;
  status?: PlanStatus; priority?: PlanPriority; assigneeId?: number;
  tags?: string[]; customFields?: Record<string, string | number>;
}
export interface PlanItemUpdateParams {
  id: number; title?: string; status?: PlanStatus; priority?: PlanPriority;
  assigneeId?: number | null; tags?: string[];
  customFields?: Record<string, string | number>;
}
export interface PlanItemMoveParams { id: number; status: PlanStatus; sortOrder: number; }
// IPC：
// planItem:list (projectId) => PlanItemRecord[]        sortOrder asc, updatedAt desc
// planItem:listMine (userId) => PlanItemRecord[]       OR 聚合, updatedAt desc
// planItem:create (params) => PlanItemRecord           枚举校验; sortOrder=同状态列 max+1
// planItem:update (params) => void                     枚举校验; id 不存在抛 PLAN_ITEM_NOT_FOUND
// planItem:delete (id) => void
// planItem:move (params) => void                       存在性校验
```

- [ ] 失败测试：create 枚举拒绝（非法 status/priority 抛中文错误）/ title 空 trim 拒绝；list 排序谓词；listMine 的 `OR: [{ assigneeId }, { createdById }]` 精确断言（含本地行）；update 局部字段（未传字段不覆盖——data 只含传入键）；move 更新 status+sortOrder；create 的 sortOrder=max+1；project remove 级联断言（扩 project-repo.test）
- [ ] 实现（JSON 列 tags/customFields 读写解析 + 容错：畸形 JSON → 空数组/空对象）
- [ ] typecheck + eslint + 全量 + 提交 `feat(project): 计划事项仓储——单表双视图聚合/枚举校验/拖拽落点/项目级联`

---

### Task 3: plan-item.repo 自定义字段（TDD）

**Files:**
- Modify: `electron/domains/project/plan-item.repo.ts`（fields 两方法）
- Test: `tests/project/plan-item-repo.test.ts`（扩展）

**Interfaces:**
- `planItem:fields:list (projectId) => PlanFieldDef[]`——读 option `type="planFields:<projectId>"`（name/value=字段名，note=类型），按 name 排序
- `planItem:fields:save (projectId, fields: PlanFieldDef[]) => void`——全量替换（diff：删 option 行 + 建新行）；**删除的字段**同步清理该项目全部 planItem 行的 customFields 键（逐行 update，失败收集不中断）；重命名视为删旧建新（同清理）
- `PlanFieldDef { name: string; type: "text" | "number" | "date" }`（entity 里定义）

- [ ] 失败测试：save 全量替换的 diff 行为；删除字段触发值清理（断言逐行 update 的 customFields 不含被删键）；类型非法拒绝；list 排序
- [ ] 实现 + 全量 + 提交 `feat(project): 计划自定义字段——option 域字段定义 + 行内值同步清理`

---

### Task 4: plan-item.api + i18n（TDD 轻量）

**Files:**
- Create: `src-react/domains/project/api/plan-item.api.ts`（静态类 8 方法）
- Modify: `src-react/i18n/locales/{zh-CN,en-US}/project.json`（`plan.*`：viewTable/viewKanban/title/status/handleMan/priority/tags/add/addField/edit/delete/empty/confirmDelete/search/filterStatus/filterPriority/filterTag/status.notStarted/status.inProgress/status.paused/status.done/priority.P0-P2/me/fieldType/fieldText/fieldNumber/fieldDate/manageFields/fieldName/sortOrderSaved；`tasks.*`：listMine? no——mine/all/assigned/created/filterSource/allSource/local/project/privateTip/search/newLocalTask/fromLocal；约 45 key 双语）

**Interfaces:**
- `PlanApi` 命名冲突注意：类名 `PlanItemApi`；query keys：`["planItems", projectId]` / `["planItemsMine", userId]` / `["planFields", projectId]`

- [ ] api 封装（通道/参数与 Task 2/3 一致）+ i18n 双语齐
- [ ] 全量 + 提交 `feat(project): 计划/任务 API 封装 + plan/tasks i18n 双语言`

---

### Task 5: PlanItemDialog + CustomFieldsEditor（TDD）

**Files:**
- Create: `src-react/domains/project/components/PlanItemDialog.tsx`、`src-react/domains/project/components/CustomFieldsEditor.tsx`
- Test: `tests/project/plan-item-dialog.test.tsx`

**Interfaces:**
- `PlanItemDialogProps { open, onOpenChange, projectId: number | null（null=本地任务）, item?: PlanItemRecord（编辑）, onSaved: () => void }`
- 字段：标题（必填 ≤100）/ 状态 Select 四态 / 优先级 Select（P0 红色 P1 主题色 P2 灰色 Badge 预览）/ 标签（Input 回车添加 → Tag 可移除 + datalist 式候选：来自 `["planItems", projectId]` 缓存聚合的已有标签）/ 处理人只读"我" / 自定义字段动态区（按 `["planFields", projectId]` 渲染 text=Input number=Input[type=number] date=Input[type=date]，仅 projectId 非空显示）
- `CustomFieldsEditor`（字段定义管理弹窗）：字段行（名称 + 类型 Select + 删除）+ 添加行 + 保存 → `fields:save` → invalidate planItems+planFields → 删除字段的值清理由后端完成，toast 提示"已保存（若删除字段将清理各行对应值）"
- 保存：create（新）或 update（编辑）→ invalidate 双 key（planItems/planItemsMine）→ toast + onSaved

- [ ] 失败测试：空标题禁用/提交拒绝；编辑回填各字段；标签添加/移除/候选出现；自定义字段按定义渲染三种类型；保存调用正确通道与参数；本地任务（projectId null）无自定义字段区
- [ ] 实现 + 全量 + 提交 `feat(project): 计划事项弹窗——新建/编辑共用 + 自定义字段动态渲染 + 字段定义管理`

---

### Task 6: PlanPane + PlanTableView（TDD）

**Files:**
- Create: `src-react/domains/project/components/PlanPane.tsx`、`src-react/domains/project/components/PlanTableView.tsx`
- Modify: `src-react/domains/project/views/ProjectWorkspaceView.tsx`（plan Tab 接入 `<PlanPane projectId={...}/>` + **switchTab 改合并式** `setSearchParams(prev => { prev.set("tab", v); return prev; }, { replace: true })`）
- Test: `tests/project/plan-table.test.tsx`

**Interfaces:**
- `PlanPaneProps { projectId: number }`：视图切换（`?view=table|kanban` **合并式**写入，缺省 table）+ 工具栏（筛选：状态/优先级/标签 DropdownMenu 多选；搜索 Input）+ 「添加」按钮（PlanItemDialog）+ 视图渲染
- `PlanTableViewProps { items: PlanItemRecord[]; fields: PlanFieldDef[]; onEdit; onDelete; onQuickCreate(title); onFieldClick(编辑该行该字段——Select/Inline) }`
  - 列：标题（点击=onEdit）| 状态（行内 Select 四态，切换即 update）| 处理人（"我"）| 优先级（行内 Select，色徽标）| 标签（Badge 组）| 动态自定义字段列（fields 逐列；值缺失显示 --）| 行 `...` 菜单（编辑/删除 AlertDialog）
  - 表头自定义字段列尾部 `+` → CustomFieldsEditor；顶部快速新增行（Input，回车 onQuickCreate）
- 筛选/搜索为客户端过滤（PlanPane 计算后传入表格）

- [ ] 失败测试：表格渲染全列；行内状态/优先级 Select 切换调 update；快速新增回车调 create；筛选组合过滤；搜索；动态列渲染与缺值 --；视图切换写 `?view=` 且**保留 `?tab=plan`**（断言 URL）；switchTab 改合并式后切 Tab 不丢 view（回归断言）
- [ ] 实现 + 全量 + 提交 `feat(project): 计划表格视图——行内编辑/快速新增/动态自定义列/筛选搜索 + Tab 切换合并式 query`

---

### Task 7: PlanKanbanView（TDD）

**Files:**
- Create: `src-react/domains/project/components/PlanKanbanView.tsx`
- Test: `tests/project/plan-kanban.test.tsx`

**Interfaces:**
- `PlanKanbanViewProps { items: PlanItemRecord[]; onMove(params: PlanItemMoveParams): Promise<void>; onQuickCreate(status: PlanStatus): void; onEdit(item): void }`
- 四列（PLAN_STATUSES 序）：列头 = 状态名 + 计数 Badge + 列内 `+`；卡片 = 优先级左色条（P0 destructive/P1 primary/P2 muted）+ 标题 + 标签 Badge + "我"头像点
- dnd-kit：`DndContext` + 每列 `useDroppable`（id=status）+ 卡片 `useSortable`（SortableContext id=String(item.id)）；`onDragEnd` 计算 target status 与 insertion index → `sortOrder`（目标列重排：插入位前半/后半均值或全列重编号）→ onMove
- **乐观更新与回滚**：父层（PlanPane）维护 items 状态（query 缓存 setQueryData 即时重排），onMove reject → invalidate 还原真值 + toast（"sortOrderSaved"/失败 toast）
- 应用 PlanPane 的筛选/搜索（过滤后仍可拖拽——被过滤卡片不参与，目标列序号按可见序列计算）

- [ ] 失败测试：四列渲染与计数；卡片字段渲染；模拟 dragEnd（dnd-kit jsdom：直接调用封装的 handleDragEnd 或 fireEvent 拖拽事件）→ onMove 参数正确（status + 合理 sortOrder）；move reject → invalidate 被调（回滚）；列头 + 调 onQuickCreate(status)
- [ ] 实现 + 全量 + 提交 `feat(project): 计划看板视图——dnd-kit 四态泳道拖拽/列内重排/乐观更新回滚`

---

### Task 8: TasksPane（TDD）

**Files:**
- Create: `src-react/domains/project/components/TasksPane.tsx`
- Modify: `src-react/domains/project/views/ProjectWorkspaceView.tsx`（tasks Tab 接入 `<TasksPane />`）
- Test: `tests/project/tasks-pane.test.tsx`

**Interfaces:**
- 数据 `useQuery(["planItemsMine", user.id], () => PlanItemApi.listMine(user.id))`；项目名解析：`useQuery(["projects", user.id])` 缓存 map（projectId → name）
- 顶部：私密提示灰字（`plan:tasks.privateTip`）+ 筛选下拉（mine 全部/assigned 指派给我的/created 我创建的）+ 来源下拉（allSource/local/project）+ 搜索 + 「新建本地任务」按钮（PlanItemDialog projectId=null）
- 列表项：状态小徽标 + 标题 + 优先级色点 + 来源 Badge（projectId null → `fromLocal`；否则项目名）+ 相对时间；点击：本地 → PlanItemDialog 编辑；项目任务 → `navigate(/module/project/<id>?tab=plan)`（合并式 query）
- 空态文案

- [ ] 失败测试：列表渲染（来源 Badge 本地/项目名分流）；assigned/created 筛选谓词；来源筛选；搜索；本地任务行点击开弹窗、项目任务行点击导航；新建本地任务按钮弹窗（projectId null）
- [ ] 实现 + 全量 + 提交 `feat(project): 任务清单——个人聚合/来源标识/筛选搜索/本地任务创建`

---

### Task 9: 收尾——全量验证 + 手动验收清单

- [ ] `npm run typecheck && npm run lint && npm run test` 全绿
- [ ] 写 `docs/superpowers/manual-acceptance-2026-09-14-project-module-phase3.md`（照二期清单格式）：
  - 计划：添加事项（弹窗全字段）→ 表格行内改状态/优先级 → 快速新增 → 标签添加/候选 → 自定义字段三型 + 表头管理（增/改名/删 + 值清理）→ 筛选组合 + 搜索 → 切看板（URL 保 tab）→ 拖拽跨列/列内 + 计数 + 失败回滚 → 列头快速新增
  - 任务：新建本地任务 → 列表来源标识（本地/项目名）→ assigned/created 筛选 → 项目任务点击跳转 → 私密提示
  - 删除项目 → 其 planItem 清空、本地任务保留
  - 中英文/主题回归
- [ ] 提交 `docs(project): 项目模块三期手动验收清单`

---

## 自审记录

1. **Spec 覆盖**：§2 单表/四态/字段 option 复用/dnd-kit/预留 assignee → T1-T3/T7；§3.4 两视图与工具栏 → T6/T7；§3.5 任务 Tab → T8；§3.6 弹窗 → T5；§4 错误表 → T2（枚举）/T5（校验）/T3（清理失败收集）/T7（回滚）；§6 风险 1（dnd spike）→ T1；风险 3（项目名解析）→ T8。无缺口。
2. **占位符**：T1 dnd spike 与 T7 乐观回滚为实现性步骤含明确退路；无 TBD。
3. **类型一致性**：PlanItemRecord/PlanFieldDef/各 Props 在定义任务（T2/T3/T5/T6/T7/T8）间签名一致；query key 三组（planItems/planItemsMine/planFields）全局唯一定义于 T4，后续任务引用。
4. **已知衔接点**：ProjectWorkspaceView 被 T6/T8 两次小改（各自只加自己的 Tab 接入）——先后串行无冲突；switchTab 合并式在 T6 一次完成，T8 的 navigate 也用合并式（Global Constraint 已约束）。
