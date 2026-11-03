# tianshu relay 部署与协议

中继服务：让「被控端 tianshu-server」与「控制端」穿过 NAT/防火墙配对，帧级直转 WebSocket 消息。独立于 Nest 主应用——纯 `node:http` + `ws`，可单进程部署在任意一台公网机器上。双场景：单租户 static token（本节起的大部分内容）与多租户 jwt 验签（公共中继 SaaS，运营方控制平面 relay-admin，见「多租户部署（beta）」）。

```
被控端(role=server) ──┐                     ┌── 控制端(role=client)
  家庭/办公内网机器    ├──> 公网 relay /ws <──┤    任意网络
  (tianshu-server)   ─┘   帧级直转+配对      └───
```

- 实现：`src/relay/relay-main.ts`（HTTP/WS 接入、心跳、CLI，198 行）+ `src/relay/registry.ts`（配对注册表、有界缓冲）
- relay 不解释业务帧内容，只按 `kind`/`connectionId` 做配对与路由；两个被控端/控制端的业务协议与直连时完全一致

## 本地运行

```bash
npm run build
npm run start:relay -- --port 8411 --token "$(openssl rand -hex 16)" --max-buffer-frames 200
# [relay] listening on port 8411
```

CLI 参数（`--k v` 与 `--k=v` 两种形式均可）：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--port` | `8411` | 监听端口；`0` = 随机端口（启动日志回显实际端口） |
| `--token` | 无 | 接入令牌；**缺省拒绝启动**（公网中继必须鉴权） |
| `--max-buffer-frames` | `200` | 每 socket 出向积压帧上限，超限拆连接（背压保护） |
| `--cert` / `--key` | 无 | TLS 证书/私钥 PEM；**成对**传入即 https/wss 监听（原生 TLS 可选通道，见「TLS 部署」），缺省 http |
| `--auth-pubkey` 等 | 无 | 多租户 jwt 模式参数（`--auth-pubkey` / `--internal-secret` / `--crl-admin-url` / `--crl-fail-close`），见「多租户部署（beta）」；`--auth-pubkey` 与 `--token` **互斥**（同传拒绝启动） |

产物路径：`dist/src/relay/relay-main.js`（`nest build` 全量编译，tsc 因 `prisma/seed.ts` 推断 rootDir=仓库根，与 Dockerfile 的 `dist/src/main.js` 同规则；`npm run start:relay` 已指向该实测路径）。运行时只需 node_modules 里的 `ws` + Node 标准库。

健康探活：`GET /health` → `200 {"status":"ok"}`。

## 接入协议

WS 端点：`GET /ws`（连接角色与凭证经**首帧 auth**，安全批 I/J）

- **鉴权（安全批 I：凭证出 URL query；批 J：query 双轨窗口关闭）**：升级完成后第一条消息必须是 `{kind:'auth', token, role:'server'|'client', connectionId?}`（server 角色带 connectionId 即注册键）。query 携带凭证已不再受理（批 I 曾设双轨兼容窗口，四端客户端随批 I 全部切换后于批 J 关闭）——query 凭证的明文面会留存在反代/负载均衡访问日志。零凭证/首帧非 auth 连接在首帧等待窗（5s）内即 `4001`
- **role=server（被控端）**：auth 后发 `{kind:'register', instanceId, capabilities, name}` 元数据帧（relay 只收不转发）；此后 `res`/`event` 帧转发给已配对 client
- **role=client（控制端）**：auth 后发 `{kind:'open', connectionId:'<目标>'}` 触发配对；此后 `req` 帧转发给 server，`res`/`event` 帧由 server 透传回来

| kind | 方向 | 说明 |
| --- | --- | --- |
| `auth` | 双向→relay | **首帧鉴权**（token/role/connectionId 全量承载，relay 只收不转发） |
| `register` | server→relay | 可选元数据（instanceId/capabilities/name），不入转发 |
| `open` | client→relay→server | 配对请求；relay 原样转发给 server 作为接入通知 |
| `req` | client→relay→server | 请求帧（含 `id`，业务自定义 `method`/`payload`） |
| `res` | server→relay→client | 应答帧（按 `id` 与 req 关联） |
| `event` | server→relay→client | 事件透传（如 `message.chunk` 流式块） |
| `close` | 双向控制帧 | client→relay：主动拆配对（server 收 `client-gone`，client 收 `closed` 回执，ws 保留可重新 open）；relay→client/server：对端掉线等生命周期通知 |

关闭码与通知帧：

| 场景 | 对端收到 | WS close code |
| --- | --- | --- |
| token 不符 / 首帧等待窗（5s）内无 auth 或首帧非 auth | — | `4001 invalid-token` |
| role 非法 / server 未带 connectionId / 旧连接被顶掉 | — | `4000` |
| client open 的目标未注册 | `{kind:'close', reason:'not-found'}` | `4004 not-found` |
| jwt 模式租户配额超限（claims `quota.maxServers/maxClients`，断开释放） | client 配对时先收 `{kind:'close', reason:'quota-exceeded'}` | `4005 quota-exceeded` |
| jwt 模式异租户注册已占用 connectionId（顶号防护） | — | `4006 id-conflict` |
| jwt 模式跨租户 attach（open 目标为异租户 server） | `{kind:'close', reason:'tenant-forbidden'}` | `4007 tenant-forbidden` |
| server 掉线 | `{kind:'close', reason:'server-gone'}` | `4003 server-gone` |
| client 掉线 | server 收 `{kind:'close', reason:'client-gone'}` | — |
| client 主动发 close 控制帧 | 同上 + client 收 `reason:'closed'` 回执 | —（ws 保留） |
| client 换目标 open（已有配对再 open 新 id） | 旧 server 收 `client-gone`，配对迁到新 server | — |
| 出向积压超 `--max-buffer-frames` | — | `4002 buffer-overflow` |
| 转发时对端已死（send 抛错） | — | `1011 send-failed` |
| 单帧超过 4MiB（ws 层 maxPayload） | — | `1009`（ws 库回） |

健壮性要点：心跳 ping 30s / 无 pong 60s 剔除；坏 JSON 帧静默丢弃；同 `connectionId` 重复注册视为重连（旧连接 `4000 replaced`，已配对 client 由新连接无缝接管、不误拆）；每 socket 出向帧「发出挂账、落盘递减」，慢消费者积压超限即拆连接，防止 relay 内存膨胀；单帧 4MiB 上限防巨包。

## 端到端加密（relay E2E）与 E2E 测试

relay 对业务载荷零知识：控制端与被控端配对后可自行完成端到端握手（`e2e-hello`/`e2e-ack` 明文经 relay 照转，其后 req/res/event 一律 `e2e-secure` 密文信封；X25519+HKDF+AES-GCM，实现单份在 `@tianshu/core` `e2e-crypto`）；四链路抓帧验证（密文往返 / relay 侧零明文 / off 降级 / 指纹不匹配断开——本仓真 relay 子进程 + 双端真实握手栈 + 透传抓帧 proxy）在 mirror 仓维护：`npm run test:e2e:relayE2E`。

## Docker 部署示例

单租户（含业务面的通用示例，见下）；多租户公共中继请改用 **`Dockerfile.relay`**（`node:22-slim` 最小镜像，仅 5 个 relay 运行时 js + `ws` + 协议常量包，零业务代码——spec §9），构建与运行命令见「多租户部署（beta）」末节。

```dockerfile
FROM node:20.19.5-alpine3.22 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:20.19.5-alpine3.22
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
EXPOSE 8411
# token 经环境变量注入，避免写进镜像层
CMD ["sh", "-c", "node dist/src/relay/relay-main.js --port 8411 --token \"$RELAY_TOKEN\""]
```

```bash
docker build -t tianshu-relay .
docker run -d --name tianshu-relay -p 8411:8411 \
  -e RELAY_TOKEN="$(openssl rand -hex 16)" tianshu-relay
