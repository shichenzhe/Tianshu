# relay 双场景多租户实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** relay 同时支撑自托管（static 单租户，零行为变化）与多租户公共中继（EdDSA 验签 + AK 换 access + 吊销双路径 + relay-admin 控制平面），四端接入 AK 续期。

**Architecture:** relay 本体原地演进（鉴权策略可插拔 + 三租户校验点 + kick/stats 内部端点 + CRL 拉取）；控制平面为 `src/relay-admin/` 独立 Nest 入口 + 独立 Prisma schema；续期纯函数下沉 `packages/tianshu-core`。协议包仅追加常量。

**Tech Stack:** NestJS 11 + Fastify、Prisma 6、node:crypto Ed25519（JWT 手写编解码，零新依赖）、ws、Vitest（mirror 侧）/ Jest（server 侧）。

**Spec:** `docs/superpowers/specs/2026-11-03-relay-multitenant-design.md`（§5.4 停机语义表与 §4.2 三校验点为本计划契约）

## Global Constraints

- relay 本体（`src/relay/relay-main.ts`、`registry.ts`、`auth.ts`、`jwt-eddsa.ts`、`crl.ts`）运行时依赖仅 `ws` + node 内置——**禁止引入任何新 npm 包**（JWT 用 node:crypto 手写，见 Task 2）
- static 模式（`--token`）行为零漂移：现有 relay 单测与 E2E 四链路全绿即回归基线
- `packages/tianshu-protocol` 零结构改动，仅追加常量；`packages/tianshu-core` 新增文件须同步重建 dist（见 Setup）
- server 仓文件遵循 server 仓 `.prettierrc`（**单引号、trailingComma=all**）；mirror 根仓文件双引号无尾逗号——按文件归属仓套用
- relay-admin 复用 `src/commons/`（auth guard、web 拦截器、exception/query 模式），业务错误抛 `BusinessException` + `ErrorCode`
- 跨平台纪律：路径用 `node:path`、无 shell 内联命令、无平台硬编码（Windows 开发机存在）
- **执行环境（worktree）Setup，首个任务开始前一次性完成**：
  1. `ln -s <主树>/node_modules <worktree>/node_modules`（已存在则跳过；下同）
  2. `ln -s <主树>/apps/tianshu-server/node_modules <worktree>/apps/tianshu-server/node_modules`
  3. packages 变更后：worktree 内 `npm --prefix packages/tianshu-protocol run build`（core 同理），并 `cp -R packages/tianshu-protocol/dist <主树>/packages/tianshu-protocol/`（防主树 dist 滞后，memory 已知坑）
  4. server jest 出现 TS paths 型解析失败（symlink 目录级不跟随，memory 已知坑）：该 suite 记录跳过、不阻塞任务推进，Task 19 收尾统一在主树复跑补验
- 遇 spec 未覆盖的决策：采用业界成熟方案并在 commit message 注明，不阻塞等待确认

---

### Task 1: protocol close code 常量

**Files:**
- Modify: `packages/tianshu-protocol/src/relay-frames.ts`
- Test: `packages/tianshu-protocol/src/relay-frames.test.ts`（若无测试文件则 Create）

**Interfaces:**
- Produces: `export const RELAY_CLOSE_CODES = { QUOTA_EXCEEDED: 4005, ID_CONFLICT: 4006, TENANT_FORBIDDEN: 4007 } as const;`（后续任务经 `@tianshu/protocol` 引用）

- [ ] **Step 1: 写失败测试**——断言三个常量值分别为 4005/4006/4007
- [ ] **Step 2: 跑测试确认失败**（vitest 常规集或 tsc）
- [ ] **Step 3: 在 relay-frames.ts 追加常量**（带注释：多租户三校验点语义，见 spec §4.2）
- [ ] **Step 4: 测试通过**
- [ ] **Step 5: 构建并同步 dist**（Global Constraints Setup 第 3 条）后 commit `feat(protocol): relay 多租户 close code 常量 4005/4006/4007`

### Task 2: jwt-eddsa 签发/验签模块（relay 与 relay-admin 共用）

**Files:**
- Create: `apps/tianshu-server/src/relay/jwt-eddsa.ts`
- Test: `apps/tianshu-server/test/relay/jwt-eddsa.spec.ts`

**Interfaces:**
- Produces（后续任务全部依赖此签名）：

