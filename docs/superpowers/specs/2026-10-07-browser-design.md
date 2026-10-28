# 内置浏览器（BrowserView）——设计文档

日期：2026-10-07
状态：已与用户确认设计方向（裁剪版）

## 背景与目标

参照 WorkBuddy v5.5.6 内置浏览器（`packages/context-viewer-components/src/browser-preview/*`，
app.asar 解包源码）为天枢提供应用内浏览器能力。

WorkBuddy 浏览器的产品定位（源码考证）：**首先是 AI 产物预览器**（Agent
`present_files` 默认用内置浏览器打开 HTML 产物，partition 名
`agent-browser-preview-webview`），**其次是通用网页浏览**（多 tab + 地址栏 +
新标签页，persist partition 保登录态）。

天枢现状：webview 仅用于本地 `file://` 只读预览（资料库
`LibraryPreviewContent` / 产物面板 `FilePreview`），`will-navigate` 全拦、
http(s) 子请求全拒——无任何「浏览任意网页」的能力。本设计补上这半边。

**已拍板的决策**：

- **定位**：「AI 产物预览（未来升级复用）+ 应用内查资料」二合一，第一版
  交付浏览器本体。
- **入口**：全局侧边栏一级入口「浏览器」`/module/ai/browser`（与资料库、
  自动化并列）。
- **裁剪**（用户确认）：设备模拟、local-file:// Range 协议不进第一版；
  LRU webview 池（低端机优化）、账号级动态 partition（腾讯多账号特有）、
  腾讯文档/乐享特判、搜索兜底均不做。
- **安全模型（天枢特色，WorkBuddy 没有）**：浏览器 session 的 http(s)
  请求走天枢 `NetworkGate` 判定（blocklist 命中即拦 + 审计），对齐安全中心
  四层拦截口径。

## 1. 信息架构

```
全局侧边栏 navEntries +「浏览器」（Globe 图标，资料库之后）
└── 路由 /module/ai/browser（routes/index.tsx 懒加载）
    └── BrowserView（新）
        ├── BrowserTabBar：tab 列表（favicon/标题/关闭）+「+」新建
        ├── 内容区（每 tab 一个常驻 <webview>）
        │   ├── NewTabPage：输入框（url-input.ts 解析）
        │   └── BrowserWebview：页面 + 加载/错误/拦截态
        └── BrowserToolbar：返回/前进/刷新/地址栏/清数据菜单
```

## 2. 主进程设计

### 2.1 模块

`electron/domains/ai/browser/browser-session.ts`（薄壳 + 纯函数，electron
mock 可测——对齐 `renderer-guard.ts` 先例）：

```typescript
/** 剥离响应头判定：mainFrame/subFrame 剥 XFO 与 CSP frame-ancestors */
export function sanitizeEmbedHeaders(
  resourceType: string,
  responseHeaders: Record<string, string[]>,
): Record<string, string[]>;

/** SSRF 判定：云 metadata 主机封锁（169.254.169.254 等 3 个） */
export function isSsrfHost(hostname: string): boolean;

/** 清数据类型归一："cookies" | "cache"，非法值抛错 */
export function readClearDataType(value: unknown): "cookies" | "cache";

/** 装配：persist:browser-webview partition 的两道 webRequest 门 + IPC 注册 */
export function installBrowserSessionGuard(): void;
```

### 2.2 session 守卫（`persist:browser-webview`，Application 启动装配一次）

- **onBeforeRequest**（http/https）：
  1. SSRF 主机 → cancel；
  2. `getNetworkGate().judgeUrl(url)` 拦截 → `blockedAudit(host, rule,
     "browser")`（source 分层对齐 SP5 的 renderer/source 口径）+ cancel。
- **onHeadersReceived**：mainFrame/subFrame 剥 `X-Frame-Options`、CSP
  `frame-ancestors`（含 report-only 变体）——不剥则 GitHub 等设 XFO 的站点
  无法在 webview 内打开。其余资源类型原样放行。
- 复刻 WorkBuddy 语义但不带腾讯 CSP 白名单域（无地图/文档依赖）。

### 2.3 IPC 通道

`browser:clearData`（invoke，进 `ipc-channels.ts` allowlist）：

- 入参 `{ type: "cookies" | "cache" }`；
- cookies → `clearStorageData({ storages: ["cookies"] })`；
- cache → `clearStorageData({ storages: [除 cookies 外的站点存储] }) +
  clearCache()`（对齐 WorkBuddy #74366 两类语义：cookies=登录态、cache=其余
  全部）；
- 单一固定 partition（天枢无账号体系，无需 WorkBuddy 的多 session 收集），
  失败向上抛由渲染层 toast。

## 3. 渲染进程设计

### 3.1 模块

```
src-react/domains/ai/browser/
  views/BrowserView.tsx        # 路由视图（拼装 tab 条/内容区/工具栏）
  components/BrowserTabBar.tsx # tab 条
  components/BrowserToolbar.tsx# 导航工具栏
  components/BrowserWebview.tsx# webview 封装（事件同步 + 态路由）
  components/NewTabPage.tsx    # 新标签页
  lib/url-input.ts             # looksLikeUrl / resolveAddressInput 纯函数
  store/browser.store.ts       # Zustand
```

webview 类型声明直接复用 `src-react/domains/ai/library/components/webview.d.ts`
（`declare module "react"` 为环境模块扩充，全编译单元生效，无需移动；实现期若
lint 边界报错再提升到共享位置）。

### 3.2 store（内存态，不持久化）

