# 单 UI 多主机与无头端/中继架构技术方案

> 调研基线：main 995bf652（2026-11-05）。路径基准：桌面端路径相对 `apps/tianshu-desktop/`，server 端相对 `apps/tianshu-server/`，共享包相对 `packages/`。所有路径/函数名/字段名均来自当前代码实测，未实现项如实标注。

## 1. 总览

天枢的控制模型是「**一张桌面 UI，多个可切换主机**」（HD 批，spec 2026-10-19）：

```
┌─────────────────── 桌面单 UI（src-react）───────────────────┐
│  HostSwitcher（顶栏切换器）→ switchToHost → useHostStore     │
│  activeHost = {kind:"local"} | {kind:"remote", connId}       │
│  caps 门控（HostCaps：chat/provider/files/graph…九面）       │
└──────────────┬──────────────────────────────┬───────────────┘
       routeInvoke（本地 invoke）      routeInvoke（远程适配器闭包）
               │                              │
        chat:* IPC 通道                server:* IPC 通道（57 个）
               │                              │
┌──────────────▼─────────┐   ┌───────────────▼────────────────┐
│ 本地主进程（Electron）   │   │ electron/domains/server/       │
│ electron/domains/ai/*   │   │ ConnectionRegistry（连接注册表）│
│                         │   │  ├ DirectTransport（fetch+SSE）│
│ server-face 被控面      │   │  └ RelayTransport（ws role=client）
│ （HTTP/WS + relay 客户端）│   └───────┬──────────────┬───────┘
└───────────┬─────────────┘           │              │
            │ 出站 WS role=server      │ 直连 HTTP    │ ws + e2e-secure 信封
            ▼                          ▼              ▼
     ┌────────────────────────────────────────────────────┐
     │ relay（tianshu-server src/relay，公网中继，8411）      │
     │  jwt 多租户三校验（配额/顶号/跨租户）+ CRL + kick       │
     └────────────────┬───────────────────────────────────┘
                      │ 配对转发（业务零明文可见）
                      ▼
     无头端（tianshu-server NestJS 主应用）——CAPABILITIES:
     chat/provider/graph/files/library/monitor
```

三类角色：

- **控制端**：桌面 UI（移动端亦可作控制端，经同一协议契约）——发起请求、订阅事件、展示审批卡与编排遥控面板；
- **被控端**：无头端（`apps/tianshu-server`，编排/自动化/webhook 能力独占）或桌面端自身被控面（`electron/domains/server-face/`——本机数据根、MCP、项目、技能市场、备份、记忆等桌面专属能力）；
- **中继**：`src/relay/relay-main.ts` 独立进程（`start:relay` 入口）——纯转发面不解释业务负载，负责配对、鉴权、多租户闸门；配套运营控制平面 `relay-admin`（独立入口 8412 / 独立库）。

三个设计要点：

1. **req 帧与直连 HTTP 同构**：`{method:"GET"|"POST", path:"session/query"（前导斜杠归一等价）, body?}`——直连与中继两承载对上层完全无感（统一 `Transport` 接口）；响应统一 starter 包装 `{code, success, data, message}`，业务错是 HTTP 200 + code 4xxx（判错查 success/code 勿只看 status；认证 401 例外：HTTP 401 + code 4010）。
2. **relay 零明文**：relay 链路端到端加密（X25519 + HKDF-SHA256 双向密钥 + AES-256-GCM 信封），中继只见恒明文生命周期帧（register/open/close/ping/pong）与密文信封；E2E 四链路抓帧测试断言「业务哨兵零泄漏」。
3. **能力协商运行时化**：被控端经三上报点（HTTP `/info`、SSE/relay 事件、relay register 帧）透出 capabilities，控制端按**运行时上报值**门控 UI（严禁 import 常量做客户端判定）；两份常量不对称——`CAPABILITIES`（无头端）与 `DESKTOP_CAPABILITIES`（桌面被控端）各自定义，graph 无头端专属、ui-drive/mcp/skillhub/memory/backup 桌面专属。

## 2. 架构分层

| 层 | 位置 | 职责 |
|---|---|---|
| 数据源路由层 | `src-react/domains/ai/data-source/`（host-route/host.store/switch-host/remote-catalog/remote-session/remote-files/chat-stream） | api 模块内双通道路由 + 远程形状转换 + 主机全局态与 caps |
| 连接管理层 | `electron/domains/server/`（connections/ipc/transport/direct-transport/relay-transport/supervisor/relay-ak/bridge-executor/protocol） | 连接注册表持久化、Transport 抽象与两承载、Supervisor 本地无头端启停、57 个 `server:*` IPC、AK 换发、控制端桥执行面 |
| 被控面层 | `electron/domains/server-face/`（server-face/routes/relay-client/deps/face-events/face-info/e2e-keys/ws-liveness/各 *-tap） | 桌面端 HTTP/WS 被控服务 + relay 出站客户端 + 各域 tap 桥接 |
| 无头端层 | `apps/tianshu-server/src/{modules,core,commons}` | NestJS 二十余模块业务面 + `core/` 桌面 golden 移植（chat-runner/tools/graph…） |
| 传输层 | DirectTransport / RelayTransport / server-face relay-client（双侧）+ ws-liveness（双侧） | 两承载同一 `Transport` 接口；应用层 ping/pong 活性；E2E 信封 |
| 协议层 | `packages/tianshu-protocol`（relay-frames/server-event/各 contract） | 中继帧、E2E 握手帧、事件与能力常量、逻辑端点表——三端 wire 单源 |
| 密码学层 | `packages/tianshu-core/src/e2e-crypto.ts`、`crypto-envelope.ts`、`relay-credential.ts`、server 侧 `jwt-eddsa.ts`/`auth.ts`/`crl.ts` | E2E 密钥协商与信封、access 换发与续期判定、EdDSA access JWT、吊销名单 |

## 3. 核心技术方案

### 3.1 host-route 双通道路由（HD 批核心）

**`src-react/domains/ai/data-source/host-route.ts`**（spec §2.2）：

```ts
export function routeInvoke<T>(
  local: { ch: string; args: unknown[] },        // 本地：invoke 原通道，参数逐字一致
  remote: (connId: string) => Promise<T>,        // 远程：适配器闭包（server:* 通道 + 形状转换）
): Promise<T> {
  const connId = remoteConnId();                  // useHostStore.getState().activeHost
  if (connId == null) return invoke<T>(local.ch, ...(local.args));
  return remote(connId);
}
export function routeSubscribe(local, remote) { … }  // 事件订阅路由（chunk 流）
```

UI 组件对路由完全透明——改造发生在 api 方法内部，本地分支零行为变化。connId 来自 `host.store.ts` 的 zustand 全局态（`ActiveHost = {kind:"local"} | {kind:"remote"; connId: string}`）；非组件态经 `activeHost()` 读取（api 路由层避免 React 依赖），组件态经 `useHostCaps()` 门控 UI。

