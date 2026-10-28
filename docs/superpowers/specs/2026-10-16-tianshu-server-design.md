# 天枢服务端（客户端-服务端模式）设计

- 日期：2026-10-16
- 状态：已与用户对齐（无头核心 chat 切片 / 本地伴生+远程兼容 / relay 提进一期；偏离项见 §12）
- 参照：OpenCode 客户端-服务端架构（server = headless HTTP 唯一入口 + SSE 事件总线 + `/tui/*` 远程驱动的多客户端模式）；paseo-relay（NAT 穿透中继：双方出站 WS + connectionId 配对 + 端到端加密、relay 零知识）；脚手架 shu-nestjs-starter（NestJS 11 + Fastify 5 + Prisma + JWT）

## 1. 背景与目标

天枢现为单机 Electron 应用，AI 核心（chat 引擎/编排/provider）全部在主进程内，渲染层经 IPC 消费。参照 OpenCode 的客户端-服务端模式引入服务端形态，使**天枢桌面端保持全功能不变，同时成为控制端**，可操纵：

1. **其它天枢桌面端**（内嵌被控服务面，桥接其本地引擎与数据）
2. **纯无头服务端** `tianshu-server`（NestJS 新仓，移植无头核心）

跨网络（被控端在 NAT 后）经自研 **relay 中继**打通。

**一期目标**：控制协议 + chat 遥控闭环（两种被控端均可会话管理/发消息/流式回显/中止）+ relay 全链路。
**非目标（二期）**：graph/编排触发（graph-executor 131K 移植风险高）、ui-drive（远程驱动被控端 UI，OpenCode `/tui/*` 对应物）、桌面工具桥（服务端回调桌面端执行 browser/terminal 工具）、personalization/memory、library、Swagger→SDK 生成、NaCl 端到端加密。

## 2. 总体架构

```
                控制协议（逻辑层：端点 + 事件）
                承载层：直连 HTTP+SSE ｜ relay WS 隧道（帧封装）
┌─────────────────────────────┴─────────────────────────────┐
│ 天枢桌面端 A（控制端）：现有功能全保留                        │
│   ServerSupervisor + ServerClient(Transport 抽象) + 控制台页 │
└──────┬──────────────────────────────────┬─────────────────┘
       │ 直连 HTTP+SSE                     │ 出站 WS（NAT 友好）
       ▼                                  ▼
┌───────────────────────┐      ┌──────────────────┐   ┌─────────────────────┐
│ 被控端①：其它天枢桌面端 │      │ tianshu-relay    │   │ 被控端②：无头服务端   │
│ 内嵌服务面（node:http） │◀──── │ 公网 VPS 独立部署  │──▶│ tianshu-server       │
│ 桥现有 chat.service    │ 配对 │ token 认证       │   │ NestJS+Fastify       │
│ 事件 tap → SSE/WS 帧   │      │ /ws + /health    │   │ 移植无头 chat 核心    │
│ 数据：自己的 ~/.tianshu │      └──────────────────┘   │ 数据：自己的 SQLite   │
└───────────────────────┘                              └─────────────────────┘
```

要点：

- **桌面端不被瘦身**：控制端能力是纯增量（新域 + 设置页），现有 chat/编排/工具链零改动（除 §6.2 的 tap 点小改）。
- **数据天然分治**：被控端操纵各自本地库，控制端不搬数据只遥控。
- **协议是核心资产**：逻辑协议（端点+事件 payload）与承载（直连/中继）解耦，两种被控端各自实现同一逻辑协议，控制端只写一份客户端。

## 3. 控制协议

### 3.1 逻辑端点（全 POST 风格，对齐 starter 路由约定与 `{code, message, data}` 统一包装）