```ts
export interface AccessQuota { maxServers: number; maxClients: number; }
export interface AccessClaims {
  iss: "tianshu-relay"; sub: string; tid: string;
  role: "server" | "client"; ak: string; quota: AccessQuota;
  iat: number; exp: number; jti: string; kid?: string;
}
export function signAccessJwt(claims: AccessClaims, privateKeyPem: string): string;
export function verifyAccessJwt(token: string, publicKeyPem: string): AccessClaims | null; // 过期/错签/结构坏 → null
export function generateEd25519KeyPems(): { publicKeyPem: string; privateKeyPem: string };
```

- [ ] **Step 1: 写失败测试**：往返签发→验签还原 claims；错公钥验签 null；`exp` 已过 null；篡改 payload null；b64url 无 `+/=` 字符
- [ ] **Step 2: 跑 `npx jest test/relay/jwt-eddsa.spec.ts`（server 仓）确认失败**
- [ ] **Step 3: 实现**：`generateKeyPairSync("ed25519")` 导出 PEM；JWT 三段式——`Buffer.from(JSON.stringify(header)).toString("base64url")`（node 原生 base64url），签名为 `crypto.sign(null, Buffer.from(`${h}.${p}`), privateKey)`，验签 `crypto.verify(null, data, publicKey, sig)`。header `{alg:"EdDSA",typ:"JWT",kid?}`；verify 内含 `exp > Date.now()/1000` 检查与 `iss === "tianshu-relay"` 检查
- [ ] **Step 4: 测试通过；commit** `feat(relay): EdDSA access JWT 签发/验签模块（node:crypto 零依赖）`

### Task 3: relay 鉴权策略可插拔（Authenticator 抽象 + static/jwt 双实现）

**Files:**
- Create: `apps/tianshu-server/src/relay/auth.ts`
- Modify: `apps/tianshu-server/src/relay/relay-main.ts`（`admitConnection` 分流）
- Test: `apps/tianshu-server/test/relay/auth.spec.ts`

**Interfaces:**
- Consumes: Task 2 `verifyAccessJwt`/`AccessClaims`；Task 1 `RELAY_CLOSE_CODES`
- Produces:

```ts
export type AuthDecision =
  | { ok: true; role: "server" | "client"; tenantId?: string; quota?: AccessQuota; ak?: string }
  | { ok: false; closeCode: number; reason: string };
export interface Authenticator {
  admit(p: { token: string; role: unknown; connectionId: string }): AuthDecision;
}
export function createStaticAuthenticator(token: string): Authenticator;
export function createJwtAuthenticator(
  publicKeyPem: string,
  isRevoked: (t: { tid?: string; ak?: string }) => boolean,
): Authenticator;
```

- [ ] **Step 1: 失败测试**：static——正确 token + role=server → ok（无 tenantId/quota）；错 token → `{ok:false, closeCode:4001}`；非法 role → 4000。jwt——签合法 token → ok 且带 `tenantId/role/quota/ak`；过期 → 4001；`isRevoked` 命中 tid/ak → 4001；畸形 token → 4001
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**：static 实现 = 现有 `admitConnection` 校验逻辑平移；jwt 实现 = `verifyAccessJwt` + `isRevoked` 检查 + role 校验。`relay-main.ts` 的 `RelayOptions` 增 `authMode?: "static" | "jwt"`、`authPubkeyFile?: string`、`internalSecret?: string`；CLI 解析增 `--auth-pubkey`、`--internal-secret`；`startRelay` 构造对应 Authenticator，`admitConnection` 改为消费 `AuthDecision`（static 路径行为与现状逐字节一致——diff 审视）
- [ ] **Step 4: 新测试过 + 现有 `test/relay/` 全部单测过（static 回归）**
- [ ] **Step 5: commit** `feat(relay): 鉴权策略可插拔——static 现状平移 + jwt 验签通道`

### Task 4: registry 三校验点（顶号/attach 授权/配额）

**Files:**
- Modify: `apps/tianshu-server/src/relay/registry.ts`
- Modify: `apps/tianshu-server/src/relay/relay-main.ts`（接线）
- Test: `apps/tianshu-server/test/relay/registry.spec.ts`（扩展）

**Interfaces:**
- Consumes: Task 3 `AuthDecision`（relay-main 持有 tenantId/quota）
- Produces（签名变更，三处）：

