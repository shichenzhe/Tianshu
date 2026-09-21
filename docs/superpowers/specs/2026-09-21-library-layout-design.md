# 资料库布局交互对齐 PRD——设计文档

日期：2026-09-21
状态：已与用户确认设计方向

## 背景与目标

参照 WorkBuddy 资料库四张截图整理的 PRD（三栏布局、目录树、双维度筛选、表格列表、
搜索命令面板、引导推荐区），改造天枢资料库（`/module/ai/library`）。

**已拍板的裁剪决策**：

- 对齐 PRD 的布局骨架，砍掉天枢无对应的概念（团队空间、分享 Tab、存储配额条、
  引导营销卡片、悬浮帮助按钮），不造假数据。
- PRD 关系 Tab「最近访问｜我分享的｜与我共享」改为「全部｜收藏」。
- PRD 的「①全局导航栏」对应天枢已有的 `GlobalSidebar`/`MainLayout`（App 级），本次不动。

**方案选择**：渐进改造——保留 `LibraryView` 三态架构与现有组件文件，逐区改造，
复用 `GlobalSearchDialog` 的居中 Modal 模式。不推倒重写、不做最小改动。

## 1. 数据层（DB v14 迁移）

`libraryItem` 新增两列：

| 字段 | 用途 |
| --- | --- |
| `favorite Boolean @default(false)` | 收藏 ♥ 与「收藏」Tab |
| `lastViewedAt DateTime?` | 「最近」入口排序、命令面板「最近浏览」、NEW 标记判定 |

**NEW 判定规则**：`kind = "file"` 且 `lastViewedAt IS NULL` 即 NEW（从未预览过）。
预览进详情态时调 `library:markViewed` 置时间，NEW 随之消失；rename/move 触碰
updatedAt 不影响 NEW。

**假设**：folder 不记 lastViewedAt（点文件夹是导航非阅读），「最近」与 NEW 仅对
file 生效。

**后端新增 IPC**（均走 userId 隔离，v12 起口径；channel 白名单
`electron/commons/ipc-channels.ts`，handler 在 `library.repo.ts` 按现有结构挂载）：

| IPC | 行为 |
| --- | --- |
| `library:toggleFavorite(id)` | 切换 favorite 布尔，返回更新后的 item |
| `library:markViewed(id)` | 置 lastViewedAt = now（幂等） |
| `library:listRecent()` | file 且 lastViewedAt 非空，按 lastViewedAt 倒序，限 50 |
| `library:listFavorites()` | 全局收藏 file，按 updatedAt 倒序 |

`library:list` / `library:search` 返回全行，天然带新字段。

**位置字段**：四个列表/搜索 IPC 的每项附带 `location`（从「我的资料」起的祖先
文件夹名拼接），后端用现有 `buildBreadcrumbChain`（library.utils.ts）逐项上溯
拼装——与 `library:list` 现有 breadcrumbs 同口径，前端不再自行拼路径。

## 2. 目录树（②）重排

`LibrarySidebarTree` 自上而下：

1. **标题行**：大号「资料库」标题（砍分享/导出图标）。
2. **搜索框**：带放大镜的样式框，点击唤起命令面板。**替代现有内嵌搜索输入**——
   主区「搜索态」删除，三态（列表/搜索/详情）收敛为「列表/详情」两态；
   `keyword` / `onKeywordChange` / `onBackToList` / `backEnabled` 一串 props 删除。
3. **快捷入口**：「最近」（Clock 图标，**默认选中**）+「我的资料」（FolderOpen，即根）。
4. **文件夹树**：根行「我的资料」右侧加「+」新建文件夹（从主区工具栏移过来）。
   不引入分组手风琴（天枢仅单组，无意义）。砍存储条。
5. 折叠窄条保留现状（含置顶展开按钮，不回退 0eccb50 的修复）。

**假设**：选中节点/Tab 状态不持久化（现状也不持久化，每次进入默认「最近」）。

## 3. 主内容区（③）

- **左上角切换按钮**：收起按钮从树栏顶部行移交到主区标题行左侧
  （PanelLeftClose/PanelLeftOpen）；折叠窄条内按钮保留。
- **动态大标题**：跟随视图——「最近」/「我的资料」/文件夹名（`PageTitle` 改传动态值）。
- **Tab 胶囊组**：「全部（默认）｜收藏」。
  - 「收藏」= **全局**收藏文件（跨文件夹，`library:listFavorites`），与当前文件夹无关。
  - 「最近」入口与 Tab 正交：最近视图下切「收藏」即显示收藏列表。
  - 类型下拉沿用现有 Select（现有 fileType 集合），与 Tab **AND** 叠加。
