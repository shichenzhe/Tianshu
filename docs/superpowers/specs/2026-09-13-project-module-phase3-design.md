# 项目模块三期设计（Project Module Phase 3 · 计划与任务）

- 日期：2026-09-13
- 状态：待用户审阅
- 上游：一期 spec §10（三期 roadmap）、补充 PRD §2（计划）§3（任务）
- 范围：项目详情页「计划」「任务」两个 Tab 从占位空态落地为完整功能

## 1. 目标

- **计划**：项目维度宏观进度管理——表格视图（默认）+ 看板视图（拖拽流转），字段含状态/处理人/优先级/标签/自定义字段。
- **任务**：个人视角执行清单——聚合"我被指派的 + 我创建的"事项，区分「本地/项目」来源，私密提示。

## 2. 关键决策

| 决策点 | 结论 | 理由与代价 |
| --- | --- | --- |
| 数据模型 | **单表双视图**：一张 `planItem` 表——计划 Tab = 该项目的全部事项；任务 Tab = 个人聚合视图（`assigneeId=me OR createdById=me`），`projectId IS NULL` 的行为「本地任务」 | PRD 任务的"来源标识（本地/项目）"语义即跨容器聚合；两张表会让"项目指派的任务"与"计划事项"双写不同步。代价：计划表里要容许 projectId null 的本地行（计划 Tab 按 projectId 过滤不可见） |
| 状态枚举 | 四态统一 `not_started / in_progress / paused / done`（待开始/进行中/已暂停/已完成） | PRD 表格视图三态与看板四态的取并集；表格的状态下拉同样四项。存字符串枚举 |
| 处理人 | `assigneeId Int?` 字段预留，UI 恒为"我"（C 方案单成员） | 多成员时字段直接可用；代价：无 |
| 优先级 | `P0 / P1 / P2` 三级，默认 P1 | PRD "P0/P1/P2 等分级"取常用三级 |
| 标签 | `tags` JSON 字符串数组，前端自由输入 + 既有标签快捷选择 | 不建标签表（YAGNI）；按项目内出现过的标签聚合供选择 |
| 自定义字段 | 值存 `planItem.customFields` JSON；**字段定义存 option 表**（`type = "planFields:<projectId>"`，value=字段名，note=类型） | 零表结构成本复用现有 option 域；类型一期支持 `text / number / date` 三种。代价：字段定义读写走既有 option IPC（重命名/删除字段需同步清理各行的值——删除字段时全项目行清该键） |
| 看板拖拽 | 引入 **dnd-kit**（`@dnd-kit/core` + `@dnd-kit/sortable`）新依赖 | React 19 兼容、shadcn 生态惯用、跨列拖拽+列内排序都有现成原语；原生 HTML5 DnD 触摸端不可用 |
| 列内顺序 | `sortOrder Int`——看板拖拽持久化列内顺序；表格视图按 sortOrder 后 updatedAt 排序 | 看板"卡片顺序"是用户表达；表格默认最近更新在前 |
| 任务私密性 | 渲染 PRD 提示文案"你的任务是私密的…"（单机应用为说明性文案，无隔离逻辑） | C 方案延续，不做假机制 |

## 3. 架构

### 3.1 数据模型（script/v4 迁移，新表一张）

```prisma
model planItem {
  id           Int      @id @default(autoincrement())
  projectId    Int?     // NULL = 本地任务（仅任务 Tab 可见）
  title        String
  status       String   @default("not_started")  // not_started|in_progress|paused|done
  priority     String   @default("P1")           // P0|P1|P2
  assigneeId   Int?     // 预留，单成员恒当前用户
  tags         String?  // JSON string[]
  customFields String?  // JSON Record<fieldName, string|number>
  sortOrder    Int      @default(0)
  createdById  Int
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@index([projectId], map: "plan_item_projectId_index")
  @@index([assigneeId], map: "plan_item_assignee_index")
}
```

删除项目级联：remove 时 `planItem.deleteMany({ where: { projectId: id } })`（本地任务不受影响）。

### 3.2 后端结构

```
electron/domains/project/plan-item.entity.ts   # 类型 + 状态/优先级常量
electron/domains/project/plan-item.repo.ts     # IPC 仓储
```

IPC 通道：

| 通道 | 参数 | 行为 |
| --- | --- | --- |
| `planItem:list` | (projectId) | 项目全部（计划 Tab 数据源），sortOrder asc + updatedAt desc |
| `planItem:listMine` | (userId) | 个人聚合：`assigneeId=me OR createdById=me`（含本地/项目行），updatedAt desc |
| `planItem:create` | (params) | title 必填 trim；projectId/assigneeId/tags/customFields 可选；新建行 sortOrder 置于目标状态列尾 |
| `planItem:update` | (id, fields) | 局部更新（title/status/priority/tags/customFields/assigneeId） |
| `planItem:delete` | (id) | 删除 |
| `planItem:move` | (id, status, sortOrder) | 看板拖拽落点持久化（status 变更 + 列内新序） |
| `planItem:fields:list` | (projectId) | 自定义字段定义（读 option `planFields:<projectId>`） |
| `planItem:fields:save` | (projectId, fields[]) | 全量替换字段定义（新增/重命名/删除；删除的字段同步清理项目内各行的 customFields 键） |