```ts
registerServer(connectionId: string, ws: PeerSocket, tenantId?: string): "ok" | "id-conflict";
attachClient(connectionId: string, ws: PeerSocket, callerTenantId?: string): "ok" | "not-found" | "forbidden";
tenantConnCount(tenantId: string, role: "server" | "client"): number;
```

- [ ] **Step 1: 失败测试**：异租户注册已占 id → `"id-conflict"`（relay-main 映射 close 4006）；同租户重注册 → `"ok"` 且顶掉旧连接（现状行为保留）；`attachClient` 异租户 → `"forbidden"`（4007）、不存在 → `"not-found"`（现状 4004）；计数——2 个 server 连接后 `tenantConnCount(tid,"server")===2`，close 后回落；`tenantId === undefined`（static 模式）时三校验全旁路（返回 ok/原语义）
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**：registry 增 `serverTenants: Map<connectionId, string|undefined>` 与 `tenantCounts: Map<string, {servers:number; clients:number}>`（register/attach 时增、drop/forget/close 时减）；relay-main 的 `handleServerSocket`/`handleClientSocket` 消费新返回值并 close 对应码（4005/4006/4007 用 `RELAY_CLOSE_CODES`）；quota 检查在 `admitConnection` 成功后、注册前：`tenantConnCount(tid, role) >= quota.maxServers|maxClients` → close 4005
- [ ] **Step 4: 全部 relay 单测过**
- [ ] **Step 5: commit** `feat(relay): registry 三租户校验点——顶号 4006/attach 授权 4007/配额 4005`

### Task 5: relay 内部端点 /internal/kick + /internal/stats

**Files:**
- Modify: `apps/tianshu-server/src/relay/relay-main.ts`（requestListener 扩展）
- Test: `apps/tianshu-server/test/relay/internal-endpoints.spec.ts`

**Interfaces:**
- Consumes: registry 的连接簿记
- Produces:
  - `POST /internal/kick`（`Authorization: Bearer <internalSecret>`，body `{tenantId?: string; ak?: string}`）→ 拆匹配的在线连接（terminate），响应 `{kicked: number}`
  - `GET /internal/stats`（同鉴权）→ `{tenants: [{tenantId, servers, clients}]}`（仅 jwt 模式有租户维度）
  - 无 `--internal-secret` 时两端点 404（不暴露）

- [ ] **Step 1: 失败测试**：无 secret 配置端点 404；错 Bearer 401；kick tenantId 拆对应 server/client 连接（假 socket 断言 terminate/close 调用）；stats 聚合计数正确
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**：requestListener 内先于 404 匹配 `/internal/*`；kick 需要 registry 提供 `kickTenant(tenantId|ak, sendClose)`——registry 增方法（按 serverTenants/clients 反查）
- [ ] **Step 4: 测试过**
- [ ] **Step 5: commit** `feat(relay): 内部端点 kick/stats（internal secret 鉴权）`

### Task 6: relay CRL 吊销名单拉取

**Files:**
- Create: `apps/tianshu-server/src/relay/crl.ts`
- Modify: `apps/tianshu-server/src/relay/relay-main.ts`（启动接线：jwt 模式时创建并注入 Authenticator 的 isRevoked；close 时 stop）
- Test: `apps/tianshu-server/test/relay/crl.spec.ts`

**Interfaces:**
- Produces:

```ts
export interface CrlStore {
  isRevoked(t: { tid?: string; ak?: string }): boolean;
  start(): void; stop(): void;
}
export function createCrlStore(opts: {
  adminUrl: string; internalSecret: string;
  intervalMs?: number;            // 缺省 45_000
  failCloseAfter?: number;        // 缺省 0=fail-static；>0 为连续失败阈值，触发后 isNewConnDenied=true
  isNewConnDenied(): boolean;     // fail-close 触发态查询（relay-main 拒新连接用）
}): CrlStore;
```

- [ ] **Step 1: 失败测试**：起 stub http server 返回 `{epoch:1, revokedAk:["ak1"], revokedTenant:["t9"]}` → `isRevoked({ak:"ak1"})`/`isRevoked({tid:"t9"})` true、未命中 false；stub 停掉（拉取失败）→ 名单维持（fail-static）；`failCloseAfter:2` 时连续 2 败后 `isNewConnDenied()===true`，名单仍维持
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**：`setInterval` + 全局 `fetch`（node 18+）`GET {adminUrl}/relay-admin/revocations`；`unref()`；fail-close 只拒新连接不拆存量（契约 spec §5.3/§5.4）
- [ ] **Step 4: 测试过；jwt 模式 E2E 冒烟（Task 18 补全链）**
- [ ] **Step 5: commit** `feat(relay): CRL 吊销名单拉取——fail-static 缺省/可配 fail-close`