**主机全局态与 caps**（`host.store.ts`）：`HostCaps` 九面（chat/provider/session/assistant/skills/permission/usage/files/graph）——`caps.files=false` 隐藏附件/文件联想/compact 等（`ChatInput.tsx` 消费），`caps.graph=false` 不渲染编排遥控。本地主机恒 `LOCAL_HOST_CAPS` 全集但 **graph 恒 false**（本地桌面无编排端点，远程编排是无头端专属）；远程 caps 由 `capsOfCapabilities(capabilities: string[])` 从连接运行时上报值推导：`chat/provider` 直判、`session/permission/usage` 挂 chat、`assistant/skills` 恒 true、`files` 需被控端显式上报（FA-T3 动态化——旧端不上报照旧全关）、`graph` 独立判定。切换时先置空面（`capsOfCapabilities([])`），由切换入口拉连接列表回填真实值。

**切换副作用**（`switch-host.ts` `switchToHost`，HD-T4）：`useHostStore.switchHost` 幂等守卫（同主机直 return）后置 activeHost，`onSwitched` 钩子执行——react-query 缓存全清（`deps.clearCache` ← `queryClient.clear()`；数据按主机隔离的 P1 简化口径：queryKey 不带主机维度，切换即全清）、会话搜索复位（`useSessionSearchStore.reset()`）、流式缓冲复位（`useChatStore.resetAll()`）；随后 `ServerApi.listConnections()` 按注册表运行时上报回填 caps（连接查无——已删/注册表过期——保持空面）。store 保持纯态不依赖 queryClient（缓存清空经 deps 注入）。

**已路由化域清单**（`routeInvoke`/`routeSubscribe` 消费方，`src-react` 全量）：

| api 文件 | 路由内容 |
|---|---|
| `api/chat.api.ts` | send/stop/usage/regenerate/editResend/approve 等十余方法（**审批决议在此路由化**） |
| `api/session.api.ts` | 会话 CRUD/标记已读/compact/polish |
| `api/model.api.ts` / `api/provider.api.ts` | 模型与服务商配置（**providerSave 写面含 apiKey 掩码回传约定**） |
| `api/assistant.api.ts` | 专家（assistant）列表/详情 |
| `api/workspace.api.ts` | workspace 列表（HD-A2 侧栏树数据源） |
| `skills/api/skill.api.ts` | HD-P2b：list/readSkill/setEnabled（远程技能管理） |
| `chat/components/ChatInput.tsx` | 附件/文件联想等 caps.files 面 |
| `data-source/chat-stream.ts` | 流式事件统一订阅面 |

流式订阅 `onChatStream(sessionId, cb)`：本地 `chat:stream:<sessionId>` vs 远程 `server:chunk:<connId>:<sessionId>`（载荷同为 `ChatStreamChunk`，on 回调统一跳过 event 取 chunk）。

**数据流走查：远程主机发送一条消息**（全链路贯通示例）：

```
ChatInput 提交 → ChatApi.send(text, images, skillRefs)
  → routeInvoke({ch:"chat:send", args:[…]}, connId 适配器)
  → activeHost 为 remote → ServerApi.sessionSend(connId, …)
  → IPC server:sessionSend → remoteHandler(registry, ENDPOINTS.session.send)
  → ConnectionRegistry 取 transport.request("POST", "session/send", body)
     ├ direct：fetch {baseUrl}/session/send + Bearer token
     └ relay：e2e-secure 信封 {kind:"req", id, method, path} → relay 转发 → 被控端解封
  → 被控端（无头端 SessionModule / 桌面 face routes handleRoute）
  → 流式 chunk 逐帧回推：event 帧 message.chunk（relay）/ SSE data（direct）
  → ipc.ts 广播 server:chunk:<connId>:<sessionId>
  → onChatStream → 前端 onChunk 协议（与本地 chat:stream 同构）→ UI 增量渲染
```

**形状转换**（`remote-catalog.ts` / `remote-session.ts`）：`toModelRecord`（type 五值收窄防远程新类型炸本地枚举）、`toProviderRecord`（apiKey 脱敏掩码原样直传——只读展示语义，编辑保存由 providerSave 掩码回传约定承载）、`toWorkspaceRecord`（null→undefined 走 UI 缺省分支；时间戳远端不透出缺省空串）、`toSessionRecord`（mode 三值收窄；summary/compactedUptoId/unreadCount/lastMessage A9/P1 批起透传）。不映射字段缺省——远程编辑/详情面由 caps 门控或走专通道，本地 UI 对缺省走既有分支。**适配器模式的关键收益：形状转换收敛在 data-source 层一处，UI 组件零感知。**

**HostSwitcher**（`src-react/domains/ai/layout/components/HostSwitcher.tsx`，HD-T4 常驻化）：DropdownMenu 列本机 + 已连接主机（状态点色：绿=已连/黄=连接中/灰=其余；**非 connected 禁用**——数据面拉不动，防切过去全灰误判故障）；`refetchInterval: 5_000` 轮询连接列表；`onRemoteEvent` 订阅三事件——`server.connected` 失效 sessions/messages 缓存重取（断流漏事件兜底，HD-P2c 随壳承接）、`workspace.changed`/`project.changed` 失效侧栏分组树（批③：远端被他端——移动端/另一控制端——写入时即时失效）；菜单底部「主机配置」常驻入口导航 `/module/ai/server`（无连接也可达）。

**主机页**（`src-react/domains/ai/server/views/ServerConsoleView.tsx`）：连接管理列表为主体（HD-P3 收敛：无编排能力时居中独占）；选中连接 `(selectedConnection?.capabilities ?? []).includes("graph")` 才展开右栏编排遥控 `GraphPanel.tsx` + `AutomationPanel.tsx`（Ruling 11 门控，**运行时上报值判定**，graph/automation 遥控经 `server:graph*`/`server:automation*` 通道）。配套 `ConnectionDialog.tsx`（连接编辑：mode/baseUrl/token/relayUrl/relayToken/AK 三要素/E2E 模式）、`ConnectionList.tsx`、`LocalFaceCard.tsx`（本机被控面开关卡）、`BridgeApprovalCard.tsx`（桥工具审批卡）。

### 3.2 server-face 被控面（桌面端被控）

**HTTP/WS 控制面**（`electron/domains/server-face/server-face.ts`，spec §6.1/T12）：node:http 承载直连控制端——`GET /info`（身份/能力）、`GET /event`（SSE 事件流，`encodeSseFrame`）、`POST session/*` 等业务路由经 `routes.ts`（97.9K）的 `handleRoute` 路由表分发。配置存 option 表 `type="app" name="serverFace"` JSON `{enabled, port, token, host, relayUrl, relayToken, akId, akSecret, adminUrl}`（经 `openSecretFields/sealSecretFields` 加密）；缺省端口 `DEFAULT_FACE_PORT = 18411`、host `0.0.0.0`（被控面消费者是远程控制端，本机进程走 IPC 不经 HTTP 面；与 server 端 `DEFAULT_LISTEN_HOSTNAME` 同口径）；**token 未配置即拒绝启动（不裸奔）**；鉴权 `authorized()` Bearer 与 `?token=` 双口径（EventSource 不能带 header），`tokenMatches` 用 `timingSafeEqual` 防时序侧信道。

