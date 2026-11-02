# relay 双场景（自托管 + 多租户公共中继）设计

- 日期：2026-11-03
- 状态：已与用户逐节对齐（关键决策记录见 §2）
- 前置讨论：relay 是否拆独立服务的三轮架构评估（结论：拓扑与归属均不触发拆分；本次双场景需求正式确立多租户演进，beta 阶段仍不拆仓，见 §2 决策 D6）

## 1. 背景与目标

relay 现为 `apps/tianshu-server/src/relay/` 内 412 行零依赖转发面（`relay-main.ts` + `registry.ts`，运行时仅依赖 `ws`），单租户单 token 鉴权，经 `start:relay` 独立进程部署。本设计使其同时支撑两种场景：

- **场景 1（自托管）**：用户自部署 tianshu-server 生态，自带一个 relay 供私用。形态与现状一致，**零行为变化**
- **场景 2（公共中继 SaaS）**：运营方部署一个共享 relay，多租户的 tianshu-server 被控端与天枢桌面端（server-face）接入，控制端（mobile / 桌面 UI 主机页）经其遥控；后续演进为订阅收费

**MVP 商业形态：邀请制 beta**——控制平面无自助注册、无支付；运营方手动建租户、发 AK。收费与支付为 v2（§12）。

**非目标**：relay 水平扩展/高可用集群（单实例 + 客户端重连）、按流量计量计费、管理面前端页面（Swagger 即操作台）、stdio MCP 类无关面。

## 2. 决策记录

| # | 决策 | 备选（被否原因） |
|---|---|---|
| D1 | 租户隔离：**共享多租户单实例**（relay 内长出租户校验） | 专享实例/容器（用户选择共享；边际成本最低、规模化最顺） |
| D2 | MVP：**邀请制 beta** | 注册+手动订阅 / 含在线支付（收费后置 v2） |
| D3 | 控制平面：**完整形态**（NestJS + Prisma + API） | JSON 文件 + 极简 CLI（用户否决，要完整形态） |
| D4 | 签名：**EdDSA（Ed25519）非对称** | HS256 对称（用户否决；relay 被打穿也无法伪造凭证） |
| D5 | 凭证：**AK（长效、可临时吊销）换 access（30 天）**，用户提出并采纳 | 短 TTL 高频续期（控制平面停机敏感，用户否决）；refresh token rotation（有 rotation race 人工介入点，被 AK 模型取代） |
| D6 | relay 代码**留在 tianshu-server 仓原地演进** | 拆独立仓（用户确认 beta 不做结构手术；v2 收费前再拆） |
| D7 | 长期停机语义对齐业界主流：**存量连接与未过期重连永不依赖控制平面**；吊销走状态化双路径 | —（§5.4） |

## 3. 总体架构

```
场景 1（自托管）                        场景 2（公共中继）
被控端 ──┐                             各租户被控端 ──┐
        ├─ relay-main --token <t>                     ├─ relay-main --auth-pubkey <k>
控制端 ──┘  （static 单租户，现状）      各租户控制端 ──┘  （EdDSA 验签多租户）
                                          │ 内部端点（Bearer internal secret）
                                      运营方：relay-admin（NestJS 独立入口 + 独立库）
                                        - 用户/AK 管理、access 签发、吊销、在线视图
                                        - kick 推送 + CRL 名单拉取（§5.4）
```

- **relay 本体**（`src/relay/` 原地演进）：配对转发核心不动；鉴权策略可插拔；新增三个租户校验点与两个内部端点
- **控制平面**（`src/relay-admin/` 新目录，独立 Nest 入口 `dist/src/relay-admin/main.js`）：运营方服务，部署于运营方机器，**独立 Prisma schema 与库文件**——运营数据与被控端业务数据为不同角色域，物理隔离
- **protocol 包**：`AuthFrame.token` 字段承载 access JWT，**零结构改动**；仅追加 close code 常量（§8）

## 4. relay 本体改造

### 4.1 鉴权策略可插拔

`RelayOptions` 增加 `authMode: "static" | "jwt"`：

- `--token <t>` → static（现状路径，行为逐字节不变）
- `--auth-pubkey <pem>` → jwt（Ed25519 公钥验签，支持 `kid` 多密钥共存，MVP 单密钥）
- 两模式互斥；均缺失时拒绝启动（保持现状）。static 模式下 §4.2 三校验点全部旁路

### 4.2 三个租户校验点（全部落在连接管理/registry，转发路径不碰）

1. **注册防顶号**：`registerServer` 记录 `connectionId → tenantId`（验签 claims 的 `tid`）；异租户注册已占用 id → `close(4006, "id-conflict")`。instanceId 为 UUID 高熵不可猜，离线抢注不可行，内存 Map 足够（relay 重启清空亦无攻击面）
2. **attach 配对授权**：client 验签得 `tid`，open 帧目标 server 的租户不等 → `close(4007, "tenant-forbidden")`
3. **配额**：claims 带 `quota {maxServers, maxClients}`，relay 按租户内存计数在线连接（断开释放），超限 → `close(4005, "quota-exceeded")`

