# 天枢服务端二期：桌面工具桥设计

- 日期：2026-10-17
- 状态：已与用户对齐（MVP 桥 browser 四工具/隐藏桥窗/审批分级/广播-requestId 匹配；待入库）
- 前置：`2026-10-16-tianshu-server-design.md` §11 桌面工具桥项；GA/UD 计划（事件通道/端点/能力协商先例）
- 关键事实：mirror browser 工具为 **GuestControl 注入式**（`executeJavaScript/loadURL` 接口、工具本体零 Electron 依赖、快照文本化 ≤4KB）——`BrowserWindow` 天然实现该接口

## 1. 背景与目标

无头 server 的 chat 工具循环只有无头子集（file/command/web/plan/skill）；browser 等桌面专属工具不可用。工具桥使无头端遇桥工具时**回调控制端桌面执行**——「远程算力+本地桌面能力」，且桌面端天然回归审批语义（无头端无人审批 → 控制端桌面有人审批）。

**目标**：browser 四工具（snapshot/navigate/click/type）桥接闭环 + 审批分级 + 超时/离线语义。
**非目标**：widget/file-window 桥（后续批）、browser_use 复杂操控组、多控制端负载均衡（广播-requestId 单次消费即可）。

## 2. 协议

### 2.1 事件（ServerEvent 新成员）

`tool.request {requestId: string, sessionId: number, tool: "browser_snapshot"|"browser_navigate"|"browser_click"|"browser_type", args: Record<string, unknown>}`——广播给全部活跃控制端连接（SSE / relay event 帧，现有通道零新传输）。

### 2.2 端点（server 侧新端点）

`POST tool/respond {requestId: string, result: {ok: true, output: string} | {ok: false, error: string}}`——requestId 一次性（重复/未知 respond 4005；relay 走普通 req 帧直达同端点）。

### 2.3 能力语义

桥工具在 server **默认注册**（无静态 capability 变化）；运行时可用性由「有无活跃连接收到 tool.request 并 respond」决定——无连接时工具调用立即拒绝（错误串「桌面控制端不在线」，模型可见）。

## 3. server 侧执行链

- 工具注册：`src/core/tools/bridge/` 新增 browser 四工具桥版定义（zod schema/描述与 mirror `agent/browser-tools.ts` 同构副本——drift manifest 入册）；执行函数 = 发 `tool.request` + Promise 挂起等待 respond，超时 config `tianshu.bridge.timeoutMs`（默认 30_000）。
- 挂起注册表：requestId → {resolve, timer}；respond 到达/超时/SSE 连接全断（无接收者时立即拒）三路收敛；进程关闭时全量 abort。
- 广播出口：EventBus publish tool.request（SSE controller/relay event 帧既有链路自动送达）。

## 4. 控制端桌面执行面（mirror）

### 4.1 桥窗与执行

- `electron/domains/server/bridge-executor.ts`：隐藏 `BrowserWindow`（单例懒建，`show:false`）实现 GuestControl（executeJavaScript/loadURL）；browser 四工具的执行体**复用 mirror `agent/browser-tools.ts` 的工具函数**（GuestControl 注入式零改动——resolver 返回桥窗）。
- SSRF：navigate 前沿用工具层 `isSsrfHost` 检查（工具函数内置）。

### 4.2 审批分级

- read 类（snapshot）+ navigate（工具内 SSRF 已守）：直接执行。
- write 类（click/type）：主进程推 IPC `server:bridgeApproval`（EVENT 白名单登记）→ 渲染层全局审批卡（复用现有审批卡组件形态，ServerConsole/全局通知位）→ 用户允许/拒绝经 `server:bridgeDecision`（INVOKE）→ 执行或回 `{ok:false,error:"denied by user"}`。
- 审批等待计入工具超时（超时可配，用户可调大）。

### 4.3 通道

- 控制端主进程订阅现有连接事件流（connections eventSink 已聚合）过滤 `tool.request` → bridge-executor → 结果经现有 `requestRemote` 通道 POST `tool/respond`（transport 无关）。

## 5. 测试

- server Jest：桥工具注册/挂起-respond 匹配/超时拒绝/未知 requestId 4005/无连接立即拒（EventBus 订阅者计数）。
- mirror Vitest：bridge-executor（mock BrowserWindow——executeJavaScript 断言/单例/销毁）；审批链（write 类事件→渲染层卡→decision→执行/拒绝）；tool.request 事件到 IPC 透传；respond 通道调用。
- E2E：直连链路 fake——起 server、SSE 订阅、send 带 browser_snapshot 调用（fake model 发起）→ 收 tool.request → respond 模拟结果 → chunk 流收到工具结果（真桥窗可选做视觉级验证，脚本断言协议闭环）。

## 6. 安全

- 桥窗为隐藏 BrowserWindow：仅受控 loadURL（工具内 SSRF+URL 校验），无 node 集成、无 preload 暴露；executeJavaScript 仅工具函数内固定快照/点击/输入脚本（mirror 同款模板，参数 JSON.stringify 转义铁律沿用）。
- write 类必须经控制端人工审批（拒绝为默认安全态）；审批卡展示工具名/参数摘要。
- respond 一次性 requestId 防重放；server 侧 respond 端点经既有 token 鉴权。

## 7. 假设与偏离

1. 广播-requestId 匹配：多控制端并发时首个 respond 生效（其余 4005）——单控制端常态语义无损。
2. 桥窗无 session 隔离（partition 沿 BrowserWindow 默认）——工具层 SSRF 约束为安全边界，浏览器状态跨桥调用共享（与 mirror 右栏 tab 同 session 语义近似）。
3. widget/file-window/terminal 桥、browser_use 组、桥窗池化——后续批。
4. 审批卡为控制端本地新 UI（复用组件形态，不复用 chat 流审批通道——桥调用不在桌面本地 chat 流内）。
