# 服务端检索层可配指向 PG（FTS + pgvector）设计

日期：2026-10-31
状态：设计定稿（用户已认可六节设计），实施待排期
前置：`docs/superpowers/specs/2026-10-30-hybrid-search-node-design.md`（hybridSearch 三模式已双端落地，检索层现状为内存 BM25 + 内存余弦）

## 背景与目标

hybridSearch Phase 1 以内存 BM25 落地双端同形（FTS5 因 server Prisma 内置 engine 不支持而否决）。内存方案在 server 侧是规模化短板：十万级 chunk 每查询全表分词评分会到秒级。本设计让**服务端检索层可配指向 PostgreSQL**——业界最成熟的服务端 hybrid 检索配方（Supabase 官方形态：PG FTS + pgvector + RRF）。

目标：

1. 新增 env `SEARCH_DB_URL`：空 = 现状本地检索（Prisma 主库 + core 内存 BM25/余弦）；`postgres://…` = PG 检索库（tsvector FTS + pgvector 向量）。
2. mirror 桌面端零改动；executor handler（hybridSearch/vectorize）零改动；core 零改动（tokenize/rrfFuse 复用）。
3. compose 自托管 `pgvector/pgvector` 服务与 server 同栈部署。

## 业界方案综述（决策依据）

- **配方**：PG FTS（tsvector + GIN + ts_rank）+ pgvector（`<=>` 余弦距离）+ RRF 融合——Supabase 官方 hybrid search 教程同构；我们已有 RRF（core `rrfFuse`），PG 只补索引与评分两环。
- **中文分词：应用层分词 + `simple` config**——入库前用 core `tokenize`（Intl.Segmenter）分词空格连接，`to_tsvector('simple', …)` 与查询侧 `to_tsquery('simple', …)` 同源；零 PG 扩展依赖（任何托管/自托管 PG 通用）、与 mirror 内存 BM25 **分词行为完全一致**（跨端检索同构）。备选 zhparser/pg_jieba（需 PG 装扩展、云上多半没有、与端上分词不一致）与 pg_trgm（相关度弱）均不取。
- **pgvector 维度问题**：多 embedding 模型混用、维度不同，而 pgvector 的 HNSW/IVFFlat 索引要求固定维度列。**v1 用无维度 `vector` 列 + 顺序扫描**（PG 端 SQL 余弦，十万级量级与内存方案同级）；HNSW 索引留 v2 按「主流模型部分索引」策略演进（spec 显式取舍，非疏漏）。
- **查询语义**：FTS 词元 OR 连接（`term1 | term2`，对齐 ES 默认 OR 与现有 BM25 宽召回语义），ts_rank 排序；向量 score = `1 - 余弦距离`（方向对齐现有余弦相似度展示）。

## 已裁定决策

| # | 决策 | 结论 |
|---|------|------|
| 1 | 范围分期 | 本期仅检索层可配指向 PG；主库 datasource 双引擎（SQLite⇄PG）为 Phase 2 独立一期 spec |
| 2 | 检索数据真源 | 独立检索库 = 单一真源：`vectorize` 直写检索库，主库不留 vectorChunk 副本；切回默认模式旧数据不迁移、需重新入库 |
| 3 | PG 实例 | compose 自托管 `pgvector/pgvector:pg17` 官方镜像 |
| 4 | 向量 | 支持指向 pgvector（无维度列顺序扫，HNSW 留 v2） |
| 5 | 分词 | 应用层 tokenize + `simple` config（零扩展、双端同源） |
| 6 | 失败哲学 | PG 不可用/扩展缺失显式失败（人话错误码），不静默降级回本地 |

## 设计

### 1. 配置面

