# server Docker 部署治理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** server Dockerfile 按 monorepo 根 context 重写为 vendor 内嵌构建（spike 实证版转正），compose server 服务端到端可用 + SQLite 主库数据卷，README caveat 撤销。

**Architecture:** builder（alpine+工具链）全量 `npm ci`（npmmirror，lock 钉死）→ `prisma generate`（先于 build）→ 三包 build → 组装 `/bundle`（vendors `file:` 转换 + dist + prisma + bundle lock）；runner 只装 bundle 生产依赖（官方源 `npm ci`）+ 拷入 `.prisma` 生成物（源路径精确到 server 本地 node_modules）。compose 经 `TIANSHU_DB_URL=file:/app/data/local.db` + named volume 持久化 SQLite。

**Tech Stack:** Docker multi-stage（node:20.19.5-alpine3.22）、docker compose、npm workspaces。

**Spec:** `docs/superpowers/specs/2026-10-31-server-docker-deploy-design.md`（执行者须同时读——spike 六坑清单是设计的一部分）

## Global Constraints

- **零源码改动**：本批仅部署面（Dockerfile/.dockerignore/compose/README），`src/`、`packages/`、根 `package.json` 零 hunks。
- **spike 六坑处置不可偏离**（spec 坑清单）：工具链 apk、builder npmmirror/runner 官方源、bundle lock 先生成、generate 先于 build、`.prisma` 拷贝源 `apps/tianshu-server/node_modules/.prisma` 且 COPY 在 runner install **之后**、compose context `../..`。
- **docker daemon 可用**（本机 29.2.1）：每任务的 build/run 验收是真跑，不是 `config -q` 级。
- **镜像基线**：~1.13GB（spike 实测）；深度瘦身不扩本期。
- **提交纪律**：中文 conventional；spike 产物（`Dockerfile.spike`）T1 删除。
- **回归基线**：mirror vitest 4465（实测口径 4460 passed + 9 skipped，环境 delta 非失败——2026-10-31 验收记录）/ server jest 74 suites（零源码改动，理论上零影响——T3 跑一遍确证）。

---

### Task 1: 正式 Dockerfile + 根 .dockerignore + spike 清理

**Files:**
- Modify: `apps/tianshu-server/Dockerfile`（重写为正式版，全文如下）
- Create: `.dockerignore`（根，spike 版转正）
- Delete: `apps/tianshu-server/Dockerfile.spike`

**Interfaces:**
- Produces: 可构建的正式镜像 `docker build -f apps/tianshu-server/Dockerfile .`（根 context）；镜像内 `/app/dist/src/main.js` 可启动（T2/T3 依赖）。

- [ ] **Step 1: 写根 .dockerignore**

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

- [ ] **Step 2: 重写 Dockerfile（全文，spike 终版 + bundle lock 补强）**

