# 空间/项目变更跨端刷新 + 移动端聊天主页项目组 设计

日期：2026-11-01（批 ③，用户报告问题 3）

## 背景（四条断链）

移动端新建 workspace/project 后：桌面侧栏 `["workspaces"]`/`["projects"]`
（react-query，失效驱动、无轮询、`refetchOnWindowFocus:false`）永不失效；
移动端聊天主页（zustand sessions.store）只在挂载时拉一次，全库无
useFocusEffect。链路缺口：

1. 协议 `ServerEvent` 联合无 workspace/project 变更事件类型。
2. 发射侧静默：server `workspace.service` 与桌面被控面
   `workspace-tap`/`project-tap` 写后不 publish；桌面本地 UI 写面（repo
   层）写入也不广播（渲染层与已连移动端均无感）。
3. 桌面接收侧拦死：`electron/domains/server/ipc.ts` 事件转发白名单仅五
   类；远程事件消费（HostSwitcher）只失效 sessions/messages。
4. 移动端接收侧无分支：`sessions.store.bindEvents()` 只认
   server.connected/session.updated。

架构事实（决定方案形状）：
- 桌面本地库与无头端库是两套独立库，无同步——「刷新」靠事件信号触发
  各端重拉自己的数据面。
- `automation.changed` 已有完整同构链（进程内 change-bus → 渲染层
  webContents 失效 + face 桥 SSE/relay 外发；消费端重拉列表），本批复
  制该模式到 workspace/project 域。
- workspace/query 数据源 `projectId:null` 过滤（项目资产空间不进分组
  树，二期 §3.2 有意语义）——**不动**；项目在侧栏/聊天主页的呈现走
  独立「项目组」。
- face `session/query` 投影 `...row` 整行透传（`toSession`）——
  **projectId 本就在下发**，移动端 SessionBrief 未消费而已，协议零改。

## 方案

### 1. 协议（packages/tianshu-protocol/src/server-event.ts）

`ServerEvent` 增两个列表级刷新信号（payload 空对象，消费端以重拉为准
——`automation.changed` taskId 0 同语义）：

- `{ type: "workspace.changed"; payload: Record<string, never> }`
- `{ type: "project.changed"; payload: Record<string, never> }`

（project.changed 仅桌面被控端发——无头端无 project 模块。）

### 2. 桌面发射侧（automation-change-bus 同构）

- 新 `electron/domains/ai/chat/workspace-change-bus.ts`：
  `emitWorkspaceChanged()`/`onWorkspaceChanged()`——渲染层全窗
  `WORKSPACE_CHANGED_EVENT`（常量放 `src-react/domains/ai/api/workspace.api.ts`，
  主进程跨引先例同 AUTOMATION_CHANGED_EVENT）+ 进程内订阅扇出（异常
  隔离）。
- 新 `electron/domains/project/project-change-bus.ts`：
  `emitProjectChanged()`/`onProjectChanged()`，事件常量
  `PROJECT_CHANGED_EVENT` 放 `src-react/domains/project/api/project.api.ts`。
- repo 埋点（单点双路径覆盖——本地 UI invoke 与 face tap 都过 repo）：
  - `session.repo.ts` `createWorkspace`/`updateWorkspace`/`deleteWorkspace`
    成功后 emitWorkspaceChanged()
  - `project.repo.ts` `create`/`update`/`delete` 成功后 emitProjectChanged()
    （`ensureAssetWorkspace` 建的资产空间行不进 workspace 分组树，无需
    连带 workspace 事件）
- `face-events.ts` `ensureTapBridge` 增两桥：onWorkspaceChanged →
  publishFaceEvent({type:"workspace.changed",payload:{}})；project 同理。

### 3. 桌面接收侧

- `electron/domains/server/ipc.ts` setEventSink 白名单加
  `"workspace.changed" | "project.changed"`（远程主机态事件进渲染层）。
- `HostSwitcher.tsx` onRemoteEvent 增分支：两事件 → invalidate
  `["workspaces"]` / `["projects"]`（前缀失效，覆盖 `["projects", user.id]`）。
- `src-react/lib/query-invalidate-events.ts` 注册：
  `WORKSPACE_CHANGED_EVENT` → invalidate `["workspaces"]`；
  `PROJECT_CHANGED_EVENT` → invalidate `["projects"]`
  （本机被控写入 → 本 UI 失效）。

### 4. 无头端发射（apps/tianshu-server）

`workspace.service.ts` `create`/`update`/`delete` 成功后
`this.bus.publish({ type: "workspace.changed", payload: {} })`
（EventBusService 已有，session.updated 先例）。

### 5. 移动端接收侧（apps/tianshu-mobile）

- `sessions.store.ts` `bindEvents()` 增分支：
  - `workspace.changed` → `void loadFirst()`（会话+workspace 重拉）
  - `project.changed` → `void loadProjects()`（项目列表重拉）
- `sessions.store.ts` 增 `projects: {id,name}[]` state + `loadProjects()`
  （capability 含 `project` 才拉 `project/query`，无头端恒空表——门禁
  先例同 project.store；loadFirst 顺带调用，失败静默保留旧表）
- `project.store.ts` 写面（create/update/delete）成功后单向联动
  `useSessionsStore.getState().loadFirst()`（本地即时反馈，不等事件
  回环；单向 import 防循环——sessions.store 不反向引 project.store）
- `(tabs)/index.tsx` 增 `useFocusEffect` 兜底（返回聊天 Tab 时轻量
  loadWorkspaces+loadProjects——tab 常驻挂载不会重跑 useEffect）。

### 6. 移动端聊天主页「项目组」（用户裁定：补，对齐桌面 D4）

- `SessionBrief` 增 `projectId?: number | null`（face 投影已透传，
  纯消费端补字段；旧被控端/无头端恒缺省 → 无项目组，能力语义自洽）。
- `(tabs)/index.tsx` 组态列表：workspace 组之后渲染「项目组」——聚合
  `projectId` 非空且项目可见的会话，组头=项目名（sessions.store.projects
  映射）+ 展开态组内会话行（行渲染/点击与 workspace 组同款复用）。
  projectId 非空的会话不再落「未归属」兜底组（workspace-grouping 纯函
  数扩展：项目会话先剥离再分组）。
- 纯函数逻辑进 `src/logic/workspace-grouping.ts`（新增
  `splitProjectSessions`：输入 sessions+projects，输出项目组集合+余量）。

## 非目标

- 不动 workspace/query 的 `projectId:null` 过滤语义（项目空间不进
  workspace 分组树）。
- 不做桌面端远程写面（`server:workspaceCreate` 等）——单 UI 远程态仍
  只读 workspace，建空间走被控端本地/移动端。
- 不做实体级事件载荷（id 级定点刷新）——列表级重拉信号够用（YAGNI）。
- 桌面侧栏项目组已有（D4），不动。

## 验收

- `npm run test -w apps/tianshu-mobile` 通过（新增：bindEvents 分支/
  splitProjectSessions/loadProjects 门禁单测）。
- 桌面 vitest 相关 suite 通过（workspace-change-bus/project-change-bus
  扇出与隔离单测；query-invalidate 注册既有测试不回归）。
- server jest `workspace.service` 相关测试通过（publish 断言）。
- relay 四链路抓帧 e2e 不回归（`npm run test:e2e:relayE2E` 可选，改
  动不触 relay 帧结构）。
- 手工链路（用户验收）：移动端建 workspace/项目 → 桌面侧栏即时多行；
  桌面建 workspace → 移动端聊天主页组头即时出现；移动端建项目并发起
  会话 → 聊天主页出现项目组。