**各域 tap**（连接 Application 构造期单实例，`deps.ts`（30.9K）`setServerFaceDeps` 注入面，**严禁 face 侧二次构造**）——tap 清单与对应能力：

| tap | 面向能力 | tap | 面向能力 |
|---|---|---|---|
| `skills-tap.ts` / `skillhub-tap.ts` | skills / skillhub（市场宿主侧安装） | `files-tap.ts` | files（A1 三端点） |
| `providers-tap.ts` / `mcp-tap.ts` | provider / mcp（连接器管理面） | `library-tap.ts` | library（A5 资料库） |
| `project-tap.ts` / `project-asset-tap.ts` | project（A7 项目读面+计划资产写面） | `memory-tap.ts` | memory（记忆进化读写） |
| `plan-item-tap.ts` / `plan-view-tap.ts` | plan（todo 数据面） | `backup-tap.ts` | backup（遥控备份客户端） |
| `automation-tap.ts` / `artifact-tap.ts` / `chat-tap.ts` | automation / artifact / chat chunk 事件 | `permission-tap.ts` | permission（审批记忆五端点） |

`face-events.ts ensureTapBridge` 聚合各域事件驱动 event 帧；`active-user.ts` 解析被控数据面实际归属用户（user 表最新用户——token 是实例级非用户级）。身份与能力：`face-info.ts` `FACE_INSTANCE_ID = randomUUID()`（进程级）、`FACE_CAPABILITIES = DESKTOP_CAPABILITIES`（协议包单源 RC-T1 收编）、`FACE_NAME = "tianshu-desktop"`。

**relay 客户端**（`server-face/relay-client.ts`，spec §6.2/T12）：出站 WS `role=server` 连 relay（**NAT 友好——被控端无公网监听**）；连上即发 `register` 元数据帧（instanceId/capabilities/name）；req 帧经 `handleRoute` 回 res 帧（`relay-protocol.ts isReqFrame` 校验——与直连 HTTP 同构 envelope）；face 事件总线驱动 event 帧（仅当前已连接时发送，断线窗口事件**丢弃**——控制端重连后全量刷新当前会话兜底）。重连指数退避 1s 起封顶 30s；重连成功重新 register（同 instanceId 顶掉 relay 侧旧连接，重注册不丢配对——F1 修复承诺）。活性（T14）：undici 全局 WebSocket 无协议层 ping → 应用层 `{kind:'ping'}` 25s 定发、收 ping 回 pong、60s 无任何入站帧判死强制重连（`ws-liveness.ts`，双侧同款）。E2E 角色为 server（3.4 节）；恒明文帧面：register/ping/pong/open/close。

**AK 凭证通道**（`server-face/renewable-credential.ts`，Task 15 被控端常驻）：static token 缺席而 `adminUrl/akId/akSecret` 三要素齐备时走 AK 模式——启动 Basic 换 access（401=AK 失效：干净启动失败/续期粘滞断连不重连；网络失败 30s 起退避封顶 10min），内存三元组 + 10min 巡检续期；auth 首帧发帧时读当前 access（续期后重连即用新 token）；static token 在场则 AK 机制整体旁路（零漂移）。`e2e-keys.ts ensureE2eStaticPair` 持久化被控端静态身份密钥对。

**HD-A1 workspace 数据面**：`files-tap.ts createFilesFace` 实现 `files/list|read|uploadImage` 三端点——清单/守卫读取经 `@tianshu/core workspace-files-scan.ts` 共享纯函数：`listWorkspaceFiles`（排除 node_modules/.git/dist 与点开头目录、2000 条上限、相对路径 / 分隔）、`readTextFileGuarded`（512KB 上限 + NUL 二进制判定），与桌面本地 `file:listWorkspaceFiles`、无头端 files 端点**三处同口径单源**（逻辑逐字迁自 mirror chat.service，收编 core 防双份漂移）；`uploadImage` 落本机数据根 attachments/ 返回相对 appDataHome 路径（sessionSend images/ImageBlock.imagePath 同值消费，本机 loadImage 回喂零适配）；workspace 归属校验对齐 face 既有桥（userId 比对）。

### 3.3 Direct/Relay 传输与 Supervisor

**Transport 抽象**（`electron/domains/server/transport.ts`，T13）：`Transport` 接口 = `state`（connecting/connected/reconnecting/closed）+ `e2eState`（unsupported/plaintext/encrypted/mitm-suspect/required-failed）+ `request(method, path, body)` + `onEvent/onState/onE2eState` 订阅 + `close`；`TransportBase` 抽象类持共用状态机与订阅扇出（订阅者异常隔离）。`E2eStatusChange {state, fingerprint?}`——fingerprint 为本次协商确认的被控端指纹，**控制端自算不信任 wire 回显**，是 TOFU 回填持久化的数据源。两承载对照：

| 维度 | DirectTransport | RelayTransport |
|---|---|---|
| 承载 | fetch + SSE（GET /event） | ws role=client 出站 |
| 配对 | baseUrl 直达 | open 帧 binding connectionId |
| 事件流 | SSE data | event 帧（register 不透传，身份经 GET info 合成 server.connected） |
| E2E | 恒 unsupported（localhost/上游 TLS 信任模型内） | hello/ack 协商 → 信封（plaintext/encrypted/mitm-suspect/required-failed） |
| 超时 | AbortSignal.timeout | requestTimeoutMs 10s（req/res 按 id 配对） |
| 重连 | —（SSE 断由底层） | close/超时 → 1s×2ⁿ 封顶 30s 退避重发 open |
| 活性 | — | ws-liveness 25s ping/60s 判死 |

**DirectTransport**（`direct-transport.ts`）：fetch + SSE——业务请求走 HTTP（`AbortSignal.timeout`，DOMException.name 中止判定），事件流 `GET /event` SSE 订阅；SSE 首帧合成 `server.connected`（连接级合成事件，不进被控端事件总线）。信任模型内 E2E 恒 unsupported：localhost/上游 TLS 已覆盖。