### Task 7: core 续期纯函数

**Files:**
- Create: `packages/tianshu-core/src/relay-credential.ts`
- Modify: `packages/tianshu-core/src/index.ts`（导出）
- Test: `packages/tianshu-core/src/relay-credential.test.ts`

**Interfaces:**
- Produces（四端接入任务依赖）：

```ts
/** 剩余寿命 < 半个 maxAge 即应续期（spec §5.4：剩 <50% 触发） */
export function shouldRenew(expiresAtMs: number, maxAgeSec: number, nowMs: number): boolean;
```

- [ ] **Step 1: 失败测试**：刚签发（剩 100%）→ false；剩 49% → true；剩 51% → false；已过期 → true
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现（一行表达式）+ index.ts 导出**
- [ ] **Step 4: 测试过；构建 core dist 并同步主树（Setup 第 3 条）**
- [ ] **Step 5: commit** `feat(core): shouldRenew 续期判断纯函数（四端共享）`

### Task 8: relay-admin Prisma schema + client + seed

**Files:**
- Create: `apps/tianshu-server/prisma/relay-admin/schema.prisma`
- Create: `apps/tianshu-server/src/relay-admin/prisma.service.ts`
- Create: `apps/tianshu-server/prisma/relay-admin/seed.ts`
- Modify: `apps/tianshu-server/package.json`（scripts：`prisma:generate:ra`、`prisma:push:ra`、`prisma:seed:ra`）

**Interfaces:**
- Produces: `RaUser{ id, tenantId(unique), name, plan("beta"), status("active"), creator?, updator?, createdAt, updatedAt }`；`RaAccessKey{ id(=akId), secretHash, role("server"|"client"), userId, status("active"|"disabled"), expireAt, creator?, createdAt, updatedAt }`；`RaAuditLog{ id, action, operator, target, detail?, createdAt }`
- datasource sqlite，`url = env("RA_DATABASE_URL")`（缺省 `file:./data/relay-admin.db` 由 service 层兜底设 env）；output `../../src/relay-admin/generated/prisma`
- seed：无 admin 用户时创建（用户名 `admin`，密码 bcrypt 随机打印一次）

- [ ] **Step 1: 写 schema（model 上沿 StandardEntity 审计字段惯例；relay-admin 独立表前缀 `ra_`，不与业务 schema 任何表共用）**
- [ ] **Step 2: `npm run prisma:generate:ra` 生成 client；`prisma:push:ra`（`prisma db push --schema prisma/relay-admin/schema.prisma`，新库无迁移历史，业界起步惯例）建库成功**
- [ ] **Step 3: prisma.service.ts——`RaPrismaService extends PrismaClient`（onModuleInit connect；读 env `RA_DATABASE_URL`）；seed 跑通**
- [ ] **Step 4: 验证：seed 后 sqlite 三表存在、admin 行存在**
- [ ] **Step 5: commit** `feat(relay-admin): 独立 Prisma schema/client/seed——ra_user/ra_access_key/ra_audit_log`

### Task 9: relay-admin Nest 骨架 + 管理员鉴权

**Files:**
- Create: `apps/tianshu-server/src/relay-admin/main.ts`、`app.module.ts`、`auth/`（复用 `src/commons/auth/` 的 JwtAuthGuard/JwtAuthService 装配）
- Test: `apps/tianshu-server/test/relay-admin/bootstrap.spec.ts`

**Interfaces:**
- Consumes: Task 8 `RaPrismaService`；`src/commons/auth`、`src/commons/web`（ResponseInterceptor/HttpExceptionFilter）、`src/commons/log`
- Produces: 独立入口 `dist/src/relay-admin/main.js`（Fastify 监听 `RA_PORT` 缺省 8412）；全局管道/拦截器/过滤器与主应用同构；`/actuator/health`；`POST /relay-admin/auth/login`（username/password → JWT，复用 commons JwtAuthService）；其余路由默认 JwtAuthGuard；scripts 增 `start:relay-admin`

