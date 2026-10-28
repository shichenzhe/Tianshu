# DetailPanel 查看变更 tab（git 工作树变更）+ tab 拖拽与快捷键设计

- 日期：2026-10-13
- 状态：用户持久授权免确认推进（「参照最佳实践继续往下做，不用和我确认」）；裁定均记 Ruling
- 参照：WorkBuddy detailPanel newTab.viewChanges + tabs 快捷键/拖拽
- 前置：DetailPanel 已上线（产物/浏览器/工作空间/终端 tab）

## 1. 目标

1. **查看变更 tab**：右栏新增 changes tab——工作树变更（staged + unstaged + untracked）文件列表，点击查看单文件 unified diff（行级着色）
2. **tab 拖拽排序**：DetailTabBar 本地 HTML5 拖拽重排（无依赖库）
3. **tab 快捷键**：T 新建（弹 + 菜单）、W 关当前——仅右栏聚焦场景生效（焦点不在输入框时）

### 非目标

提交历史浏览/多 commit diff（WorkBuddy 亦无）；untracked 文件内容 diff（只列名+大小）；git 写操作（add/commit——属 AI 工具域另议）

## 2. 主进程：`electron/domains/ai/chat/git-changes.ts`（纯 Node 可测）

- `runGit(cwd, args)`：execFile("git", args, {cwd, timeout: 10_000, maxBuffer: 4MB})，注入可测（工厂参数，照 child-monitor promisify 先例）
- `gitWorkingChanges(cwd)`：
  - `git rev-parse --is-inside-work-tree` 非 git → 返回 `{ kind: "not-git" }`
  - `git status --porcelain -z --untracked-files=all` 解析（-z 防文件名转义；XY 状态码映射 M/A/D/R/??）
  - 返回 `{ kind: "ok", files: [{ path, status: "modified"|"added"|"deleted"|"renamed"|"untracked", staged: boolean }] }`，列表上限 500（超限截断+标记）
- `gitFileDiff(cwd, path)`：
  - `git diff --no-color HEAD -- <path>`（staged+unstaged 合并 vs HEAD）；空输出且 untracked → `{ kind: "untracked" }`；否则 `{ kind: "diff", text }`（截断 64KB）
  - path 经 `resolveSafePath(cwd, path, false)` 沙箱（防 `--output` 类注入参数与越界）
- 注册（session.repo，照 workspace:listDir 模式）：`workspace:gitStatus(workspaceId)`、`workspace:gitDiff(workspaceId, relPath)`——handleUser + assertWorkspaceOwned + directoryPath 校验

## 3. 前端：ChangesPanelTab + kind 接入

- `DetailTabKind` 加 `"changes"`；store/NewTabMenu(KIND_LABEL/ICON)/DetailTabBar(KIND_ICON)/DetailPanel(内容分支) 四处接入（Record 全覆盖编译器强制）
- `ChangesPanelTab(props: { workspace: WorkspaceRecord })`：
  - 文件列表（状态色徽标：modified=text-primary / added=绿语义 via primary / deleted/untracked=muted——全部主题变量，新增状态色用 `--color-primary` 系与 muted 区分，不硬编码红绿）；刷新按钮；列表上限截断提示
  - 点击文件 → diff 视图（自写 unified diff 行渲染：+/-/hunk 着色 `bg-primary-subtle`/`text-muted-foreground`，零依赖解析）；返回列表
  - 空（无变更）/非 git 目录/未绑定目录三种空态文案
- i18n：`detailPanel.openChanges`（查看变更）/`detailPanel.changes`（tab 标题）/`changes.*`（无变更/非 git/未绑定/已截断/未跟踪无 diff/刷新）双语

## 4. tab 拖拽与快捷键

- store 加 `reorderTab(sessionId, fromId, toId)`（from 移到 to 的位置；TDD 补 store 测试）
- DetailTabBar：tab 节点 `draggable` + dragstart/dragover(drop 前移插入)/drop/dragend；拖拽时源 tab 视觉 `opacity-50`；drop 目标经 id 定位（不传 index，防渲染竞态）
- 快捷键（DetailPanel 挂 keydown，window 级 capture）：
  - `T` → 打开 NewTabMenu（菜单受控 open state 上提）；`W` → 关当前 active tab
  - 守卫：`document.activeElement` 非 input/textarea/contenteditable 且无修饰键——防抢聊天输入
  - NewTabMenu 改受控组件（open/onOpenChange props，快捷键与点击共用）

## 5. 测试

- git-changes：注入 fake execFile——非 git/状态解析（-z 分隔、staged 标记、重命名）/上限截断/diff 沙箱拒绝/diff 截断/untracked 分支
- store reorderTab：TDD
- ChangesPanelTab：jsdom——列表渲染/点击进 diff/空态/刷新回调（fetch mock）
- 快捷键守卫：输入框聚焦时不触发（jsdom 派发键盘事件）

## 6. Rulings（免确认授权下的自主裁定）

- R11 两通道拆分（列表/单文件 diff 按需）——大仓库全量 diff 会卡
- R12 changes=工作树变更 vs HEAD（含 staged+unstaged+untracked 列表）；无提交历史
- R13 上限：列表 500、单文件 diff 64KB；git 参数白名单固定（status/rev-parse/diff 三命令只读）
- R14 execFile 直调不走 run_command 审批链（只读、参数固定、10s 超时）
- R15 untracked 只列名（无内容 diff）；diff path 过 resolveSafePath 沙箱
- R16 快捷键仅 T/W 且聚焦守卫（防抢聊天输入）；拖拽 HTML5 本地实现零依赖