**RelayTransport**（`relay-transport.ts`，T14 中承载）：出站 WS `role=client`，`open` 帧绑定目标 connectionId 配对；req/res 按 id 配对（`requestTimeoutMs` 默认 10s）；register 帧不透传 → 被控端身份经 GET info 取并合成 `server.connected`（与 DirectTransport 同构，上层无感，T18）；断线重连指数退避 1s×2ⁿ 封顶 30s，重连重发 open 帧重新配对；活性同 ws-liveness。E2E 控制端角色：ws open 后发 `e2e-hello`（每连接临时对 + 已存指纹 expectedFingerprint）→ 等 `e2e-ack`：指纹匹配（自算 `fingerprintOf`）→ `deriveSessionKeys`（临时私钥 + ack 静态公钥，connectionId 绑定）+ 信封收发，状态 encrypted；TOFU 首连（无已存指纹）→ 加密 + ack 指纹经 `onE2eState` 上报由注册表回填连接配置持久化（下次强制）；不匹配 → 断开 + mitm-suspect **不再重连**（重连只会再次不匹配）。连接级 `RelayE2eMode = "auto" | "required"`（required=握手无 ack 拒降级直接断开堵「攻击者恒强制降级」缺口，E2E-T4；无 off——不建 relay 连接即得等价语义）。

**连接注册表**（`connections.ts`，T16/T18）：

- `ConnectionRegistry` 类 + 单例 `serverConnections`（911 行）；
- `ConnectionConfig`：id/name/`mode: "direct" | "relay"`/baseUrl/token/backupToken（备份专用 token 申领所得）/relayUrl/relayToken/connectionId/fingerprint（hex16，空=TOFU 首连回填）/`e2eMode`/adminUrl/akId/akSecret（relay AK 凭证三要素——与 relayToken 并存时 static 优先）/local；
- `ConnectionView extends ConnectionConfig` 增运行态 `state: idle|connecting|connected|reconnecting|invalid-token|closed`（invalid-token 401/4010 粘滞，server.connected 或 save 重建才清除）、`e2e`、`capabilities`（协商到的能力清单）；
- 持久化 `createOptionPersistence()` 落 option 表（`PersistedShape {connections, activeConnId}`）；transport 工厂可注入（单测换 fake）；`testConnection` 8s 整体超时窗（relay 建链等待 3s）返回 `{ok, instanceId, capabilities}` 或 `{ok:false, reason: invalid-config|invalid-token|unreachable|timeout, message}`；AK 凭证失效占位 `akFailure: "invalid-ak"（粘滞）| "unavailable"（瞬态）`；transport 代际守卫防 save 重建与挂起请求竞态；
- AK 换发（`relay-ak.ts`，控制端短连接语义——与被控端常驻 renewable-credential 分域不互引）：每次建连前 `resolveRelayAccessToken` 收口——存量新鲜（`shouldRenew` 自 core 单源）直用零 admin 请求；缺失/剩<50%/换绑 → `POST {adminUrl}/relay-admin/token`（Basic akId:akSecret）换新；瞬态失败降级用存量；401 按 data.reason 分支（disabled/expired/bad-secret/无存量→invalid-token 粘滞；not-found/代理质询→瞬态自愈）；access 内存态不落盘。

**Supervisor**（`supervisor.ts`）：`ServerSupervisor` 管本地无头端子进程——`SupervisorState = stopped|starting|running|error`；握手行 `HANDSHAKE_PREFIX = "TIANSHU_HANDSHAKE "`（JSON：port/token/instanceId，同进程同值）；产物缺失给可读指引（引导 server 仓 build）。**仅 dev 态**：`connections.ts:835 startLocalServer` 开头 `if (app.isPackaged)` 前置拒绝——打包态安装包**不内嵌**无头端（2026-10-27 拆除内嵌裁定），本地无头端 spawn 兄弟仓产物（node 跑 dist；`resolveLocalServerCommand`/`localServerEntry(projectDir)` 解析命令）。IPC 通道 `server:localStart/localStop/localStatus`。

**连接生命周期**（注册表状态迁移）：

```
新建/编辑（ConnectionDialog → server:connectionSave）
  → registry.save（重建 transport、代际递增）
  → testConnection（8s 窗；GET info 拿 instanceId/capabilities）
  → 激活（activeConnId 持久化；HostSwitcher 选择 → switchToHost）
运行态迁移：idle → connecting → connected
  ↘ reconnecting（断线指数退避）→ connected
  ↘ invalid-token（401/4010 粘滞——server.connected 或 save 重建才清除）
  ↘ closed（server:connectionDelete 拆除）
capabilities：connected 时经 register/info 上报存 ConnectionView；
  HostSwitcher 5s 轮询 connectionList 即取此运行时值（非静态配置）
```

**IPC 面**（`electron/domains/server/ipc.ts`）：57 个 `server:*` 通道，`remoteHandler(registry, ENDPOINTS.xxx)` 工厂统一装配（端点路径全引协议包 ENDPOINTS 常量——2026-11-01 审查架构债收敛，防通道与端点双份漂移）。分组：connection 管理 7（connectionList/Save/Delete/testConnection/localStart/localStop/localStatus）、session 十九（List/Get/Send/Abort/Create/Delete/Update/Regenerate/EditResend/AccessMode/Usage/Approve/Read/Compact/Polish…）、provider 六（Query/Save/Delete/Test/FetchModels）、graph 五（Query/Save/Delete/Run/RunAbort）、automation 四、webhook 三、files 三（List/Read/UploadImage）、skills 三（Query/Read/SetEnabled）、ui-drive 三（OpenSession/Notify/OpenRoute）、workspaceList、bridgeDecision（桥审批决议）。无头端 `tool.request` 事件经 `bridge-executor.ts`（TB-T2 控制端桥执行面）：隐藏 BrowserWindow 单例（GuestControl）复用桌面 browser 四工具，read+navigate 直执行、write 推 `server:bridgeApproval` 审批卡等渲染层 `server:bridgeDecision`（30s 上限，拒绝为默认安全态），结果 POST `tool/respond` 回传——**无头端会话里也能「借用」控制端桌面浏览器**，这是「桌面控制端既是 UI 又是执行资源」的关键设计。

### 3.4 relay 中继与多租户控制平面

**无头端 NestJS 模块清单**（`apps/tianshu-server/src/app.module.ts` imports，三入口并行：`main.ts` 主应用 / `relay/relay-main.ts` 中继（`start:relay`）/ `relay-admin/main.ts` 控制平面（`start:relay-admin`））：

| 模块 | 职责 |
|---|---|
| UserModule / AuthControllerModule / AuthModule | 用户与认证（JWT） |
| SessionModule / ProviderModule / AssistantModule | 会话/服务商配置/专家——单 UI 远程聊天主数据面 |
| WorkspaceModule / FilesModule / SkillsModule | 工作空间/文件三端点/技能五端点 |
| GraphModule / AutomationModule / WebhookModule | 编排图/定时任务/webhook 触发（graph 能力域） |
| ChatCoreModule（`core/chat-runner.service.ts` 53.5K） | chat 执行核心（桌面 golden 移植） |
| ToolModule | 工具桥 `POST tool/respond`（TB-T1） |
| PermissionModule / LibraryModule / MonitorModule / BackupModule | 审批记忆五端点/资料库十七端点/用量聚合/备份六端点 |
| InfoModule / EventModule / EventBusModule | `/info` 身份能力/事件面/进程内事件总线 |
| OperationLogModule / HealthModule / MetricsModule | 操作日志/健康检查/性能指标 |

