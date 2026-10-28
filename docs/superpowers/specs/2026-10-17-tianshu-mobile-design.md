# 天枢移动端设计（tianshu-mobile：Expo 遥控 app）

参照 [paseo](https://github.com/getpaseo/paseo) 移动端（Expo 原生应用，连 daemon 的 WS API，远程走 E2E 加密 relay）为天枢做移动端遥控 app：**手机上控制天枢无头服务端（tianshu-server）或天枢桌面端（mirror server-face）**——看会话、发消息、盯 agent 流式干活、应答工具审批。

## 1. 背景与目标

一期（2026-10-16）已把遥控协议设计为「同一逻辑协议跑两种承载（直连 HTTP+SSE / relay WS 隧道）、控制端只写一份客户端」。桌面端 `electron/domains/server/*-transport.ts` 是第一个控制端消费者。移动端是**第三个控制端**，不新造协议：

- **目标**：Expo app（iOS/Android，Web 可选输出），添加被控端连接（direct 或 relay）后完成会话遥控闭环：列表/历史/新建/删除/发送/中止/流式回显/审批应答/选模型/看图。
- **非目标（见 §3）**：推送通知、语音、自动化与 graph 遥控（等二期落地）、图片发送、设备配对体系、E2E 加密。

### 现状事实（2026-10-17 双仓探索结论）

- 协议包 `@tianshu/protocol`：纯类型 + 常量（`ENDPOINTS` 九端点逻辑路径表、`CAPABILITIES = ["chat","provider"]`、`ChatStreamChunk` 7 种、`MessageBlock` 5 种、`RelayFrame` 8 种），零运行时依赖，CJS dist。
- 两种被控端同契约：tianshu-server（9 端点含 provider）与 mirror server-face（7 端点，无 provider），靠 `/info` capabilities 协商差异。
- `Transport` 接口（`request/onEvent/onState/close`，六态状态机 idle/connecting/connected/reconnecting/invalid-token/closed）双承载参考实现合计 <600 行。
- blocks 渲染协议双端零翻译复用已被桌面远控台验证（`RemoteMessageList` 复用 `MessageItem` + `remote-stream.ts` 纯函数归并）。
- 硬缺口（本 spec 伴生补齐前三项）：① 审批 `approval-request` chunk 推得出回不去，无 `session/approve` 端点，远控遇需审批工具**永久挂起**（`ApprovalCoordinator` 无超时）；② mirror face 缺 `provider/query`（远端选不了模型）；③ `ImageBlock.imagePath` 是被控端本地相对路径，无远端图片读取端点；④ 鉴权全静态 token（face token / relay token），无设备配对/撤销；⑤ relay 对同 connectionId 的 res/event 帧广播给全部已配对 client，按单控制端设计。

## 2. 总体架构

```
手机 (Expo app)                    桌面端 (mirror)                无头端 (tianshu-server)
┌──────────────┐   direct: HTTP+SSE   ┌──────────────────┐         ┌──────────────┐
│ tianshu-mobile├─────────────────────→│ server-face       │         │ Nest 控制器  │
│ Transport×2  │   relay: WS 隧道      │ :18411 (7→10 端点)│         │ (9→10 端点)  │
└──────┬───────┘                      └────────┬─────────┘         └──────┬───────┘
       │        file: @tianshu/protocol（纯类型+常量，双承载同构契约）    │
       └──────────────────────────┬─────────────────────────────────────┘
                            公网 relay（自建, :8411, 不动）
```

- **新仓** `/Users/hjx/workspace/tianshu-mobile`（与两仓同级）。协议包经 `file:../mirror/packages/tianshu-protocol` 吃 dist——与 tianshu-server 完全同款消费模式（npm symlink 直读，重建 dist 重启即生效，Metro 零特殊配置）。不 monorepo 化进 mirror：Expo/Metro/watchman 工程链与 Electron 的 vite/rolldown/node-gyp 互不污染，且三仓现实先于 monorepo 设计，后续可迁。
- relay 服务端零改动；被控端对移动端无感知（就是多一个带 `?token=` 的客户端）。
- 依赖结构：移动端**只依赖 `@tianshu/protocol`**（不引 `@tianshu/core`——那是端上跑 agent 循环才需要的，拖 LangChain peer 链）。

## 3. 范围（MVP）

**做**：

1. 连接管理：列表/添加/编辑/删除，direct（baseUrl+token）与 relay（relayUrl+relayToken+connectionId）两种模式，测试连接（GET info 8s 超时，失败原因四分类 invalid-config/invalid-token/unreachable/timeout），六态状态徽章，多连接切换活动目标。
2. 会话遥控：列表（分页上拉、keyword 搜索）、进入看历史（5 种 blocks 渲染）、新建、删除、发消息（202 受理 + optimistic 用户消息）、中止。
3. 流式回显：chunk 按活动连接 + sessionId 分发，`remote-stream.liveBlocks()` 归并流式渲染，finish/session.updated 收尾。
4. 审批应答：approval-request → Banner（工具名+参数摘要）→ 批准/拒绝 → `session/approve`。
5. 模型选择：capability 含 `provider` 时显示 ModelPicker（`provider/query` 只读消费）。
6. 图片只读：ImageBlock 经 `image` 端点 base64 加载。

**不做（后续迭代，按序）**：推送通知（移动后台需自建长连或推送网关）、语音、自动化/graph 遥控（二期 `graph/*`/`automation/*` 落地后 capability 驱动渲染）、图片**发送**、provider/save（写面留在桌面端）、设备配对码/per-device 凭据轮换、E2E 加密、多控制端串流隔离。

## 4. 服务端伴生改动

### 4.1 协议包（mirror 仓内改，`npm --prefix packages/tianshu-protocol run build` 后三仓生效）

- `ENDPOINTS` 加 `session/approve`、`image`（POST 风格，载荷 `{path}`）。
- `chat-contract.ts` 加 `ApproveParams {sessionId, toolCallId, approved}`。
- `CAPABILITIES` 不动：approve 归 chat 能力域，靠端点存在性判定（approve 返回 4040 = 被控端版本过旧），避免能力协商复杂化；image 是资源端点非能力。

### 4.2 mirror server-face（`electron/domains/server-face/`，7→10 端点）

- `POST session/approve {sessionId, toolCallId, approved}`：转发 `ApprovalCoordinator.respond`；不匹配 pending 应答返回业务错 4040（已应答或不存在），幂等语义由「已应答即 4040」达成。
- `POST provider/query`：读 modelConfig 表，返回形状与 tianshu-server `provider/query` 对齐（providers+models 全量）。
- `POST image {path}`：统一返回 `{mime, dataBase64}` JSON。**单一 JSON 形态**是关键决策——direct（fetch）与 relay（req 帧 JSON 隧道）走同一条代码路径，RN Image 吃 data URI，无需二进制帧扩展；用 POST 而非 GET 系 `handleRoute` 只吃 GET/POST + JSON body 的契约（GET 无载荷通道）。安全：resolve 后必须落在数据根内（防路径穿越）+ mime 白名单 png/jpeg/webp/gif + 既有 token 双口径鉴权。
- `routes.ts`/`deps.ts`/`server-face.ts` 相应注入 approve/provider 依赖。
- `electron/domains/ai/agent/approval.ts`：`request` 加 **10 分钟超时自动 deny**（常量），同时治好桌面远控台的挂死问题。
- 桌面远控台 `RemoteSessionPanel` 顺带补 ApprovalBanner（协议已通，UI 量小，plan 末尾可选任务）。

### 4.3 tianshu-server（9→10 端点）

- `POST session/approve`：调既有 `ChatRunnerService.approve()`（方法已备未暴露），过全局 StaticTokenGuard 无需额外鉴权。
- `accessMode` 增加第三值 `manual`：需审批操作挂起并推送 `approval-request` chunk，等 approve 或超时（config `tianshu.chat.approvalTimeoutMs`，默认 300s）自动 deny；现有 `default`（auto-deny）/`auto-approve` 语义不变。
- 图片端点**不加**：无头端无图片产生链路（send 一期不收图，无 ImageBlock 来源）。

## 5. 移动端 app 架构

```
tianshu-mobile/
├── app/                    # expo-router 文件路由
│   ├── _layout.tsx         # 根 layout：transport/store/i18n 装配
│   ├── index.tsx           # 会话列表（顶部连接切换器）
│   ├── session/[id].tsx    # 会话流 + composer
│   └── connections.tsx     # 连接管理（列表/添加/编辑/测试）
└── src/
    ├── transport/          # transport.ts(接口) direct-transport.ts relay-transport.ts sse-parser.ts
    ├── logic/              # remote-stream / blocks / group-blocks / optimistic-user-message（自 mirror 原样搬纯函数，零依赖）
    ├── store/              # zustand：connections.store / sessions.store / stream.store
    ├── components/         # MessageItem / ToolCallCard / ThinkingPanel / ApprovalBanner / Composer / ModelPicker / ConnectionCard
    ├── i18n/               # react-i18next，zh-CN/en-US，namespace 与 key 结构照天枢
    └── theme/              # NativeWind 4 + 四色主题 CSS 变量映射
```

依赖：Expo 最新稳定 SDK、expo-router、NativeWind 4（Tailwind 语法贴天枢习惯）、zustand、react-i18next、lucide-react-native（需 react-native-svg）、react-native-markdown-display（备选见 §8）。

- `ConnectionConfig {id, name, mode, baseUrl?, token?, relayUrl?, relayToken?, connectionId?}` 持久化 AsyncStorage，结构对齐桌面 option 表存档（`connections.ts`）。
- 开发工作流：`npx expo start` + Expo Go 真机扫码，无需 Apple 开发者账号；服务端联调对本地 face/无头端/relay（`node dist/src/relay/relay-main.js`）。

## 6. 传输层

| | Direct | Relay |
|---|---|---|
| 请求 | `expo/fetch`（Expo SDK 内置流式 fetch，为 SSE 场景设计；RN 原生 fetch 无响应流） | RN 内置 WebSocket，req 帧按 id 配对 res，单请求 10s 超时 |
| 事件 | SSE 流（`sse-parser.ts` 纯函数：吃字节流 AsyncIterable，吐事件，处理半包/心跳注释行） | `event` 帧；连上后自动 GET info 合成 `server.connected` |
| 活性 | 60s 无入站字节判死重连 | 应用层 ping/pong 25s/60s（relay 帧本就是应用层，RN WebSocket 无协议层 ping 正好绕开） |
| 重连 | 指数退避 1s×2ⁿ 封顶 30s；重连后 `server.connected` 触发全量刷新 | 同左；open 帧按 connectionId 重配对 |

语义逐条对齐 mirror `direct-transport.ts` / `relay-transport.ts`（各 <300 行，状态机照抄）。请求头带 Bearer token；业务错判 `body.success`（HTTP 200 + 4xxx 包装是天枢约定）。

## 7. UI 与数据流

**会话页主流程**：进入 → `session/getById` 拉全量 → blocks 解析渲染 → 发消息（optimistic 用户消息纯函数，自 mirror 搬）→ `session/send` 202 → chunk 流按 connId+sessionId 分发进 `stream.store` → `remote-stream.liveBlocks()` 归并 → 流式追加渲染 → finish/session.updated 收尾落定。

blocks 渲染对齐桌面 `MessageItem`：text→markdown（代码高亮）、thinking→折叠面板、tool_call→状态卡（6 态）、usage→角标、image→`image` 端点 base64 加载（占位/失败兜底）。

**审批流**：approval-request chunk → 顶部 ApprovalBanner → 批准/拒绝 → `session/approve`；4040 提示「被控端版本过旧不支持远端审批」。

**模型选择**：`/info` capability 含 `provider` 才显示 ModelPicker（无头端有、桌面 face 补齐后也有）。

## 8. 错误处理与已知限制

- 401/code 4010 → `invalid-token` 粘滞态，引导改 token；连接失败四分类文案。
- 断线事件丢弃 + 重连全量刷新（列表与活动会话重拉）——移动网络切换频繁，这是主路径而非边缘 case。
- 同会话 `CONCURRENT_REQUEST` 守卫：发送中 composer 锁定 + 中止按钮。
- **已知限制（标注不改，写入 app 内关于页/文档）**：
  - 多控制端同时控同一会话会串流（relay res/event 广播给全部已配对 client），按单控制端使用；
  - `getById` 全量拉取，长会话高延迟链路慢（后续可加增量端点）；
  - relay 无被控端列表端点，instanceId 带外获取（手填/桌面端查看复制）；
  - 静态 token 无设备撤销，token 泄漏即失守（沿用一期安全假设，见 §9）。
- markdown 库风险：`react-native-markdown-display` 维护一般，备选自写轻量渲染（text/code/list 子集），实现时裁定。

## 9. 安全说明

MVP 沿用既有静态 token 体系：direct 链路 = face/无头端业务 token（Bearer 或 `?token=`）；relay 链路 = relay 接入 token，被控端业务 token 由 relay-client inject 注入。token 持久化于手机 AsyncStorage（明文，设备级风险自担）。图片端点新增面已含路径穿越防护与 mime 白名单。设备配对码、per-device 凭据、token 轮换、E2E 加密列为后续迭代（一期 spec §11 同款路线）。

## 10. 测试与验收

- **纯函数单测（Vitest）**：sse-parser（切帧/半包/心跳行）、remote-stream 归并、req/res id 配对、退避序列、blocks 解析。
- **服务端侧**：mirror face 三新路由 + approval 超时（照现有 server-face vitest 模式）；tianshu-server approve 端点 + `manual` accessMode（照现有 spec 模式）。
- **手动验收清单**（对齐 `manual-acceptance-*` 文档习惯）：Expo Go 真机 × 被控端（桌面 face / 无头端）× 承载（direct / relay）矩阵，含弱网切换、token 错误、审批超时、图片加载兜底场景。

## 11. 技术验证点与风险

1. **expo/fetch 的 SSE 流式读取**（唯一未经验证的技术假设）：plan 任务 1 在 Expo Go 里对本地 SSE 源跑通；失败 fallback `react-native-sse` 库（接口差异收敛在 direct-transport 内部）。
2. Metro 吃 file: symlink 的 CJS 协议包：tianshu-server 的 node 侧先例 + CJS 兼容性成熟，风险低，纳入任务 1 一并验证。
3. RN 内置 WebSocket 稳定性（长连 + 弱网）：有应用层 ping/pong + 退避兜底。

## 12. 与二期的关系

二期（graph/编排/自动化无头化，plan 未开工）落地后：capability 增 `"graph"`，移动端按 capability 驱动渲染自动化区（列表/触发/状态），消费 `automation/*` 与 `graph.run.updated` 事件——本 spec 的连接管理、Transport、chunk 渲染管道全部复用，无需结构性改动。移动端审批闭环（approve 端点）同时也是二期 accessMode 语义的先声。

## 13. 假设与偏离

- 用户已裁定：技术形态 Expo/RN（否掉 Capacitor 与 PWA）；MVP 含服务端补端点（否掉纯客户端）；双目标（无头端+桌面端）+ 双承载（direct+relay）。
- 假设（可推翻）：新仓路径 `/Users/hjx/workspace/tianshu-mobile`；approve 归 chat 能力域不加新 capability；图片端点单一 JSON base64 形态（不做二进制直载）；ApprovalCoordinator 超时常量 10 分钟（不可配）；无头端 approvalTimeoutMs 默认 300s；MVP 无推送/语音/图片发送/配对体系。
- 偏离 paseo 之处：paseo monorepo（packages/app）→ 天枢三仓 file: 依赖；paseo E2E 加密 relay → 沿用天枢一期明文 relay + TLS 半可信假设；paseo 推送/语音/插件 → 后续迭代。