- env `SEARCH_DB_URL`：空/未设 = 本地检索（现状代码路径）；`postgres://user:pass@host:5432/db` = PG 检索库。
- `SEARCH_DB_URL` 仅支持 `postgres://`/`postgresql://` scheme，其他值启动/首用时显式报错（`search_pg_unsupported_url` 人话提示），不做静默忽略。
- 解析：`resolveSearchBackend()` 内直读 `process.env.SEARCH_DB_URL`（每调用读一次，廉价且便于测试注入）；「空 = 跟随主库引擎」的语义预留给 Phase 2（本期主库恒 SQLite，空即本地）。
- mirror 桌面端无此配置概念，永不路由——mirror `vector-store.ts` 零改动。

### 2. 检索层路由（server `src/core/graph/vector-store.ts` 薄路由）

`searchFts / searchChunks / upsertChunks / countCollection` **签名与返回形态不变**（`FusedHit[]`/`VectorHit` 等），内部：

```
resolveSearchBackend():
  SEARCH_DB_URL 空  → 本地实现（Prisma 主库 + core rankBm25/cosine，现状代码不动）
  非空 postgres URL → PgSearchBackend（src/core/graph/search-pg.ts）
```

- vector-store 本体仅增 ~20 行路由分支（drift 容差内）；PG 实现全落 server 独有新文件 **`src/core/graph/search-pg.ts`**——不进双份守护面（mirror 无对应文件）。
- `PgSearchBackend`：`pg.Pool` 模块级单例懒创建（`connectionString` 直传），首次使用时幂等建库（DDL 见 §3）；`pg` 驱动懒加载 import（对齐 db-client 惯例）。

### 3. PG 检索库数据面（幂等建表）

```sql
CREATE EXTENSION IF NOT EXISTS vector;  -- 失败 → search_pg_no_vector_ext 人话报错（提示换 pgvector 镜像）
CREATE TABLE IF NOT EXISTS vector_chunk (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT      NOT NULL,
  collection  TEXT        NOT NULL,
  source_name TEXT        NOT NULL,
  seq         INTEGER     NOT NULL,
  text        TEXT        NOT NULL,
  text_tsv    tsvector    NOT NULL,     -- INSERT 时 to_tsvector('simple', $tokensJoined)
  vector      vector,                   -- 无维度（多模型混用）；JSON 数组字面量 '[1,2,3]' 参数化转 ::vector
  model       TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vector_chunk_tsv_gin   ON vector_chunk USING gin(text_tsv);
CREATE INDEX IF NOT EXISTS vector_chunk_user_coll ON vector_chunk (user_id, collection);
```

- 表名 snake_case（PG 惯例；独立库无 Prisma 命名约束）。
- **upsert 幂等**对齐现状语义：同 `user_id + collection + source_name` 先 `DELETE` 后 `INSERT`。
- userId 透传 Number（主库 Int? → PG BIGINT 兼容）。

### 4. 查询

- **FTS（keyword 路）**：
  ```sql
  SELECT id, collection, source_name, text,
         ts_rank(text_tsv, q) AS score
  FROM vector_chunk, to_tsquery('simple', $query) q
  WHERE text_tsv @@ q AND user_id = $1 [AND collection = $2]
  ORDER BY score DESC LIMIT $k
  ```
  `$query` = tokenize 词元以 `" | "` 连接（OR 宽召回）；score 归一方向与现状一致（越大越相关）。`collection` 空串 = 不过滤全集合（对齐本地实现语义）。
- **向量（semantic 路）**：
  ```sql
  SELECT id, collection, source_name, text,
         1 - (vector <=> $qvec::vector) AS score
  FROM vector_chunk
  WHERE model = $m AND user_id = $1 [AND collection = $2]
  ORDER BY vector <=> $qvec::vector LIMIT $k
  ```
  `$qvec` 为 JSON 数组字符串参数化转 `::vector`；按 model 过滤保持维度防线。
- **hybrid 路**：两路各取候选池 `max(50, topK×5)` → map `FusedHit` → core `rrfFuse`——server executor 现有 handler 零改动，融合/分词全部复用 core 纯函数。