全局件：`StaticTokenGuard`（TIANSHU_TOKEN 设置时全局校验 Bearer/query token，豁免 webhook/backup 两前缀）、`ResponseInterceptor`（starter 包装 `{code,success,data,message}`——transport 判错契约的另一半）、`OperationLogInterceptor`/`MetricsInterceptor`/`HttpExceptionFilter`。

**帧协议**（`packages/tianshu-protocol/src/relay-frames.ts`，wire 单源——tianshu-server `src/relay/registry.ts` 已收编引用本类型，2026-11-01 收敛原「六值宽松联合与 ping/pong 分叉」架构债）：

```
RelayFrame =
  | {kind:"req";  id; method; path; body?}        // 与直连 HTTP 同构
  | {kind:"res";  id; status; body}
  | {kind:"event"; type; payload}
  | {kind:"open";  connectionId}                  // 控制端绑定被控端
  | {kind:"close"; connectionId; reason?}         // server-gone/not-found
  | {kind:"register"; instanceId; capabilities; name?}  // 被控端注册（relay 消费）
  | {kind:"ping"} | {kind:"pong"}                 // 应用层活性
AuthFrame = {kind:"auth"; token; role:"client"|"server"; connectionId?}  // 首帧鉴权
RELAY_CLOSE_CODES = {QUOTA_EXCEEDED:4005, ID_CONFLICT:4006, TENANT_FORBIDDEN:4007}
```

首帧鉴权（安全批 I）：凭证出 URL query——query 明文会留存反代/负载均衡访问日志与浏览器 URL 记录；升级完成后以首帧 auth 承载凭证（ws 帧不经访问日志），兼容窗口双轨（query 保留 + 首帧 auth 优先并打弃用告警）。

**relay 主服务**（`src/relay/relay-main.ts` `startRelay(options)`，`start:relay` 独立入口，`DEFAULT_RELAY_PORT = 8411`，Dockerfile.relay 零业务代码）：static/jwt 双鉴权模式（`auth.ts createStaticAuthenticator/createJwtAuthenticator`）；首帧鉴权等待窗 `DEFAULT_AUTH_WINDOW_MS = 5s`（窗口内无凭证即拒）；心跳 30s/超时 60s；内部端点（internal secret 保护）`/internal/stats`（按租户聚合在线数，tenants 按 tenantId 字典序稳定输出）与 `/internal/kick`（按 tenantId 或 ak 拆连接——relay-admin 联动入口）。`registry.ts RelayRegistry`：connectionId → server ws + 已配对 client ws 集合；**内嵌租户簿记**（顶号归属 + server/client 分计配额闸），relay-main 只消费三校验点返回值不感知簿记细节，tenantId 缺省（static 模式）时三校验全旁路（与单租户现状逐字节一致）；有界缓冲 `DEFAULT_MAX_BUFFER_FRAMES = 200` 拆慢消费者防内存膨胀；**relay 为透传面不解释业务负载**，转发逻辑不依赖 kind 白名单（register 兜底之外原样转发）。

**E2E 加密**（`packages/tianshu-core/src/e2e-crypto.ts`，纯 node:crypto 零第三方依赖；三方消费：mirror RelayTransport 控制端 / server-face relay-client 被控端 / headless relay-client 经 dist）：

- 密钥协商 X25519：被控端静态身份对持久化（`parseStaticPair`/`ensureE2eStaticPair`）+ 控制端每连接临时对；
- HKDF-SHA256 派生**双向会话密钥**（info 绑定 connectionId + 两公钥 + 方向标签——双向密钥不同，跨方向密文互不可解）；
- AES-256-GCM 信封 `E2ESecureEnvelope {kind:"e2e-secure", n, ct}`：nonce = 4B 会话随机前缀 + 8B 计数器；aad = 方向 + 计数器（防帧重排序注入）；接收端 64 滑动窗口拒重放（`E2E_REPLAY_WINDOW = 64`）；
- 握手：控制端发 `E2E_HANDSHAKE_HELLO = "e2e-hello"` `{ephemeralKey(base64 32B), expectedFingerprint?}`（TOFU 空=首连）→ 被控端回 `E2E_HANDSHAKE_ACK = "e2e-ack"` `{staticKey, fingerprint(hex16)}` → 其后 req/res/event 业务帧一律 `E2E_SECURE_KIND = "e2e-secure"` 信封承载；
- 降级语义：被控端 `FaceE2eMode = auto|required|off`（auto 缺省收 hello 即握手、控制端不握手则明文兼容；required 拒明文业务帧断开；off 忽略 hello 完全旧版）；控制端 auto|required（无 off）。

**relay 全链路时序**（一次加密会话的建立与请求往返）：

```
控制端                                relay                               被控端
   │ ws connect (role=client) ──────▶│                                     │
   │ auth 首帧 {token,role:"client"} ▶│ 鉴权（static/jwt+CRL+配额）           │
   │                                  │◀──── ws connect (role=server) ──────│
   │                                  │◀──── auth + register {instanceId,…} │
   │ open {connectionId} ────────────▶│ 配对（顶号/租户校验）                  │
   │ e2e-hello {ephemeralKey} ───────▶│ （明文照转发） ──────────────────────▶│
   │◀────────────── e2e-ack {staticKey, fingerprint} ────────────────────────│
   │   [TOFU 首连：回填 fingerprint 持久化；不匹配：断开 mitm-suspect]        │
   │ e2e-secure{req(id,path,body)} ──▶│ （密文照转发） ──────────────────────▶│ handleRoute
   │◀────────────── e2e-secure{res(id,status,body)} ──────────────────────────│
   │◀────────────── e2e-secure{event(type,payload)} ──────────────────────────│ face 事件总线
   │ ping ──────────────────────────▶│（照转发）────────────────────────────▶│ pong
   （25s 周期 ping；60s 无入站帧判死重连；relay 侧另有 30s/60s 心跳拆死链）
```

**jwt 多租户**（spec 2026-11-03，`src/relay/jwt-eddsa.ts`）：Ed25519 access JWT（node:crypto 原生 + base64url，零 jose/jsonwebtoken——中继公网暴露面最小化）——**relay-admin 持私钥签发、relay 持公钥验签**（非对称凭证替代「知道即通过」的共享 token：泄露面从「租户全量」收敛到「短期 access」）；`AccessClaims {iss:"tianshu-relay", sub, tid, role:"server"|"client", ak}` + `AccessQuota {maxServers, maxClients}`；防御闸 `isUsableQuota` 拒签名合法但 quota 畸形 token（防无配额租户进闸门后解引用炸）。吊销走 CRL（`crl.ts createCrlStore`——控制平面名单命中 ak 即拒**新**连接 4001；存量长寿命连接不拆：relay 不存 exp、不定时拆连接，spec §5.3）。