- [ ] **Step 1: 失败测试**：Test 模块起 app——未带 JWT 访问受保护探针路由 401；login 换 token 后访问 200 且响应 `{code,message,data}` 包装；health 200**
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现骨架（模块注册 PrismaService/ConfigModule/ commons 拦截器；`nest build` 后 `node dist/src/relay-admin/main.js` 启动冒烟）**
- [ ] **Step 4: 测试过 + 启动冒烟过**
- [ ] **Step 5: commit** `feat(relay-admin): Nest 独立入口骨架——管理员 JWT 鉴权/统一包装/health`

### Task 10: users API + audit 基础设施

**Files:**
- Create: `apps/tianshu-server/src/relay-admin/users/`（controller/service/dto）
- Create: `apps/tianshu-server/src/relay-admin/audit/audit.service.ts`
- Test: `apps/tianshu-server/test/relay-admin/users.spec.ts`

**Interfaces:**
- Produces:
  - `POST /relay-admin/users` `{name, plan?}` → `{userId, tenantId}`（tenantId = `randomUUID()`）
  - `GET /relay-admin/users` → 列表（`@Roles(admin)` 可见全量）
  - `POST /relay-admin/users/:userId/disable|enable`（disable 时同步把该用户 AK 全部置 disabled——吊销联动在 Task 13 完成闭环）
  - `AuditService.log(action, operator, target, detail?)`——写 `ra_audit_log`（所有管理写操作调用）

- [ ] **Step 1: 失败测试**：建用户返回 userId/tenantId 且落库；重复 name 不限（tenantId 唯一即可）；disable 后 `ra_access_key.status` 级联 disabled、audit 两行（user.disable + ak 级联）；未鉴权 401**
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现（BusinessException/ErrorCode 风格、DTO class-validator）**
- [ ] **Step 4: 测试过**
- [ ] **Step 5: commit** `feat(relay-admin): 用户管理与 audit 落库`

### Task 11: AK 管理服务与 API

**Files:**
- Create: `apps/tianshu-server/src/relay-admin/aks/`（controller/service/dto）
- Test: `apps/tianshu-server/test/relay-admin/aks.spec.ts`

**Interfaces:**
- Produces:
  - `POST /relay-admin/aks` `{userId, role, expireAt?}` → `{akId, akSecret}`（akId=`randomUUID()`；akSecret=`randomBytes(32).toString("hex")`；库存 `sha256(akSecret)`；expireAt 缺省 now+365d；**明文仅本次响应返回**）
  - `POST /relay-admin/aks/:akId/disable|enable`、`/rotate-secret`（发新 secret、旧 hash 替换）、`/extend` `{expireAt}`
  - `GET /relay-admin/aks?userId=`
  - `AksService.isAkUsable(akId, secretPlain): Promise<{ok:true, userId, role, quota} | {ok:false, reason:"not-found"|"disabled"|"expired"|"bad-secret"}>`（Task 12 token 端点消费；quota 自 user.plan 查 `PLAN_QUOTA` 映射：beta → `{maxServers:5, maxClients:10}`）

- [ ] **Step 1: 失败测试**：签发→库中 secretHash===sha256(明文)；`isAkUsable` 四种失败 reason 各覆盖 + 成功路径返回 quota；disable→isAkUsable disabled；rotate 后旧 secret bad-secret、新 secret ok；过期 AK expired**
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 测试过**
- [ ] **Step 5: commit** `feat(relay-admin): AK 生命周期管理——签发/禁用/轮换/续期（secret hash 存储）`

### Task 12: token 换发端点 + revocations 名单端点

**Files:**
- Create: `apps/tianshu-server/src/relay-admin/token/`（controller/service）
- Create: `apps/tianshu-server/src/relay-admin/revocations/`（controller）
- Create: `apps/tianshu-server/src/relay-admin/keys/keypair.service.ts`
- Test: `apps/tianshu-server/test/relay-admin/token.spec.ts`