### 4.3 内部端点（Bearer internal secret，`--internal-secret <s>` 配置）

- `POST /internal/kick`：按 `tenantId` / `ak` 踢在线连接（吊销即时路径）
- `GET /internal/stats`：在线连接按租户聚合（控制平面在线视图数据源）

### 4.4 CRL 拉取（吊销补偿路径）

relay 每 30–60s 从控制平面 `GET /relay-admin/revocations`（internal secret）拉增量吊销名单（`{epoch, revokedAk: [], revokedTenant: []}`）；首帧 auth 验签通过后与本地名单比对，命中即拒。拉取失败 **fail-static**（维持现有名单）为缺省；可配 **fail-close**（连续 N 次失败后拒绝**新**连接，不拆存量）。

## 5. 凭证体系（AK + access JWT）

### 5.1 分层

```
接入方配置面（akId + akSecret，默认 1 年有效）
   └─ 出示于控制平面 POST /relay-admin/token（Basic auth）
        └─ 换取 access JWT（30 天 TTL，Ed25519 签发）
             └─ 首帧 auth 出示于 relay（离线验签）
```

### 5.2 AK 模型

- **成对**：`akId`（公开标识，可展示/索引）+ `akSecret`（32B 随机 hex）；库内只存 `sha256(akSecret)`，创建/重置时明文仅显示一次（GitHub PAT 惯例）
- **role 分离**：一个租户至少两对 AK——server AK 只能换 server role 的 access，client AK 只能换 client role 的（泄露面隔离、吊销粒度到角色）；AK 数量不限（如多台被控端各持一对）
- **状态机**：`active` / `disabled`（临时吊销，可恢复）/ `expired`（`expireAt` 到期；运营方可续期）。有效期默认 1 年
- **换 token 协议**：HTTPS bearer（Basic：akId 作用户名、akSecret 作密码）——与 GitHub PAT / npm token 同级；HMAC 请求签名为 v2 加固，MVP 不做

### 5.3 access JWT

claims：`{iss, sub: userId, tid: tenantId, role: "server"|"client", ak: akId, quota: {maxServers, maxClients}, iat, exp, jti, kid}`。

**TTL 语义（协议契约注记）**：TTL 到期只拦**新连接/重连**（首帧 auth 验签失败 4001），**永不拆存量连接**——relay 鉴权为连接建立时一次性，与现状语义一致。

### 5.4 续期与吊销

- **续期循环**（四端）：access 剩余 TTL < 50% 时拿 AK 换新 access；AK 被禁/到期 → 401 → 断开 relay 并告警。续期失败仅退避重试，不触碰连接
- **吊销双路径**：即时——控制平面禁用 AK/租户时同步调 `/internal/kick` 拆存量；补偿——CRL 名单持续拦截该 ak/租户的 access 新连接（覆盖 kick 丢失：relay 重启、网络分区）
- **停机语义（D7，业界主流对齐：Tailscale DERP / X.509+CRL / ngrok）**：

| 场景 | 结果 |
|---|---|
| 控制平面停机任意时长 | 存量连接正常；access 未过期的重连正常（relay 离线验签）；access 已过期的重连在控制平面恢复后自动续上（退避重试） |
| 被控端离线 < AK 有效期 | 自动恢复，零人工 |
| 人工介入点（唯一） | AK 到期不再续 / 被禁用不恢复——租户/接入方重新领 AK |
| 禁用 AK | renew 即拒 + kick 拆存量 + CRL 名单拦新连接 |

## 6. 控制平面 relay-admin

- **位置**：`apps/tianshu-server/src/relay-admin/`，NestJS 独立入口；复用脚手架（JWT+Basic 管理 of 鉴权、统一响应包装、HttpExceptionFilter、`/actuator/*`、Swagger `/api-docs` 即 beta 操作台）。seed 单管理员（脚手架 prisma:seed 模式）
- **数据**：独立 schema `prisma/relay-admin/schema.prisma` + 独立 sqlite 文件（PG 变体随脚手架 derive 机制）；与被控端业务库物理隔离
  - `ra_user`：userId、tenantId、name、plan、status、审计字段（plan 决定 quota 缺省值；beta 单档如 `maxServers=5, maxClients=10`，签发时写入 access claims）
  - `ra_access_key`：akId、secretHash、role、userId、status、expireAt、审计字段
  - `ra_audit_log`：管理操作审计（建户/发 AK/禁用/续期；renew 高频不记）