**relay-admin 运营控制平面**（`src/relay-admin/`，独立入口 `start:relay-admin`（`cross-env NODE_ENV=production node dist/src/relay-admin/main.js`），`RA_DEFAULT_PORT = 8412`——spec 2026-11-03「relay 面板 8410 / 控制面 8412」；独立库 `prisma/relay-admin/schema.prisma`（`RA_DATABASE_URL`，prisma:generate:ra/push:ra/seed:ra 独立脚本链））：

| 表 | 字段要点 |
|---|---|
| `RaUser`（ra_user） | 租户：tenantId=randomUUID 建户生成、plan（beta 单档）、status |
| `RaAccessKey`（ra_access_key） | AK：id 即对外 akId、secretHash=sha256(akSecret)（明文仅签发/重置显示一次）、role server/client 分离（泄露面隔离）、expireAt 动态判过期（非存储态） |
| `RaAuditLog`（ra_audit_log） | append-only 审计（建户/发 AK/禁用/续期；renew 高频不记）：action/operator/target/detail |
| `RaAdminUser`（ra_admin_user） | 运营方管理员登录账号（与租户表分离；passwordHash） |

模块：`aks`（`aks.service.ts` 签发/续期/禁用/轮换，`PLAN_QUOTA` 套餐配额表签发时写入 claims）、`token`（`token.service.ts` Basic akId:akSecret → access 三元组）、`revocations`（CRL 名单管理）、`users`（ra-users 租户管理）、`audit`（审计查询）、`prisma.service`（RaPrismaService 独立连接）。`relay-link.service.ts` 持 relay 侧内部端点客户端——AK 禁用/轮换/用户禁用联动 `POST /internal/kick`（KickTarget tenantId 与 ak 恰一维）即时拆在线连接、`/internal/stats` 供在线视图；`relay-admin-config.ts resolveInternalSecret/resolveRelayBaseUrl`。

**AK 凭证全生命周期**（签发到吊销）：

```
运营方 relay-admin 建租户（RaUser.tenantId=randomUUID）
  → 签发 AK（RaAccessKey：akId 公开标识 + akSecret 明文仅显示一次，库只存 sha256）
  → 交付租户：桌面/被控端配置 adminUrl/akId/akSecret 三要素
建连（控制端 relay-ak.ts / 被控端 renewable-credential.ts）：
  → POST {adminUrl}/relay-admin/token（Basic akId:akSecret）
  → access JWT（claims: tid/role/ak/quota；短期有效）
  → ws 连 relay + auth 首帧 {token: access, role}
  → relay 验签（Ed25519 公钥）+ 三校验点 + CRL 查询
续期：被控端常驻 10min 巡检；控制端短连接语义——建连前 shouldRenew 判定（剩<50% 换新）
吊销：relay-admin 禁用 AK → CRL 名单生效（新连接 4001 拒）
  + 联动 POST relay /internal/kick → 存量在线连接即拆
审计：RaAuditLog append-only（action/operator/target/detail）
```

**四链路 E2E 抓帧验证**（`apps/tianshu-desktop/tests/ai/server/e2e-relay-e2e.ts`（48.3K），`npm run test:e2e:relayE2E`（vitest.relay-e2e.config.ts），文件名无 .test. 段不进常规集）：本机**真 relay 子进程**（tianshu-server dist/src/relay/relay-main.js）+ 双端真实握手栈（控制端真 RelayTransport、被控端真 relay-client——setServerFaceDeps 内存替身 + Log/prisma 两桩，桩外握手/信封/路由/重连均生产代码路径）+ 双端与 relay 之间挂**透传抓帧 proxy**（ws 库，query 原样转接、双向帧全记录——所录即 relay 所见）。四条基础链路：

- ① 密文往返：hello→ack→req/res/event 全 e2e-secure 信封（TOFU 指纹自算与被控端静态对一致）；
- ② relay 侧零明文：断言业务哨兵零泄漏、业务帧 kind 全为 e2e-secure（其余仅恒明文生命周期帧）；
- ③ 降级路径：被控端 e2e=off → 控制端握手超时降级明文往返成功 + plaintext 标注（抓帧对照：明文 req 含哨兵——与 ② 互为反证）；
- ④ 指纹不匹配：控制端配错指纹 → ack 即断开 + mitm-suspect + 不再重连（proxy 连接数不增），上报指纹为对端实际值。

另有 ⑤-⑩ 多租户链路（另起 jwt 模式 relay 子进程，`--auth-pubkey` 测试密钥 + `--internal-secret`；测试内以生产同源 jwt-eddsa 模块签发双租户 access，raw ws 双端观测 close code）：⑤ 双租户隔离（A-client attach B-server → 4007）；⑥ 顶号（异租户注册已占 connectionId → 4006）；⑦ 配额（quota.maxServers=1 第二个 server → 4005）；⑧ kick（POST /internal/kick 拆本租户、他租户与记账无扰）；⑨ CRL（名单命中 ak 新连接 4001、存量不断）；⑩ 存量长寿命（access TTL 到期只拦新连接、存量配对双向照转发）。

### 3.5 workspace 协议化数据面（HD-A1/A2）

- **A1（透出）**：被控端工作空间面——`packages/tianshu-protocol/src/workspace-contract.ts` 定义 `WorkspaceSavePayload {id?, name?, icon?, defaultModelId?}`（v1 全量字段传；**不带 directoryPath**——绑定目录留桌面端：系统选择框语义 + 任意路径写面不可远程化，spec §1.4）与稳定错误码 `WORKSPACE_ERROR_CODES = [WORKSPACE_NOT_FOUND（不存在/归属校验失败——不泄露存在性）, WORKSPACE_INVALID]`；files 三端点（3.2 节）同批落地。workspace 概念**不跨主机**——远端只是分组树数据，本地 workspace 表与远端各自独立。
- **A2（消费）**：侧栏远端 workspace 树——`remote-catalog.ts` `remoteWorkspaceList(connId)` 走 `server:workspaceList` 通道，`RemoteWorkspaceBrief → WorkspaceRecord`（`toWorkspaceRecord`：null→undefined 走 UI 缺省分支、时间戳远端不透出缺省空串）；`src-react/components/layout/GlobalSidebar.tsx` 以 queryKey `["workspaces"]` 消费（挂载查询兼任非 AI 路由下的观测），`workspace.changed` 远端事件触发失效重取（HostSwitcher 订阅分支）——远端被他端写入时侧栏分组树即时刷新。

**A1/A2 的边界语义**（设计裁定沉淀）：

| 面 | 本地主机 | 远程主机 |
|---|---|---|
| workspace 增删改 | 本地面（含目录绑定选择框） | 远程写面（无 directoryPath） |
| 文件浏览/附件 | 本地数据根 | files 三端点（被控端上报才可见） |
| workspace 树 | 侧栏本地分组 | 同一 UI 位、远端数据（caps.files 门控） |
| 会话归属 | 本地 workspaceId | 远端 workspaceId（分组语义各自独立） |

