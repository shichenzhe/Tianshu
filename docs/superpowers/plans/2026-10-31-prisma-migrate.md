# prisma migrate 体系迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 弃 db push 长期契约——双引擎双迁移目录的 prisma migrate 体系（生产契约 `migrate deploy` + 存量 baseline 探测 + 成对迁移工作流），SQLite 默认行为等价演进。

**Architecture:** PG schema 迁 `prisma/pg/`（migrations 目录随 schema 位置，避免撞）；双端各生成 `0_init` 入库；`db-url.ts` 的 `ensureDatabase`/`ensureDatabasePg` 以 `migrate deploy` 替换 db push（存量库首次探测 journal 空且表存在 → `migrate resolve --applied 0_init`）；测试桩保留 db push（与生产契约分离）。

**Tech Stack:** Prisma migrate（dev/deploy/resolve）、docker（PG 迁移生成与 e2e）、jest。

**Spec:** `docs/superpowers/specs/2026-10-31-prisma-migrate-design.md`（执行者须同时读）

## Global Constraints

- **检索 schema 正交**：`tianshu_search` 检索表由 search-pg 幂等 DDL 自管，migrate 目录与迁移不得涉及。
- **测试桩分离**：`test-db.ts` / `prisma:reset` 保留 db push，注释注明与生产契约分离。
- **双端成对**：本批只产生 `0_init` 一对；工作流约定写入 README（后续 schema 变更成对生成迁移）。
- **回归基线**：server jest 全绿（含新单测）、mirror vitest、typecheck 恰 5 条预存、drift 双对不增长；检索/双引擎批既有 e2e（graphPg/mainPg）SKIP 路径不破。
- **风格**：server 单引号/trailingComma/中文注释；migrations 生成物按 prisma 原样入库（不手改 SQL）。
- docker daemon 可用（29.x）；PG 迁移生成与 e2e 用 throwaway 容器，结束拆除。

---

### Task 1: PG schema 迁子目录 + 全引用同步

**Files:**
- Modify: `apps/tianshu-server/prisma/derive-pg.mjs`（输出 `prisma/pg/schema.prisma`；output 路径 `../../src/generated/prisma-pg`）
- Rename: `prisma/schema.prisma.postgresql` → `prisma/pg/schema.prisma`（git mv 语义，由派生脚本重生成）
- Modify: 引用面同步——`package.json`（`prisma:generate:pg` 的 --schema 路径）、`src/commons/database/db-url.ts`（`ensureDatabasePg` 的 schemaPath 与 migrations 目录）、`Dockerfile`（derive 输出 + generate --schema + bundle cp 路径）、`tests/ai/server/e2e-main-pg.ts` 与 `e2e-graph-search-pg.ts`（如有 schema 变体路径引用）
- Test: `apps/tianshu-server/test/core/derive-pg.spec.ts`（断言路径更新）

**Interfaces:**
- Produces: PG schema 唯一权威路径 `prisma/pg/schema.prisma`（后续任务与所有脚本的引用基准）；`src/generated/prisma-pg` 生成物路径不变（require 面零改动）。

- [ ] **Step 1**: 更新 derive-pg.spec 断言（输出路径/output 多一级 `../`）→ RED
- [ ] **Step 2**: 改 `derive-pg.mjs`（out 路径 `pg/schema.prisma`、output `../../src/generated/prisma-pg`；`mkdir -p pg`）；跑派生生成新位置；删除旧 `schema.prisma.postgresql`
- [ ] **Step 3**: 全引用 grep 同步（`schema.prisma.postgresql` 与 `../src/generated` 全仓扫——server src/Dockerfile/package.json/e2e；`ensureDatabasePg` 的 findSchemaRoot 定位按新层级核对 dist 运行时布局）
- [ ] **Step 4**: 验证：derive spec 绿；`npm run prisma:generate:pg` 产物落位且 `require` 面 OK；全量 jest 绿；`docker compose config -q`（TIANSHU_TOKEN=x）VALID
- [ ] **Step 5**: Commit `refactor(server): PG schema 迁 prisma/pg 子目录——migrations 目录避撞前置（引用面全同步）`

---

### Task 2: 双端 0_init 迁移生成（真跑）

**Files:**
- Create: `apps/tianshu-server/prisma/migrations/0_init/migration.sql` + `migration_lock.toml`
- Create: `apps/tianshu-server/prisma/pg/migrations/0_init/migration.sql` + `migration_lock.toml`

**Interfaces:**
- Produces: 两端 init 迁移（T3/T5 依赖；journal 名 `0_init`）。

- [ ] **Step 1**: SQLite 端——临时库 env（`TIANSHU_DB_URL=file:/tmp/migrate-init-$$$.db` 不适用：migrate dev 用 schema url/DATABASE_URL——按 prisma 惯例 `DATABASE_URL=file:./local.db` dev 态直接跑会动真库；安全做法：复制现 dev 库或空库 + `npx prisma migrate dev --name init --skip-generate`，生成后 `git status` 核对仅 migrations 入库，dev 库恢复（本地 gitignored，被 migrate 打 journal 无碍——如介意则备份还原）
- [ ] **Step 2**: PG 端——throwaway pgvector 容器（55432 端口）→ `DATABASE_URL=postgres://… npx prisma migrate dev --schema prisma/pg/schema.prisma --name init --skip-generate` → 迁移落 `prisma/pg/migrations/0_init` → 拆容器
- [ ] **Step 3**: 核对：两份 migration.sql 各含 23 表全量 DDL（`grep -c "CREATE TABLE"` = 23）；SQLite 版无 PG 方言残留、PG 版引号 camelCase 与派生 schema @@map 一致；migration_lock.toml provider 各为 sqlite/postgresql
- [ ] **Step 4**: Commit `feat(server): 双端 0_init 基线迁移——23 表全量 DDL 入库（migrate 体系基线）`

