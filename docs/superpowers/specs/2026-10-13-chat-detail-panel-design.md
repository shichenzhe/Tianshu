# 会话右侧栏 tab 化（DetailPanel）设计

- 日期：2026-10-13
- 状态：已评审（用户裁定：tab 按 sessionId 隔离；终端不挂权限门）
- 参照：WorkBuddy detailPanel（从 app.asar 逆向确认：tab 条 +「+」菜单开 浏览器/工作空间/终端 tab，可多开）

## 1. 背景与目标

天枢聊天会话页右栏现为 ArtifactsPanel（概览/产物/工作空间 三视图 dropdown，340px 挤压式旁挂）。目标：升级为 tab 式 DetailPanel——「产物」为默认 tab，「+」菜单可开 浏览器 / 工作空间（文件树） / 终端 tab，各 tab 可多开、可关闭，参照 WorkBuddy 会话右侧栏形态。

### 非目标（一期不做）

- tab 拖拽排序、快捷键（T 新建/W 关闭）、关闭其他/右侧
- 查看变更（git diff）tab
- AI 经会话协议主动开浏览器/终端（WorkBuddy 的 openSessionBrowser 协议）
- 终端权限门/security 域授权（用户裁定：暂不挂）
- 右栏最大化按钮（现有开关 Toggle 已够用）

## 2. 总体布局

```
右栏（340px 挤压式旁挂；列宽/开关/TopBar 宽度注册/收起移除逻辑全部不变）
├─ tab 条：[产物] [终端] [浏览器] [工作空间] … [+]
│    · 「产物」为默认 tab：现有三视图 dropdown 完整保留在 tab 内容头部
│    · 「+」弹菜单：打开浏览器 / 查看工作空间 / 打开终端
│    · 关闭全部 tab 后右栏自动收起（等价 artifactsOpen=false）
└─ 内容区：按 activeTab 渲染；非 active 的 browser tab 以 display 隐藏保状态
     （同 BrowserView 常驻不卸载策略）；terminal tab 同样常驻隐藏
```

### 文件结构

```
src-react/domains/ai/chat/components/detail-panel/
  DetailPanel.tsx        # 右栏容器：tab 条 + 内容路由（替 ArtifactsPanel 在 ChatView 的位置）
  DetailTabBar.tsx       # tab 条（图标式小 tab，参照 BrowserTabBar 交互）
  NewTabMenu.tsx         # 「+」菜单（三项）
  BrowserPanelTab.tsx    # BrowserToolbar + BrowserWebview 组合（props 驱动）
  WorkspaceFileTree.tsx  # 懒加载目录树 + 文件点击预览
  TerminalTab.tsx        # xterm.js 终端
src-react/domains/ai/chat/components/artifacts/
  ArtifactsPanel.tsx → 瘦身为 ArtifactsTab（删外壳列宽/边框/顶栏宽度注册，
    保留三视图 dropdown 与内容路由）；ArtifactsPanelToggle 不动
src-react/domains/ai/chat/store/detail-panel.store.ts
```

## 3. Store 设计（sessionId 隔离）

```ts
interface DetailTab {
  id: string;                 // crypto.randomUUID()
  kind: "artifacts" | "browser" | "workspace" | "terminal";
  title: string;              // tab 条展示（产物/终端/浏览器/工作空间，i18n）
  createdAt: number;          // 同类多开时排序稳定（终端1/终端2 编号可选）
  // 负载状态（进 store 才能跨会话切换存活）：
  url?: string;               // browser：当前地址（空串 = 新标签页形态）
  terminalId?: string;        // terminal：主进程 pty 会话 id
}
interface DetailPanelState {
  tabs: DetailTab[];
  activeTabId: string;
}
// Record<sessionId, DetailPanelState>；无选中会话不渲染右栏（现有语义）
```

- **sessionId 隔离**（用户裁定）：切换会话各自保留 tabs；负载状态（browser
  url、terminal pty id）在 store 中存活——切回后 webview 按 url 重新加载
  （页面滚动位重置）、终端 pty 未死续流（xterm 回滚缓冲重置）。tab 内容
  组件只挂当前会话的（切走的会话其 tab 内容卸载，控内存）；DetailPanel
  容器本身不随会话切换重挂（ChatView 层渲染，同现 ArtifactsPanel）
- 打开右栏（Toggle）时若该会话无 tabs → 初始化为单「产物」tab
- 关 tab：terminal → 先 kill pty；browser → webview 随 React 卸载销毁
- 关到最后一个 tab → 自动 `setArtifactsOpen(false)`
- 内存态不持久化（重启重置，同 browser.store 假设）
- 会话删除时的清理：store 记录按需淘汰（会话删除 IPC 后 store 项成为孤儿数据，仅占内存，不清理无害；一期接受）

## 4. 浏览器 tab

- 复用 `ai/browser` 域组件：`BrowserToolbar` + `BrowserWebview` + `NewTabPage` 均已 props 驱动
- **唯一改造**：`BrowserToolbar` 内 `useBrowserStore.getState().syncTab(...)` 参数化为可选 `onSync` prop（缺省回落全局 store，`/module/ai/browser` 页行为不变）
- 每个 browser tab 的 url/title 等状态存于 DetailTab 负载（不接全局
  browser.store），BrowserPanelTab 以 props 驱动复用既有组件；url 空 →
  NewTabPage 输入后挂 webview
