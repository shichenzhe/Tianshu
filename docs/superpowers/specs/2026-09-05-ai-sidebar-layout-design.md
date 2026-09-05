# AI 模块标准侧边栏布局改造设计

- 日期：2026-09-05
- 状态：已评审通过
- 范围决策：方案 C（布局+交互全做；置顶/归档/时间筛选真实实现含 DB 迁移；分享/批量操作/自动化/资料库内容管理占位）

## 1. 背景与目标

现状：`MainLayout` = TopBar（36px）+ 左侧系统菜单 Sidebar（欢迎/AI/系统配置 140px）+ 主内容区；AI 模块 `ChatView` 内嵌 `SessionSidebar`（工作空间下拉切换 + 新建会话 + 消息搜索 + 会话列表）。

目标：按桌面客户端标准侧边栏规范重构——

1. 移除最左侧系统菜单，应用默认进入 AI 模块（只剩登录 + AI 两个页面）
2. AI 模块左侧改为标准侧边栏：功能入口（新建任务/专家·技能·连接器/自动化/资料库）+ 空间分组任务树
3. 全局顶栏注入侧边栏折叠按钮、全局搜索（Modal）、筛选漏斗（Popover）
4. 任务列表支持：置顶、归档、时间筛选（真实持久化）；分享/批量操作/资料库/自动化（占位）

术语映射：规范中的「空间」= `workspace` 表、「任务」= `session` 表。

## 2. 布局与路由

### 2.1 删除

- `src-react/components/layout/Sidebar.tsx`（系统菜单）及 MainLayout 中的引用
- welcome、system-config 两个前端域（views + i18n 命名空间 `welcome`/`system-config`）+ 路由
- 后端 `option` 域：删除前先 grep 引用（UpdateLogDialog、升级脚本等可能用到；有引用则保留域，仅删前端入口）
- 旧路由 `/module/ai/assistants`、`/module/ai/mcp`（内容并入专家管理页）
- 侧边栏内嵌消息搜索框（搜索统一走顶栏全局搜索）

### 2.2 路由结构

```
/           → Navigate /module/ai（未登录由现有守卫弹回 /login）
/module     → MainLayout（TopBar + 登录守卫，无左侧导航）
/module/ai  → AiLayout（新：标准侧边栏 + Outlet）
  ├─ index  → ChatView（?session=<id> 表示选中任务）
  ├─ providers → ProviderSettingsView（保留，模型菜单/引导卡直达）
  ├─ experts  → ExpertsView
  ├─ library  → LibraryView
  └─ automation → AutomationView
```

`/module` index 重定向到 `/module/ai`。providers 移入 AiLayout（原为 MainLayout 直接子路由），侧边栏常驻、顶栏注入条件统一。

### 2.3 状态流

- `selectedSessionId` → URL searchParams `?session=<id>`（刷新可恢复、全局搜索跳转有落点）
- `activeWorkspaceId` 概念取消：侧边栏渲染全部空间分组树；**当前空间 = 选中任务所属空间**（无选中时取第一个空间）；新建任务、工作空间默认模型解析、目录绑定 Chip 均基于当前空间派生
- 跨 MainLayout ↔ AiLayout 的 UI 状态（侧边栏折叠、筛选条件、搜索面板开关）放 AI 域新 zustand store（如 `ai-ui.store.ts`）；折叠态初始从 localStorage `sidebar-collapsed` 读取、变更时写回（沿用现有持久化 key）。MainLayout 在 pathname 前缀 `/module/ai` 时于 TopBar 注入 `AiTopbarActions`（AI 域新组件）

## 3. AiLayout 标准侧边栏

```
[logo / 折叠按钮]           ← macOS logo 区（Windows logo 留 TopBar，沿用现有逻辑）
─────────────────────
+ 新建任务                  ← 当前空间新建并选中
专家·技能·连接器  → /module/ai/experts
自动化            → /module/ai/automation
资料库            → /module/ai/library
─────────────────────      ← 可滚动区
空间 (n) ▾                 ← 可折叠分组头（计数）
  ▾ <空间名>     [+] [...]  ← 空间行悬停：+ 在此空间新建；... 管理菜单（重命名/绑定目录/解绑/删除，复用现有 Dialog/AlertDialog）
      · 查询今日金价   22小时前
      · 询问助手身份 ●      ← ● 绿点 = 该会话流式进行中（前端派生：chat.store.streams）
─────────────────────
[底部] 折叠/展开按钮（窄条模式，折叠态经 ai-ui store 持久化到 localStorage `sidebar-collapsed`，沿用现有）
```

- 任务项：标题 + 相对时间（`formatDistanceToNow`）；选中态 `bg-primary-subtle`；置顶任务排在空间内最前（带 Pin 小图标）
- 任务项悬停：右侧显示 `...` / 归档 / 置顶 三个快捷图标（规范 3.3.2）
- 归档任务不出现在侧边栏