**Interfaces:**
- Consumes: Task 11 `isAkUsable`；Task 2 `signAccessJwt`/`generateEd25519KeyPems`；Task 6 的 CRL 响应契约
- Produces:
  - `KeypairService.getPrivateKeyPem()`——首启生成 Ed25519 对，落 `RA_DATA_DIR/keys/relay-access.pem`（0600），此后加载；`getPublicKeyPem()` 供导出
  - `POST /relay-admin/token`（`Authorization: Basic base64(akId:akSecret)`，**不走管理员 JWT**）→ 成功 `{accessToken, expiresAt(ms), maxAgeSec:2592000}`（30d）；失败 401 `{reason}`；不做审计（高频）
  - `GET /relay-admin/revocations`（`Authorization: Bearer <internalSecret>`）→ `{epoch(单调+1), revokedAk: string[], revokedTenant: string[]}`——名单=全部 `status="disabled"` AK + 其所属 `status="disabled"` 用户的 tenantId
  - 配置：`relayAdmin.relayBaseUrl`、`relayAdmin.internalSecret`（config.yml 段 + env `RA_RELAY_BASE_URL`/`RA_INTERNAL_SECRET`）

- [ ] **Step 1: 失败测试**：合法 Basic → token 三段式、`verifyAccessJwt(pubkey)` 还原 claims（tid=用户 tenantId、role=AK role、quota 正确、exp≈30d）；错 secret/禁用/过期 → 401 各 reason；revocations 在禁用一个 AK 后包含其 akId、epoch 递增；internalSecret 错 401**
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（token controller 手写 Basic 解析——`Buffer.from(b64,"base64").toString()` split `:`，不走 passport）
- [ ] **Step 4: 测试过**
- [ ] **Step 5: commit** `feat(relay-admin): AK 换 access 端点 + CRL 名单端点（internal secret）`

### Task 13: 吊销 kick 联动 + 在线视图聚合

**Files:**
- Modify: `apps/tianshu-server/src/relay-admin/aks/aks.service.ts`、`users/`（disable 路径）
- Create: `apps/tianshu-server/src/relay-admin/relay-link.service.ts`
- Test: `apps/tianshu-server/test/relay-admin/relay-link.spec.ts`

**Interfaces:**
- Consumes: Task 5 relay 内部端点契约
- Produces: `RelayLinkService.kick({tenantId?|ak?})`（POST `{relayBaseUrl}/internal/kick` Bearer internalSecret；失败**不回滚禁用**——CRL 补偿兜底，只 warn 日志）；`RelayLinkService.stats()`（GET /internal/stats）；aks disable / user disable / rotate-secret 路径接入 kick；`GET /relay-admin/stats/online`（管理员）→ 透传聚合 stats（加 `fetchedAt`）

- [ ] **Step 1: 失败测试**：stub relay http 端点断言 disable AK → kick 收到 `{ak}`；disable user → kick 收到 `{tenantId}`；stub 500 → disable 仍成功（降级 warn）**
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现（全局 fetch + 超时 3s）**
- [ ] **Step 4: 测试过**
- [ ] **Step 5: commit** `feat(relay-admin): 吊销 kick 即时联动（失败降级 CRL 兜底）+ 在线视图`

### Task 14: tianshu-server relay-client 接入 AK 续期

**Files:**
- Modify: `apps/tianshu-server/src/relay/relay-client.ts`、启动入口 `main.ts`（env 读取处）
- Test: `apps/tianshu-server/test/relay/relay-client-renew.spec.ts`

**Interfaces:**
- Consumes: Task 7 `shouldRenew`（server 经 workspace `@tianshu/core` dist 消费）；Task 12 token 端点
- Produces: env `TIANSHU_RELAY_ADMIN_URL` + `TIANSHU_RELAY_AK_ID` + `TIANSHU_RELAY_AK_SECRET`（与既有 `TIANSHU_RELAY_URL/TOKEN` 同款优先级链 env/CLI）；AK 配置存在时：启动先 `ensureAccess()`（Basic 换 token，存内存 `{token, expiresAt, maxAgeSec}`）；每 10min 定时器查 `shouldRenew` → 换新；401（AK 失效）→ 断开 relay、`[relay-client] AK 凭证失效（disabled/expired），需运营方恢复或换发` 日志 + 停止重连；`TIANSHU_RELAY_TOKEN` 显式存在时 static 模式优先（零漂移）