- partition 同 `persist:browser-webview`：登录态与浏览器页共享；`installBrowserSessionGuard`（NetworkGate/SSRF/响应头剥离）与 guest 开窗转发按 partition 自动生效
- webview 非受控 src / 事件原生绑定 / ref 惰性取值（不传节点为 prop）——全部沿 BrowserWebview 既有实现与已踩坑结论，不重写

## 5. 工作空间 tab（文件树）

- 新 IPC `workspace:listDir`（invoke，入参 `{ workspaceId, dirPath? }`；dirPath 缺省 = 工作空间根 `directoryPath`）
  - 沙箱校验：resolve 后必须仍在该工作空间 `directoryPath` 之内（越界拒绝报错）——与 `file:readWorkspaceFile` 的 resolveSafePath 同语义，**非**产物预览的 fullAccess 语义
  - 返回 `{ name, isDir, size, mtime }[]`（目录内自然序，前端图标区分）
  - 纯 Node 实现（禁止 import electron），照 `workspace-files.ts` 可测先例，放 `electron/domains/ai/chat/workspace-dir.ts`
- `WorkspaceFileTree`：懒加载递归树（展开时列子目录），点击文件构造 `SessionFile { path, group: "workspace", status: "written", messageId: 0 }` 复用 `FilePreview` 预览（在 tab 内容区内预览，返回回树）
- 工作空间无 `directoryPath`：空态引导「绑定目录」（复用现有绑定流程入口）
- 隐藏文件/目录（`.` 开头）默认不列；文件数上限单目录 2000 条防卡

## 6. 终端子系统（新域 `electron/domains/ai/terminal/`）

### 依赖

- `node-pty`：vite main external（走 Node 原生 require，同 better-sqlite3 注释先例）；`postinstall: electron-builder install-app-deps` 负责按 Electron ABI 重编译；electron-builder 自动 asarUnpack `.node`
- `@xterm/xterm` + `@xterm/addon-fit`（仅渲染进程）

### terminal.service.ts

```ts
create(cwd: string): string           // pty.spawn → 登记 id；返回 id
write(id, data) / resize(id, cols, rows) / kill(id)
// 事件推送：terminal:data:<id>（pty data）、terminal:exit:<id>（进程退出）
// app will-quit：全量 kill；重复 kill/写不存在的 id 幂等不抛
```

- 默认 shell：win `powershell.exe`；darwin/linux `process.env.SHELL` → `/bin/zsh` → `/bin/bash` 兜底
- 启动失败（spawn 抛错）→ invoke 直接 reject，前端 toast 原因并不开 tab
- 不挂权限门（用户裁定）；不落库、无 userId 语义；IPC 仍走 preload 白名单收敛面

### IPC 通道（ipc-channels.ts）

- INVOKE：`terminal:create`
- SEND：`terminal:write`、`terminal:resize`、`terminal:kill`（高频流数据不走 invoke）
- EVENT_PREFIXES：追加 `terminal:data:`、`terminal:exit:`（同 `chat:stream:` 模式）

### TerminalTab.tsx（渲染）

- `@xterm/xterm` Terminal + fit addon + ResizeObserver（tab 显示/隐藏切换时 refit）
- 主题：从 `getComputedStyle` 读 CSS 变量（`--background`/`--foreground`/`--primary` 等）取色，跟随 4 主题；主题切换时重建 theme（一期监听 `data-theme` 变更或重挂时刷新均可）
- `onData` → `terminal:write`；`on('terminal:data:<id>')` → `term.write`；`terminal:exit` → 显示退出态 + 「重新打开」按钮（同 id 重建）
- cwd = 打开时会话工作空间 `directoryPath`；无绑定取 `os.homedir()`
- tab 隐藏不销毁（display 隐藏，保回滚缓冲）；关闭 tab 前必 kill

## 7. i18n（chat 命名空间，zh-CN/en-US 同步）

```
detailPanel.newTab / .openBrowser / .openWorkspaceFiles / .openTerminal
detailPanel.artifacts / .browser / .workspace / .terminal（tab 标题）
detailPanel.terminal.reopen / .exited / .createFailed
detailPanel.workspace.bindDirectory / .empty / .loadFailed
```

## 8. 错误处理

- listDir 越界/目录不存在 → 前端行内错误态 + 重试
- pty create 失败 → toast + 不开 tab
- webview 加载失败 → 沿 BrowserWebview 既有覆盖层
- xterm 容器尺寸为 0 时跳过 fit（隐藏 tab）

## 9. 测试（Vitest）

- `workspace-dir.ts`：正常列目录 / 越界 dirPath 拒绝 / 隐藏文件过滤 / 上限截断
- `terminal.service`：mock node-pty——create 登记、write/resize 转发、kill 幂等、exit 推送、will-quit 全清
- `detail-panel.store`：初始化产物 tab / +菜单三类 / 关 tab 切 active / 关空自动收起语义 / sessionId 隔离互不影响
- 组件测试：DetailTabBar/NewTabMenu 交互（xterm 与 webview 薄封装不测）

## 10. 风险

- node-pty 与 Electron 44 ABI 匹配：依赖 install-app-deps 重编译（本机已装 node-gyp）；若失败，终端菜单项禁用并提示，不阻塞其余 tab
- Windows powershell 行为需打包后验证（本机 darwin 开发）
- 多终端/多 webview 常驻的内存占用：tab 数量由用户控制，接受
