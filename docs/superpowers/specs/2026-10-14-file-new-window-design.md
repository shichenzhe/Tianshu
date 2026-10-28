# 文件独立窗口（file-window）设计

- 日期：2026-10-14
- 状态：已与用户对齐（多 tab / AI 直改 / 资料库 / 快捷指令全量 / 快照持久化 / library 工具直改；偏离项见 §10；二批调整见 §13）
- 参照：WorkBuddy 5.7.7（/Applications/WorkBuddy.app 逆向调研，结论摘要见 §2）

## 1. 背景与目标

主窗口文件预览（FilePreview / 资料库预览）增加「在新窗口打开」，弹出独立文件窗口：

- 窗口内**多 tab**（workspace 文件 / 资料库条目），可编辑、可保存
- 右侧 **AI 对话面板**：围绕当前激活文件对话，快捷指令，**AI 可直接修改文件**
- 交互形态与 WorkBuddy office window 对齐

## 2. WorkBuddy 调研结论摘要（逆向要点）

| 机制 | WorkBuddy 实现 |
|---|---|
| 窗口形态 | 独立 window app（`?windowAppId=office`），多实例，1440×852 / min 640×480 |
| 多 tab | 渲染层 reducer；按文件路径去重；busy 态 closing/moving 防重入；`+` 按钮是下拉菜单（新建模板文件/打开文件/打开网址/最近打开），无空白 tab；空窗居中提示，最后一个 tab 关闭自动关窗 |
| 新建文档 | 临时目录真实文件（模板内容），另存为转正，关闭未另存即删 |
| tab 菜单 | 在新窗口打开（=移动：本窗关 tab + 新窗开，携带 conversationId）/ 关闭其他 / 关闭右侧 / 复制路径 |
| 关闭握手 | 4 通道 close bridge（close-request/confirm/cancel/ready）+ renderer 未 ready 3s 强关 + 请求 15s 超时重置 |
| 会话绑定 | 每 tab（按文件）一个 conversation；惰性创建（首条消息）；文件→会话映射持久化（每文件最近 20 个）；关空会话丢弃；conversationId 挂 tab.resource 随移窗迁移；面板显示激活 tab 的会话 |
| 快照持久化 | `{tabs, activeTabId}` 经 setSessionState 存主进程窗口注册表 meta，重载 restoreSnapshot |
| AI 上下文注入 | 不拼全文：blocks 插 `resource_link`（file:// 引用）+ prompt 级本地文件路由声明，agent 用本地工具按需读 |
| AI 直改 | agent 工具直接写磁盘（二进制走 editor SDK MCP 命令实时流；文本走 Write/Edit）+ 文件 watcher 检测外部变更 → 预览不脏则重载、脏则冲突对话框；无预览 diff/人工应用中间步骤 |
| 审批 | 无 office 域专属审批 UI，共享全局权限系统（allow once/always/reject） |
| 快捷指令 | 按文件类型矩阵（word/excel/ppt/pdf/markdown/html/text/image/audio 各 3-4 条）；点击仅插入输入框不自动发送 |
| 面板交互 | 可收起（tab 粒度记忆）+ 可拖宽（min 320 / max 窗宽 50%，storage.device 持久化）；「新建任务」=当前文件换新会话 |
| 资料库 | 云端 web 应用（workbuddy.cn/space，module federation），本地无文件窗逻辑可抄 |

## 3. 总体架构

```
主窗 FilePreview 工具栏「在新窗口打开」────────┐
资料库预览工具栏「在新窗口打开」───────────────┤
文件窗 tab 菜单「在新窗口打开」（移动语义）─────┼→ invoke fileWindow:open {windowId?, resources: Resource[]}
                                              ↓
主进程 FileWindowService（electron/domains/ai/file-window/file-window.service.ts）
  ├ open：新开 BrowserWindow（每次 open 新窗，WorkBuddy disposition:"new-window" 同款）
  ├ 复用/恢复：windowId → BrowserWindow 注册表（Map）；
  │   同 windowId 已存在 → 发 fileWindow:deliver {resources} 让既有窗口开 tab（复用语义）
  ├ 窗口参数：1440×852、min 640×480、preload/webviewTag/titleBarStyle/trafficLightPosition/titleBarOverlay 照抄主窗 createWindow
  ├ 守卫：setWindowOpenHandler（deny + handleWindowOpen）/ will-navigate 白名单，同主窗
  └ loadURL：dev server / index.html + #/file-window?windowId=…
```

