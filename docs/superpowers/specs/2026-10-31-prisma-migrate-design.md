# prisma migrate 体系迁移（双引擎双迁移目录）设计

日期：2026-10-31
状态：设计定稿（用户已认可五节设计），实施待排期
前置：`docs/superpowers/specs/2026-10-31-server-pg-main-db-design.md`（主库双引擎——db push 运行时契约为本批替换对象）

## 背景与目标

server schema 变更现走 `db push`（启动时整库盲 diff 直接应用）：无版本、无历史可审、破坏性变更要 `--accept-data-loss`、盲 diff 语义曾把检索表当 drift（双引擎批终审 Critical 实证）。mirror 桌面端已有 `v1 快照 + script/vN` 版本化升级体系，server 侧缺对等物。用户裁定：**弃 db push 长期契约，迁 prisma migrate 体系**；变更预期**向下兼容为主**（加法变更），不预期破坏性变更（工作流约定见 §6）。

## 已裁定决策

| # | 决策 | 结论 |
|---|------|------|
| 1 | 覆盖范围 | 双端全 migrate（生产契约整体替换 db push）；测试临时库保留 db push（快速、无 journal 需求） |
| 2 | 目录结构 | PG schema 迁 `prisma/pg/` 子目录（migrations 目录跟随 schema 位置且不可自定义，避免双 schema 撞目录） |
| 3 | 变更基调 | 向下兼容为主（加法）；破坏性变更须人工介入（显式迁移 + 评审），不依赖工具兜底 |

## 设计

### 1. 目录结构与派生脚本调整

```
prisma/
  schema.prisma              # SQLite 主 schema（不变）
  migrations/                # SQLite 迁移历史（新，git 跟踪）
  pg/
    schema.prisma            # 派生 PG schema（派生脚本输出改此）
    migrations/              # PG 迁移历史（新，git 跟踪）
```

`derive-pg.mjs` 输出路径 `prisma/schema.prisma.postgresql` → `prisma/pg/schema.prisma`；generator output 相应改 `../../src/generated/prisma-pg`（多退一级）；所有引用处同步（`ensureDatabasePg` 的 schema 路径 / `prisma:generate:pg` scripts / Dockerfile derive+generate / e2e / `ensureDatabase` 若引用变体路径处）。

### 2. 迁移历史初始化（baseline）

- 双端各生成 `0_init` 迁移：SQLite `prisma migrate dev --name init`（dev 库）；PG `prisma migrate dev --schema prisma/pg/schema.prisma --name init`（临时 PG，docker throwaway）。
- **存量库 baseline**：运行时首次 migrate deploy 检测到库已有表但 journal 空 → `migrate resolve --applied 0_init`（标记已应用，不执行 SQL）→ 后续 deploy 正常增量。实现为 `ensureDatabase*` 内的一次性探测分支（表存在性经 information_schema/sqlite_master 查询）。

### 3. 运行时契约替换（db-url.ts）

- `ensureDatabase`（SQLite）：缺库分支 db push → **`migrate deploy`**（从零全量建表 ✓）；存量库走 §2 baseline 探测。
- `ensureDatabasePg`（每 boot）：db push → **`migrate deploy`**（journal 幂等，无变更秒级；连接类有界重试语义保留；`tianshu_search` 检索 schema 与 migrate 完全正交——migrate 只管 public 业务表，互不感知）。
- Docker bundle：`cp` 清单补两套 migrations 目录；runner 首启 migrate deploy 走 journal。

### 4. 开发工作流（scripts）

- `prisma:migrate` = `prisma migrate dev`（SQLite，现在真正可用）
- 新增 `prisma:migrate:pg` = `prisma migrate dev --schema prisma/pg/schema.prisma`
- `prisma:deploy` 保留（`migrate deploy`，生产/CI 用）
- `prisma:reset`/`test-db.ts` 测试桩保留 db push（与生产契约分离，头注释注明）

### 5. 工作流约定（spec 契约）

**双端迁移成对提交**：主 schema 变更后，开发者先 `prisma:pg:derive` 派生，再分别 `prisma:migrate` / `prisma:migrate:pg` 生成两端迁移，SQL 评审后随代码同 commit。变更基调向下兼容（加法）；破坏性变更（删列/改类型/重命名）须显式迁移 + 人工评审数据影响，不依赖 `--accept-data-loss`。

### 6. 测试与验收

- 单测：baseline 探测分支（存量库→resolve 一次 / 空库→deploy 全量 / journal 齐全→no-op）mock 层钉形态。
- e2e（真库双端）：fresh deploy 从零 23 表 + 存量库 baseline 升级 + 双 boot 幂等 + 迁移文件新增一列（加法）后 deploy 增量应用——四断言组。
- 回归基线不动：jest 80 suites / mirror vitest / typecheck 恰 5 / drift 双对不增长。
- README：开发工作流段（成对迁移约定）+ 部署段措辞更新（db push → migrate deploy）。

## 影响面清单

| 文件 | 变更 |
|------|------|
| `prisma/pg/schema.prisma`（自 `schema.prisma.postgresql` 迁移）+ `derive-pg.mjs` | 输出路径与 output 调整 |
| `prisma/migrations/` + `prisma/pg/migrations/` | 新（0_init 入库） |
| `src/commons/database/db-url.ts` | db push → migrate deploy + baseline 探测分支 |
| `package.json` scripts | `prisma:migrate:pg` 新增；相关路径更新 |
| `Dockerfile` / `docker-compose.yml` / `README.md` | 部署面与工作流段 |
| e2e（`e2e-main-pg.ts` 等） | 迁移断言组；schema 引用路径同步 |
| 测试 | baseline 单测 + 双端 e2e |
| `test-db.ts` / `prisma:reset` | 保留 db push（注释注明分离语义） |

## 假设与开放问题

- **假设**：`migrate resolve --applied` 的探测分支只在「表存在且 journal 空」触发一次（resolve 后 journal 非空）——幂等。
- **假设**：检索 schema `tianshu_search` 由 search-pg 幂等 DDL 自管，migrate 不涉及（双引擎批已限定隔离）。
- **开放**：CI 中双端迁移成对性检查（lint 级：两端 migrations 目录 latest 时间戳/数量一致性）——本期手工约定，工具化留后续。
