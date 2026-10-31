# server 主库双引擎（SQLite ⇄ PostgreSQL）设计

日期：2026-10-31
状态：设计定稿（用户已认可六节设计），实施待排期
前置：`docs/superpowers/specs/2026-10-31-server-pg-search-design.md`（检索层可配指向 PG——本批启用其「空=跟随主库引擎」预留语义）

## 背景与目标

用户在 PG 检索批拍板的需求第 1 点「服务端本身就需要支持切换到 PG」分期至今。本批交付：`TIANSHU_DB_URL` 指向 `postgres://` 时 server 主库整体运行在 PostgreSQL 上（23 张业务表），默认 SQLite 行为零变化；检索层自动跟随主库引擎。

**探索结论（工作量修正）**：主 schema 23 model 的类型面（String/Int/DateTime/Boolean/Json×7）全部跨库兼容，PG 变体（`schema.prisma.postgresql`）与主 schema 的实质差异仅 datasource 头两行——「双 schema 维护」实为「头差异 + 生成/装载机制」。检索联动零新增逻辑（主库 `vectorChunk` 表与检索表 `vector_chunk` 不同名并存，单真源原则延续）。

## 已裁定决策

| # | 决策 | 结论 |
|---|------|------|
| 1 | 双 schema 维护策略 | **派生脚本**：主 schema 单源真相，npm script 派生 PG 变体（仅换 datasource 头），漂移归零 |
| 2 | 存量迁移 | **仅新部署**：PG 模式为全新初始化，不做 SQLite→PG 迁移脚本 |
| 3 | 检索联动 | SEARCH_DB_URL 空 + 主库 postgres → 默认取主库 URL（检索表 search-pg 自建，与主库 Prisma 表并存） |
| 4 | 类型策略 | TS 静态类型用 SQLite client（同构 schema 结构兼容），运行时双态 |

## 设计

### 1. schema 派生与双 client 生成

- **`prisma:pg:derive`**（新 npm script，node 脚本 `prisma/derive-pg.mjs`，~30 行）：读 `prisma/schema.prisma` → 替换 datasource 块（`provider = "postgresql"`、`url = env("DATABASE_URL")`）→ 写 `prisma/schema.prisma.postgresql`（**覆盖**现有 3 表占位版——占位版仅脚手架历史价值）。表体逐字节不变（单测钉死）。
- **`prisma:generate:pg`**：`prisma generate --schema prisma/schema.prisma.postgresql`。PG 变体 generator 加 `output = "../src/generated/prisma-pg"`（派生脚本注入该行；目录 `.gitignore`；CommonJS `require` 同步可载——server 是 CJS 构建）。
- 既有 `prisma:generate`（SQLite）零改动。`src/generated/prisma-pg` 生成物随 nest build 进 dist（tsconfig include 或 build 后置拷贝——按 nest build 实际行为落地）。

### 2. PrismaService 双 client 装载（Proxy 门面）

- `PrismaService` 不再 `extends PrismaClient`，改**组合 + Proxy 转发**：构造时经 `dbUrlOptions()` 解析 scheme——未设/`file:` → `require` SQLite client（现状默认）；`postgres://`/`postgresql://` → `require('../generated/prisma-pg')` 的 client；datasources url 覆盖沿用。
- Proxy 把业务面全量转发内部 client：model 代理（`this.user.…`）、`$transaction`/`$queryRaw`/`$executeRawUnsafe`/`$connect`/`$disconnect` 等。**TS 类型标注用 SQLite client**（业务代码零改动）；非法 scheme（非 file/postgres）启动人话报错。
- 测试注入通道（`@Optional() options`）语义保留——`onModuleInit` 的首启建库/连接逻辑随内部 client 工作。

### 3. 配置与首启建库

- `TIANSHU_DB_URL`：未设/`file:` = SQLite（零行为变化）；`postgres://` = PG 主库。
- 首启 `db push`（`db-url.ts` prod 契约）：按 engine 选 schema 文件——PG 时 `--schema prisma/schema.prisma.postgresql`（部署包内两份 schema 均随行；Docker bundle 已含 prisma 目录，派生版由 Dockerfile builder 生成后随 bundle）。
- `relationMode = "prisma"`（无外键）双引擎同款，关联语义零差异。

### 4. 检索层跟随（一行规则）

