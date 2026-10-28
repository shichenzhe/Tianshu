# 二期实施计划：项目会话导航统一与健壮性补全

> 2026-09-24 编制，接续 docs/plans/2026-09-23-task-session-unification-phase1.md。
> 一期已完成：任务/项目会话统一到 ChatView、侧边栏项目分组、发起跳转、
> 面包屑/任务概览/能力保真、事项推进入口、动态 Tab 删除。
> 二期目标：侧边栏单区化（项目导航并入任务树）、会话域可见性补全、
> 一期遗留的边界健壮性。

## 0. 前置事实（一期产出，可直接依赖）

- `SessionRecord` 带 `projectId/planItemId`；`listAll`/`searchByTitle` 已含项目会话
- `SessionTreePanel` 已有项目分组（`projectSessionGroups` 纯函数 + `ProjectGroup` 组件），
  组名走 `["projects", userId]` 缓存
- `ProjectSidebarList`（侧边栏下方「我的项目」区）仍在；顶部 nav「项目」入口
  （→ /module/project hub 页）仍在
- 快照守卫（snapshot-guard.ts）已覆盖开发库 schema 演进，无需手动迁移
- 已知缺陷：任务有**归档**会话时点「推进」→ 后端查重返回归档会话 → 前端
  `listAll`（过滤 archivedAt）find 不到 → ChatView 显示无会话兜底（批 1 遗留 3）
- `project:getDetail` 无会话时抛 PROJECT_NOT_FOUND（用户经树删光项目会话后
  项目页 404，批 2 遗留 3）

## 1. 设计决策

| # | 决策 | 理由 |
|---|------|------|
| D8 | 「我的项目」区移除；项目入口 = 顶部 nav「项目」+ 任务树项目组头点击进入 | 用户方向（「我的项目合并到空间中」）；组头折叠钮保留，组名区点击进项目页 |
| D9 | 推进命中归档会话时**自动撤销归档**再跳转 | 复用语义保留（不建第二会话），撤销后 listAll 可见、ChatView 落点正常 |
| D10 | getDetail 无会话时自愈重建主会话 | 对齐既有「自愈重绑」模式（projectId 找不到会话即重建，title=项目名） |
| D11 | searchMessages（全局消息搜索）放开项目会话 | 会话域可见性补全；GlobalSearchDialog 副标题已支持项目名（一期批 2） |

## 2. 实施批次

### 批 7：导航统一（侧边栏单区化 + 徽标 + ⌘F）

1. `SessionTreePanel` 项目组头：组名区可点击 → `navigate("/module/project/:id")`
   （折叠 chevron 点击行为不变；hover 提示进项目；i18n 双语）
2. 删 `ProjectSidebarList` 渲染与组件（GlobalSidebar 主体仅剩任务树；顶部
   nav「项目」入口保留；`["projects", userId]` 缓存预热查询如仅由该组件承担
   则移到 GlobalSidebar 本体）
3. 会话卡片项目徽标：GlobalSearchDialog 搜索/最近列表已有项目名副标题——
   检查其余会话列表位（若 BatchActionBar 无列表语义则无改动），仅做查漏
4. `⌘F`/`Ctrl+F` 唤起会话内搜索（use-ai-layout-keybindings 加快捷键 →
   session-search store 的 open；ChatView 路由下生效）
5. i18n + 测试

### 批 8：会话域可见性补全

1. `searchMessages`（session.repo.ts）删 `projectId: null` 过滤（D11）；
   结果跳转落点 ChatView 已可承载项目会话（一期验证过）
2. 相关测试断言更新（session-isolation.test.ts 等）

### 批 9：健壮性（归档复用 + getDetail 自愈）

1. `openTaskSession`（task-session.ts）：create 返回的会话 `archivedAt` 非空
   时先 `SessionApi.unarchive` 再失效缓存跳转（D9）；后端复用分支不改
   （查重不看归档语义保留）；测试补归档命中场景
2. `project.repo.ts` getDetail：`findFirst({ projectId })` 为空时重建主会话
   （title=项目名、无 welcomeMessage），复用 `createProjectSession` 既有
   逻辑（D10）；测试补删光会话后 getDetail 自愈
3. 复用分支补归档撤销的前端兜底：缓存命中分支只可能命中未归档会话
   （listAll 已滤归档），无需处理——注释说明

## 3. 明确不做（三期候选）

- AI 建待办一键预填弹窗（消息内建议 → PlanItemDialog 预填，涉及 AI 输出
  触发链路设计）
- 工具卡片富化（PRD「信息卡片区」）
- 项目会话的 `hasModel` 默认模型继承（资产空间无列表记录，维持
  session.currentModelId 口径）

## 4. 验收标准

1. 侧边栏无「我的项目」区；任务树项目组头点击进项目页；顶部 nav「项目」
   仍达 hub 页
2. `⌘F` 在 ChatView 唤起会话内搜索
3. 全局消息搜索能搜到项目会话内的消息且可跳转
4. 归档的任务会话点「推进」→ 撤销归档并正常进入
5. 删光某项目全部会话后打开该项目 → 自愈重建主会话不 404
6. `npm run test` / `typecheck` / `lint` 全绿