### 3.6 协议包全景（packages/tianshu-protocol）

零运行时依赖纯类型 + 常量包（移动端可消费、不引 core——langChain peer 不进 metro bundle）：

| 文件 | 内容 |
|---|---|
| `relay-frames.ts` | RelayFrame/AuthFrame/RELAY_CLOSE_CODES/E2E 握手与信封类型（3.4 节） |
| `server-event.ts`（29K） | `ServerEvent` 联合（server.connected/session.updated/message.chunk/tool.request/session.error/graph.run.updated/automation.changed/backup.progress…）、`FaceEvent`（被控端事件总线，server.connected 不含——连接级合成）、`CAPABILITIES`（无头端：chat/provider/graph/files/library/monitor）、`DESKTOP_CAPABILITIES`（桌面被控端：chat/provider/ui-drive/files/mcp/monitor/library/project/skillhub/automation/memory/backup）、`RemoteInstanceInfo {name, version, instanceId, capabilities, username?}`（token 是实例级非用户级，归属用户名单独透出）、`ENDPOINTS` 逻辑端点路径表 |
| `chat-contract.ts` | chunk（`ChatStreamChunk`）/blocks（`MessageBlock` 联合）/send（`ChatSendParams`）契约——三端消息形态单源 |
| `agent-runner.ts` / `artifact-contract.ts` / `backup-contract.ts` / `expert-contract.ts` / `graph-contract.ts` / `library-contract.ts` / `mcp-contract.ts` / `memory-contract.ts` / `monitor-contract.ts` / `permission-contract.ts` / `project-contract.ts` / `provider-save-contract.ts` / `skill-contract.ts` / `ui-contract.ts` / `workspace-contract.ts` | 各域载荷与稳定错误码（provider-save 含 apiKey 掩码回传约定；skill 含 SkillHub 市场契约） |

`@tianshu/core` 的 e2e-crypto/relay-credential 监护 wire 常量 re-export 自 protocol（安全批 H 上收——移动端接入 e2e 需消费契约但不能引 core）。server 侧原 `src/protocol/server-event.ts`、mirror 侧 `electron/domains/server/protocol.ts`、server-face `face-events.ts` 三处同构双写已收编单份（RC-T1）。

**共享包消费方式**（与 CLAUDE.md 口径一致）：desktop（apps/tianshu-desktop）经 vite/tsconfig/vitest alias 直引 `packages/*/src` 源码（主进程与渲染进程各自登记）；apps/tianshu-server 与 apps/tianshu-mobile 经 workspace 依赖消费 `dist` 产物——改协议/核心包源码后须重建 dist（server 侧 `npm run sync:core`，或根 `npm --prefix packages/tianshu-core run build`），链接直读、重启即生效；worktree 内构建不回写主树，合并后主树需手动刷新 dist，否则 server jest 的 `@tianshu/core` 解析失败。

**相关文档**：工具/技能/MCP 能力面见 `docs/design/skills-tools-mcp.md`；安全域整体（SSRF/secret-field/审计）见 `docs/design/security.md`；监控见 `docs/design/monitoring.md`；relay 部署（Dockerfile.relay、relay-admin 运维）见 `apps/tianshu-server/README-relay.md`。

## 4. 业界主流做法对比

**VS Code Remote（SSH/Containers/Tunnel）**：VS Code 把 UI 壳（workbench）与扩展宿主分离，remote 侧跑语言服务/终端，经单条隧道复用为多路 RPC；Tunnel 以 dev tunnels 服务打通 NAT，身份走 Microsoft 账号。天枢同构处：单 UI 多主机、连接注册表、NAT 穿透经中继、事件流驱动 UI 刷新；差异：① VS Code 是「一窗一远端」（window 级切换，多窗多远端），天枢是**全局 activeHost 切换 + 缓存全清**——更接近「数据源切换」语义，切换成本更低但并发性弱（见改进 2）；② VS Code Tunnel 由平台托管鉴权（OAuth），天枢 relay 自持（自部署 Dockerfile + E2E，relay 看不到内容——VS Code 隧道流量对隧道服务终结可见，天枢密文只在两端终结）。

**JetBrains Gateway**：瘦客户端发起远端会话，IDE 后端进程整体跑远端，本地仅 UI/输入——「backend 远程化」路线。天枢桌面端不走此路（Electron 渲染进程本地、本地域全功能），但**无头端本质是「chat 后端远程化」**：会话/模型调用/编排全在 server，控制端只持 UI 与流式订阅；Gateway 的「远端后端自包含、断线可重连续跑」对天枢无头端天然成立（automation/webhook 不依赖控制端在线，被控端 relay-client 断线重连后控制端全量刷新兜底）。Gateway 的「远程后端有完整状态、UI 重连即恢复」正是天枢 HD-P2c（server.connected 失效重取）想达到的效果。

**Tailscale 组网**：WireGuard mesh + DERP 中继（NAT 穿透失败回落），身份=设备/用户，ACL 集中下发。天枢未走 mesh：direct 模式覆盖同网/公网可达，relay 覆盖 NAT——形态上「direct 优先/relay 兜底」与 Tailscale「直连优先/DERP 回落」一致；被控端出站连 relay（role=server 无公网监听）与 DERP 的客户端出站同思路。差异：① Tailscale 是 L3 overlay（对应用透明），天枢是应用层协议（对业务端点显式建模——换来能力协商与逻辑端点表）；② Tailscale 组内即全通（ACL 需显式配置），天枢 relay 有显式多租户三校验点（配额/顶号/跨租户）；③ 加密上 DERP 只见 WireGuard 密文与天枢 e2e-secure 信封等价，但 Tailscale 密钥协商在组网层（每次连接重建），天枢静态身份 + TOFU 更接近 Signal 模型。

**Cloud IDE 控制面（Codespaces/Devbox）**：控制面持生命周期 API（create/suspend/delete）+ 数据面（SSH/HTTPS 进容器），严格分离且控制面不碰代码内容。天枢对应物：relay-admin（控制面：租户/AK/kick/stats）与 relay（数据面：帧转发）分离部署分离扩缩；被控端业务面（face routes）与连接面（transport/registry）分离。本质差异：Codespaces 控制面可**调度计算**（冷启动容器按需供给），天枢被控端是已存在的常驻机器（桌面/无头端），无调度语义——「bring your own machine」模型；因此 relay-admin 不需要 Codespaces 级的编排状态机，只做准入与治理。

**K8s 控制面/数据面分离**：apiserver 持期望态，kubelet 上报实况并执行，watch 增量同步。天枢相似点：capabilities 运行时上报（被控端 register/info 三上报点，控制端不静态假设）+ 事件驱动失效（server.connected/workspace.changed/project.changed → invalidate 重拉）；差异是天枢无期望态协调（不是声明式系统），注册表只持连接事实，被控端能力由其版本决定。K8s 的 RBAC/namespace 多租户与 relay 三校验点目标一致（隔离+配额），但 K8s 在 API 层逐请求鉴权 + 准入 webhook，天枢在**建连时**一次性闸门 + 首帧鉴权 + CRL/kick 事后治理——层级更粗，但对连接级（非请求级）的转发面是合身的粒度。

