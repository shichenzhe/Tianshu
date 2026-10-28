# 天枢单 UI 多主机架构（Paseo 模式）设计

- 日期：2026-10-19
- 状态：方向已与用户对齐（P0 spec 待审）
- 前置：server 一期/二期全部（协议包、41 个 `server:*` 通道、E2E relay、server-face、Supervisor）
- 退役对象：`src-react/domains/ai/server/` 的 Remote* UI 壳（RemoteSessionPanel/RemoteComposer/RemoteMessageList 等——P3 删）

## 1. 背景与目标

**问题**：远控台是第二套 UI（Remote* 壳），每个功能要「协议+server+face+壳」四方对齐（CU/AL/LA/PM 四批的成本）——功能数 × UI 套数的平方维护。

**目标（Paseo 模式）**：桌面端只有**一套 UI**（现有 ChatView/ChatPane/ChatInput/模型页/专家页…），
「主机（host）」作为数据源维度：本地主机（本地 IPC）或远程主机（无头 tianshu-server / 另一台桌面 server-face，
直连或 E2E relay）。切换主机 = 整套 UI 操作该主机。**新功能只写一遍。**

```
┌─ 桌面 UI（唯一一套）─────────────────────────────┐
│   ↓ api 层（session/chat/model/provider/assistant/skill…）│
│ 主机路由层（hostStore.activeHost）                  │
│   local  → invoke 本地通道（现状零变化）             │
│   remote → requestRemote server:* + 形状适配         │
└──────────────────────────────────────────────┘
```

**非目标**：workspace 文件/附件/项目/监控域的远程化（capability 门控隐藏，后续批按需）；
mobile/web 客户端（本批只做桌面单 UI 双主机）。

## 2. 架构设计

### 2.1 主机模型与全局状态（hostStore）

`src-react/domains/ai/data-source/host.store.ts`（zustand）：

```ts
interface HostState {
  activeHost: { kind: "local" } | { kind: "remote"; connId: string };
  /** 远程主机运行时 caps（capabilities + 连接态），本地主机恒全集 */
  caps: HostCaps;
  switchHost(next): void;   // 切换：queryClient.clear() + 会话搜索/草稿 store 复位
}
```

- **activeConnId 复用**连接注册表持久化（option 表）——「当前主机」跨重启记忆
- `HostCaps`（P1 集）：`chat/provider/session/assistant/skills/permission/usage` + `files=false`
  （远程恒 false——附件/文件树/项目门控用）；本地主机恒全 true
- 切主机副作用：`queryClient.clear()`（缓存按主机整体重拉）+ `useSessionSearchStore.reset()` +
  ChatInput 草稿外置 key 已按会话——切主机等价全切，无需逐 key 加维度（P1 取舍：粗粒度清空，
  简单正确；per-host 缓存命名空间留后续优化）

### 2.2 主机路由层（api 内路由——UI 零改动）

形态决策：**api 模块内部路由**（非 context 注入）。理由：UI 组件静态调用 `SessionApi.listAll()`
遍布全仓，注入式要动几百个调用点；内部路由对 UI 完全透明，本地路径就是原调用透传（风险最小）。

`data-source/host-route.ts`：

```ts
/** 双通道路由：本地走 invoke 原通道；远程走 server 通道 + 适配器 */
export function routeInvoke<T>(local: { ch: string; args: unknown[] },
  remote: () => Promise<T>): Promise<T>
  // 实现读 hostStore.activeHost——local 直接 invoke(local.ch, ...local.args, token)；
  // remote 走 requestRemote（适配器闭包内完成形状转换+connId 透传）
```

每个 api 方法改造模式（session.api.ts 示例）：

```ts
static async listAll(): Promise<SessionRecord[]> {
  return routeInvoke(
    { ch: "session:listAll", args: [] },
    () => remoteSessions.listAll(),   // 适配器：分页拼全量 + SessionRecord 形状
  );
}
```

### 2.3 远程适配器（data-source/remote-adapters.ts）

形状转换集中在适配器（UI 类型零变化）：