| 端点 | 入参 | 语义 |
|---|---|---|
| `GET /info` | — | `{name, version, instanceId, capabilities}`；capabilities 如 `["chat","provider"]`，控制端据此渲染 UI |
| `POST session/create` | `{title?, workspaceId?}` | 建会话 |
| `POST session/query` | QueryFilter 分页 | 会话列表 |
| `POST session/getById` | `{id}` | 会话+消息历史（blocks 原样） |
| `POST session/delete` | `{id}` | 删会话 |
| `POST session/send` | `{sessionId, content, attachments?, assistantId?}` | 202 启动，流经事件通道回传 |
| `POST session/abort` | `{sessionId}` | 中止进行中的流 |
| `POST provider/query` / `provider/save` | — | 模型配置查存 |

消息体沿用天枢 blocks 协议（TextBlock/ThinkingBlock/UsageBlock/ToolCallBlock/ImageBlock），**零翻译复用**。

### 3.2 事件通道

- **直连承载**：`GET /event` SSE。首事件 `server.connected {instanceId, capabilities}`，其后：`session.updated {session}` / `message.chunk {sessionId, chunk}`（chunk = 天枢 onChunk 协议原样：text/thinking/toolcall 增量、usage、finish、title-updated）/ `session.error {sessionId, code, message}`。
- **中继承载**：同一批事件以 WS 消息帧推送（无 SSE 语义），payload 不变。

### 3.3 中继隧道协议（参照 paseo-relay v2 思想，自研 TS 实现）

relay 暴露 `GET /ws`（WebSocket）与 `GET /health`：

- 被控端连 `role=server&token=<relayToken>`：注册存在，声明 `{instanceId, capabilities, name}`，接收连接/断开通知
- 控制端连 `role=client&token=<relayToken>`：可列出被控端、按 `connectionId`（= instanceId）建立隧道
- 隧道帧（双向 JSON）：
  - 请求：`{kind:"req", id, method, path, body}` → 响应：`{kind:"res", id, status, body}`
  - 事件：`{kind:"event", type, payload}`（被控端 → 控制端单向）
  - 控制：`{kind:"open", connectionId}` / `{kind:"close", connectionId}` / 心跳 ping/pong
- relay 职责仅按 connectionId 配对转发，不解析帧内容；`--max-buffer-frames` 式背压缓冲

### 3.4 认证

- 逻辑协议层统一 `Authorization: Bearer <token>`（直连 HTTP 头 / 中继在 role 握手里完成一次，隧道内不再逐请求）
- 被控桌面端：option 表静态 token（服务面默认关闭，开启时生成）
- tianshu-server：本地伴生 = 启动注入随机 token；远程多用户 = starter `/auth/login` JWT（现成）
- relay：独立 relayToken（--token 启动参数），与被控端业务 token 分层

## 4. tianshu-server 新仓（无头服务端）

- 位置 `../tianshu-server`（与 shu 系列平级独立 git 仓），degit shu-nestjs-starter + `npm run init`（APP_NAME=tianshu-server）
- **双运行形态**：`node dist/main.js`（无头服务端）与 `node dist/relay.js`（中继，见 §5），复用一套构建设施
- 模块：`modules/session`（会话 CRUD + chat 执行 + abort）、`modules/provider`（模型配置）；starter 的 auth/actuator/swagger/web 层照用；新增 `commons/event-bus`（injectable，进程内事件总线，SSE controller 与 WS relay 客户端共同订阅）
- **无头化移植清单**（自 mirror 摘取改造）：
  - 直接移植：`runChatStream`/`consumeAgentStream`（chat.service 核心）、`blocks`、`history-truncate`、`tool-output-trim`、`param-merge`、`expert-catalog`、`scenario-prompt`、`time-context`、`workspace-files`、`error-classify`、`context-usage`、`pasted-image-store`（URL/base64 输入保留，无剪贴板）、LangChain provider 工厂、`skill-loader`+`skillRecord`（技能集）
  - 改造：`ipcMain`/`WebContents`/`sender.send` → EventBus.publish；`session.repo`/`assistant.repo` 摘取
  - 剔除：`dialog`/`clipboard`/`shell`/file-window 依赖（`broadcastFileChangedFor`/`grantedPaths` 等）
  - 工具注册子集：file/command/web/plan/skill（无头可用）；browser/terminal/widget/file-window 不注册
  - 数据根 `~/.tianshu-server`（skillsDir/attachmentsDir 同构镜像 `commons/paths`）