**消息中继 E2E 加密（Signal/MLS）**：Signal 是 X3DH 预密钥 + 双棘轮（每消息前向保密）+ safety numbers 人工核对；MLS 用 TreeKEM 支持群组高效成员变更。天枢取 Signal 的「静态身份密钥 + 每连接临时密钥 + 指纹人工可核对」骨架：X25519 静态对≈身份密钥、每连接临时对≈会话材料、TOFU 首连回填 + mitm-suspect≈safety number 校验失败；双向密钥 + aad 方向绑定（跨方向密文互不可解）超出多数简单实现的水平。差异：① 无双棘轮——天枢会话密钥连接生命周期恒定（nonce 计数器 + 滑窗防重放，但单帧泄露影响整连接），Signal 每消息演进；② 无群组语义（一对一配对）——若未来多控制端同被控端需组密钥，MLS 的 TreeKAM 是可参考方向；③ 恒明文帧面收敛到最小生命周期帧与 Signal metadata-minimization 思路一致。

**多租户 SaaS AK 体系（AWS IAM/AKSK、阿里云 AccessKey）**：业界标配——AK/SK 静态凭证换发短期 STS token、按 principal 授权、支持吊销与审计。天枢 relay-admin 完整对齐：RaAccessKey（secretHash 只存哈希、明文一次显示、role 分离≈云厂商主/子账号 AK）→ Basic 换短效 access JWT（EdDSA 非对称验签，relay 不持私钥≈STS 的签名验证方无签发能力）→ CRL 吊销 + kick 联动 + RaAuditLog append-only 审计；quota 进 claims（inline policy 形态）。与云厂商差距：无细粒度资源级授权（AK 即租户全量——云厂商有 resource-level ARN/policy），无 AssumeRole 委托链；当前「单租户内单角色」模型下够用，若未来按连接/按端点授权则需 claims 增维。

**小结**：天枢这套架构的本质是把「远程开发/远程控制」的业界成熟模式（backend 远程化、中继穿透、控制/数据面分离、非对称凭证多租户）移植到 **AI 桌面 agent** 场景，并叠加两类业界少见的约束解：① relay 零明文（E2E 加密把中继从信任边界降级为管道——多数中继方案的中继可见明文）；② 能力协商运行时化（单 UI 同时面对能力面完全不同的两类被控端——无头端与桌面被控面——caps 九面门控让 UI 代码零分支）。代价是双份能力常量（CAPABILITIES/DESKTOP_CAPABILITIES）与三上报点的一致性维护，已由协议包单源收编（RC-T1）兜底。

## 5. 改进空间

1. **queryKey 主机维度化**：当前隔离靠切换时 `queryClient.clear()` 全清（spec §2.4 自认 P1 简化口径）——切换后全部重新拉取、无「回切秒开」。可把 activeHost 归一为 queryKey 前缀（或利用 react-query 的 query scope 机制），缓存按主机自然隔离，切换保留各自缓存；顺带消灭同主机幂等切换仍需回填 caps 的重复请求。改动集中在 `switch-host.ts` + 各 api 的 queryKey 构造（约十处机械替换）。
2. **多主机并发会话**（HD spec 遗留）：activeHost 全局单值意味着同时只能操作一台主机；可在 store 层引入 per-host 会话视图（chat 面板绑定 connId 而非全局 activeHost），对齐「多 headless 会话共享工作区」的既有协作纪律。改动面大（api 路由层签名需带显式 host 参数、缓存与流式订阅联动），宜分批：先消息查看后发送、后审批/操作。
3. **caps 变更事件化**：caps 只在切换时回填一次，被控端能力热变化（server 升级新增 graph/重启换 instanceId）要重连才可见；可在 register/info 差异检测时经注册表推 caps 更新事件（复用 server.connected 同通道语义），HostSwitcher/store 消费刷新——对齐 K8s watch 的「事实变化即推送」而非「查询时点快照」。
4. **E2E 会话密钥前向保密增强**：现会话密钥连接生命周期恒定；可引入密钥演进（每 N 帧或每分钟 HKDF ratchet 派生下一把，接收端同步窗口宽限），把单帧密文泄露的影响窗从「整连接」收敛到「窗口内」——Signal 双棘轮的最小子集。改动集中在 `e2e-crypto.ts` `E2ESession`（seal/open 内部维护代际）+ 双端同步窗口，wire 契约不变（信封形态不动）。
5. **TOFU 指纹核对的 UI 显式化**：指纹目前 TOFU 首连自动回填，之后仅 mitm 时报警（红色徽标）；可在连接详情卡常显当前指纹（`ConnectionConfig.fingerprint` 字段已有），并提供「核对后确认」动作（显式 pin + 确认时间戳），对齐 Signal safety number 的人工核对仪式——把「静默信任首连」升级为「可审计的信任决策」。
6. **relay 多副本/水平扩展**：RelayRegistry 是单进程内存态（配对/租户计数/CRL stub），单点且重启丢配对（被控端重注册自愈、client 侧重连，但 admin 在线视图断档）；多副本需 sticky（同 connectionId 的 server/client 同副本）或注册表外置（Redis）+ internal 端点鉴权改造。Dockerfile.relay 已零业务代码具备多副本部署基础，缺的是状态外置方案——短期可先做 relay 无状态化评估（CRL 已是 stub 控制平面，配对表外置是主要工程量）。
7. **DirectTransport 与 server-face 的传输安全强化**：直连模式鉴权是静态 Bearer token，明文 HTTP 时 token 即凭证且业务面明文；局域网外直连应要求 HTTPS——可加自签证书 + 指纹钉扎（复用 E2E 指纹基础设施与 UI 警示先例），至少先在 UI 对 `http://` 非局域网地址给警示徽标（relay 链路已有 plaintext 警示徽标可直接复用视觉语言）。
8. **编排遥控的实时性**：GraphPanel/AutomationPanel 走请求-响应式轮询；`graphRunNode` 节点级执行详情表已存在（`ensureGraphRunNodeTable`），可透出为 face 事件流（先例：message.chunk/graph.run.updated），图运行监控页实时滚动、减少轮询空转——协议面只需增一种 ServerEvent 载荷（增量兼容）。
9. **无头端 capabilities 的版本协商**：capabilities 是布尔清单无版本号，控制端遇未知能力名静默忽略（数组 includes 判定），新语义依赖隐式兼容；可在 `/info` 增 `protocolVersion` 字段（协议包常量，`RemoteInstanceInfo` 加可选列），控制端对过低版本给「建议升级」提示而非静默降级——避免「能力在但语义老」的隐性行为分叉。