---

### Task 3: db-url 契约替换（migrate deploy + baseline 探测）

**Files:**
- Modify: `apps/tianshu-server/src/commons/database/db-url.ts`（`ensureDatabase` 缺库分支与 `ensureDatabasePg`：db push → migrate deploy；新增 baseline 探测）
- Test: `apps/tianshu-server/test/core/db-url-migrate.spec.ts`（新建）

**Interfaces:**
- Produces: `ensureDatabase`（sqlite）与 `ensureDatabasePg`（pg）内部 spawn `prisma migrate deploy --schema <对应 schema>`；baseline 探测函数 `needsBaselineResolve(engine)`——表存在（sqlite_master/information_schema 查询经临时连接或 `prisma db execute`）且 `_prisma_migrations` 表空/不存在 → 先 spawn `migrate resolve --applied 0_init` 再 deploy；连接类有界重试保留。

- [ ] **Step 1**: TDD——mock spawn 序列断言三分支：空库（deploy 直接跑，无 resolve）/ 存量表+journal 空（resolve 0_init → deploy）/ journal 齐（仅 deploy）。RED
- [ ] **Step 2**: 实现（探测用 `prisma db execute` 跑 `SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE '_prisma%'` / PG 版 `information_schema.tables WHERE table_schema='public'`——spawn 形态沿既有先例；表数 >0 且迁移表无 0_init 行 → resolve）
- [ ] **Step 3**: 全量 jest 绿（既有 db-url-engine.spec 等不受破——spawn 命令串变更需同步其断言则改之）
- [ ] **Step 4**: Commit `feat(server): 运行时契约替换——migrate deploy 替代 db push（存量 baseline 探测一次性 resolve）`

---

### Task 4: 部署面与工作流文档

**Files:**
- Modify: `apps/tianshu-server/Dockerfile`（bundle 组装 cp 补 `prisma/migrations` 与 `prisma/pg/migrations`；runner 首启即走新契约无需改动）
- Modify: `apps/tianshu-server/README.md`（开发工作流段：成对迁移约定 + migrate dev/deploy 用法；部署段 db push 措辞更新）

**Interfaces:**
- Consumes: T1-T3。
- Produces: 镜像含双 migrations；README 工作流契约。

- [ ] **Step 1**: Dockerfile bundle cp 两目录（.dockerignore 无碍——prisma 目录在 bundle 组装显式 cp）
- [ ] **Step 2**: README 段（spec §5 约定原文落）：
```markdown
### schema 变更工作流（migrate 体系）

主 `schema.prisma` 变更后：① `npm run prisma:pg:derive`（派生 PG 变体）
② `npm run prisma:migrate` 与 `npm run prisma:migrate:pg` 双端各生成迁移
③ 迁移 SQL 评审后与代码同 commit（**双端成对提交**）。基调向下兼容
（加法）；破坏性变更须显式迁移+人工评审，禁 `--accept-data-loss`。
生产启动自动 `migrate deploy`（journal 幂等增量；存量库首启自动
baseline resolve）。测试桩（prisma:reset/test-db）保留 db push 快速通道。
```
- [ ] **Step 3**: 验证 `docker build` 到 bundle 层（缓存快）+ 镜像内 `ls /app/prisma/migrations /app/prisma/pg/migrations` 各含 0_init；`docker compose config -q` VALID
- [ ] **Step 4**: Commit `feat(server): migrate 部署面——bundle 双 migrations 随行 + README 成对迁移工作流`

---

### Task 5: 双端 e2e 四断言组 + 全量回归

**Files:**
- Modify: `tests/ai/server/e2e-main-pg.ts`（追加迁移断言组；schema 路径引用若 T1 未尽则补）
- Test: 全量回归（无新 spec 文件）

**Interfaces:**
- Consumes: T1-T4 全部。

- [ ] **Step 1**: e2e-main-pg 追加四断言组（沿既有 spawn/两 boot 手法）：
  ① fresh：全新 PG → server 首启 → 23 表 + `_prisma_migrations` journal 含 `0_init`
  ② baseline：手工 `db push` 造假存量库（无 journal）→ server 首启 → journal 自动补 `0_init`（resolved）→ 健康
  ③ 幂等：二次 boot → journal 不重复、健康
  ④ 增量：主 schema 加可空列（如 `option.note2 String?`）→ 派生 + 双端 migrate dev 生成 `1_add_note2` → server 重启 deploy → 新列存在 → **还原该试验迁移与 schema 改动**（试验品不入库——e2e 内动态生成或分支上验证后 revert，实现取简：e2e 脚本内经 db execute 直接对 PG 加列模拟「待应用迁移」不可行（deploy 走文件）——务实裁剪：④ 改为验证 deploy 对「journal 已含全部」的 no-op 语义 + 手工演示步骤写入报告；真增量演示由 T2 流程在报告中留证）
- [ ] **Step 2**: live 跑（throwaway PG）：SKIP 路径 + live 全断言组；SQLite 侧首启自愈经本地空库 spawn 冒烟（TIANSHU_DB_URL 指临时空文件 → server 起 → 表齐）
- [ ] **Step 3**: 全量回归：root `npm run test` + server jest 全量 + `npm run typecheck`（恰 5）+ `npm run check:drift`（双对不增长）+ 既有 graphPg/mainPg SKIP 路径复核
- [ ] **Step 4**: 终验三项：① migrations 双端成对且 23 表全量；② 检索 schema 零涉及（migration.sql 无 tianshu_search）；③ test-db/reset 仍 db push（分离注释在位）
- [ ] **Step 5**: Commit `test(server): migrate 体系 e2e——fresh/baseline/幂等/自愈四断言组 + 全量回归`