- Prisma schema 摘表：`provider`/`model`/`assistant`/`workspace`/`session`/`message`（userId 关联 starter 自有 user 表）；starter 的 `user`/`option`/`operation_log` 照用
- 启动握手：stdout 打印一行 JSON `{port, token, instanceId}`（OpenCode 模式），供 Supervisor 解析；`NODE_ENV`/`--port`/`--hostname` CLI 参数
- 权限偏离：无头端无审批人——tool-gate 高危工具（命令执行/批量删除/任意路径写）默认禁用，经 config 可显式放行（§12 偏离项 2）

## 5. relay 本体（tianshu-server 第二形态）

- 单入口 `src/relay-main.ts`（构建立独立产物 `dist/relay.js`），极简实现参照 webhook-server 的 node:http 先例 + `ws` 库
- 职责：role 握手校验 token → connectionId 注册表 → 帧转发 + 有界缓冲 + 心跳剔除；不解析业务帧
- 部署：公网 VPS（Docker/systemd，README 给示例）；TLS 由上游 nginx/Caddy 终止（paseo-relay 同款约定）
- 一期安全边界：token 认证 + TLS（自部署 relay 半可信）；NaCl 端到端加密（relay 零知识）列二期演进
- 许可证说明：paseo-relay 为 AGPLv3，仅参照协议思想，不引入其代码/二进制

## 6. 被控面（mirror 桌面端内嵌）

### 6.1 服务面骨架

`electron/domains/server-face/`：`node:http` 服务，默认**关闭**（option `serverFace.{enabled, port, token, host}`，默认 127.0.0.1；显式配 0.0.0.0 才对外）。实现 §3.1/§3.2 端点，capability 报 `["chat","provider"]`。

### 6.2 桥接与 tap 点

- 会话/历史/删除 → 直接调 `session.repo`（不经 IPC）
- send → `chat.service` 新增 headless 入口（复用现有 `send` 主链路，无 `sender` 参数）；chunk 流经**新增 tap 点**：`this.emit` 处挂进程内 EventEmitter（`chatTap.emit(sessionId, chunk)`），服务面订阅转 SSE/WS 帧——渲染层现有 `chat:stream:` 推送零改动
- relay 客户端：`server-face/relay-client.ts` 出站连 relay，role=server 注册；隧道 `req` 帧分发给本地路由处理器（与 HTTP 共用同一张路由表），`event` 帧由 tap 总线驱动

### 6.3 IPC 登记

`serverFace:status/setEnabled` 进白名单 `electron/commons/ipc-channels.ts`；设置 UI 放 AI 模块设置区。

## 7. 控制端（mirror 桌面端新增）

- `electron/domains/server/`：
  - `ServerSupervisor`：spawn 本地 tianshu-server（dev 指向 `../tianshu-server/dist/main.js`，路径可配）+ stdout 握手解析 + 健康轮询 + 退出清理/状态机（stopped/starting/running/error）
  - `ServerClient`：Transport 抽象（`DirectTransport`：fetch+SSE 流解析；`RelayTransport`：WS 帧封装），上层 API 无感；断线指数退避重连（上限 30s），重连后全量刷新当前会话
  - 连接注册表：多被控端配置（name/addr/token 或 relay+connectionId），持久化 option 表
- 渲染层**不直连**被控端：token 留主进程，SSE/WS 事件经 IPC 二次桥（`server:chunk:<connId>:<sessionId>`），与现有 chat 流式同构；IPC 白名单新增 `server:*` 系列
- 前端「服务端」页（AI 模块设置区）：连接管理（增删/状态/本地无头端启停/relay 配置）+ 会话遥控（连接 → 会话列表 → 打开历史 → 发消息流式回显，复用现有 blocks 消息渲染组件）；i18n zh-CN/en-US 双语同步

## 8. 错误处理