`search-pg.ts` 的 `searchDbTarget()`：SEARCH_DB_URL 非空照旧（显式独立检索库）；**空且 `TIANSHU_DB_URL` 为 postgres scheme → 返回主库 URL**。检索数据面 = search-pg 自建 `vector_chunk` 表（幂等 DDL 在主库 PG 里建检索表，与主库 `vectorChunk` Prisma 表不同名并存）；检索单真源原则延续（vectorize 直写检索真源）。mirror 侧零改动。

### 5. 部署面

- compose 加 **`main-pg` profile**：独立 `main-pg` 服务（`pgvector/pgvector:pg17`，volume、healthcheck），profile 启用时 server 的 `TIANSHU_DB_URL` 指向它（`docker compose --profile main-pg up -d`）；默认 profile 仍 SQLite。
- Dockerfile builder 增派生+双 generate 两行（`npm run prisma:pg:derive && npx prisma generate --schema prisma/schema.prisma.postgresql` 先于 nest build；PG client 生成物随 dist 进 bundle，`.prisma` 拷贝规则不变——SQLite 版仍首启建 SQLite 库用，PG 模式运行时用 prisma-pg client）。
- README 双模式说明 + **PG 模式为全新初始化**（仅新部署裁定）。

### 6. 测试

- **派生脚本单测**（jest）：datasource 头正确替换、表体逐字节不变、output 行注入。
- **引擎判定 + Proxy 装载单测**：mock 双 client，断言 scheme 分支/转发完整性/非法 scheme 报错/options 注入语义。
- **e2e 可选段**（`SEARCH_E2E_PG_URL` 门控沿用，或独立 env `MAIN_PG_E2E_URL`）：真 PG 上 `db push`（派生 schema）→ server 以 `TIANSHU_DB_URL=postgres://…` 启动 → 健康冒烟 + 登录/建图走 PG 主库 + hybridSearch keyword 同库检索命中（验证 §4 跟随规则）。
- **回归基线不动**：server jest 75 suites、mirror vitest、typecheck 恰 5、drift 双对（本批不动 mirror 双份文件——search-pg 是 server 独有 ✓）。

## 影响面清单

| 文件 | 份数 | 变更 |
|------|------|------|
| `apps/tianshu-server/prisma/derive-pg.mjs` | 新增 | 派生脚本 |
| `apps/tianshu-server/prisma/schema.prisma.postgresql` | 派生产物（跟踪） | 占位版被派生覆盖 |
| `apps/tianshu-server/package.json` | server | +`prisma:pg:derive`/`prisma:generate:pg` scripts |
| `apps/tianshu-server/src/commons/database/prisma.service.ts` | server | Proxy 门面双 client |
| `apps/tianshu-server/src/commons/database/db-url.ts` | server | db push 按 engine 选 schema |
| `apps/tianshu-server/src/core/graph/search-pg.ts` | server 独有 | searchDbTarget 跟随规则一行 |
| `apps/tianshu-server/Dockerfile` / `docker-compose.yml` / `README.md` | server | 部署面 |
| `apps/tianshu-server/src/commons/database/ensure-graph-run-node-table.ts` | server | 实施期新增：DDL 按引擎分流（SQLite 存量升级补建语义在 PG 不存在，早退） |
| `apps/tianshu-server/src/modules/automation/automation-retention.ts` | server | 实施期新增：trim SQL 按引擎分流（PG 引号标识符 + $N 占位符——堵静默裁剪永败） |
| 测试 | — | 派生/装载/方言单测 + e2e 可选段 |
| mirror / core / 双端 executor | 零改动 | — |

## 假设与开放问题

- **假设**：Prisma 对 SQLite 的 Json 字段支持与 PG 行为差异（序列化细节）在现有用法（OperationLog.details 等 7 处）内无实质影响——回归基线覆盖；如有差异在实施期暴露按实际处理。
- **假设**：PG client 生成目录进 `.gitignore` 且 Docker bundle 携带（builder 生成）——本地开发首次需跑 `prisma:generate:pg`（README 注明）。
- **开放**：PG 主库的迁移体系（prisma migrate vs db push 长期策略）——当前两端均 db push（首启建库契约），migrate 体系留后续；主库 PG 模式下的备份/恢复联动（BackupService 面）留后续。