- [ ] **Step 1: 失败测试**：mock admin http——启动时持 AK → 收到 access 后才连 relay（首帧 auth token=access）；`shouldRenew` 真值时触发换新并更新内存 token；401 → 断开且不再重连；static env 双存在时用 static token**
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现（fetch + 退避重试 30s 起；现有 `relayToken` 变量改经 getter 取当前 access）**
- [ ] **Step 4: 测试过 + 现有 relay-client 相关测试全过（static 回归）**
- [ ] **Step 5: commit** `feat(relay-client): AK 凭证通道——启动换 token/低频续期/失效断开告警`

### Task 15: mirror server-face 接入 AK 续期

**Files:**
- Modify: `electron/domains/server-face/relay-client.ts`、`ipc.ts`（配置面）、`server-face.ts`（ensure 装配）
- Test: `electron/domains/server-face/__tests__/` 下新增（跟随现有测试组织）

**Interfaces:**
- Consumes: `@tianshu/core`（mirror 经 alias 直引源码）；Task 12 token 契约
- Produces: option 表 relay 段新增 `akId`/`akSecret`/`adminUrl` 三字段（与现有 url+token 并存；token 存在则 static 优先零漂移）；ipc 配置读写面透出三字段（脱敏口径与现有 token 一致）；renew 循环同 Task 14 语义（10min 定时 + 401 断开告警进 face 日志）

- [ ] **Step 1: 先读 `server-face/ipc.ts` 现有 option 读写与脱敏模式，写失败测试**：AK 三字段配置后连接使用换发的 access；401 断开；static 优先**
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现（续期逻辑提为 `renewable-credential.ts` 小模块，Task 16/17 复用同构实现——mobile/desktop 无法共享 electron 侧文件，各自实现但语义对齐）**
- [ ] **Step 4: vitest 常规集相关文件过**
- [ ] **Step 5: commit** `feat(server-face): AK 凭证配置面与续期循环`

### Task 16: mobile relay-transport 接入（连接前续期）

**Files:**
- Modify: `apps/tianshu-mobile/src/transport/relay-transport.ts`、`connection.ts`、连接存储（先读 `src/app/(tabs)/connections.tsx` 确认现有连接配置模型）
- Test: `apps/tianshu-mobile/src/transport/relay-transport-renew.test.ts`

**Interfaces:**
- Consumes: `@tianshu/core` `shouldRenew`（workspace dist）；Task 12 token 契约
- Produces: 连接配置类型扩展 `akId?/akSecret?/adminUrl?`（与 `relayToken` 并存，static 优先）；连接前 `ensureFreshAccess`——有 AK 且本地 `expiresAt` 缺失或 `shouldRenew` → fetch 换新（失败且旧 token 未过期 → 照常连；401 → `setState("invalid-token")` 粘滞，连接页提示重贴 AK——复用现有 4001 语义面）

- [ ] **Step 1: 先读 mobile 连接存储与 `setState` 语义，写失败测试**：AK 配置 + access 新鲜 → 直连不请求；`shouldRenew` 真 → 请求后连；换新 401 → invalid-token 态**
- [ ] **Step 2: 确认失败（`npm run test -w apps/tianshu-mobile`）**
- [ ] **Step 3: 实现（fetch RN 全局有；Basic header 手写）**
- [ ] **Step 4: 测试过**
- [ ] **Step 5: commit** `feat(mobile): relay 连接 AK 凭证——连接前续期/失效提示`

### Task 17: 桌面控制端接入（server 域 transport + 主机页）

**Files:**
- Modify: `electron/domains/server/`（Relay Transport——先读该域定位 relay 连接构造点）、`src-react/domains/ai/server/`（连接表单与 store）
- Test: 跟随 server 域现有测试组织新增

**Interfaces:**
- Consumes: 同 Task 16 语义
- Produces: 主机页连接配置增 `akId/akSecret/adminUrl` 三字段（表单 + store + 类型）；控制端 relay 连接构造前 `ensureFreshAccess`（主进程侧实现，语义同 Task 16：剩<50% 顺手换新、失败不阻连、401 报"凭证失效"态）

- [ ] **Step 1: 先读 server 域 RelayTransport 与主机页连接表单现状，写失败测试（连接构造消费换发 access；401 态）**
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现（i18n：新增文案进 zh-CN/en-US 的 ai 命名空间，禁硬编码）**
- [ ] **Step 4: vitest 相关集过 + `npm run typecheck` 过**
- [ ] **Step 5: commit** `feat(server-host): 控制端 relay 连接 AK 凭证支持`

### Task 18: E2E 多租户链路