```typescript
interface BrowserTab {
  id: string;            // crypto.randomUUID()
  url: string;           // 当前地址（did-navigate 同步）
  input: string;         // 地址栏编辑值（失焦回显 url，聚焦可编辑）
  title: string;         // page-title-updated 同步
  favicon: string;       // page-favicon-updated 同步（首个 dataUrl/http url）
  canGoBack: boolean;    // did-navigate 同步
  canGoForward: boolean;
  isLoading: boolean;    // did-start-loading / did-stop-loading
}
```

action：`addTab / closeTab / setActive / setInput / syncTab(partial)`。
关闭最后一个 tab = 回到新标签页（tab.url 为空 + NewTabPage）。

### 3.3 webview 属性（与现有两处预览的关键差异）

| 属性 | 值 | 说明 |
|------|----|------|
| `partition` | `persist:browser-webview` | **persist**：登录态跨重启（现有 library-preview / artifact-preview 为内存态） |
| `webpreferences` | `contextIsolation=yes,sandbox=yes` | 对齐 WorkBuddy LocalWebview |
| `nodeintegration` | 不写 | 默认关 |
| `allowpopups` | **不写** | Electron 按属性「存在性」取值，不写即拒弹窗（同 WorkBuddy BrowserPreview / 现有两处预览） |
| `will-navigate` | **不拦** | 导航是浏览器本职（现有两处预览是全拦，语义相反） |
| `preload` | 不挂 | 无 ui-bridge 语义 |

### 3.4 事件同步（原生 addEventListener，React 合成事件不支持 webview 事件）

- `did-navigate` / `did-navigate-in-page` → url、canGoBack、canGoForward；
- `page-title-updated` → title；
- `page-favicon-updated` → favicon（取 favicons[0]）；
- `did-start-loading` / `did-stop-loading` → isLoading；
- `did-fail-load`（errorCode ≠ -3 ERR_ABORTED）→ 错误态。

导航命令：toolbar 经 `id → webview ref` map 调 `goBack() / goForward() /
reload()`。

## 4. 交互细节

### 4.1 地址栏输入解析（`url-input.ts`，复刻 WorkBuddy new-tab-input 判定）

```typescript
function looksLikeUrl(input: string): boolean;
// 含空白 → false；显式协议头（scheme://）→ true；
// localhost / 127.0.0.1（可带端口）→ true；
// 形如 a.b（含点、点后有内容、无空格）→ true；其余 → false

function resolveAddressInput(input: string): string | null;
// 网址 → 补 https:// 前缀返回（已有协议头原样）；非网址 → null
```

非网址提交 → 地址栏提示「仅支持直接访问网址」（WorkBuddy 同款禁用搜索
兜底）。Enter 提交 / 失焦回显当前 url。

### 4.2 tab 操作

- 「+」新建 tab（NewTabPage 起步）；tab 上「×」关闭；点击切换；
- 每 tab 常驻一个 webview（切换不重载，保滚动/表单状态），不做 LRU 池。

### 4.3 清除浏览数据

工具栏菜单两项：「清除 Cookie（登录态）」「清除缓存与站点数据」→ invoke
`browser:clearData` → 成功 toast；失败 toast `mapIpcError`。

## 5. 安全模型汇总

| 层 | 机制 |
|----|------|
| 请求 | NetworkGate blocklist（source="browser" 审计进安全中心） |
| SSRF | 云 metadata 主机封锁 |
| 嵌入 | 剥 XFO / CSP frame-ancestors（仅 browser partition，不影响 defaultSession） |
| 隔离 | sandbox + contextIsolation + 禁弹窗 + 无 nodeintegration/preload |
| 协议 | 仅 http(s) + localhost（`file://` 不进地址栏解析——本地产物走 FilePreview） |

## 6. 错误处理

- `did-fail-load`（非 -3）→ 页内错误态（图标 + url + 「重试」按钮，重试 =
  reload）；
- 网络门拦截 → 主进程 cancel 表现为加载失败 → 错误态文案「已被安全策略拦
  截」（审计可在安全中心查看）；
- `browser:clearData` 失败 → toast 报错；
- 非网址输入 → 地址栏行内提示（不 toast，避免打断）。

## 7. i18n

- 入口：`chat:sidebar.browser`（chat.json sidebar 对象加 key）；
- 页面文案：`chat:browser.*`（对齐 `chat:library.*` 先例）；
- zh-CN / en-US 同步添加，禁止硬编码文案。

## 8. 测试

- `url-input.ts`：全形态单测——协议头、localhost 带端口、127.0.0.1、裸域名、
  含空格、中文、`a.`、`.b`、空串；
- `browser-session.ts` 纯函数单测（electron mock）：`sanitizeEmbedHeaders`
  （剥 XFO/frame-ancestors、保留其余头、非 frame 资源不动）、`isSsrfHost`、
  `readClearDataType`；
- store 单测：addTab/closeTab（关最后一个回新标签页）/setActive/syncTab。

## 9. 明确不做（第一版）与后续增强

| 项 | 说明 |
|----|------|
| 设备模拟 | DeviceToolbar + enableDeviceEmulation，独立增强 |
| local-file:// Range 协议 | 产物音视频进度条，独立增强 |
| 产物面板升级复用 | FilePreview 的 webview 分支换挂浏览器内核（同 partition + 工具栏） |
| LRU webview 池 / 账号级 partition / 搜索兜底 / AI 工具联动 | 见「背景与目标」裁剪清单 |

## 10. 假设清单（规划期自主决策，实现期如遇冲突回报）

1. tab 内存态，应用重启回新标签页（登录态由 persist partition 保留）；
2. 无搜索兜底，非网址输入仅提示；
3. 浏览器不支持 `file://`；
4. webview 不挂 preload；
5. 清数据清的是全局 partition（全部站点），无按站点清理。