### 3.1 任务上下文菜单（`...`）

| 菜单项 | 行为 |
|---|---|
| 重命名 | 现有 Dialog 流程 |
| 置顶 / 取消置顶 | `session:pin`，置顶项带 Pin 标、排空间内最前 |
| 归档 | `session:archive`，立即从列表移除；toast 带「撤销」按钮（5s，sonner action，再次调 archive 撤销）；全局搜索不含归档任务；不做归档列表页（YAGNI） |
| 打开文件夹 | 打开所属空间 `directoryPath`（未绑定时禁用） |
| 分享任务 / 批量操作 | toast「开发中」占位 |
| 删除任务 | 红色 + 二次确认（现有 AlertDialog） |

## 4. 顶栏与全局搜索/筛选

TopBar 保持全局组件（登录页也渲染），不加 AI 专属按钮；MainLayout 检测 `/module/ai` 前缀时渲染 `AiTopbarActions`（折叠按钮、🔍 搜索、漏斗筛选）。

### 4.1 全局搜索 Modal

- 居中 Dialog，顶部输入框（占位「搜索任务」），展示「最近任务」
- 列表项：任务名 + 所属空间路径（Folder 图标 + 空间名）
- 后端 `session:searchByTitle(keyword)`：`title LIKE` + 未归档 + `updatedAt` 倒序；空关键词返回最近 20 条
- 输入实时过滤（防抖 300ms）；点击结果 → `navigate('/module/ai/chat?session=id')`

### 4.2 全局筛选 Popover

- 时间维度四选一：全部时间 / 今天 / 最近 7 天 / 最近 30 天（选中项右侧主题色对勾）
- 「重置筛选条件」一键清空
- 作用于侧边栏任务列表：按 `lastMessageAt ?? updatedAt` 前端过滤；纯内存态不进 URL

## 5. 数据模型与后端（DB v1 → v2）

```prisma
model session {
  pinnedAt   DateTime?
  archivedAt DateTime?
}
```

- 升级脚本：SQLite `ALTER TABLE ADD COLUMN`，沿用 `db_version` 机制；`electron/Constants.ts` 版本号 1 → 2

新增 IPC（session 域，沿用 entity + repo 模式）：

| channel | 说明 |
|---|---|
| `session:listAll` | 全部未归档任务（侧边栏分组树数据源） |
| `session:pin` | `pin(id, pinned)`；置顶项按 `pinnedAt` 排序 |
| `session:archive` | `archive(id, archived)` |
| `session:searchByTitle` | 按标题搜索（见 4.1） |

现有 `session:listByWorkspace` 返回值补 `pinnedAt`/`archivedAt` 并过滤已归档；`searchMessages` 后端保留、前端入口移除。

## 6. 新视图

- **ExpertsView**（`/module/ai/experts`）：Tab 三块——专家（复用 AssistantSettingsView）/ 连接器（复用 McpSettingsView）/ 技能（占位：说明文案 + 「打开技能目录」按钮，复用 `skill:openDir` IPC）。现有两个 SettingsView 直接作 Tab 内容嵌入，如有整页专属 padding 再微调。
- **LibraryView**（`/module/ai/library`）：完整 UI 骨架、静态空数据——标题「资料库」+ 右上导出/分享图标（toast 开发中）、搜索输入框、「最近/本地产物」快捷 chips、可折叠「我的资料」「团队空间」分组（右侧 `+` → toast 开发中）、空态文案。
- **AutomationView**（`/module/ai/automation`）：图标 + 「开发中」占位页。

## 7. i18n 与清理

- 删除 `welcome`/`system-config` 命名空间及 layout 命名空间中 `sidebar.welcome/ai/systemConfig` 等 key
- 新增文案走 `chat` 命名空间（+ `common` 复用），zh-CN/en-US 同步；key 命名 camelCase 分层嵌套
- `routes/index.tsx` 硬编码「加载中...」改 `t("common:loading")`
- 样式遵守项目规范：主题变量（`bg-primary-subtle` 等）、弹出层 `border-border/50 rounded-lg shadow-lg`

## 8. 测试

- 后端：session repo/IPC 单测——pin/archive/searchByTitle/listAll（含「归档任务不出现在列表与搜索」断言）
- 迁移：升级脚本 v1→v2 单测（旧库升级后字段存在、默认 null）
- 前端：时间筛选纯函数（今天/7 天/30 天边界）、搜索结果截断逻辑单测
- 收尾：`npm run test` + `lint` + `typecheck` 全绿

## 9. 明确不做（本次）

- 归档任务列表页 / 归档恢复中心（撤销 toast 即恢复手段）
- 消息级搜索 UI（后端 API 保留）
- 分享、批量操作、自动化、资料库内容管理的真实功能
- 空间内「文件夹组/项目指引」子层级（数据模型无对应，两层树即可）