```

## systemd 部署示例

`/etc/systemd/system/tianshu-relay.service`（部署目录以 `/opt/tianshu-server` 为例，需先 `npm ci && npm run build`）：

```ini
[Unit]
Description=tianshu relay (ws 中继)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/tianshu-server
Environment=RELAY_TOKEN=change-me            # openssl rand -hex 16
ExecStart=/usr/bin/node dist/src/relay/relay-main.js --port 8411 --token ${RELAY_TOKEN} --max-buffer-frames 200
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now tianshu-relay
journalctl -u tianshu-relay -f      # 看启动端口与运行日志
```

## TLS 部署（安全批 I）

既定架构为**反代终止 TLS**（nginx/Caddy 之后跑明文 relay，见下节片段）。
如需 relay 直露公网自管证书，`--cert`/`--key` 成对传入即原生 https/wss 监听：

```bash
npm run start:relay -- --port 8411 --token "$(openssl rand -hex 16)" \
  --cert /etc/relay/cert.pem --key /etc/relay/key.pem
```

客户端地址用 `wss://`（各端零改动——URL 原样交给 WebSocket 实现）。证书轮换
需重启进程（无热加载；证书管理属部署面职责）。

## nginx TLS 反代片段（wss）

默认形态 relay 不开 TLS（公网建议置于 nginx 之后；原生 TLS 见上节可选项）：

