# 项目计划模块 · 子系统 C：三种新视图 — 设计文档

- **日期**：2026-09-14
- **状态**：已与用户逐节确认
- **来源 PRD**：项目计划模块（补充与进阶功能）§1.1 / §3.1–3.3
- **范围**：子系统 C（A–E 五个子系统中的第三个）；A（视图框架/日期字段/引擎）与 B（筛选排序深化）已交付

## 背景

PRD 要求三种新视图：列表（Todo 式紧凑清单）、日历（月历+农历）、甘特（时间轴+拖拽调期）。A 阶段已就绪全部地基：`planView.type` 枚举含 `list/gantt/calendar`（仅未点亮）、`planItem.startDate/dueDate`（UTC 零点日历日语义）、筛选/排序/分组引擎、视图 Tab 与设置入口。

## 已确认的关键决策

1. **农历库**：`lunar-typescript`（纯 TS 零依赖，公历⇄农历+节气+传统节日；全项目仅 `plan-date.ts` 一处 import）。
2. **甘特交互深度**：条身平移 + 左右边缘拉伸（天粒度吸附）；**不做依赖线**——planItem 无 dependsOn 字段，加字段+连线属后续独立需求（YAGNI）。
3. **甘特实现**：全自绘（div 网格 + 原生 pointer 事件），不用 gantt-task-library（重依赖+主题打架）也不用 dnd-kit（连续位移+吸附非其抽象场景）。
4. **今天线用 `bg-primary`**（PRD 原文「绿色竖线」让位于项目主题变量规范——颜色随主题）。

## §1 日期模型层 `src-react/domains/project/model/plan-date.ts`

纯函数层，`lunar-typescript` 唯一引用点：

```ts
/** 农历标注：festival > term > dayInChinese 优先级；初一显示月名（「九月」） */
export interface LunarLabel {
  dayInChinese: string; // 廿三
  term?: string;        // 节气：霜降
  festival?: string;    // 传统节日：中秋节
}

export function monthGrid(year: number, month: number): MonthCell[];
// 周一起始 42 格；含上下月溢出格（inMonth=false）；每格含 dateKey("YYYY-MM-DD") 与 lunar 标注

export function groupByDueDate(cells: MonthCell[], items: PlanItemRecord[]): Map<string, PlanItemRecord[]>;
// dueDate 的 ISO slice(0,10) 与格子 dateKey 相等聚合

export function ganttColumns(range: DateRange, granularity: GanttGranularity): GanttColumn[];
// 粒度分列：日/周/月/年 → 列 key/label/跨度天数

export function toGanttBar(item: PlanItemRecord): GanttBar | null;
// { startKey, endKey, days }；单端日期钳制为 1 天；两端皆空 → null（无日期）

export function dragToDates(bar: GanttBar, dayDelta: number, edge: "move" | "start" | "end"): { startKey: string; endKey: string };
// 三边缘语义；days < 1 钳制为 1；纯函数可单测
```

**dateKey 语义（硬约束）**：存储为 UTC 零点（A 阶段裁决），dateKey 一律 `iso.slice(0,10)`；网格格子 key 由本地日历日构造。两边均为「日历日字符串」直接相等比较，**全程不做时区换算**（本地 `getDate()` 解析 UTC 零点在 UTC+8 偏一天——A 阶段时区 bug 的教训，模型层测试含该回归用例）。

## §2 列表视图 `PlanListView.tsx`

- `groupItems(items, "status")` 四组区块（空组保留），组头 = 折叠箭头 + 状态名 + 计数 + 组内 `+`。
- 行：完成 checkbox + 标题（点击开编辑弹窗）+ 标签（2 + `+N`）+ 优先级色点 + 截止日（超期 `text-destructive`、未超期 muted）+ 处理人头像点。
- 勾选语义：勾选 → done，取消 → not_started（走现有 move 通道，无落点=列尾）。
- 组内快速新增：组头 `+` 展开行内 Input，回车 create（预置该组状态）。
- 折叠态组件内 useState（刷新重置全展开，不持久化）。
- 纯展示+回调：`onToggleDone(id, done)` / `onQuickCreate(status, title)` / `onEdit(item)`；变更逻辑全在 PlanPane。

## §3 日历视图 `PlanCalendarView.tsx`

