# tianshu relay 部署与协议

中继服务：让「被控端 tianshu-server」与「控制端」穿过 NAT/防火墙配对，帧级直转 WebSocket 消息。独立于 Nest 主应用——纯 `node:http` + `ws`，可单进程部署在任意一台公网机器上。

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

产物路径：`dist/src/relay/relay-main.js`（`nest build` 全量编译，tsc 因 `prisma/seed.ts` 推断 rootDir=仓库根，与 Dockerfile 的 `dist/src/main.js` 同规则；`npm run start:relay` 已指向该实测路径）。运行时只需 node_modules 里的 `ws` + Node 标准库。

健康探活：`GET /health` → `200 {"status":"ok"}`。

## 接入协议

WS 端点：`GET /ws?role=server|client&token=<t>&connectionId=<id>`

- **role=server（被控端）**：连接即以 query 中的 `connectionId` 注册；首消息可发 `{kind:'register', instanceId, capabilities, name}` 元数据帧（relay 只收不转发）；此后 `res`/`event` 帧转发给已配对 client
- **role=client（控制端）**：发 `{kind:'open', connectionId:'<目标>'}` 触发配对；此后 `req` 帧转发给 server，`res`/`event` 帧由 server 透传回来

| kind | 方向 | 说明 |
| --- | --- | --- |
| `register` | server→relay | 可选元数据（instanceId/capabilities/name），不入转发 |
| `open` | client→relay→server | 配对请求；relay 原样转发给 server 作为接入通知 |
| `req` | client→relay→server | 请求帧（含 `id`，业务自定义 `method`/`payload`） |
| `res` | server→relay→client | 应答帧（按 `id` 与 req 关联） |
| `event` | server→relay→client | 事件透传（如 `message.chunk` 流式块） |
| `close` | 双向控制帧 | client→relay：主动拆配对（server 收 `client-gone`，client 收 `closed` 回执，ws 保留可重新 open）；relay→client/server：对端掉线等生命周期通知 |

关闭码与通知帧：

| 场景 | 对端收到 | WS close code |
| --- | --- | --- |
| token 不符 | — | `4001 invalid-token` |
| role 非法 / server 未带 connectionId / 旧连接被顶掉 | — | `4000` |
| client open 的目标未注册 | `{kind:'close', reason:'not-found'}` | `4004 not-found` |
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

## nginx TLS 反代片段（wss）

relay 自身不带 TLS，公网建议置于 nginx 之后：

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

## 运维提示

- token 泄漏即失守：所有角色共用一个 token，轮换时同时更新被控端与控制端配置并重启 relay（连接会被 `4001` 拒绝直至更新完成）
- 多控制端同时 open 同一 `connectionId` 时，`event`/`res` 帧会广播给全部已配对 client（当前设计按单控制端使用）
- relay 无持久化状态，重启后两端自动重连即可恢复（被控端重连同 id 会顶掉旧连接）
