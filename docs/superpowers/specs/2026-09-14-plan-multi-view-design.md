# 项目计划模块 · 子系统 A：数据基础 + 多视图框架 — 设计文档

- **日期**：2026-09-14
- **状态**：已与用户逐节确认
- **来源 PRD**：项目计划模块（补充与进阶功能）
- **范围**：子系统 A（共 A–E 五个子系统中的第一个）

## 背景

「补充与进阶功能」PRD 涵盖六个子系统，已确认分解为五个阶段逐个走「spec → 计划 → 实现」循环：

- **A. 数据基础 + 多视图框架**（本文档）
- **B. 高级筛选与搜索**（组合筛选器 UI 深化）
- **C. 三种新视图**：列表 → 日历（含农历）→ 甘特（拖拽调期）
- **D. 新建弹窗增强 + 底部全局操作栏**（@ 引用输入栏）
- **E. 项目级定时任务**（automationTask 项目化，挂进 ConfigPanel）

现状：表格/看板视图已有（`PlanTableView`/`PlanKanbanView`，`?view=` 切换），但视图无持久化、planItem 无日期/来源字段、处理人恒为当前用户。

## 已确认的关键决策

1. **严格视图语义**：视图 = 展示类型 + 筛选/排序/分组配置的组合；视图不复制数据，所有视图共享当前项目 `planItem`。v1 不做「导入数据源」。
2. **显式保存模型**：临时调整存 draft 态；`...` 菜单提供「保存为新视图」「覆盖保存」；切换视图/刷新丢弃未保存调整。
3. **看板通用分组**：`分组依据` 可选 状态/优先级/处理人；拖拽跨列写回对应字段。
4. **处理人多人指派打通**：assigneeId 真正可用，弹窗与行内编辑提供项目成员选择器。
5. **planItem 字段扩展**：`startDate`/`dueDate`、`source(manual|ai|template)`、优先级枚举加 P3。
6. **删除保护**：最后一个视图不可删（项目至少保留一个视图）；默认视图可删、可改名、可覆盖保存。
7. **持久化形态**：独立 `planView` 表（一等公民）+ 客户端筛选引擎（单机数据量级下不做服务端筛选）。
8. **排序与列配置 UI 后置**：`sortJson` 数据结构与引擎本期就绪，排序控件 UI 后置（同 `reorder` 通道处理）；表格列配置（columnConfig）本期不做。

## 数据模型（prisma/schema.prisma）

### planItem 扩展

```prisma
startDate   DateTime?                       // 甘特/日历地基
dueDate     DateTime?
source      PlanItemSource @default(manual) // 新枚举: manual | ai | template
priority    PlanPriority  @default(P1)      // 枚举扩展: P0 | P1 | P2 | P3
```

- `assigneeId` 已存在，无 schema 改动。
- SQLite 枚举存 TEXT：`source` 新列带 default 可安全 `ALTER TABLE ADD COLUMN`；`priority` 加 P3 无需迁移。

### 新表 planView

```prisma
model planView {
  id         String   @id @default(cuid())
  projectId  String
  name       String
  type       String   // table | kanban | list | gantt | calendar
  groupBy    String?  // status | priority | assignee（看板分组依据）
  filterJson String   @default("{}")
  sortJson   String   @default("[]")
  sortOrder  Int      @default(0)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  @@unique([projectId, name])
  @@index([projectId])
}
```

- 无 `isDefault` 字段（YAGNI：播种用判空幂等、删除保护用「最后一个不可删」、旧路由映射用 type 匹配）。
- 项目删除级联删除视图（沿用 project.repo 现有级联模式）。
- `@@unique(projectId, name)`：重名时自动生成「(n)」后缀。

### 数据库版本 1 → 2

新增 `script/v2`：planItem 加两列（startDate/dueDate/source）+ 建 planView 表，走现有版本管理器执行。

## 主进程（electron/domains/project）

新文件 `plan-view.entity.ts` + `plan-view.repo.ts`（沿用 entity+repo 模式）。IPC 通道：

| 通道 | 行为 |
|---|---|
| `plan-view:list` | 返回项目全部视图；**返回空时懒播种**「表格」「看板」两条（事务，幂等，兼容 v1 老项目） |
| `plan-view:create` | 创建视图；重名自动加「(n)」后缀 |
| `plan-view:update` | 改名 / 改 type / 覆盖保存 filterJson·sortJson·groupBy |
| `plan-view:delete` | 项目仅剩此一条时拒绝，返回「至少保留一个视图」可读错误 |
| `plan-view:reorder` | 批量更新 sortOrder（本期通道就绪，UI 后置） |

