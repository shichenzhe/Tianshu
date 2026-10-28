# AI 网页阅读与浏览器面板联动（web_fetch + open_browser）设计

- 日期：2026-10-13
- 状态：设计已获用户批准（聊天呈现版），待 spec 审阅
- 参照：WorkBuddy openSessionBrowser（AI 执行中把正在浏览的页面呈现给用户）
- 前置：DetailPanel 已上线（2026-10-13-chat-detail-panel spec，浏览器 tab 可用）

## 1. 目标

给天枢 agent 新增两个内置工具：

- **`web_fetch(url)`**（kind: read）：AI 读网页正文回喂模型
- **`open_browser(url)`**（kind: read）：AI 把页面打开到当前会话右栏 DetailPanel 的浏览器 tab 给用户看

### 非目标（另立项）

- AI 操控页面（点击/填表/截图——WorkBuddy computer-use 级）
- web_search 工具
- 消息内链接点击联动（用户主动开浏览器 tab）

## 2. 主进程：`electron/domains/ai/agent/web-tools.ts`

纯 Node 可测（照 file-tools 先例：不 import electron；fetch 与 emitPanel 均注入/可 mock）。

### web_fetch(url)

- url 校验：必须 http/https
- 网络层：主进程 fetch（undici）。**实现第一步先验证** global fetch 是否已被 NetworkGate 的 `setGlobalDispatcher` 包装覆盖（SP5 PolicyDispatcher）；若未覆盖，web-tools 显式接受注入的 dispatcher（装配层从 NetworkGate 取），保证域策略/审计生效
- SSRF 封锁：复用 browser-session 的 SSRF 清单——`isSsrfHost` 从 `electron/domains/ai/browser/browser-session.ts` 提为公共小模块（两处消费，不复制清单）
- 限制：超时 15s；响应体 ≤1MB；Content-Type 仅 text/html 或 text/plain（其他类型拒绝，避免二进制/JSON API 滥用）
- HTML→文本：轻提取（去 `<script>/<style>` 块与标签、压缩空白），**零新依赖**
- 截断 32KB 回喂模型；返回体带 `{url, title?, content}` 简单文本格式
- 失败统一走 file-tools 的 `fail(message)` 模式（回喂模型不抛出）

### open_browser(url)

- url 校验同上；`ctx.emitPanel?.("detailPanel:openBrowser", { url })`
- 返回固定文案「已在右侧浏览器面板打开 <url>」；emitPanel 缺省（非会话装配场景，如自动化测试）时返回「面板不可用」

## 3. ToolContext 扩展与装配

```ts
// file-tools.ts ToolContext 追加（可选字段，向后兼容）：
/** 面板联动（web 工具）：ChatService 装配闭包绑定 sender；agent 域零 electron 依赖 */
emitPanel?: (
  event: "detailPanel:openBrowser",
  payload: { url: string },
) => void;
```

- 装配：ChatService 组装 ToolContext 处（executeToolSafe / AgentStreamOptions 链路）注入闭包——内部 `sender?.isDestroyed() || sender.send("detailPanel:openBrowser", { sessionId, url })`（sessionId 由闭包捕获，前端按会话过滤）
- 工具注册：`tool-registry.ts` 初始集追加 WEB_TOOLS（`registerTools` 不用——那是 MCP 动态注册通道）

## 4. IPC 通道

`ipc-channels.ts` EVENT 白名单追加：

```ts
  // AI 面板联动（web 工具 open_browser）：主进程 → 渲染层开右栏浏览器 tab
  "detailPanel:openBrowser",
```

## 5. 前端联动：`use-detail-panel-bridge.ts`

新 hook（`src-react/domains/ai/chat/hooks/use-detail-panel-bridge.ts`），ChatView 挂载订阅：

```
on("detailPanel:openBrowser", (payload)) →
  payload.sessionId === 当前选中会话：
    useAiUiStore.setArtifactsOpen(true)                  // 右栏未开自动开
    该会话 tabs 中已存在 browser tab → 取最后一个复用；
    否则 openTab(sessionId, "browser", t("chat:detailPanel.browser"))
    syncTab(tabId, { url: payload.url })
  否则：静默（不抢当前视图，WorkBuddy 同语义）
```

- 复用策略：**复用最后一个 browser tab 回写 url**，不无限开新 tab
- hook 卸载取消订阅；依赖当前会话 id（闭包读取最新选中会话）

## 6. i18n / ToolCallCard / 权限

- 两工具 kind: "read" → 免审批（既有 read 语义）
- 工具可经既有 `filterDisabledTools` 设置禁用，无新开关
- i18n（chat 命名空间双语）：`tools.webFetch` / `tools.openBrowser` 及卡片 tip（若 ToolCallCard 按工具名有文案/图标映射则补映射；通用渲染则仅加描述词条）
- NetworkGate 域审计事件自动产生（fetch 过 dispatcher 即可），SSRF 命中记审计并拒绝

## 7. 测试（Vitest）

- `web-tools`：HTML 提取（script/style 剥离/空白压缩）、32KB 截断、1MB 上限、非 html/plain Content-Type 拒绝、超时、SSRF 拒绝、协议校验、open_browser 的 emitPanel 调用/缺省兜底（fetch 以注入 fake 覆盖，不起真网）
- `use-detail-panel-bridge`：jsdom——事件触发开 tab/复用/syncTab/url 回写/跨会话静默（mock `@/lib/ipc` 的 on）
- 装配链路（ChatService ctx 注入 emitPanel）：轻量集成断言或冒烟归入收尾任务

## 8. 风险与对策

- global fetch 未过 PolicyDispatcher：实现首任务先验证，未装则装配层显式注入 NetworkGate dispatcher（web-tools 接受注入）
- SPA 空壳页提取质量差：截断原样返回，模型自行说明；不引 headless 渲染（YAGNI）
- 大页面内存：1MB 上限 + 流式读截断，不整页缓冲
