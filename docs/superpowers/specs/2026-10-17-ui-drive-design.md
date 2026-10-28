# 天枢服务端二期：ui-drive（远程驱动被控桌面端 UI）设计

- 日期：2026-10-17
- 状态：已与用户对齐（MVP 三动作全做、控制端只配 openSession 按钮；待入库）
- 前置：`2026-10-16-tianshu-server-design.md`（§11 二期 ui-drive 项）、GA 计划（capability 双向协商/事件通道先例）
- 参照：OpenCode `/tui/*` 端点（远程驱动 TUI：追加/提交 prompt、打开会话/选择器、显示 toast）

## 1. 背景与目标

控制端已可遥控被控端会话/编排（数据面），但被控桌面端的 **UI 不受驱动**——控制端看到有意思的远程会话，无法让那台桌面「自己打开看」。ui-drive 补上这一层：控制端 → 被控桌面端的窗口/路由/toast 动作。

**目标**：三个动作端点 + 桌面端执行 + 控制端按钮。
**非目标**：远程键鼠级操控、prompt 代填（OpenCode 的 appendPrompt/submitPrompt 对应物——涉及输入态管理，后续按需）、file-window/webview 级驱动。

## 2. 协议

### 2.1 端点（被控面路由表 + relay req 帧直达，零新传输）

| 端点 | 入参 | 语义 | 返回 |
|---|---|---|---|
| `POST ui/openSession` | `{sessionId: number}` | 主窗口聚焦（BrowserWindow.show/focus）+ 渲染层打开该会话 | `{opened: true}` / 会话不存在 4040 |
| `POST ui/notify` | `{title: string, message?: string}` | sonner toast（渲染层事件） | `{notified: true}` |
| `POST ui/openRoute` | `{path: string}` | 渲染层路由跳转；**白名单：必须 `/module/` 前缀**，否则 4005 参数错 | `{opened: true}` |

### 2.2 capability

- `DESKTOP_CAPABILITIES` 追加 `"ui-drive"`（桌面被控端专属）；headless `CAPABILITIES` 不报——**与 graph 相反方向**，协商语义已双向覆盖
- 控制端按连接运行时上报值门控 UI

### 2.3 渲染层事件（被控桌面端内部）

主进程 → 渲染层三条事件（IPC_EVENT_ALLOWLIST 登记）：
- `ui:openSession {sessionId}`——渲染层监听后路由到会话（`/module/ai` 会话切换走现有 store 动作或路由 query）
- `ui:notify {title, message?}`——渲染层调 sonner
- `ui:openRoute {path}`——渲染层 navigate（白名单已在主进程校验，渲染层二次校验前缀双保险）

## 3. 实现面

### 3.1 被控面（mirror `electron/domains/server-face/`）

- `routes.ts` 路由表加三端点：窗口聚焦复用 `BrowserWindow.getAllWindows()` 主窗先例（graph-executor notifyNodeStatus 同款）；会话存在性校验经 session.repo；渲染层事件经主窗 webContents.send（isDestroyed 守卫，terminal-ipc 先例）
- `face-info.ts`：无改动（DESKTOP_CAPABILITIES 常量在协议包）

### 3.2 协议包（mirror `packages/tianshu-protocol`）

- `DESKTOP_CAPABILITIES` 加 `"ui-drive"`
- `ENDPOINTS` 补 `ui/*` 三段（顺带补 GA 遗留的 graph/automation 九段——终审 Minor 5 一并清掉）
- `chat-contract.ts` 或新 `ui-contract.ts`：三端点入参出参类型

### 3.3 控制端（mirror）

- `RemoteSessionPanel` 会话行加「在被控端打开」按钮（ui-drive capability 门控：连接上报含 `ui-drive` 才显示）→ `server:uiOpenSession` IPC 透传
- IPC：`electron/domains/server/ipc.ts` remoteHandler 加三通道透传；白名单登记 `server:uiOpenSession|uiNotify|uiOpenRoute`
- i18n 双语 `server:ui.*`

## 4. 安全

- openRoute 白名单 `/module/` 前缀（主进程校验 + 渲染层二次校验）；openSession 经归属校验（该用户会话）
- ui-drive 动作全程经被控面 token/relay 握手既有鉴权（与 chat 端点同级信任面，无额外放行）
- 无头端不实现三端点（capability 不报即控制端不可达；直连调用返回 404）

## 5. 测试

- mirror Vitest：被控面三端点（mock 窗口/webContents——校验聚焦调用、事件 payload、白名单拒绝、4040）；控制端按钮门控（有/无 ui-drive capability 渲染差异）；渲染层监听器（事件→toast/navigate mock）
- server Jest：无头端 `/info` 不含 ui-drive（防 capability 泄漏回归）
- E2E：手动冒烟（控制端按钮 → 桌面端窗口聚焦+会话打开），脚本化限于直连 `ui/notify` 往返

## 6. 假设与偏离

1. 渲染层打开会话的路由形态以现有会话导航实现为准（plan 阶段查 chat store 的会话激活动作后定，倾向 query 参数或 store 直调，不新造路由）
2. notify 不配控制端按钮（协议端点供外部/调试）
3. file-window/webview 级驱动、prompt 代填列后续
