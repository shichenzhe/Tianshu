# server Docker 部署治理设计

日期：2026-10-31
状态：已实施（2026-11-02 核实更正；commits 0cf1c707 补坑→d8db6731 Dockerfile 根 context vendor 内嵌→b4097cf0 收尾钉版自愈；原「实施待排期」状态行过时未随实施更新）
前置：`docs/superpowers/specs/2026-10-31-server-pg-search-design.md`（PG 检索层，部署面因 Dockerfile 债务打了 caveat）

## 背景与目标

server Dockerfile 是独立仓时代产物（subtree 前史）：`COPY package*.json ./` + `npm ci` + `npx prisma generate` + `npm run build` 假设 server-local context。monorepo 化后 `@tianshu/*` 为 workspace 名协议依赖，任何 context 下原配方均不可构建——上一批以 README caveat 兜底（「server 镜像待 Docker 治理批」）。本设计补齐：**根 context vendor 内嵌构建 + compose server 服务端到端可用 + SQLite 主库数据卷**。

**Spike 已实证**（2026-10-31，10 轮迭代，throwaway `Dockerfile.spike`）：根 context + vendor 内嵌（`@tianshu/*` → `file:./vendors/*`）模式成立——镜像构建成功（1.13GB）、容器启动、`/actuator/health` 返回 ok。

## Spike 坑清单（实证，全部进设计）

| # | 坑 | 处置 |
|---|---|---|
| 1 | builder 全量 `npm ci` 装到桌面原生模块（node-pty musl arm64 无 prebuilt）→ node-gyp 失败 | builder 加 `apk add python3 make g++`（bcrypt 有 musl prebuilt/白名单允许脚本；electron 二进制被 allowScripts 白名单机制天然跳过）<br>**2026-11-03 后续**：主 Dockerfile（834d24cd）已改 `npm ci --ignore-scripts`，工具链行整行移除——builder 免全部原生重编（prisma engine 为预编译二进制），见 Dockerfile 头注释；Dockerfile.relay 同款 |
| 2 | npmmirror 版本集与官方 registry 不同步（`@langchain/langgraph-sdk@~1.12.9` ETARGET） | builder 的 `npm ci` 走 npmmirror（lock 钉死不解析，安全）；runner/bundle lock 生成走**官方源**（semver 解析场景） |
| 3 | runner `npm ci` 需 lock 而 bundle 无 lock | builder 内 bundle 目录 `npm install --package-lock-only --omit=dev`（官方源）生成 lock 随 bundle 交付，runner 换 `npm ci`（确定性），lock 留镜像可审计 |
| 4 | `prisma generate` 必须先于 `nest build`（TS 类型依赖生成物） | 层序：generate → build |
| 5 | workspace 不提升：prisma CLI 与 `.prisma` 生成物在 `apps/tianshu-server/node_modules/`；根 `node_modules/.prisma` 是 postinstall **占位**（空 schema 生成物，`UserType` 等枚举缺失 → IsEnum 崩） | COPY 源精确到 `/repo/apps/tianshu-server/node_modules/.prisma` |
| 6 | compose 相对 context 相对 compose 文件目录（`..` 只到 apps/） | `context: ../..`（上批已落） |
| 7 | **实施期新增**：spike 的健康 ok 系假阳性——主树 gitignored 开发库 `prisma/local.db` 被 COPY 烘进镜像，掩盖了首启 `prisma db push` 依赖 CLI（devDep 被 transform 删除）的事实 | transform 将 `prisma` CLI 按 builder 实装精确版本提升进 prod 依赖；`.dockerignore` 加 `**/local.db*`（另加 `**/.env` 防开发密钥入构建上下文——终审追加） |

## 设计

### 1. 正式 Dockerfile（重写 `apps/tianshu-server/Dockerfile`）

**Builder**（`node:20.19.5-alpine3.22` + `apk add --no-cache python3 make g++`）：