- spawn 失败/握手超时（10s）→ Supervisor error 态 + toast
- 认证失败 401 → 连接态 invalid-token，UI 提示重配
- SSE/WS 断线：自动重连 + 全量刷新；被控端崩溃 → 连接态 lost，可重试
- chat 执行错误：`error-classify` 移植后经 `session.error` 事件回传，控制端复用现有错误块渲染
- relay 满缓冲/心跳超时：断开该 connectionId，控制端走重连

## 9. 测试策略

- tianshu-server（Jest，starter 现成）：chat send 流式单测（注入 fake model，天枢既有模式）、SSE 事件序列、token/JWT guard、info capability、relay 帧转发与配对
- mirror（Vitest）：Supervisor 状态机（fake 子进程 stdout 握手）、Transport SSE/WS 帧解析、被控面路由表、tap 点广播、chat.service headless 入口（fake model）
- E2E：dev 下直连链路（拉起 tianshu-server 跑通一条消息往返）+ 中继链路（本机起 relay + 双端穿越）

## 10. 部署与分发

- 远程无头端：starter Dockerfile 现成（`node dist/main.js`）
- relay：公网 VPS 独立部署 `node dist/relay.js`（Dockerfile 复用）
- 桌面端打包内嵌 tianshu-server 产物（extraResources）：二期；一期 dev 模式指向工作副本

## 11. 分期

**一期（本设计范围）**：协议定义（含帧封装与 relay 协议）→ tianshu-server 无头核心（chat+provider）→ relay 本体 → 桌面端被控面（直连+relay 客户端）→ 控制端（双 Transport + 控制台页）→ 双链路 E2E。

**二期（按优先级）**：graph/编排触发 → ui-drive（远程驱动被控桌面端 UI）→ 桌面工具桥 → personalization/memory、library → NaCl 端到端加密 → Swagger→SDK 生成 → 打包内嵌分发 → 终态抽 `@tianshu/core` 共享包（消除双仓同构维护）。

## 12. 偏离项与假设

1. **范围收缩**：graph/编排触发从用户确认的 MVP 移入二期（graph-executor 131K + 向量库/skill 热加载依赖，一期移植风险过高）。
2. **无头权限语义偏离**：无头端无审批人，高危工具默认禁用可配放行（桌面端审批语义不变）。
3. **relay 一期不做端到端加密**：token + 上游 TLS，自部署 relay 半可信假设。
4. **渲染层经主进程透传**，不直连被控端（token 不落渲染层）。
5. **新仓名 `tianshu-server`**，与 shu 系列平级独立仓；relay 不另开仓（第二形态）。
6. **双仓同构代码债务**：blocks/chat 核心片段在 mirror 与 tianshu-server 双份，服务端仓 README 记录来源 commit，终态抽 core 包（§11 二期末项）。
7. **被控桌面端服务面默认关闭**，option 开启（127.0.0.1 起步）。

## 13. 尾批：留档七项收口（2026-10-17，终审分诊「可并入」）

| # | 项 | 设计 |
|---|---|---|
| 1 | 被控面设置 UI | 「服务端」页加「本机被控面」卡片：开关/端口/host/token（可重新生成）/relay 配置（url+token）；消费既有 serverFace:status/setEnabled IPC；host 非回环时警告文案；i18n 双语 |
| 2 | 重连全量刷新 | 控制端 server.connected 重连事件下发渲染层（经 server:event 通道）→ ServerConsoleView 收到即 refetch 会话列表（消注释承诺与实际行为差） |
| 3 | Direct request 超时 | DirectTransport.request 加 15s AbortSignal 超时（abort 抛 TIMEOUT 上层可判） |
| 4 | headless 技能 enabled 过滤 | tianshu-server 技能目录扫描消费 skillRecord.enabled（镜像 mirror collectEnabledSkills 语义） |
| 5 | 默认空间竞态 | tianshu-server ensureDefaultWorkspace 并发 upsert 唯一化（findFirst 失败回退 create catch unique 重查） |
| 6 | 密钥外移 | config.yml JWT_SECRET 挪 .env（gitignore）+ CLAUDE.md 移除明文行；README 注明生成方式 |
| — | PG schema 变体同步 6 表 | **不做**（当前仅 SQLite 形态部署；PG 需要时随迁移补，注记） |