**Resource 联合类型**（前后端共享，放 `src-react/domains/ai/file-window/model/resource.ts`，主进程 type-only 反向 import 先例）：

```ts
type FileWindowResource =
  | { kind: "workspace"; workspaceId: number; path: string; sessionId?: number }
  | { kind: "library"; itemId: number; sessionId?: number };
```

**新增 IPC**（白名单 `electron/commons/ipc-channels.ts` 同步登记）：

| 通道 | 方向 | 语义 |
|---|---|---|
| `fileWindow:open` | r→m invoke | 开新窗（或向既有 windowId 投递 resources） |
| `fileWindow:setSessionState` | r→m invoke | 按 windowId 存 tabs 快照（主进程内存注册表） |
| `fileWindow:getSessionState` | r→m invoke | bootstrap 时取快照恢复 |
| `fileWindow:close-request` | m→r send | 主进程拦截 close 后询问 renderer |
| `fileWindow:confirmClose` | r→m invoke | 全部 tab 处理完毕，放行关闭 |
| `fileWindow:cancelClose` | r→m invoke | 用户取消，复位 |
| `fileWindow:close-ready` | r→m invoke | renderer 就绪标记（挂载即发） |
| `workspace:writeFile` | r→m invoke | workspace 文件写回（见 §5） |
| `workspace:fileChanged` | m→r broadcast | AI 工具写盘后全窗广播（见 §5） |

**路由**：`#/file-window`（与 `/login` 平级，不套 MainLayout/AiLayout）。视图 `FileWindowView` 自带登录守卫 effect（`isLoginValid` 失败 → navigate `/login`，语义同 MainLayout；localStorage 同 partition 共享，token 可读）。

## 4. 多 tab 子系统

### 4.1 状态

窗口本地 zustand（`src-react/domains/ai/file-window/store/file-window.store.ts`，照 detail-panel.store 模式）：

```ts
interface FileWindowTab {
  id: string;                // "fw-tab-" + 单调递增
  resource: FileWindowResource;
  title: string;             // basename / 条目名
  contentKind: "md" | "text" | "csv" | "image" | "pdf" | "html" | "audiovideo";
  dirty: boolean;
  saveStatus: "saved" | "unsaved" | "saving" | "hidden";  // hidden=只读类不显示
  busy: null | "closing" | "moving";
  sessionId?: number;        // AI 会话绑定（惰性创建）
  /** 加载基线：磁盘 mtime（保存/冲突检测用） */
  baselineMtime: number | null;
  aiPanelOpen?: boolean;     // 面板开合按 tab 记忆
}
// state: { tabs, activeTabId, nextId }；action: openTab/restore/activate/reorder/close/patchTab（initResources 已删——openTab 直用，§16 项 7）
```

- **去重键**：workspace `w:{workspaceId}:{normalize(path)}`、library `l:{itemId}`；重复打开激活既有 tab
- **busy 防重入**：closing/moving 置位后 tab 禁交互、溢出列表禁用，标签文案换「正在关闭…/正在移到新窗口…」
- **快照**：`{tabs 精简序列化（含 resource/sessionId/dirty 标记）, activeTabId}` 每次变更防抖 500ms `setSessionState`；bootstrap 先 `getSessionState` restore（WorkBuddy restoreSnapshot 同款；关窗即弃）
- **tab 条**：复用 `DetailTabBar`（DnD 重排/横滚/溢出隐藏现成），图标映射从固定 `DetailTabKind` 泛化为 `contentKind → icon` 注入

### 4.2 「+」菜单（下拉，非空白 tab）

- **新建 Markdown / 新建文本**：直接在 workspace 根创建 `未命名-{n}.md|.txt`（§10 偏离 1）后按普通文件开 tab
- **打开文件**：主进程 `dialog.showOpenDialog`，限定「首个 workspace tab 所属 workspace 的 directoryPath」内（多选）；窗口无 workspace tab 时按默认 workspace
- **最近打开**：localStorage（每类最近 10 条）
- 无 tab 时内容区居中提示「打开文件以开始」；恢复完成 + 无 tab → 自动关窗（`fileWindow:confirmClose` + BrowserWindow.close）

### 4.3 tab 菜单（右键/更多）