1. 分层 COPY：根 `package.json`+`package-lock.json` → 两共享包 `package.json` → server `package.json`
2. `npm config set registry https://registry.npmmirror.com/ && npm ci`（全量，lock 钉死）
3. COPY `packages`、`apps/tianshu-server` 源码
4. `cd apps/tianshu-server && npx prisma generate`（层序先于 build）
5. `npm --prefix packages/tianshu-protocol run build && npm --prefix packages/tianshu-core run build && npm run build -w apps/tianshu-server`
6. 组装 `/bundle`：
   - `vendors/tianshu-protocol`、`vendors/tianshu-core`（各含 dist + package.json）
   - server `dist/` + `prisma/`
   - 变换后的 `package.json`：`@tianshu/core`/`@tianshu/protocol` → `file:./vendors/tianshu-*`，删 devDependencies
   - bundle lock：`cd /bundle && npm install --package-lock-only --omit=dev --no-audit --no-fund`（官方源）

**Runner**（`node:20.19.5-alpine3.22`，`NODE_ENV=production`）：

1. `COPY --from=builder /bundle /app`
2. `COPY --from=builder /repo/apps/tianshu-server/node_modules/.prisma /app/node_modules/.prisma`（坑 #5）
3. `RUN npm ci --omit=dev --no-audit --no-fund`（官方源；lock 在 bundle 内——注意层序：install 会重建 node_modules，`.prisma` COPY 必须在 install **之后**覆盖）
4. `EXPOSE 3000`、`CMD ["node","dist/src/main.js"]`

### 2. 根 `.dockerignore`（spike 版转正）

```
node_modules
**/node_modules
dist-electron
src-react
tests
docs
.superpowers
.claude
.git
*.md
apps/tianshu-mobile
release
coverage
```

### 3. compose server 服务复活 + 数据卷

- 撤销上批 caveat（README 与 compose 注释）
- SQLite 主库持久化：env `TIANSHU_DB_URL=file:/app/data/local.db`（PrismaService 现成 env 覆盖机制，`prisma.service.ts:13` 的 `dbUrlOptions()`）+ named volume `server-data:/app/data`——db 与 schema 分离，volume 不遮蔽镜像内 `prisma/` 目录
- `SEARCH_DB_URL` 串联保留（PG 检索模式同栈）

### 4. 验收（端到端）

1. `docker compose up -d` → server 健康 `/actuator/health` ok
2. PG 检索模式冒烟：compose 全栈下 `hybridSearch` keyword 查询经 server API 命中（复用上批 e2e 手法，容器端口探测）
3. 数据存活：入库/建图后 `docker compose restart server` → 数据仍在（volume 验证）
4. 回归：`docker compose config -q` 合法；mirror vitest / server jest 全量基线不动（本批零源码改动，仅部署面）

### 5. 影响面与清理

| 文件 | 变更 |
|------|------|
| `apps/tianshu-server/Dockerfile` | 重写（正式版） |
| `.dockerignore`（根，新增） | spike 版转正 |
| `apps/tianshu-server/docker-compose.yml` | caveat 撤销 + server 服务激活 + 数据卷 |
| `apps/tianshu-server/README.md` | 部署段更新（一键 compose up、数据卷说明） |
| `apps/tianshu-server/Dockerfile.spike` | 删除（throwaway 收尾） |

镜像 ~1.13GB（@langchain 全家桶 + prisma engine 大头，`--omit=dev` 已做）；深度瘦身（multi-stage 依赖裁剪/基础镜像换 distroless）不扩本期。

## 假设与开放问题

- **假设**：docker daemon（本机 29.2.1）可用于验收；arm64 构建（本机），linux/amd64 目标镜像的 node-pty 编译由同一工具链路径覆盖（CI/发布构建跨平台验证留发布批）。
- **开放**：bundle lock 的上游版本漂移窗口（lock 生成于构建时——同一 lock 文件重跑确定性 ✓，跨构建日漂移与根 lock 解析一致，可接受）；镜像深度瘦身与 CI 构建流水线（发布批）。