- **API**（管理面，管理员鉴权）：
  - `POST/GET /relay-admin/users`（建租户/列表）
  - `POST /relay-admin/aks`（为用户签发 AK，返回一次性明文）、`POST /relay-admin/aks/:akId/disable|enable`、`POST /relay-admin/aks/:akId/rotate-secret`、续期 expireAt
  - `GET /relay-admin/stats/online`（聚合 relay `/internal/stats`）
- **relay 侧端点（internal secret 鉴权）**：`GET /relay-admin/revocations`——CRL 吊销名单（epoch 增量；§4.4 relay 拉取）
- **换 token 端点（接入方用，Basic AK 鉴权）**：`POST /relay-admin/token` → 校验 AK（status/expireAt/sha256）→ 签发 access JWT

## 7. 四端影响

| 端 | 改动 |
|---|---|
| tianshu-server `relay-client` | 凭证配置改 akId+akSecret；续期循环（§5.4）；AK 失效断开+日志告警 |
| mirror `server-face` | 同上（option 表凭证字段 +1） |
| mobile `relay-transport` | 连接前查本地 access exp：剩 <50% 顺手 renew（失败不阻连，旧 token 仍有效）；401 时连接页提示重贴 AK |
| 桌面 UI 主机页 | 同 mobile（连接配置面 +1 字段） |

- `shouldRenew(claims, now)`、`parseExp` 等续期纯函数下沉 `packages/tianshu-core` 四端复用
- 实现期验证点（跨段终验清单）：JWT 长度在各端配置存储/ws 帧无约束冲突；4005/4006/4007 错码在各端 close 处理分支的存在性与接线

## 8. 协议影响（packages/tianshu-protocol）

- `AuthFrame.token` 字段承载 access JWT——结构零改动
- 新增 close code 常量：`4005 quota-exceeded` / `4006 id-conflict` / `4007 tenant-forbidden`（纯常量追加，无破坏性）

## 9. 部署

- **场景 1**：`relay-main --token <t>`——README-relay 语义不变
- **场景 2**：`relay-main --auth-pubkey <k> --internal-secret <s> --port <p>`（反代终止 TLS，或 `--cert/--key` 原生 wss）；控制平面独立部署（运营方域名，HTTPS）
- **relay 部署产物独立**：Dockerfile 增 relay target，只拷 relay 本体 + `ws`——公共 relay 服务器不落任何业务代码（既有结论，本场景下更必要）
- 密钥物料：Ed25519 私钥（控制平面持有，落运营方机器 dataDir、权限受限）；公钥导出配给 relay；internal secret 运营方双机各持

## 10. 安全与风险

- **实现前必查**：`packages/tianshu-core/src/e2e-crypto.ts` 握手是否绑定被控端身份凭证。若未绑定，4006 顶号防护是唯一跨租户身份防线（本设计已为硬校验）；v2 应给握手加实例密钥绑定
- AK secret 库内 hash 存储、明文仅显示一次；泄露处置 = rotate-secret / disable
- internal secret 与 Ed25519 密钥分域：前者保护控制信道（kick/stats/CRL），后者保护凭证签发；互不复用
- fail-static 下最坏吊销延迟：kick 丢失 + 控制平面停机期间被吊销 access 仍可新建连接（名单停更）；控制平面恢复即收敛。收紧选项 fail-close（§4.4）
- **合规（运营风险项）**：对公众提供收费网络中继服务涉及备案/增值电信许可；beta 邀请制免费阶段风险低，**收费上线前须评估**
- quota 仅即时内存计数（限并发），无用量持久化计量——v2 收费需要时再加

## 11. 测试策略

- **relay 单测**：EdDSA 验签适配器（有效/过期/错签/claims 缺失/kid 不匹配）；三校验点（4006 异租户顶号、4007 越权 attach、4005 配额边界与断开释放）；static 模式全回归（现状零漂移）；CRL 名单命中与 fail-static/fail-close 行为
- **relay-admin 测试**：AK 生命周期（签发→换 token→禁用→401→恢复→续期→过期）；吊销触发 kick 调用与名单 epoch 递增；audit 落库
- **E2E**（`test:e2e:relayE2E` 扩展）：现有四链路回归（static 模式）+ 多租户新链路——双租户隔离（A-client 连不上 B-server，4007）、异租户抢注（4006）、配额超限（4005）、吊销 kick 拆存量、AK 换 token→连接→续期滚动全链
- **四端终验**（跨段终验清单）：错码存在性/载荷字段接线/状态联合同形三查

## 12. v2 演进点（本期不实现）

支付与订阅状态机、档位自助变更；短 access TTL 窗口收紧 + HMAC 请求签名；密钥轮换（kid 多密钥在线切换）；管理面 Web 前端与自助注册（邀请码表届时引入）；用量持久化计量与配额档位；非对称升级已有（EdDSA 为 MVP）；relay 拆独立仓 `tianshu-relay`（收费上线前的结构手术）；e2e 握手实例密钥绑定；多 relay 实例与 registry 状态外置。