`ProjectRepository.remove` 扩展一行级联。`lib/ipc.ts` 增 8 通道。

### 3.3 前端结构

```
src-react/domains/project/api/plan-item.api.ts
src-react/domains/project/components/PlanPane.tsx          # 计划 Tab：视图切换 + 工具栏
src-react/domains/project/components/PlanTableView.tsx     # 表格视图
src-react/domains/project/components/PlanKanbanView.tsx    # 看板视图（dnd-kit）
src-react/domains/project/components/PlanItemDialog.tsx    # 新建/编辑事项弹窗（含自定义字段）
src-react/domains/project/components/TasksPane.tsx         # 任务 Tab：个人清单
src-react/domains/project/components/CustomFieldsEditor.tsx # 字段定义管理（表头 + 弹窗内编辑器）
```

### 3.4 计划 Tab（PlanPane）

- **视图切换**（左上，URL query `?view=table|kanban` 缺省 table——与 Tab 的 `?tab=` 同一 query 串）；
- **表格视图**（默认，shadcn table）：列 = 标题（点击进详情/编辑）| 状态（Select 四态）| 处理人（恒"我"）| 优先级（Select P0-P2，色徽标）| 标签（Badge 组）| 自定义字段列（动态）；表头右侧 `+` 管理自定义字段（CustomFieldsEditor 弹窗）；行首快速新增（顶部内联输入行，回车即建，状态默认待开始）；每行 `...` 菜单（编辑/删除）；
- **看板视图**：四列泳道（待开始/进行中/已暂停/已完成），列头计数；卡片 = 优先级色条 + 标题 + 标签徽标 + 处理人头像点；dnd-kit 拖拽跨列流转 + 列内重排（drop 即 `planItem:move`，乐观更新）；列头 `+` 快速在该列新增；
- **工具栏**：筛选（状态/优先级/标签下拉多选，客户端过滤）+ 搜索（标题包含）；右上「添加」按钮开 PlanItemDialog；
- 空态：引导文案（"暂无计划，点击右上添加"）。

### 3.5 任务 Tab（TasksPane）

- 数据源 `planItem:listMine(user.id)`；列表项 = 标题 + 来源标识 Badge（`本地`/`项目名`——projectId null → 本地，否则查项目名）+ 相对时间 + 优先级色点 + 状态小徽标；
- 顶部筛选下拉（全部任务/指派给我的/我创建的）+ 来源筛选（全部来源/仅本地/仅项目）+ 搜索框；
- 行点击 → 本地任务开编辑弹窗（无项目上下文，仅基础字段）；项目任务跳转对应项目 `?tab=plan` 并高亮（简化：仅跳转）；
- 顶部灰字私密提示（PRD 文案）；
- **入口**：任务 Tab 支持新建「本地任务」（projectId null）——这是任务 Tab 区别于计划 Tab 的创建路径。

### 3.6 PlanItemDialog（新建/编辑共用）

字段：标题（必填 ≤100 字）| 状态 | 优先级 | 标签（自由输入 + 已有标签候选）| 处理人（只读"我"）| 自定义字段动态区（按字段定义渲染 Input/number/date）。保存 → create/update → invalidate `["planItems", projectId]` / `["planItemsMine", userId]`。

## 4. 错误处理

| 场景 | 处理 |
| --- | --- |
| 标题空/超长 | 内联校验（nameRequired/nameTooLong 先例） |
| 非法 status/priority 值（裸 IPC） | repo 层枚举校验抛中文错误 |
| 自定义字段定义删除 | 行内 customFields 键清理失败（单行）→ 收集继续，结果 toast 汇总 |
| 字段类型不匹配的存量值 | 渲染层容错（显示原值，不崩） |
| 拖拽 move 失败 | 回滚乐观更新 + toast |
| 删除项目 | 级联删该项目的 planItem（本地任务保留） |

## 5. i18n / 测试 / 手动验收

- i18n：`plan.*` 与 `tasks.*` 两组 key（约 40 个），zh/en 同步；
- 单测（Vitest）：repo（create 校验/listMine 聚合谓词/move/fields 全量替换与值清理/级联）；前端（PlanTableView 渲染与筛选、PlanKanbanView dnd 交互（dnd-kit jsdom 可测）、TasksPane 来源标识与筛选、PlanItemDialog 校验）；
- 手动验收清单随实施计划产出。

## 6. 风险

1. **dnd-kit 新依赖**：React 19 兼容性 spike（首任务验证安装与基础 DnD 在 jsdom/真实环境的表现）；失败退路 = 原生 HTML5 DnD（触摸端降级）；
2. **自定义字段的 option 复用**：option 域的通用性 vs 字段定义的结构化需求——note 存类型够用但简陋；若实施中发现约束不足，退路 = planItem 表加 `fieldDefs` 列到项目行（需 planItem 之外再动 project 表——尽量避免）；
3. **任务 Tab 的项目名解析**：listMine 返回 projectId，前端需批量解析项目名（["projects"] 缓存已有，无额外通道）。

## 7. 后续（本期不做）

多成员协作（服务端化）、任务与计划的高级视图（甘特/时间线）、自动化任务联动（计划事项到期触发 automation）。