```dockerfile
# apps/tianshu-server/Dockerfile
# monorepo 根 context 构建（docker build -f apps/tianshu-server/Dockerfile .）：
# builder 全量 npm ci（lock 钉死）→ prisma generate（先于 build，TS 类型依赖）
# → 三包 build → 组装 vendor 内嵌 bundle（@tianshu/* → file:./vendors/*）。
# 六坑处置见 docs/superpowers/specs/2026-10-31-server-docker-deploy-design.md
FROM node:20.19.5-alpine3.22 AS builder
# node-pty musl arm64 无 prebuilt，需源码编译工具链（bcrypt 有 musl prebuilt；
# electron 二进制被根 allowScripts 白名单机制天然跳过）
RUN apk add --no-cache python3 make g++
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/tianshu-protocol/package.json packages/tianshu-protocol/
COPY packages/tianshu-core/package.json packages/tianshu-core/
COPY apps/tianshu-server/package.json apps/tianshu-server/
# npmmirror 仅用于 lock 钉死的 ci（不做 semver 解析，无版本集差异风险）
RUN npm config set registry https://registry.npmmirror.com/ && npm ci
COPY packages packages
COPY apps/tianshu-server apps/tianshu-server
# prisma client 生成必须先于 nest build（DTO 引用生成枚举类型）
RUN cd apps/tianshu-server && npx prisma generate
RUN npm --prefix packages/tianshu-protocol run build \
 && npm --prefix packages/tianshu-core run build \
 && npm run build -w apps/tianshu-server
# 组装 vendor 内嵌 bundle：@tianshu/* → file:./vendors/*（server 独立部署语义）
RUN mkdir -p /bundle/vendors/tianshu-protocol /bundle/vendors/tianshu-core \
 && cp -r packages/tianshu-protocol/dist /bundle/vendors/tianshu-protocol/ \
 && cp packages/tianshu-protocol/package.json /bundle/vendors/tianshu-protocol/ \
 && cp -r packages/tianshu-core/dist /bundle/vendors/tianshu-core/ \
 && cp packages/tianshu-core/package.json /bundle/vendors/tianshu-core/ \
 && cp -r apps/tianshu-server/dist /bundle/ \
 && cp -r apps/tianshu-server/prisma /bundle/prisma \
 && node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('apps/tianshu-server/package.json','utf8'));for(const k of ['@tianshu/core','@tianshu/protocol'])p.dependencies[k]='file:./vendors/'+k.slice(1).replace('/','-');delete p.devDependencies;fs.writeFileSync('/bundle/package.json',JSON.stringify(p,null,2))"
# bundle lock：官方源生成（semver 解析需官方版本集；npmmirror 有同步缺口），
# 随 bundle 交付 → runner 换 npm ci 确定性安装，lock 留镜像可审计
RUN cd /bundle && npm install --package-lock-only --omit=dev --no-audit --no-fund

FROM node:20.19.5-alpine3.22 AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /bundle /app
RUN npm ci --omit=dev --no-audit --no-fund
# .prisma 生成物拷贝须在 install 之后（install 会重建 node_modules）；
# 源路径是 server 本地 node_modules（workspace 不提升；根下的是 postinstall 占位）
COPY --from=builder /repo/apps/tianshu-server/node_modules/.prisma /app/node_modules/.prisma
EXPOSE 3000
CMD ["node","dist/src/main.js"]
```

- [ ] **Step 3: 实测构建**

Run: `cd /Users/hjx/workspace/mirror && docker build -f apps/tianshu-server/Dockerfile -t tianshu-server:deploy . 2>&1 | tail -3`
Expected: 构建成功（首次全量 ~8-12 分钟；层缓存可加速）。失败时对照 spec 六坑排查。

- [ ] **Step 4: 实测启动（健康探测）**

Run:
```bash
docker run -d --rm --name deploy-probe -e JWT_SECRET=probe -p 3998:3000 tianshu-server:deploy
sleep 8 && curl -s -m 3 http://localhost:3998/actuator/health | head -c 120
docker rm -f deploy-probe
```
Expected: `{"status":"ok"...`（与 spike 终轮同款）。

- [ ] **Step 5: 删 spike 文件 + Commit**

```bash
rm apps/tianshu-server/Dockerfile.spike
git add apps/tianshu-server/Dockerfile .dockerignore
git add -A apps/tianshu-server
git commit -m "feat(server): Dockerfile 根 context vendor 内嵌重写——bundle lock/生成物拷贝/六坑处置（spike 转正）"
```

---

### Task 2: compose 激活 + 数据卷 + README

**Files:**
- Modify: `apps/tianshu-server/docker-compose.yml`（caveat 撤销、server 服务激活、数据卷）
- Modify: `apps/tianshu-server/README.md`（部署段：caveat 撤销、一键部署、数据卷说明）

**Interfaces:**
- Consumes: Task 1 的正式 Dockerfile（compose `build: {context: ../.., dockerfile: apps/tianshu-server/Dockerfile}`）。
- Produces: `docker compose up -d` 一键全栈（server + search-pg）；`TIANSHU_DB_URL=file:/app/data/local.db` 持久化（T3 验收依赖）。

- [ ] **Step 1: 重写 compose（全文）**

```yaml
# apps/tianshu-server/docker-compose.yml
# 全栈部署：server（SQLite 主库挂卷持久化）+ PG 检索库（可选能力，随栈提供）
# 一键：docker compose up -d（构建慢首次 ~10 分钟；data 卷持久化 SQLite 主库）
services:
  search-pg:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: tianshu
      POSTGRES_PASSWORD: tianshu_search
      POSTGRES_DB: tianshu_search
    volumes:
      - search-pg-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U tianshu -d tianshu_search"]
      interval: 5s
      timeout: 3s
      retries: 10
    # 宿主直连调试时放开：ports: ["5432:5432"]
  server:
    build:
      context: ../..
      dockerfile: apps/tianshu-server/Dockerfile
    environment:
      JWT_SECRET: ${JWT_SECRET:-change-me-in-prod}
      # SQLite 主库落数据卷（PrismaService 的 TIANSHU_DB_URL 覆盖机制）
      TIANSHU_DB_URL: file:/app/data/local.db
      SEARCH_DB_URL: postgres://tianshu:tianshu_search@search-pg:5432/tianshu_search
    volumes:
      - server-data:/app/data
    depends_on:
      search-pg:
        condition: service_healthy
    ports:
      - "3000:3000"

volumes:
  search-pg-data: {}
  server-data: {}
```