```nginx
server {
    listen 443 ssl;
    server_name relay.example.com;

    ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8411;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # ws 升级必需
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        # 大于心跳周期（30s ping / 60s 超时），防 idle 断连
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

客户端连接地址相应为 `wss://relay.example.com/ws?role=...&token=...`。

## 多租户部署（beta）

```
被控端(role=server, AK) ──┐                                        ┌── 控制端(role=client, AK)
  各租户内网机器           ├──> 公网 relay /ws（Ed25519 验签多租户） <──┤   mobile / 桌面主机页
（tianshu-server /         │     ↑ kick/stats（Bearer internal secret） │
 mirror server-face）      │  运营方 relay-admin（NestJS 独立入口 8412）  │
                          └──── CRL 吊销名单拉取（45s 周期）◀───────────┘
```

场景 2（公共中继 SaaS，spec 2026-11-03）：一个共享 relay 服务多租户；邀请制 beta——运营方手动建租户、发 AK，无自助注册。凭证链：**AK（长效，默认 1 年）→ 控制平面换 access JWT（30 天，Ed25519 签发）→ relay 首帧 auth 离线验签**。relay 本体用 `--auth-pubkey` 启动（与单租户 `--token` 互斥）；控制平面为 `src/relay-admin/`（独立 Nest 入口 + 独立 Prisma 库，与本仓主应用平行部署）。

### 密钥物料

- **Ed25519 密钥对**：私钥持有在 relay-admin（签发侧），首启自动生成并落 `{RA_DATA_DIR}/keys/relay-access.pem`（0600；此后启动加载同一把——已签发 access 不因控制平面重启失效）。公钥配给 relay `--auth-pubkey`。导出方式：在 relay-admin 机器上从私钥派生（**不要读伴随落盘的 `relay-access.pub.pem`**——手动更换私钥后该文件会陈旧，以私钥派生为唯一可信来源）：

```bash
node -e "const c=require('node:crypto');const k=c.createPrivateKey(require('fs').readFileSync('<RA_DATA_DIR>/keys/relay-access.pem','utf8'));console.log(c.createPublicKey(k).export({type:'spki',format:'pem'}))" > relay-access.pub.pem
```

- **internal secret**（控制信道凭证，与 Ed25519 密钥分域互不复用）：同一秘密的两半——relay 侧 `--internal-secret`、relay-admin 侧 env `RA_INTERNAL_SECRET`；保护 kick/stats 内部端点与 CRL 名单端点。生成：`openssl rand -hex 32`，运营方双机各持。

### relay 启动（jwt 模式）

```bash
node dist/src/relay/relay-main.js --port 8411 \
  --auth-pubkey /etc/relay/relay-access.pub.pem \
  --internal-secret "<INTERNAL_SECRET>" \
  --crl-admin-url https://relay-admin.example.com \
  --crl-fail-close 5
```