在新窗口打开（移动语义）/ 关闭 / 关闭其他 / 关闭右侧 / 复制路径。

**移动语义**（WorkBuddy 同款）：`busy=moving` → 走关闭握手（move 模式，见 §4.4）→ 本窗 dispatch close → `fileWindow:open {resources:[{...resource, sessionId}]}` 新窗 → 若关的是最后一个 tab → 关本窗。

### 4.4 关闭握手（简化 close bridge）

- 挂载即 `close-ready`；主进程 `close` 事件 preventDefault（除非 allowClose）
- renderer 未 ready 时收到 close：记 pending，**3s 后强关**（防 renderer 卡死）；已 ready：发 `close-request`，**15s 超时视为取消并复位**（WorkBuddy 同款双定时器）
- renderer 收 close-request：逐 tab 脏检查——dirty tab 弹自绘确认（保存并关闭 / 放弃 / 取消）；全部处理完 `confirmClose`，任一取消 `cancelClose`
- renderer 崩溃/destroyed：主进程直接 close

## 5. 编辑与保存

### 5.1 内容类型路由（按 resource + 扩展名判定，复用 previewModeOfPath / previewModeOf 语义）

| contentKind | 渲染/编辑 | 可编辑 | saveStatus |
|---|---|---|---|
| md | `LibraryMarkdownEditor`（纯受控复用，工具栏+分栏预览） | ✅ | saved/unsaved/saving |
| text | 等宽 `<textarea>`（min-h 全区、等宽字体） | ✅ | 同上 |
| csv | `LibraryCsvEditor`（library tab） | ✅ | 同上 |
| image | dataUrl `<img>` 直渲 | ❌ | hidden |
| pdf/html/audiovideo | `<webview file://>`（独立 partition、will-navigate 拦截，同 FilePreview 守卫语义） | ❌ | hidden |

### 5.2 保存链路

- **workspace tab**：⌘S/保存按钮/关闭确认 → invoke `workspace:writeFile {workspaceId, path, content}`：
  1. 路径解析同 `resolveFilePath`（相对 → workspace 目录 resolve）
  2. **mtime 基线校验**：磁盘当前 mtime ≠ tab.baselineMtime → 返回冲突错误，renderer 弹「覆盖磁盘版本 / 重载文件」确认
  3. `FileHistoryService.backupFile`（配置启用时）
  4. 写盘、更新 baselineMtime、saveStatus=saved
- **library tab**：`library:writeFileContent {itemId, content}`（现成），同样做冲突校验（条目 updatedAt 基线）
- **另存为**：复用 `workspace:exportFile`（workspace）/ 主进程 dialog 另存（library，二期可裁）
- **保存后广播**：`workspace:writeFile` 与 AI 工具写盘后广播 `workspace:fileChanged {workspaceId, path}`；所有窗口（主窗 React Query invalidate `["artifact-file"]`、文件窗同路径 tab）消费——tab 不脏则静默重载，脏则冲突对话框（WorkBuddy saveGuard 语义的事件驱动版）

### 5.3 脏标记

编辑 onChange 即 dirty=true / unsaved；保存成功回 saved；切 tab/关窗不自动保存（窗口内统一手动保存语义，区别于资料库面板内嵌的 800ms 自动保存）。

## 6. AI 对话面板

### 6.1 复用面与布局

- `useChatSend` + `MessageList {sessionId, workspaceId}`（内含 ApprovalBanner/ToolCallCard/ThinkingPanel/MarkdownView 全家）+ 自配轻输入框（多行 textarea + 发送，无 @/技能/附件）
- 布局：右侧 aside，宽默认 400 / min 320 / max 窗宽 50%（pointer 拖拽 + localStorage 持久化）；头部「新建任务 / 收起」按钮；收起后内容区全宽
- 空态：标题「AI, 我帮你」+ 副题「围绕当前文件帮你处理各种需求」+ 快捷指令 chips；placeholder「让我帮你处理这份文件...」

### 6.2 会话绑定（每 tab 一会话）

- **惰性创建**：tab 首条消息时 `session:create {workspaceId, title: 文件名}`；workspace tab 挂所属 workspace，library tab 挂默认 workspace
- sessionId 存 tab 状态，随快照持久化、随「移到新窗口」迁移
- 「新建任务」= 当前 tab 换新 sessionId（旧会话若空不落库）
- **mode**：workspace 文件 tab 用 `agent`（工具直改需要）；library tab 同样 `agent`（路径授权后工具直写，见 §6.4）