**Files:**
- Modify: `tests/ai/server/e2e-relay-e2e.ts`（`npm run test:e2e:relayE2E` 唯一 include）

**Interfaces:**
- Consumes: Task 2-6 全部（真 relay 子进程 + 测试内签发）
- Produces: 新增用例组（现有四链路 static 用例不动=回归）：
  1. jwt 模式起 relay（`--auth-pubkey` 测试密钥 + `--internal-secret`）——双租户各自签 access：A-client attach B-server → 期望 close 4007
  2. B-server 注册 A 已占 connectionId → 4006
  3. quota `{maxServers:1}` 第二个 server 连接 → 4005
  4. `POST /internal/kick {tenantId}` → 该租户在线连接被拆、他租户不受影响
  5. CRL：stub admin 返回含某 ak 的名单 → 该 ak 新连接被拒（4001）、存量不断
  6. 长evity 契约：access 过期后**已建存量连接仍在转发**（TTL 永不拆存量——spec §5.3）

- [ ] **Step 1: 按现有 e2e 文件的起 relay 子进程模式（spawn dist 产物）写用例**
- [ ] **Step 2: `npm run test:e2e:relayE2E` 全绿（含存量四链路回归）**
- [ ] **Step 3: commit** `test(e2e): relay 多租户六链路——隔离/顶号/配额/踢线/CRL/存量长寿命`

### Task 19: 部署产物、脚本与文档收尾

**Files:**
- Create: `apps/tianshu-server/Dockerfile.relay`
- Modify: `apps/tianshu-server/package.json`（`start:relay-admin`；relay 镜像构建说明注释）、`README-relay.md`（多租户部署节：密钥物料/公钥导出/internal secret/AK 发放流程/停机语义表）、`CLAUDE.md`（relay-admin 段）、根 `CLAUDE.md`（server 域描述补 relay-admin 一句）

**Interfaces:**
- Produces: `Dockerfile.relay`——`FROM node:22-slim`、仅 `COPY dist/src/relay/*.js` + `node_modules/ws`、`ENTRYPOINT ["node","relay/relay-main.js"]`（业务代码零落地，spec §9）

- [ ] **Step 1: Dockerfile.relay 按上述写；验证 `docker build -f Dockerfile.relay -t tianshu-relay . ` 后 `docker run` 起 relay 冒烟（本机 docker 可用时；不可用则记录跳过，Dockerfile 语法经 hadolint 或人工检视）**
- [ ] **Step 2: README-relay 增「多租户部署（beta）」节—— Ed25519 公钥导出（`GET /relay-admin/keys/public` 或 keypair 落盘路径说明，按 Task 12 实际实现写）、AK 发放操作序列、停机语义表、fail-close 配置**
- [ ] **Step 3: CLAUDE.md 两份补 relay-admin 概述；`npm run sdk:export` 刷新 openapi.json（pretest 的 check-openapi-fresh 需要）**
- [ ] **Step 4: 全量收尾验证**：worktree 内 `npm run test -w apps/tianshu-server`（TS paths 型失败按 Global Constraints 第 4 条记录）、`npm run test`（mirror 常规集）、`npm run test:e2e:relayE2E`、`npm run typecheck`；主树复跑此前跳过的 server suite 并回写结果**
- [ ] **Step 5: commit** `feat(relay): 部署产物与文档收尾——Dockerfile.relay/README/CLAUDE.md` + 最终汇报（各验证命令输出摘要、跳过项清单）

---

## Self-Review 记录

- **Spec 覆盖**：§4.1→T3；§4.2→T4；§4.3→T5；§4.4→T6；§5.1-5.2→T8/T11；§5.3→T2/T12；§5.4→T7/T13/T14；§6→T8-T13；§7→T14-T17；§8→T1；§9→T19；§10 e2e 握手身份绑定验证→T18 Step 2 执行时顺带核验并记录结论（spec 要求实现前必查，落 T18）；§11→各任务测试 + T18。无缺口
- **占位符扫描**：无 TBD/「适当处理」；四端接入的「先读现有模式」为明确查证指令非留白
- **类型一致性**：`AccessClaims`/`AuthDecision`/`Authenticator`/`tenantConnCount`/`shouldRenew`/`isAkUsable` 签名在 T2/T3/T4/T7/T11 定义，T3/T4/T6/T12/T14-17 引用一致