### 5. 部署与依赖

- 新增 `apps/tianshu-server/docker-compose.yml`：`server` + `search-pg`（`pgvector/pgvector:pg17`，volume 持久化、healthcheck `pg_isready`、`SEARCH_DB_URL` env 串联、PG 端口按需映射注释说明）。
- `pg` 加入 server `dependencies`（纯 JS 驱动零编译，不撞依赖铁律）。**落地核查项**：server 副本 `db-client.ts` 的 database 节点已懒加载 `import("pg")` 而 server package.json 疑似无此依赖（隐性炸点）——本次显式补齐并回归该路径。
- `apps/tianshu-server/README.md` 补 PG 检索模式部署段（compose 起法、env 说明、单真源语义提示）。

### 6. 错误处理与边界

- `search_pg_unavailable`（连接失败/超时）、`search_pg_no_vector_ext`（扩展缺失）——节点级显式失败，人话提示，不降级回本地（对齐已裁定失败哲学）。
- 空词元短路：PG 路同样在进入 SQL 前短路（对齐本地实现）。
- 存量数据：独立检索库全新无迁移；切回默认模式不回迁（裁定 #2）。

## 测试策略

- **纯函数单测（server jest）**：tsquery 串生成（OR 连接/词元转义）、向量字面量、DDL/SQL 形态——`search-pg.ts` 内 SQL 构造抽纯函数直测。
- **路由单测（server jest，mock pg）**：SEARCH_DB_URL 空/非空分派、upsert 幂等调用序、错误码映射。
- **e2e 可选段**：新独立脚本 `tests/ai/server/e2e-graph-search-pg.ts`（package.json script `test:e2e:graphPg`），env `SEARCH_E2E_PG_URL` 提供才跑、否则 SKIP（对齐现有真模型门控模式）：spawn server 子进程（注入 SEARCH_DB_URL）→ vectorize 入库中文样本 → hybridSearch 三模式断言（keyword 命中/semantic 余弦/hybrid RRF）。
- **回归基线**：现有 server jest 754 与 mirror vitest 4465 不动；drift 双对（graph-executor/graph-vector-store）不增长（vector-store 增量限 ~20 行路由）。

## Phase 2 预留（本期不做）

主库 datasource 双引擎（SQLite⇄PG 切换、31 张表双 schema、数据迁移脚本、`SEARCH_DB_URL` 空时跟随主库引擎的语义启用）——独立一期 spec。本期接口设计（签名不变 + 引擎无关的 FusedHit/VectorHit 形态）已为其铺路。

## 影响面清单

| 文件 | 份数 | 变更 |
|------|------|------|
| `apps/tianshu-server/src/core/graph/vector-store.ts` | server 侧（drift 对） | ~20 行路由分支 |
| `apps/tianshu-server/src/core/graph/search-pg.ts` | 新增（server 独有） | PgSearchBackend 全部实现 |
| `apps/tianshu-server/docker-compose.yml` | 新增 | server + search-pg 双服务 |
| `apps/tianshu-server/package.json` | server | +pg 依赖（兼修 db-client 隐性依赖） |
| `apps/tianshu-server/README.md` | server | PG 模式部署段 |
| `apps/tianshu-server/test/core/graph-search-pg.spec.ts` | 新增 | SQL/路由单测 |
| `tests/ai/server/e2e-graph-search-pg.ts` + 根 package.json script | 新增 | 可选 e2e |
| mirror / core / 双端 executor | 零改动 | — |

## 假设与开放问题

- **假设**：`pg` 不在 server 现有 dependencies（落地核查；在则只确认版本）。
- **假设**：独立检索库仅服务检索（无其他消费方），schema 可自由 snake_case。
- **开放**：HNSW 索引的维度策略（v2，按主流模型部分索引）；PG 检索库多租户（多 server 共库）时 user_id 隔离已天然支持，暂无额外需求。