`plan-item` 通道调整：

- create/update 透传 `startDate`、`dueDate`、`source`（缺省 manual）。
- `assigneeId` 赋值增加成员资格校验（必须是该 project 的 projectMember），非法指派返回明确错误。

容错：读取时 `filterJson/sortJson` 解析失败静默降级为空配置并记 Winston 日志。

## 前端

### 筛选引擎（纯函数）`src-react/domains/project/model/plan-view-engine.ts`

```ts
type FilterCondition = {
  field: "title" | "status" | "assigneeId" | "source" | "priority" | "tags";
  op: "contains" | "in" | "notIn" | "isMe";
  value: string | string[];
};

filterItems(items, conditions, searchKeyword) → Item[]  // 搜索与筛选叠加，AND 语义
sortItems(items, sortRules) → Item[]
groupItems(items, groupBy) → { key, label, items }[]    // 看板分组/列表折叠共用
```

- 搜索框不是 condition，是独立参数。
- 引擎是 C 阶段三种新视图的共享地基。
- 非法配置降级为空配置（防御式入口）。

### 视图状态 `plan-view.store.ts`（Zustand + React Query）

- `views[]` 走 React Query；增删改乐观更新 + 失败回滚（沿用 PlanPane 惯例）。
- **draft 态**：未保存调整存 `draftConfig`，UI 显示「已修改」圆点；切换视图/刷新丢弃。
- 保存动作：`保存为新视图`（命名框 → create，重名自动后缀）、`覆盖保存`（update 回写）。

### UI

**视图切换栏**（PlanPane 顶部，「计划」标题下方）：

- 横向 Tab 组，激活态主题色高亮；Tab hover `...` 菜单：重命名 / 删除（**最后一个视图不显示删除项**）。
- `+` 下拉添加视图：**A 阶段仅「看板」可添加**；列表/甘特/日历在 C 阶段实现后才出现（不做灰显占位）。
- Tab 拖拽排序后置（通道已就绪）。
- 排序控件 UI 后置：本期引擎与 `sortJson` 存储就绪，视图默认排序为 `createdAt desc`；表格列配置（columnConfig）本期不做。

**视图设置**（工具栏齿轮 → Popover，参照 ai/automation FilterPopover 先例）：

- 视图类型切换：立即生效并保存（不走 draft）。
- 分组依据（仅看板）：状态/优先级/处理人，进 draft。
- 筛选器入口。
- 无「导入数据源」。

**筛选面板**（工具栏漏斗 → Popover）：

- `+ 添加筛选条件`：字段（标题/状态/处理人/来源/优先级/标签）→ 操作符 → 值控件，AND 语义，可逐条删除。
- 顶部 `...`：保存为新视图 / 覆盖保存 / 重置；未保存调整显示「已修改」圆点。
- 工具栏搜索框保留现有位置，实时过滤。

**路由**：`?view=table|kanban` → `?viewId=<id>`；旧参数按 type 匹配映射，匹配不到 fallback 列表第一个视图。

**合规**：文案全走 `t()`（project 域命名空间）；颜色/边框/悬停用主题变量（`border-border/50`、`hover:bg-primary-subtle` 等）。

## 错误处理

- 乐观更新失败回滚 + sonner toast（视图增删改、事项指派）。
- 引擎入口对非法 filterJson/sortJson 降级为空配置，坏配置只影响该视图自身。
- `?viewId` 指向已删除视图 → fallback 第一个视图。
- 指派非成员：repo 明确错误，toast 原文。
- 懒播种事务保证两条一起成功。

## 测试（Vitest，tests/project/）

- `plan-view-engine.test.ts`：filterItems（六字段 × 操作符、AND 组合、搜索叠加、空条件直通）、sortItems（多规则、稳定性）、groupItems（三种分组、空组保留——看板空列也显示）。
- repo 单测：播种幂等、重名后缀、最后视图拒删、级联删除、成员资格校验。
- 组件测试：视图切换栏（渲染/激活态/最后一个视图无删除项）、筛选面板（添加/删除条件/重置）。

## 与后续子系统的衔接

- **B**：筛选面板 UI 深化（更多操作符、条件模板），引擎不动。
- **C**：三种视图 = 新 type 枚举值 + 渲染组件；`+` 菜单逐个点亮；日期字段已就绪。
- **D/E**：独立于本视图框架，无依赖冲突。