- **列表四列**：名称（彩色类型图标+♥+NEW）｜类型｜位置｜最近访问。
  - 大小列挪除（详情面板已有）；「所有者」砍（单用户）。
  - 「位置」= 项上 `location` 字段（后端 buildBreadcrumbChain 逐项拼装，见 §1）。
  - 「最近访问」= `lastViewedAt ?? createdAt`。
- **列头排序**：点「名称」「最近访问」列头切换升降（替代工具栏排序按钮）。
  folder 恒置前规则保留。
- **行内交互**：
  - ♥ 恒显示（outline 灰 / filled 红），点击调 `toggleFavorite` + invalidate；
    folder 不显示。
  - NEW 为名称右侧红色小标签；预览后消失（markViewed + invalidate）。
  - 行尾 `…` 菜单保持恒显示（不做 hover 浮出）。
  - **单击文件即预览**（不做 PRD「单击选中/双击打开」两级，保持现有肌肉记忆）。
- **工具栏**：只留「上传」；新建文件夹已移树栏，排序按钮已移列头。

## 4. 命令面板（新建 `LibraryCommandDialog.tsx`）

仿 `GlobalSearchDialog` 的居中 Dialog 骨架（`rounded-lg border-border/50 shadow-lg`）：

- 顶部通栏浅灰搜索输入（autoFocus）+ 底部快捷键提示栏（横线分隔）：
  `↑ ↓ 切换`、`↵ 打开`、`Esc 关闭`。「⌘↵ 新窗口」砍——无多窗口语义。
- **键盘全程驱动**：↑↓ 移动选中（高亮 + scrollIntoView 跟随）、Enter 打开、
  Esc 关闭（Dialog 内建）。
- 空输入显示「最近浏览」（`library:listRecent`）；有输入走现有 `library:search`，
  300ms 防抖；每项 = 类型图标 + 加粗名称 + 灰色位置路径。
- 打开 = 关面板 + 主区进详情态 + `markViewed`。
- 唤起：点击树栏搜索框；`⌘K`/`Ctrl+K`（仅在资料库路由挂载时注册，
  避免与全局冲突）。

## 5. 状态模型收敛（LibraryView）

- `folderId: number | null` 升级为
  `view: { type: "recent" } | { type: "favorites" } | { type: "folder"; id: number | null }`。
- 删 `keyword` / `searchQuery` / 搜索态。
- Tab、类型筛选、排序为前端本地（单层数据量小，skill 页先例——沿用现状）。
- 收藏 Tab 与最近视图共用 `LibraryFileList` 渲染，仅数据源不同。

## 6. 边界与状态

| 场景 | 处理 |
| --- | --- |
| 「最近」为空 | 专属空态文案（「还没有访问过的文件」） |
| 命令面板无结果 | 「未找到相关内容」，保留输入可继续编辑 |
| 加载态 | 沿用现有文案（骨架屏为增强项，本次不做） |
| 列表加载失败 | 现有 loadFailed + retry 保留 |
| 空库 | 现有 empty 空态保留 |

## 7. 涉及文件与测试

**后端**：

- `prisma/schema.prisma`（libraryItem +2 字段）
- `electron/infrastructure/script/v14/`（新增 upgrade-table.sql）
- `electron/Constants.ts`（DATABASE_VERSION 13 → 14）
- `electron/domains/ai/library/library.repo.ts`（4 个新方法 + 位置字段拼装）
- IPC 注册：`electron/commons/ipc-channels.ts`（channel 白名单）

**前端**：

- `src-react/domains/ai/library/api/library.api.ts`（新字段 + 4 个 API）
- `src-react/domains/ai/library/lib/library-view-model.ts`
  （+NEW 判定 / 双向排序，扩展现有单测）
- `src-react/domains/ai/library/components/LibrarySidebarTree.tsx`（重排）
- `src-react/domains/ai/library/components/LibraryFileList.tsx`（换列+列头排序+♥）
- 新建 `src-react/domains/ai/library/components/LibraryCommandDialog.tsx`
- `src-react/domains/ai/library/views/LibraryView.tsx`（状态收敛）

**i18n**：`chat` 命名空间 library 节，zh-CN / en-US 同步新增。

**测试**：view-model 纯函数单测（NEW 判定、升降排序）；后端 location 拼装
复用已单测的 `buildBreadcrumbChain`；repo 层按现有测试模式补（若有先例）。

## 明确砍掉项（对照 PRD）

- 团队空间、「本地产物」分组、分组手风琴
- 分享/导出图标、「我分享的/与我共享」Tab、「在任务中引用」
- 存储状态条与「升级」
- 引导卡片区（「了解资料库」「100 种用法」）、「我知道了」持久化
- 悬浮帮助按钮
- ⌘+Enter 新窗口打开
- 数据埋点