### 6.3 上下文注入（引用语义，不拼全文）

首条消息（快捷指令或自由输入）自动前缀注入：

```
【当前文件】{absPath 或 library 文件说明}
请先用 read_file 工具读取该文件再处理我的请求。
```

后续轮靠会话历史；文件被外部/AI 修改后用户追问时，面板提供「重新注入文件」按钮（贴最新路径+提示重读）。图片 tab 首条走多模态 images 附件（`ChatSendParams.images {absPath}`，library 图片经 storagePath）。

### 6.4 AI 直改（双通道，均为工具真直改）

**workspace 文件**：AI `write_file` 落盘（现成链路：审批横幅 allow once/always、`FileHistoryService` 备份、workspace 沙箱判定）→ `workspace:fileChanged` 广播 → 编辑器重载/脏冲突弹窗（§5.2）。

**library 文件（路径级授权扩展）**：

- 现状：file-gate `extraBuiltin = [userData, tianshuRoot()]` 全禁 AI 工具读写数据根
- 扩展：**会话级授权路径清单**——文件窗口内 library tab 发起对话时，该条目 `storagePath` 注册进该 sessionId 的授权清单（主进程内存 + 落 option 表持久化，随会话删除回收）；判定链两层都须命中放行：`makeFileDecider`（file-gate）对授权 absPath 的 read_file 放行、write_file 仍走审批横幅（用户 allow always 后记入现有 remembered 权限体系）；`file-tools.ts` 内 `resolveSafePath` 的 workspace 沙箱校验同样以授权清单为白名单输入（否则工具内层先拒）
- 数据根其余路径（数据库、其他条目）维持全禁；授权动作本身由用户在文件窗打开该文件并发起对话这一手势构成，无静默扩权

### 6.5 快捷指令（照 WorkBuddy 文案矩阵，天枢五类）

| 类型 | 指令（label → prompt 模板） |
|---|---|
| md | 总结全文要点 / 检查错别字和语病 / 润色全文 / 生成大纲 |
| text | 总结要点 / 检查语病 / 提取信息 / 翻译 |
| image | 描述内容 / 提取文字 / 分析图表 / 图片问答 |
| html | 总结页面内容 / 优化页面结构 |
| pdf | 总结全文要点 / 提取关键数据 / 梳理文档结构 / 就内容答疑 |

prompt 模板文案对照 WorkBuddy locale 逐条移植（§8 i18n）。**点击 = 插入输入框并聚焦，不自动发送**（WorkBuddy 同款）。

## 7. 入口

1. **主窗 FilePreview 工具栏**右侧「在新窗口打开」图标钮（file tab 与产物预览两形态同享；移动语义：关主窗对应 file tab + 新窗打开；产物预览形态无 tab 可关，仅开新窗）
2. **资料库预览工具栏**同款按钮（md/csv/text/image/webview 条目；携带 itemId 开 library tab；移动语义关资料库详情）
3. 文件窗自身 tab 菜单「在新窗口打开」（§4.3）

## 8. i18n

`chat.json` 新增 `fileWindow/` 命名空间（zh-CN/en-US 同步），对照 WorkBuddy 文案移植，含：title、openInNewWindow、tab.*（new/newOrOpen/openFile/recent/close/closeOthers/closeRight/copyPath/moving/closing/emptyHint 打开文件以开始）、saveStatus.*、action.*（save/saveAs/reveal/aiChat/newTask/collapse）、closeConfirm.*（title/message/saveAndClose/discard/cancel）、chat.*（emptyTitle/emptyHint/placeholder/reinjectFile 重新注入）、prompt.{md,text,image,html,pdf}.*、conflict.*（title/overwrite/reload）、error.*（openFailed/writeFailed/conflict 等）。

## 9. 测试策略

- **主进程**：fileWindow.service（开窗参数/守卫/复用投递/关闭握手双定时器/快照存取）、workspace:writeFile（路径解析/基线冲突/备份/广播/失败文案）、路径授权清单（注册/回收/file-gate 判定命中与不命中）
- **渲染**：store（去重/邻位激活/busy/restore）、tab 条交互、内容路由与脏标记、⌘S、关闭确认流、AI 面板（惰性建会话/首条注入/快捷指令插入不发送/应用通道）、fileChanged 重载与脏冲突
- **回归**：现有 file-preview/detail-panel/chat 相关测试全量通过