- 月导航：`<<` `>>` + `今天` + 月标题；月游标组件内 useState。
- 周表头：一~日。
- 日格：公历日数字（今日格 primary-subtle 圆圈高亮）+ 农历标注（`text-[10px] text-muted-foreground`，§1 优先级规则）+ 任务 chips（最多 3 + `+N`，chip = 优先级色点 + 截短标题，点击开编辑弹窗）。
- 无日期统计：顶部右侧 muted 文本「无日期记录：N」（仅统计；无日期任务不出现在网格）。
- 点格空白 → 新建弹窗预置 `dueDate = 该日`（PlanPane 新 `dialogDefaultDueDate` state）。
- props：`items / onCreateAt(dateKey) / onEdit(item)`。

## §4 甘特视图 `PlanGanttView.tsx`

- 布局：左列 `w-52`（优先级色点+标题；无日期任务灰显 + 「点击设置日期」hover → 开编辑弹窗）+ 右侧横向滚动时间轴。
- 控制栏：粒度切换（日/周/月/年分段按钮）+ `<<` `>>` + `今天`；列宽常量 28/64/96/120px；今天竖线 `bg-primary` 1px。
- 条形：起止跨列圆角条（优先级色板）；行序 = visibleItems 传入序。
- 拖拽（原生 pointer）：条身 `cursor-grab` 平移；左右 6px 边缘热区 `cursor-ew-resize`；位移按列宽换算天偏移（取整吸附）+ 拖拽中 `translate-x` 预览；pointerup 一次回调 `onChangeDates(id, { startKey, endKey })`。语义全走 `dragToDates`。
- 单端日期：条从该端起 1 天（toGanttBar 钳制）。
- 视口：初始 range 覆盖今天前后一屏（日≈60 天/周≈24 周/月≈18 月/年≈6 年）；翻页步进一屏。

## §5 接线、i18n 与测试

**PlanPane**：type 四分支（kanban/list/gantt/calendar，缺省回落表格）；`ADDABLE_TYPES`/`SELECTABLE_TYPES` 点亮三类型；新 handlers `handleChangeDates`（乐观+回滚，日期 `T00:00:00.000Z` 构造）、`handleQuickCreateIn(status, title)`、`dialogDefaultDueDate`；`onToggleDone` 复用 move 链。

**依赖**：`npm i lunar-typescript`（唯一新增）。

**i18n**：双语言约 20 键（粒度名/今天/无日期统计/列表空态与快速新增 placeholder/甘特无日期提示/星期表头等）。

**测试**（TDD，tests/project/）：

- `plan-date.test.ts`（重头）：monthGrid（42 格/周一起始/跨月）；农历标注（真库断言已知日期，实现时以库输出写死预期）；groupByDueDate 聚合 + **UTC+8 时区回归**（slice(0,10) 不偏一天）；ganttColumns 四粒度；toGanttBar 单端钳制；dragToDates 三边缘与钳制。
- `plan-list.test.tsx`：折叠/勾选 done/快速新增/行字段。
- `plan-calendar.test.tsx`：月导航/今日高亮/农历渲染/点格 onCreateAt/chips+N/无日期统计。
- `plan-gantt.test.tsx`：列渲染/今天线/无日期灰显；拖拽语义由 dragToDates 覆盖（jsdom 不模拟 pointer，同看板先例）+ 手动验收兜底。
- `plan-table.test.tsx`：三新 type 分支切换集成。

## 与后续子系统的衔接

- **D**（弹窗增强+底部操作栏）：日历点格预置 dueDate 已铺 `dialogDefaultDueDate` 通道；甘特/日历消费的时间规划 UI 属 D 的胶囊化范围。
- **E**（项目级定时任务）：无依赖。

## 手动验收清单（实现完成后）

1. `+` 菜单出现 列表/甘特/日历 三项；视图设置类型切换四类可选。
2. 列表：折叠展开、勾选完成落 done、组内回车快速新增带状态。
3. 日历：翻月/今天回正/今日高亮/农历与节日显示/点格新建预置截止日/超 3 任务折叠 +N/无日期统计正确。
4. 甘特：四粒度切换与翻页/今天线/条形跨列正确/拖拽平移与边缘拉伸调期落库（刷新保持）/无日期任务灰显。
5. 全部文案双语言；颜色全主题变量。