| 本地 api | 远程映射 | 转换要点 |
|---|---|---|
| `session:listAll` | `server:sessionList` | 分页拉全（pageSize 500）+ `RemoteSessionRow→SessionRecord`（mode/archivedAt/pinnedAt/assistantId/currentModelId 直传） |
| `session:getById` | `server:sessionGet` | `{session,messages}→SessionRecord`（messages 走 message api 侧缓存） |
| `message:listBySession` | `server:sessionGet` | messages 段 + `createdAt/modelId`（已透出） |
| `session:create/delete/rename/pin/archive/setMode/setAssistant` | `server:sessionCreate/Delete/Update` | update 复合字段（title/mode/archived/pinned/assistantId） |
| `session:setModel` | `server:sessionUpdate` 扩 `currentModelId` | **协议小扩**（P1-T1：server updateFields+face 桥——与 send.modelId 持久同键） |
| `chat:send` | `server:sessionSend` | `{sessionId,content,modelId,assistantId}` 直传 |
| `chat:regenerate/editAndResend/stop` | `server:sessionRegenerate/EditResend/Abort` | 直传 |
| `chat:status` | 事件流推导 | 远程实现返回「由连接事件维护的状态」（P1 简化：无进行中流返回 idle；活跃流由 UI stream 订阅态表达——本地 status 消费点排查后在 T2 定） |
| `permission:get/set` | `server:sessionAccessMode` | 直传 |
| `chat:usage` | `server:sessionUsage` | 直传（Breakdown 同构） |
| `model:listAll` / `provider:list` | `server:providerQuery` | bundle → 两形状拆分（provider 脱敏字段原样） |
| `model:test/listRemote` | `server:providerTest/FetchModels` | providerId 经 model 行反查 |
| `assistant:list` | `server:assistantQuery` | +icon/quickPrompts 已有 |
| `skill:list/readSkill/setEnabled` | `server:skillsQuery/Read/SetEnabled` | 已有 |
| `chat:stream:<sid>` 事件 | `server:chunk:<connId>:<sid>` | **事件路由 helper**（onChatStream） |

不映射（capability 门控隐藏）：`workspace:*`、附件、`agent:approve`（远端审批走 session.approve
事件流——RemoteApprovalBanner 语义并入主 UI 审批横幅，P1-T4）、`chat:compact/polish/handoverSummary`
（远端不支持，门控禁用）、`assistant:create/update/delete`（远程专家只读，P2 评估）。

### 2.4 UI 接线与 capability 门控

- **ChatView/ChatPane/ChatInput/SessionTreePanel 零改动**（api 内路由）——唯一例外：
  ChatInput 的 `hasModel` 数据源已走 model:listAll（自动路由）✓
- 门控：`useHostCaps()` hook（读 hostStore.caps）——附件按钮/文件联想/compact 命令在 `caps.files=false`
  时不渲染（改动集中在 ChatInput 的几处条件）
- 审批横幅：本地 `agent:approve` vs 远端 `session/approve`——ApprovalBanner 的应答回调经
  `routeInvoke` 分流（P1-T4 接线）

### 2.5 主机切换 UI 与控制台退役（P3）

- TopBar 增主机切换器（DropdownMenu：本地主机 + 远程主机清单 + 「管理主机…」）
- 「服务端」页 → 「主机」页：保留连接 CRUD/测试/启停/E2E 配置/Supervisor；删 Remote* 壳与会话遥控 tab
- `console-tab` 编排区（graph/automation）暂留主机页（远程编排后续批评估并入主 UI）

## 3. 分阶段实施

| 阶段 | 任务 | 验收 |
|---|---|---|
| **P1-T1** | 协议小扩 `session/update.currentModelId`（server+face）；hostStore+routeInvoke+onChatStream 骨架；i18n | 单测+骨架绿 |
| **P1-T2** | session/message 域适配器+路由改造（listAll/getById/create/delete/rename/pin/archive/setMode/setAssistant/setModel） | 会话侧栏对远程主机可用（GUI） |
| **P1-T3** | chat 域（send/regenerate/editAndResend/stop/status/permission/usage）+ model/provider/assistant 适配 | 聊天页远程端到端（GUI 发送/流式/停止） |
| **P1-T4** | ChatInput 门控（附件/文件/compact）+ 审批横幅分流 + caps 接线 | 远程主机聊天页全功能（除门控项） |
| **P1-T5** | 临时主机切换入口（主机页按钮「在此 UI 打开」）+ E2E 实测（直连+relay）+ 回归收尾 | 全量绿+实测报告 |
| **P2** | 模型配置页/专家页/技能页路由化+远程写面评估 | 配置页远程可用 |
| **P3** | TopBar 切换器 + 服务端页降级主机管理 + Remote* 壳删除 + drift 清账 | 单 UI 双主机 |

## 4. 风险与取舍

1. **api 内路由 vs 注入**：选内部路由（UI 零改动/风险最小）——代价是 api 模块变厚（适配器集中
   data-source/ 目录控制）；后续若做 web 客户端再抽接口注入
2. **缓存粗粒度清空**：切主机 queryClient.clear() 简单正确；重拉成本可接受（P1 会话/模型量级小）
3. **chat:status 语义差**：远程无同步 status 查询——P1 以事件流订阅态近似（收尾清流），
   残留竞态（远程断连中的流）由 server.connected 重连信号全量刷新兜底（既有机制）
4. **本地路径回归风险**：routeInvoke 对 local 分支就是原调用透传——逐方法改造时本地行为
   逐字不变（测试基线锁定）；P1 全程 mirror 全量回归每任务跑
5. 远程主机为**另一台桌面**（server-face）时 caps 按 DESKTOP_CAPABILITIES 上报值（无 graph）——
   编排区门控沿用现有判定