## 10. 与 WorkBuddy 的刻意偏离

| # | 偏离 | 理由 |
|---|---|---|
| 1 | 新建文件直接落 workspace（不做 tmp 未命名+另存转正+关闭删除） | 天枢 workspace 即用户可见目录，tmp 转正流程复杂度高收益低 |
| 2 | 不做 lease 池/checkOpen 仲裁（多窗同文件靠保存/写盘事件时 mtime 基线冲突检测） | 天枢无二进制编辑器实时流，冲突面只剩写盘竞态，事件驱动检测够用 |
| 3 | busy 态 UI 文案未做（移动/关闭进行中仅按钮禁用） | busy 防重入已达标（再触发被拦）；「移动中…」提示条属 UX 层，留后续 |
| 4 | 资料库入口无移动语义（主窗资料库详情在文件窗只开不关） | 详情非 tab 语义，主窗无「关详情」概念可搬运；一期只开不关成本最低 |
| 5 | AI 首条注入用相对路径（WorkBuddy 注入绝对路径） | read_file 工具原生即工作空间相对路径语义，注入相对路径可直接被工具消费，良性 |

## 11. 交付切分（实现计划输入）

单 spec 交付，plan 按：① 主进程窗口服务+IPC+路由骨架 → ② tab 子系统+tab 条 → ③ 内容路由+编辑器+保存链路 → ④ AI 面板+会话+快捷指令 → ⑤ AI 直改双通道+fileChanged 联动 → ⑥ 资料库入口+路径授权 → ⑦ 网址 tab → ⑧ i18n+测试收尾。

## 12. 补齐批次（2026-10-15，终审后 WorkBuddy 差距对比裁定）

对比结论中的「可低成本补齐」七项，一项裁定不做：

