# AI 页面操控（browser_use 工具组）设计

- 日期：2026-10-14
- 状态：用户持久授权免确认推进；裁定记 Ruling R19-R23
- 参照：WorkBuddy computer-use 方向（AI 操控浏览器干活、用户在面板围观）
- 前置：web 工具（web_fetch/open_browser + 面板联动）已上线；DetailPanel 浏览器 tab 就绪

## 1. 目标

AI 可在「它自己打开的右栏浏览器 tab」里：读页面结构（文本化快照）、点击、输入、导航——形成「open_browser 打开 → snapshot 读 → click/type 操作 → 再 snapshot」的操控循环，用户全程在面板可见。

### 非目标（一期不做）

- 截图/多模态消费（模型能力不确定，快照走文本）
- 滚动控制/拖拽/悬停/键盘组合（YAGNI，快照+点击+输入覆盖绝大多数任务）
- 操控用户手动打开的 tab（仅会话绑定 tab，R19）
- iframe 穿透（跨源 iframe 不采集，标注）

## 2. 主进程：BrowserGuestRegistry（新文件 `electron/domains/ai/browser/guest-registry.ts`）

- `web-contents-created` 捕获 partition=`persist:browser-webview` 的 guest WebContents（复用 browser-session 的 isBrowserGuestSession 判定语义），登记 `{ id, url, destroyed }`；`did-navigate` 跟踪 URL；`destroyed` 移除
- `bindSession(sessionId, webContentsId)`：把 guest 标记为该会话操控目标（会话唯一，重绑覆盖）；`forSession(sessionId)` 查询（destroyed/url 实时）
- 单例（照 commandGate 先例）；electron 依赖经参数注入可测（`attachRegistry(onCreated, webContents)` 工厂形式，vitest mock）
- 生命周期：guest 销毁自动解绑

## 3. 主进程：browser-tools 工厂（`electron/domains/ai/agent/browser-tools.ts`）

四工具（kind 见 R21）：

| 工具 | kind | 行为 |
|---|---|---|
| `browser_snapshot` | read | 对会话绑定 guest `executeJavaScript` 注入采集脚本：提取可交互元素（a/button/input/select/textarea/[onclick]）+ 标题文本，产出 `{序号, tag, text≤80, selector}` 列表 + body 文本摘要 ≤4KB；JSON 回喂 |
| `browser_click` | **write** | 按序号/selector 定位元素 → dispatchEvent(click)（mousedown/mouseup/click 三连更真实） |
| `browser_type` | **write** | 定位 → focus → value 赋值 → dispatch input+change（React 受控组件兼容） |
| `browser_navigate` | read | guest.loadURL(url)（assertUrl 校验复用 web-tools：协议+SSRF） |

- 注入安全（R23）：selector/text 一律 `JSON.stringify` 后嵌入脚本模板——页面内仅 querySelector/赋值/事件派发，无任意代码拼接；序号定位用采集时缓存的 selector（guest 内存 Map<sessionId, {idx→selector}>）
- 无绑定 tab 时统一 fail 文案「先用 open_browser 打开页面」；guest destroyed 同文案
- 工厂注入 `GuestLike`（executeJavaScript/loadURL/isDestroyed）可测；页面脚本失败 try/catch 回 fail

## 4. 绑定链路（前端上报，R19 实现）

- webview tag DOM 事件 `dom-ready` 时（BrowserPanelTab 已监听层——BrowserWebview 有 did-navigate 等，dom-ready 补挂）：渲染层 `webview.getWebContentsId()` → `send("browser:bindSession", webContentsId, sessionId)`（send 白名单 +1）
- 主进程 registry.bindSession；会话重开/复用 tab → 新 webview dom-ready 重绑（覆盖语义天然成立）
- **open_browser 联动打开的 tab 与用户手动 tab 走同一上报**——但 AI 只操控「绑定的」：绑定即「该会话最近 dom-ready 的 browser tab」。用户手动 tab 若是同会话右栏开的，同样可被 AI 操控（用户可见，接受——WorkBuddy 同语义）

## 5. 装配

- registry 单例在 Application（browser 域装配旁）；browser-tools 经 ctx 扩字段拿 sessionId（已有）+ registry 单例直接引用（照 commandGate 模式，不扩 ToolContext——工具工厂闭包持有 registry）
- tool-registry 初始集 + `...makeBrowserTools()`
- 白名单：SEND `browser:bindSession`（无 invoke/事件新通道——工具不新增 IPC）

## 6. Rulings

- R19 AI 仅操控会话绑定 tab（dom-ready 上报 webContentsId；用户可见）
- R20 快照文本化（a11y 式元素表），不做截图/多模态
- R21 click/type 为 write 走既有审批链（工作空间级 isToolAllowed 记忆豁免可用）；snapshot/navigate read
- R22 主进程直执 guest executeJavaScript（不搭渲染层桥；capturePage 未来扩展同路径）
- R23 注入参数 JSON.stringify 转义；脚本仅元素定位/赋值/事件派发；selector 不入模型输出自由拼接（序号引用为主）