- `--crl-admin-url`（可选但生产强烈建议）：启用吊销名单拉取（45s 周期 `GET {url}/relay-admin/revocations`），需与 `--internal-secret` **成对**——配了 url 缺 secret 拒绝启动；不配则无吊销检查面
- `--crl-fail-close <n>`（可选，缺省 0=fail-static）：连续 n 次拉取失败后拒**新**连接，见「fail-close 配置」
- TLS 同单租户（反代终止 TLS 为既定架构，或 `--cert/--key` 原生 wss）

### relay-admin 启动（控制平面，运营方机器）

```bash
npm run build
npm run start:relay-admin
# [relay-admin] listening on http://0.0.0.0:8412 (RA_PORT 可覆盖)
```

env 清单（生产全部显式配置）：

| env | 说明 |
| --- | --- |
| `RA_PORT` | 监听端口（缺省 8412） |
| `RA_DATABASE_URL` | 独立库落点，**必须绝对路径**（如 `file:/var/lib/tianshu-relay-admin/relay-admin.db`；相对路径锚 schema/生成物目录，dist 运行时会漂移） |
| `RA_INTERNAL_SECRET` | 控制信道凭证（与 relay `--internal-secret` 同值） |
| `RA_RELAY_BASE_URL` | relay 本体基址（kick/stats 联动目标，如 `http://<relay-host>:8411`；非同机部署必配，见「非同机部署注记」） |
| `JWT_SECRET` | 管理员登录 JWT 签名密钥（脚手架 `.env` 同款纪律；未配置以进程级随机垫底，跨重启登录失效） |
| `RA_DATA_DIR` | 数据根（Ed25519 私钥落点 `<dir>/keys/relay-access.pem`；生产绝对路径） |

dev 首建（fresh clone；管理台 Swagger 在 `http://localhost:8412/api-docs`）：

```bash
cd apps/tianshu-server
npm run prisma:generate:ra                                          # 生成独立库 client（gitignored 产物）
RA_DATABASE_URL=file:./data/relay-admin.db npm run prisma:push:ra   # 建表——prisma CLI 不读 service 层缺省，无 env 直接报错
RA_DATABASE_URL=file:./data/relay-admin.db npm run prisma:seed:ra   # seed 单管理员 admin（一次性口令打在控制台，请立即登录改密）
```

（push 与 seed 都显式带同一 env——seed 层虽有缺省兜底，显式同值可避免相对锚点差异导致两库错位。）

### AK 发放操作序列（运营方）

beta 全部经管理面 API（管理员 JWT；响应为脚手架统一信封 `{code, message, data}`）：

```bash
RA=http://localhost:8412
# 1) 管理员登录（seed 打出的一次性口令）
TOKEN=$(curl -s -X POST $RA/relay-admin/auth/login -H 'content-type: application/json' \
  -d '{"username":"admin","password":"<一次性口令>"}' | jq -r '.data.accessToken')
# 2) 建租户用户（响应含 userId/tenantId；plan 当前仅 beta = maxServers:5 / maxClients:10）
curl -s -X POST $RA/relay-admin/users -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"租户A","plan":"beta"}'
# 3) 签发 AK——server/client 各一张（role 分离：泄露面隔离、吊销粒度到角色）
curl -s -X POST $RA/relay-admin/aks -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"userId":"<userId>","role":"server"}'   # → {akId, akSecret}：akSecret 明文仅此一次（库内只存 sha256）
curl -s -X POST $RA/relay-admin/aks -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"userId":"<userId>","role":"client"}'
```

生命周期端点：`POST /relay-admin/aks/:akId/disable|enable|rotate-secret`（rotate 后新明文同样仅返回一次）、`POST /relay-admin/aks/:akId/extend`（expireAt 只能延后）、`POST /relay-admin/users/:userId/disable|enable`（禁用户级联禁全部 AK + kick 整租户）。禁用/轮换即时联动 kick 拆 relay 存量连接，并由 CRL 名单持续拦截新连接。