| # | 项 | 设计 |
|---|---|---|
| 1 | busy 态文案 | DetailTabBarItem 加 busy 文案字段；tab 显示「正在关闭…/正在移到新窗口…」+ aria-busy + 禁交互；i18n fileWindow.tab.{closing,moving} |
| 2 | 溢出 tab 下拉 | tab 条「+」左侧「打开的文档」DropdownMenu 列全部 tab 点击激活（横滚保留） |
| 3 | ⌘⇧] / ⌘⇧[ 循环切换 | FileWindowView 全局 keydown；焦点在输入框/textarea/contentEditable 时忽略（DetailPanel T/W 守卫口径） |
| 4 | 文件→会话历史映射 | localStorage `tianshu-file-window-session-map` Record<dedupeKey, sessionId[]>（每文件最近 10）；openTab 时 resource 无 sessionId 则 seed 最近一个；patchTab sessionId 变化时 push；「新建任务」旧会话保留映射；不做关空会话丢弃（主窗会话列表可管） |
| 5 | 「打开主页」 | 面板头部按钮 → invoke `fileWindow:focusMain`（主进程 show+focus 主窗；白名单+handleUser） |
| 6 | 图片拖入 AI 输入框 | 轻输入框 onDrop → FileReader blob → invoke `file:savePastedImage`（现成）→ images 附件 chips（可移除）→ 随发送 images [{absPath}] |
| 7 | 窗口预热 prewarm | 主进程 ready 后预建隐藏窗（预生成 windowId，路由带参加载，渲染层即订阅）；open 时取用（show+deliver）并补建下一只池窗 |
| — | ~~快捷指令 audio/video 变体~~ | **不做**：agent 无音频处理工具（WorkBuddy 走 ffmpeg 类工具），加了是死指令；excel/ppt 文件类型天枢不存在 |

## 13. 二批调整（2026-10-15，用户验收反馈）

| # | 项 | 设计 |
|---|---|---|
| 1 | 窗口标题区分 | 文件窗 BrowserWindow title =「天枢 文件浏览器」（主窗仍「天枢」）；视图头行与 i18n fileWindow.title 同步 |
| 2 | 移除网址 tab | 文件窗仅面向文件：Resource 删除 kind:"url"、contentKind 删除 url、FileUrlView 删除、「+」菜单删「打开网址」表单、图标映射/测试/白名单相关清理；spec §3/§5.1/§6.1 的 url 行废止 |
| 3 | AI 面板全功能对齐 | 面板内嵌完整 ChatPane（会话消息流 + ChatInput 全量：附件/技能/@/权限胶囊/模型选择），替换精简输入框；面板外壳（收起/拖宽/新建任务/打开主页）保留；快捷指令 chips 点击将模板文本注入 ChatInput 输入框（不自动发送，WorkBuddy 语义不变）；ChatPane 个别主窗语境耦合（如右栏联动）在文件窗禁用对应入口而非砍组件 |
| 4 | 编辑器对齐调研 | 见对话结论文档（WorkBuddy 编辑器不开源；建议 Tiptap/CodeMirror 路线）——不属本批实现 |

## 14. 三批：CodeMirror 6 编辑器（2026-10-15）

| # | 项 | 设计 |
|---|---|---|
| 1 | CM6 统一编辑器 | 新组件 FileWindowEditor（@codemirror/state/view/language/commands + lang-markdown/json/html/css/javascript/python，动态 import 懒加载语言包→Vite 自动分包）；文件窗 md/text（含 library md）全量替换 textarea 与 LibraryMarkdownEditor 复用；受控桥接（updateListener→draft 链路不变；外部重载→dispatch 替换） |
| 2 | 体验面 | 行号/折叠/撤销重做/括号匹配/当前行高亮；md 保留分栏预览（Eye 切换）；md 工具栏（B/I/链接）**二期不做**（裁定：CM6+高亮+分栏已是主要升级） |
| 3 | 主题 | EditorView.theme 透明底 + 应用 CSS 变量（gutter/边框/选区用主题变量，跟随 4 主题切换）；语法高亮 HighlightStyle 一套中性配色 |
| 4 | ⌘S | Mod-s 不入 CM6 keymap（未处理键冒泡）——现有 window 级监听自然生效，测试钉住 |
| 5 | 不动面 | library csv 仍 LibraryCsvEditor；资料库主面板编辑器不动（library 域自有）；512KB 读取上限不变 |

## 15. 四批：AI 面板输入框（2026-10-15，用户验收反馈）

| # | 项 | 设计 |
|---|---|---|
| 1 | 面板默认即完整输入框 | 废止 §13 项 3 的「空态轻输入框」分支：面板挂载即渲染 ChatPane（无真会话时传占位 SessionRecord id=-1）；ChatPane 加可选 prop `sessionResolver?: () => Promise<{session; contentPrefix?}>`（哨兵 id 发送时先建会话+拼文件注入前缀，主窗缺省零改动）；快捷指令经 ChatInput quickPrompts 胶囊可达（原空态 chips 退役）；T19 拖入注入链保留 |
| 2 | 空会话回收 | tab 增 `sessionCreatedHere?` 瞬态标记（不入快照）；关闭 tab 时若本窗创建且会话无消息（message:listBySession 空）→ session:delete（WorkBuddy discardEmptyConversation 同款）；整窗关闭走同检查 |
| 3 | 窄容器越界 | ChatInput 布局 flex-wrap 化等响应式适配（宽容器天然同行零变化，主窗无感）；胶囊/徽标/chip 行窄容器换行、长文本截断；320/400/50% 三宽度实测无横向越界 |

| — | 裁定补记 | images-only 发送废止（T26）：面板对齐主窗口径优先，拖图挂 chips 配文字发送；§12 项 6 的 images-only 分叉撤销 |

## 16. 五批：卫生批次 + 生产构建验证（2026-10-16）

| # | 项 | 设计 |
|---|---|---|
| 1 | 授权随会话删除回收 | session:delete handler 调 revokeSession（主进程内直连，不加通道） |
| 2 | grantedPaths 按 userId 过滤 | option 查询/落盘带 userId 维度（键含 userId 或 JSON 内分用户桶——按 option 唯一键 type+name+userId 现状择一，报告写明） |
| 3 | dedupeKeyOf 路径归一 + openTab 命中保留 sessionId | path 归一（去 ./、重复分隔符）；openTab 命中既有 tab 时 resource.sessionId 非空则 patchTab 覆盖（移窗接管语义） |
| 4 | crashed renderer 直接关 | close bridge：webContents crashed/destroyed 时跳过 15s 协商直接 allowClose+close（主进程侧） |
| 5 | AI 输入草稿 per-tab | 切 tab/重挂保留草稿（store 加 inputDraft 瞬态字段或 ChatInput 草稿外置——最小侵入方案实现者定，快照不含） |
| 6 | webview 守卫收敛 | use-webview-guard 移共享位置（chat/lib），FilePreview/LibraryPreviewContent 两旧拷贝替换 |
| 7 | initResources 死动作删除 | store + 类型 + 文档引用清理 |
| 8 | 生产构建验证 | npm run build 全链路（tsc+vite+electron 打包）+ 打包产物启动冒烟（多窗/prewarm/CM6/文件窗全链路） |

## 17. 六批：library 首条注入引用式（2026-10-16，token 优化）

| # | 项 | 设计 |
|---|---|---|
| 1 | 引用式注入 | library 文本类首条不再注入全文——改为绝对 storagePath 引用 + 「请先用 read_file（绝对路径）读取」（与 workspace 同构）；前置链已备（T13 授权 layer-2 放行 + T14 绑定空间优先挂载保证工具注入）；图片分支维持 images 附件不变 |
| 2 | 降级回退 | 无绑定目录空间（工具不注入、read_file 不可用）时回退全文注入（现行为，截断 10 万字符）；i18n 双模板区分（引用式/全文回退） |
| 3 | 收益 | library 首条上下文从 ~2.5万-6万 token 降至几十 token + 按需 read_file |

## 18. 七批：多轮历史治理（2026-10-16，token 优化续）

| # | 项 | 设计 |
|---|---|---|
| 1 | 旧轮工具输出回喂瘦身 | assembleContext 构造的回喂副本上：非最近 2 轮的 tool_call output 超 6000 字符 → 头 3000 + 尾 1000 + 「[已截断 N 字符]」标注；**DB 原文不动**（编辑重发/回看全量不受影响）；token 估算与截断判定同步用瘦身后成本；常量集中可调 |
| 2 | 自动压缩 | send 前检测（历史+新消息估算 ≥ 预算 80%）→ 自动走 compact 流程（摘要轮落库，前端已有 compactedUpToId 提示条）→ 再发用户消息；冷却带（压缩后再涨 20% 才可再压）防抖；COMPACT_DIRECTIVE 轮豁免；压缩失败静默回退现行为（硬截兜底不变）；手动 /compact 保留 |


## 19. 八批：跨窗跳转双向化 + 小修（2026-10-16）

| # | 项 | 设计 |
|---|---|---|
| 1 | 主窗→文件窗跳转 | 反转文件窗 session-map（localStorage 同 partition 共享）得 session→resource 索引；主窗会话列表项若命中索引渲染「在文件窗口打开」图标钮 → invoke fileWindow:open {resources:[{...resource, sessionId}]}（文件窗去重聚焦/命中覆盖 sessionId——T28 项 3）；不强劫持点会话本体（主窗纯聊仍合法） |
| 2 | T32 双流自愈 | compact 轮 assistant 落库抛错的吞错 catch 补「注册不在则重注册 abort」一行 |
| 3 | oxc.drop 基建 | Vite 8 下 esbuild.drop 失效改 oxc 等效配置（生产 drop console），build 后产物 console 计数验证归零 |

## 20. 九批：工具面精简（2026-10-16）

| # | 项 | 设计 |
|---|---|---|
| A | 描述瘦身 | 对话注入面全部工具描述改一句话式 ≤40 字；使用细节/规范指引挪到出错提示、技能文档（create_workflow 的「先读 workflow-creator 规范」类指引归技能侧）；**工具名不动**（历史 blocks 存 toolName，改名断回喂/编辑重发） |
| B | 场景门控（学 WorkBuddy 分层：窄常驻+按需挂载） | 核心组恒注入（file5/browser5/run_command/web_fetch/create_skill/read_skill）；工作流 6 件套仅 automation 场景或 workflow-creator 技能启用时注入；create/update_expert 仅专家绑定会话；pre/after 仅对应专家绑定；实现复用 SP6 disabledTools 注入层过滤形态但独立于用户禁用配置（场景映射，非安全语义）；内置技能默认启用不开门（source!=builtin 且 enabled 才算——内置自愈态恒 true 会使门控失效，逃生门=coding 场景或自动化页） |
| — | C 结构合并不做 | get_workflow_run 并入 run_workflow 等涉及工具名变更，破坏历史会话回喂兼容 |