- [ ] **Step 2: README 部署段更新**

撤销上一批 caveat（「server 镜像构建暂不可用/Dockerfile 独立仓时代产物/宿主进程形态」整段），替换为：

```markdown
## Docker 部署（compose 一键）

`docker compose up -d` 起 server + PG 检索库全栈：

- server 镜像经 monorepo 根 context 构建（vendor 内嵌 @tianshu/* 共享包），
  `dist/src/main.js` 直跑，`/actuator/health` 探活
- **SQLite 主库持久化**：`TIANSHU_DB_URL=file:/app/data/local.db` 落
  `server-data` 卷——容器重建/升级数据不丢
- **PG 检索模式默认开启**（`SEARCH_DB_URL` 已串联 search-pg 服务）；不启用
  检索库可删 server 服务的该 env 与 depends_on，退回本地内存检索
- 单真源语义与 postgres:// scheme 限制见上一节「PG 检索模式」
```

- [ ] **Step 3: 验证 compose 语法 + Commit**

Run: `docker compose -f apps/tianshu-server/docker-compose.yml config -q && echo VALID`
Expected: VALID（T3 做真实 up）。

```bash
git add apps/tianshu-server/docker-compose.yml apps/tianshu-server/README.md
git commit -m "feat(server): compose 全栈激活——server 服务/SQLite 数据卷/README 一键部署（caveat 撤销）"
```

---

### Task 3: 端到端验收 + 全量回归

**Files:**
- 无源码变更（验收任务；异常时报告而非顺手改）

**Interfaces:**
- Consumes: T1 镜像 + T2 compose。

- [ ] **Step 1: compose 全栈起 + 健康**

Run:
```bash
cd apps/tianshu-server && docker compose up -d --build 2>&1 | tail -3
sleep 10 && curl -s -m 3 http://localhost:3000/actuator/health | head -c 80
```
Expected: 两容器 Up（search-pg healthy）+ `{"status":"ok"...`。

- [ ] **Step 2: PG 检索模式端到端冒烟**

复用上批 e2e 手法（`tests/ai/server/e2e-graph-search-pg.ts` 的种子/断言逻辑），最小闭环：容器网络内直插 PG 中文样本（经宿主 `docker exec` + psql 或临时 node 脚本连 `localhost:5432`——compose 需临时放开 search-pg 端口映射或 `docker compose exec` 进 server 容器执行）→ 经 `http://localhost:3000` API（graph save/run，hybridSearch keyword 节点）→ 断言输出含目标条目名与「相关度」。

具体手段按上批 `e2e-graph-search-pg.ts` 已验证的 seed SQL 与节点 JSON 复用（该脚本的 spawn 段不适用——本验收 server 已是容器进程，只取其 seed/断言段）。

- [ ] **Step 3: 数据存活验证**

```bash
# 经 API 造一条持久数据（如 graph save 一张测试图）→ 记录标识
docker compose restart server && sleep 8
# 再查询该标识 → 仍存在（server-data 卷持久化生效）
```

- [ ] **Step 4: 清场 + 全量回归**

```bash
docker compose down -v   # 验收清场（卷一并清）
cd /Users/hjx/workspace/mirror && npm run test -- --reporter=basic 2>&1 | tail -1
cd apps/tianshu-server && npx jest 2>&1 | grep -E "^Tests:" 
```
Expected: mirror PASS (4465)/FAIL (0)；server jest 74 suites 全绿。

- [ ] **Step 5: 终验清单 + 收尾**

① 六坑处置在 Dockerfile 逐条可指认；② 零源码改动（git diff 仅 5 个部署文件）；③ 数据卷路径 `/app/data` 与 `TIANSHU_DB_URL` 一致且 schema 目录未被遮蔽。验收记录写进任务报告（无源码变更则无本步 commit）。