**接入方配置**（发给租户的材料 = AK 三要素 + relay 地址）：

| 端 | 配置 |
| --- | --- |
| 被控端 tianshu-server（relay-client） | env `TIANSHU_RELAY_ADMIN_URL` / `TIANSHU_RELAY_AK_ID` / `TIANSHU_RELAY_AK_SECRET`（CLI 同名参优先；server AK）——启动即换 access，剩余 TTL <50% 自动续期，AK 失效断开并告警 |
| 桌面被控面（mirror server-face） | 设置面 relay 地址 + `adminUrl/akId/akSecret` 三字段（server AK） |
| 控制端（mobile 连接配置 / 桌面 UI 主机页） | relay 地址 + `adminUrl/akId/akSecret` 三字段（client AK） |

换 token 协议（四端内置，无需手工执行）：`POST {adminUrl}/relay-admin/token`，`Authorization: Basic base64(akId:akSecret)` → `{accessToken, expiresAt, maxAgeSec}`（30 天）；AK 禁用/过期/错 secret 一律 401 + `data.reason`。

### 停机语义（spec §5.4）

| 场景 | 结果 |
| --- | --- |
| 控制平面停机任意时长 | 存量连接正常；access 未过期的重连正常（relay 离线验签）；access 已过期的重连在控制平面恢复后自动续上（退避重试） |
| 被控端离线 < AK 有效期 | 自动恢复，零人工 |
| 人工介入点（唯一） | AK 到期不再续 / 被禁用不恢复——租户/接入方重新领 AK |
| 禁用 AK | renew 即拒（401）+ kick 拆存量 + CRL 名单拦新连接 |

### 非同机部署注记

relay 与 relay-admin 分机部署时 `RA_RELAY_BASE_URL` 必须指向真实 relay 地址（config.yml 缺省 `http://127.0.0.1:8410` 仅同机 dev 适用）。**缺失或指向不可达时 kick/在线视图 warn-degrade**：禁用/轮换操作照常落库与审计、CRL 名单照常发布（CRL 由 relay 主动拉取，不走该通道），仅即时 kick 与在线统计降级；`GET /relay-admin/stats/online` 呈 `{relayStats:{error:'unreachable'}}` 降级占位，排障看 relay-link warn 日志。

### fail-close 配置

CRL 拉取缺省 **fail-static**：拉取失败维持现有名单，永不因控制平面停机而拆连接或拒新（最坏吊销延迟 = kick 丢失 + 控制平面停机期间名单停更，恢复即收敛）。收紧选项 `--crl-fail-close <n>`：连续 n 次拉取失败后拒绝**新**连接（4001，与凭证失败同归因不外泄细节）；**存量连接不拆**——与停机语义一致，只拒新不拆旧。

### relay 独立镜像（Dockerfile.relay）

公共 relay 服务器不落任何业务代码（spec §9）：`apps/tianshu-server/Dockerfile.relay` 经全量 builder 后仅组装 5 个 relay 运行时 js（relay-main/registry/auth/jwt-eddsa/crl）+ `ws` + `@tianshu/protocol` 常量包进 `node:22-slim` 运行层（非特权 `node` 用户）：

```bash
# monorepo 根 context 构建
docker build -f apps/tianshu-server/Dockerfile.relay -t tianshu-relay .
docker run -d --name tianshu-relay -p 8411:8411 \
  -v /etc/relay:/keys:ro \
  tianshu-relay --port 8411 \
    --auth-pubkey /keys/relay-access.pub.pem \
    --internal-secret "$INTERNAL_SECRET" \
    --crl-admin-url https://relay-admin.example.com
```

## 运维提示

- token 泄漏即失守：所有角色共用一个 token，轮换时同时更新被控端与控制端配置并重启 relay（连接会被 `4001` 拒绝直至更新完成）
- 多控制端同时 open 同一 `connectionId` 时，`event`/`res` 帧会广播给全部已配对 client（当前设计按单控制端使用）
- relay 无持久化状态，重启后两端自动重连即可恢复（被控端重连同 id 会顶掉旧连接）
