# 服务端检索层可配指向 PG（FTS + pgvector）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 服务端检索层经 env `SEARCH_DB_URL` 可配指向 PostgreSQL 检索库（tsvector FTS + pgvector 向量），默认空值保持现状本地检索；mirror/core/executor 零改动。

**Architecture:** 路由落在 server `vector-store.ts` 四个导出函数内部（签名不变，`isPgSearchConfigured` 分派）；PG 实现全落 server 独有新文件 `src/core/graph/search-pg.ts`（纯函数 SQL 层 + Pool 运行时层，pg 懒加载）；独立检索库为单一真源（vectorize 直写，主库不留副本）；分词/融合复用 core `tokenize/rrfFuse`（server 经 dist 消费）。

**Tech Stack:** pg（node-postgres，纯 JS）、PG FTS（tsvector/GIN/ts_rank + `simple` config）、pgvector（无维度 `vector` 列顺序扫）、jest（server）、docker-compose（pgvector/pgvector:pg17）。

**Spec:** `docs/superpowers/specs/2026-10-31-server-pg-search-design.md`（执行者须同时读）

## Global Constraints

- **零改动铁律**：mirror 侧任何文件、core 包、双端 `graph-executor.ts` handler——均不得改动；`vector-store.ts` 仅增 ~20 行路由（drift 容差内，改后跑 `npm run check:drift` 确认 graph-vector-store 不超基线 12+2）。
- **签名不变**：`searchFts/searchChunks/upsertChunks/countCollection` 的参数与返回形态（`FusedHit[]`/`VectorHit[]` 等）不变——消费方（executor handler）无感知。
- **错误码**：`search_pg_unavailable`（连接失败）、`search_pg_no_vector_ext`（vector 扩展缺失）、`search_pg_unsupported_url`（非 postgres scheme）——`VectorStoreError` 形态、人话中文提示、不静默降级回本地。
- **server 代码风格**：单引号、分号、trailingComma=all（Prettier）；中文意图注释；文件 kebab-case。
- **配置**：`SEARCH_DB_URL` 走 `process.env` 直读（不入 config.yml——含凭据，对齐 JWT_SECRET 的 .env 惯例）；仅支持 `postgres://`/`postgresql://`。
- **测试环境**：单测一律 mock pg（jest.mock）；真 PG 交互只在可选 e2e（env `SEARCH_E2E_PG_URL` 门控，无则 SKIP 输出）。回归基线：server jest 既有 suite 全绿、mirror vitest 不回归（本计划不涉 mirror 代码但跑全量确认）。
- **pg 依赖**：纯 JS 驱动（无原生编译），加入 server `dependencies` 不撞依赖铁律；jest 跑前确认 `apps/tianshu-server/node_modules` 可解析（worktree 环境注意软链）。
- **提交纪律**：每 Task 一 commit，中文 conventional（`feat(graph): …`）；dist 为 git-ignored 不入 commit。

---

### Task 1: 依赖与部署面（pg 依赖 + docker-compose + README）

**Files:**
- Modify: `apps/tianshu-server/package.json`（dependencies + `pg`）
- Create: `apps/tianshu-server/docker-compose.yml`
- Modify: `apps/tianshu-server/README.md`（部署段补 PG 检索模式）

**Interfaces:**
- Produces: `pg` 可被 server 代码 `import`（Task 2/3 依赖）；compose 可起 `search-pg` 服务（Task 5 e2e 依赖）。

- [ ] **Step 1: 加 pg 依赖**

`apps/tianshu-server/package.json` dependencies 加 `"pg": "^8.13.0"`（落地时 `npm install -w apps/tianshu-server pg` 或手改 + `npm install`；纯 JS 无 install-scripts 顾虑）。确认 db-client 的 database 节点 postgres 引擎自此依赖显式可达（隐性炸点兼修）。

- [ ] **Step 2: 写 docker-compose.yml**

```yaml
# apps/tianshu-server/docker-compose.yml
# 检索模式部署：server + PG 检索库（pgvector 官方镜像，含 FTS 所需全部能力）
# 默认（SQLite 本地检索）部署不需要本文件——单独 docker run server 即可。
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
    build: .
    environment:
      SEARCH_DB_URL: postgres://tianshu:tianshu_search@search-pg:5432/tianshu_search
    depends_on:
      search-pg:
        condition: service_healthy
    ports:
      - "3000:3000"

volumes:
  search-pg-data: {}
```

- [ ] **Step 3: README 补 PG 检索模式段**

在 `apps/tianshu-server/README.md` 部署章节追加（对齐文件既有中文风格）：

```markdown
## PG 检索模式（可选）

默认检索走本机 SQLite（内存 BM25 + 余弦）。配置 env `SEARCH_DB_URL`
（`postgres://…`）后，检索层改指 PostgreSQL 检索库（tsvector 全文 +
pgvector 向量，Supabase hybrid 配方同构）：

- `docker compose up -d` 起 server + `pgvector/pgvector:pg17` 检索库
  （compose 已串联 `SEARCH_DB_URL`）
- **单真源语义**：检索库独立指定时，`vectorize` 入库直写检索库，主库
  不留 vectorChunk 副本；取消配置切回本地后旧数据不迁移、需重新入库
- 仅支持 `postgres://`/`postgresql://` 连接串；连接失败/扩展缺失时
  检索节点显式报错（不静默降级）
```

- [ ] **Step 4: 基线验证 + Commit**

Run: `cd apps/tianshu-server && npx jest --listTests | tail -2 && npx jest test/core/graph-executor.spec.ts 2>&1 | tail -3`
Expected: 既有 suite 不因新依赖破（pg 仅安装未引用）。
Run: `docker compose config -q`（若本机有 docker；无则跳过并注明）
Expected: compose 语法合法。

```bash
git add apps/tianshu-server/package.json apps/tianshu-server/package-lock.json apps/tianshu-server/docker-compose.yml apps/tianshu-server/README.md
git commit -m "feat(graph): server PG 检索部署面——pg 依赖/compose 双服务/README 模式说明"
```

---

### Task 2: search-pg.ts 纯函数层（SQL/DDL 生成）+ 单测

**Files:**
- Create: `apps/tianshu-server/src/core/graph/search-pg.ts`（本 Task 只落纯函数层与常量）
- Test: `apps/tianshu-server/test/core/graph-search-pg.spec.ts`（新建）

**Interfaces:**
- Consumes: core `tokenize`（经 `@tianshu/core` dist）。
- Produces（Task 3/4 依赖）:
  - `PG_DDL: string[]`（幂等建库语句序列）
  - `buildFtsQuery(tokens: string[]): string`（`term1 | term2` 形态）
  - `buildFtsSql(hasCollection: boolean): { sql: string; paramCount: number }`
  - `buildVectorSql(hasCollection: boolean): { sql: string; paramCount: number }`
  - `buildVectorLiteral(vector: number[]): string`（`'[1,2,3]'` pgvector 字面量）
  - `buildUpsertInsertSql(chunkCount: number): string`（multi-VALUES，含 to_tsvector 与 ::vector 转换）

- [ ] **Step 1: 写失败测试**

```typescript
// apps/tianshu-server/test/core/graph-search-pg.spec.ts
/**
 * search-pg 纯函数层：FTS 查询串（OR 连接/词元直传——词元已过 tokenize
 * 白名单无需转义）、向量字面量、DDL/SQL 生成（collection 可选段与占位
 * 序号正确性）。
 */
import {
  PG_DDL, buildFtsQuery, buildFtsSql, buildVectorSql,
  buildVectorLiteral, buildUpsertInsertSql,
} from '../../src/core/graph/search-pg';

describe('buildFtsQuery', () => {
  it('词元 OR 连接（to_tsquery 形态）', () => {
    expect(buildFtsQuery(['容', '错', '设计'])).toBe('容 | 错 | 设计');
  });
  it('空词元产出空串（调用侧短路前置防御）', () => {
    expect(buildFtsQuery([])).toBe('');
  });
});

describe('buildVectorLiteral', () => {
  it('JSON 数组字面量（pgvector 输入形态）', () => {
    expect(buildVectorLiteral([0.1, -0.2, 0.3])).toBe('[0.1,-0.2,0.3]');
  });
});

describe('SQL 生成（占位序号随 collection 段偏移）', () => {
  it('FTS：无 collection 段 $1=匹配串 $2=userId $3=limit', () => {
    const { sql } = buildFtsSql(false);
    expect(sql).toContain('to_tsquery(\'simple\', $1)');
    expect(sql).toContain('user_id = $2');
    expect(sql).toContain('LIMIT $3');
    expect(sql).not.toContain('collection = ');
  });
  it('FTS：有 collection 段占位顺延', () => {
    const { sql } = buildFtsSql(true);
    expect(sql).toContain('user_id = $2');
    expect(sql).toContain('collection = $3');
    expect(sql).toContain('LIMIT $4');
  });
  it('向量：无 collection 段 $1=向量 $2=model $3=userId $4=limit，余弦距离排序 + score 取 1-距离', () => {
    const { sql } = buildVectorSql(false);
    expect(sql).toContain('$1::vector');
    expect(sql).toContain('model = $2');
    expect(sql).toContain('user_id = $3');
    expect(sql).toContain('ORDER BY vector <=> $1::vector');
    expect(sql).toContain('1 - (vector <=> $1::vector) AS score');
    expect(sql).toContain('LIMIT $4');
    expect(sql).toContain('vector IS NOT NULL');
  });
  it('向量：有 collection 段占位顺延', () => {
    const { sql } = buildVectorSql(true);
    expect(sql).toContain('collection = $4');
    expect(sql).toContain('LIMIT $5');
  });
});

describe('PG_DDL 与 upsert 语句', () => {
  it('DDL 含扩展/表/GIN/复合索引且全部 IF NOT EXISTS 幂等', () => {
    expect(PG_DDL.join('\n')).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(PG_DDL.join('\n')).toContain('CREATE TABLE IF NOT EXISTS vector_chunk');
    expect(PG_DDL.join('\n')).toContain('USING gin(text_tsv)');
    expect(PG_DDL.join('\n')).toContain('(user_id, collection)');
    expect(PG_DDL.join('\n')).toContain('text_tsv tsvector NOT NULL');
    expect(PG_DDL.join('\n')).toContain('vector vector');
  });
  it('upsert INSERT：multi-VALUES 含 to_tsvector(simple) 与 ::vector 转换', () => {
    const sql = buildUpsertInsertSql(2);
    expect(sql).toContain("to_tsvector('simple', $6)"); // 每块 8 参：user/coll/source/seq/text/分词/向量/model
    expect(sql).toContain('$7::vector');
    expect(sql).toMatch(/VALUES \(.+\), \(.+\)/); // 两行 VALUES
    expect(sql).toContain('INSERT INTO vector_chunk');
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cd apps/tianshu-server && npx jest test/core/graph-search-pg.spec.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写纯函数层实现**

```typescript
// apps/tianshu-server/src/core/graph/search-pg.ts
/**
 * PG 检索后端（server 独有，spec 2026-10-31）：SEARCH_DB_URL 指向的
 * 独立检索库，tsvector FTS + pgvector 向量（无维度列顺序扫，HNSW 留
 * v2 维度策略）；独立库 = 检索单一真源（vectorize 直写，主库无副本）。
 * 分词与融合复用 @tianshu/core（tokenize/rrfFuse），与 mirror 内存
 * BM25 检索行为同源。
 */
import { tokenize } from '@tianshu/core';

/** 幂等建库：扩展→表→索引（首次检索/入库前执行；扩展缺失由调用方
 * 转 search_pg_no_vector_ext 人话错误） */
export const PG_DDL: string[] = [
  'CREATE EXTENSION IF NOT EXISTS vector',
  `CREATE TABLE IF NOT EXISTS vector_chunk (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT      NOT NULL,
  collection  TEXT        NOT NULL,
  source_name TEXT        NOT NULL,
  seq         INTEGER     NOT NULL,
  text        TEXT        NOT NULL,
  text_tsv    tsvector    NOT NULL,
  vector      vector,
  model       TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
  'CREATE INDEX IF NOT EXISTS vector_chunk_tsv_gin ON vector_chunk USING gin(text_tsv)',
  'CREATE INDEX IF NOT EXISTS vector_chunk_user_coll ON vector_chunk (user_id, collection)',
];

/** to_tsquery 串：词元 OR 连接（词元来自 tokenize 白名单，无语法字符） */
export function buildFtsQuery(tokens: string[]): string {
  return tokens.join(' | ');
}

/** pgvector 输入字面量：紧凑 JSON 数组串 */
export function buildVectorLiteral(vector: number[]): string {
  return JSON.stringify(vector);
}

/** FTS 查询语句（ts_rank 降序；占位序号随 collection 段偏移） */
export function buildFtsSql(hasCollection: boolean): { sql: string; paramCount: number } {
  const sql = `SELECT id, collection, source_name, text,
  ts_rank(text_tsv, to_tsquery('simple', $1)) AS score
FROM vector_chunk
WHERE text_tsv @@ to_tsquery('simple', $1)
  AND user_id = $2${hasCollection ? '\n  AND collection = $3' : ''}
ORDER BY score DESC LIMIT $${hasCollection ? 4 : 3}`;
  return { sql, paramCount: hasCollection ? 4 : 3 };
}

/** 向量查询语句（余弦距离排序，score = 1 - 距离；model 过滤保维度防线；
 * vector IS NOT NULL 防御 NULL 行） */
export function buildVectorSql(hasCollection: boolean): { sql: string; paramCount: number } {
  const sql = `SELECT id, collection, source_name, text,
  1 - (vector <=> $1::vector) AS score
FROM vector_chunk
WHERE vector IS NOT NULL
  AND model = $2
  AND user_id = $3${hasCollection ? '\n  AND collection = $4' : ''}
ORDER BY vector <=> $1::vector LIMIT $${hasCollection ? 5 : 4}`;
  return { sql, paramCount: hasCollection ? 5 : 4 };
}

/** upsert INSERT：multi-VALUES；每块参数序 = user_id, collection,
 * source_name, seq, text, 分词文本(to_tsvector), 向量(::vector), model */
export function buildUpsertInsertSql(chunkCount: number): string {
  const rows = Array.from({ length: chunkCount }, (_, i) => {
    const b = i * 8;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, to_tsvector('simple', $${b + 6}), $${b + 7}::vector, $${b + 8})`;
  });
  return `INSERT INTO vector_chunk(user_id, collection, source_name, seq, text, text_tsv, vector, model)
VALUES ${rows.join(', ')}`;
}

// （运行时层见下方 Task 3 追加——本文件占位注释，Task 3 删除）
export const _RUNTIME_LAYER_PLACEHOLDER = true;
```

> 注：文件尾 `_RUNTIME_LAYER_PLACEHOLDER` 行在 Task 3 实现运行时层时删除（避免空 import `tokenize` 告警——本 Task 暂注释掉 tokenize import，Task 3 启用）。

- [ ] **Step 4: 跑测试验证通过**

Run: `cd apps/tianshu-server && npx jest test/core/graph-search-pg.spec.ts`
Expected: PASS 全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-server/src/core/graph/search-pg.ts apps/tianshu-server/test/core/graph-search-pg.spec.ts
git commit -m "feat(graph): search-pg 纯函数层——DDL/FTS/向量 SQL 生成（占位序号钉板）"
```

---

### Task 3: search-pg.ts 运行时层（Pool/建库/upsert/双检索/错误码）+ mock 单测

**Files:**
- Modify: `apps/tianshu-server/src/core/graph/search-pg.ts`（追加运行时层，删占位行）
- Test: `apps/tianshu-server/test/core/graph-search-pg.spec.ts`（追加 mock 用例）

**Interfaces:**
- Consumes: Task 2 全部纯函数；`VectorChunkRow`/`VectorHit` 类型自 `./vector-store`（type-only import，不引运行时依赖）；core `FusedHit`。
- Produces（Task 4 依赖）:
  - `searchDbTarget(): string | null`——读 `process.env.SEARCH_DB_URL`；空返回 null；非 postgres/postgresql scheme 抛 `VectorStoreError('search_pg_unsupported_url', 人话)`
  - `isPgSearchConfigured(): boolean`——`searchDbTarget() !== null`（协议非法会在四函数入口统一抛，见 Task 4）
  - `ensureSearchPg(): Promise<void>`（幂等建库；扩展缺失转 `search_pg_no_vector_ext`）
  - `upsertChunksPg(params: { userId: number; collection: string; sourceName: string; model: string; chunks: VectorChunkRow[] }): Promise<void>`
  - `searchFtsPg(params: { userId: number; collection: string; queryTokens: string[]; limit: number }): Promise<FusedHit[]>`
  - `searchChunksPg(params: { userId: number; collection: string; model: string; queryVector: number[]; topK: number }): Promise<VectorHit[]>`
  - `countCollectionPg(userId: number, collection: string): Promise<number>`
  - 连接类失败统一转 `VectorStoreError('search_pg_unavailable', 人话含原始信息)`

- [ ] **Step 1: 写失败测试（追加到 spec 文件）**

```typescript
// ---- 追加：运行时层（mock pg 模块）----
import { VectorStoreError } from '../../src/core/graph/vector-store';

jest.mock('pg', () => {
  const query = jest.fn();
  const connect = jest.fn(async () => ({ query, release: jest.fn() }));
  return { Pool: jest.fn(() => ({ query, connect, end: jest.fn() })), __query: query, __connect: connect };
});

describe('searchDbTarget（env 读取与协议校验）', () => {
  const OLD = process.env.SEARCH_DB_URL;
  afterEach(() => { process.env.SEARCH_DB_URL = OLD; });

  it('未设/空串返回 null；postgres/postgresql 串透传', async () => {
    const { searchDbTarget } = await import('../../src/core/graph/search-pg');
    delete process.env.SEARCH_DB_URL;
    expect(searchDbTarget()).toBeNull();
    process.env.SEARCH_DB_URL = 'postgres://u:p@h:5432/d';
    expect(searchDbTarget()).toBe('postgres://u:p@h:5432/d');
    process.env.SEARCH_DB_URL = 'postgresql://u:p@h:5432/d';
    expect(searchDbTarget()).toBe('postgresql://u:p@h:5432/d');
  });
  it('非 postgres scheme 抛 search_pg_unsupported_url', async () => {
    const { searchDbTarget } = await import('../../src/core/graph/search-pg');
    process.env.SEARCH_DB_URL = 'mysql://u:p@h/d';
    expect(() => searchDbTarget()).toThrow(VectorStoreError);
    expect(() => searchDbTarget()).toThrow(/postgres/);
  });
});

describe('PG 运行时（mock pg.Pool.query）', () => {
  it('ensureSearchPg 顺序执行 DDL；扩展失败转 search_pg_no_vector_ext', async () => {
    const { ensureSearchPg, PG_DDL } = await import('../../src/core/graph/search-pg');
    const { __query } = require('pg') as { __query: jest.Mock };
    __query.mockReset().mockResolvedValue({ rows: [] });
    process.env.SEARCH_DB_URL = 'postgres://u:p@h:5432/d';
    await ensureSearchPg();
    expect(__query).toHaveBeenCalledTimes(PG_DDL.length);
    __query.mockReset().mockRejectedValue(new Error('extension "vector" is not available'));
    await expect(ensureSearchPg()).rejects.toThrow(/pgvector/i);
  });

  it('searchFtsPg：空词元短路不发查询；命中行 map FusedHit（rank 从 1）', async () => {
    const { searchFtsPg } = await import('../../src/core/graph/search-pg');
    const { __query } = require('pg') as { __query: jest.Mock };
    __query.mockReset();
    expect(await searchFtsPg({ userId: 1, collection: 'c', queryTokens: [], limit: 5 })).toEqual([]);
    expect(__query).not.toHaveBeenCalled();
    __query.mockResolvedValue({ rows: [
      { id: 9, collection: 'c', source_name: 's', text: '原文', score: 0.8 },
    ] });
    const hits = await searchFtsPg({ userId: 1, collection: 'c', queryTokens: ['容'], limit: 5 });
    expect(hits[0]).toMatchObject({ chunkId: 9, sourceName: 's', text: '原文', rank: 1 });
    expect(__query).toHaveBeenCalledWith(expect.stringContaining('to_tsquery'), expect.arrayContaining(['容', 1, 'c', 5]));
  });

  it('upsertChunksPg：先删后插、分词进 to_tsvector 参数、事务包裹', async () => {
    const { upsertChunksPg } = await import('../../src/core/graph/search-pg');
    const { __connect } = require('pg') as { __connect: jest.Mock };
    const tx = { query: jest.fn(async () => ({ rows: [] })), release: jest.fn() };
    __connect.mockReset().mockResolvedValue(tx);
    await upsertChunksPg({
      userId: 1, collection: 'c', sourceName: 's', model: 'm',
      chunks: [{ seq: 0, text: '分布式系统的容错设计', vector: [0.1, 0.2] }],
    });
    const calls = tx.query.mock.calls.map((c) => c[0]);
    expect(calls[0]).toContain('BEGIN');
    expect(calls[1]).toContain('DELETE FROM vector_chunk');
    expect(calls[2]).toContain('to_tsvector');
    // 分词参数：空格连接词元串（ICU 实际切分以 tokenize 运行时输出为准——
    // 「容」「错」「设计」等词元必然在列，精确整串不做脆弱断言）
    const tokensParam = String(tx.query.mock.calls[2][1][5]);
    expect(tokensParam).toContain('容');
    expect(tokensParam).toContain('设计');
    expect(tokensParam).toContain(' ');
    expect(calls.at(-1)).toContain('COMMIT');
    expect(tx.release).toHaveBeenCalled();
  });

  it('连接失败转 search_pg_unavailable 人话错误', async () => {
    const { searchFtsPg } = await import('../../src/core/graph/search-pg');
    const { __query } = require('pg') as { __query: jest.Mock };
    __query.mockReset().mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    await expect(searchFtsPg({ userId: 1, collection: '', queryTokens: ['x'], limit: 5 }))
      .rejects.toThrow(/PG 检索库/);
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cd apps/tianshu-server && npx jest test/core/graph-search-pg.spec.ts`
Expected: 新用例 FAIL（运行时层未实现）。

- [ ] **Step 3: 写运行时层实现（追加进 search-pg.ts）**

```typescript
import type { VectorChunkRow, VectorHit, VectorStoreError as _VSE } from './vector-store';
// ↑ 实际落地：VectorStoreError 需值导入用于构造——
// import { VectorStoreError } from './vector-store';（type-only 行删除）
import type { FusedHit } from '@tianshu/core';

const POSTGRES_SCHEME = /^postgres(ql)?:\/\//;

/** 读 SEARCH_DB_URL：空=本地检索（null）；非法 scheme 显式报错 */
export function searchDbTarget(): string | null {
  const url = process.env.SEARCH_DB_URL ?? '';
  if (url === '') {
    return null;
  }
  if (!POSTGRES_SCHEME.test(url)) {
    throw new VectorStoreError(
      'search_pg_unsupported_url',
      'SEARCH_DB_URL 仅支持 postgres:// 或 postgres:// 连接串（当前配置不是 PG 地址）',
    );
  }
  return url;
}

export function isPgSearchConfigured(): boolean {
  return searchDbTarget() !== null;
}

let pgPool: import('pg').Pool | null = null;

async function getPool(): Promise<import('pg').Pool> {
  if (!pgPool) {
    const { Pool } = await import('pg');
    pgPool = new Pool({ connectionString: searchDbTarget()! });
  }
  return pgPool;
}

function toPgError(e: unknown): VectorStoreError {
  if (e instanceof VectorStoreError) {
    return e;
  }
  return new VectorStoreError(
    'search_pg_unavailable',
    `PG 检索库不可用：${e instanceof Error ? e.message : String(e)}`,
  );
}

/** 幂等建库（扩展→表→索引）；扩展缺失给人话提示换 pgvector 镜像 */
export async function ensureSearchPg(): Promise<void> {
  try {
    const pool = await getPool();
    for (const ddl of PG_DDL) {
      await pool.query(ddl);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/extension|vector/i.test(message) && !/ECONN|timeout/i.test(message)) {
      throw new VectorStoreError(
        'search_pg_no_vector_ext',
        'PG 检索库缺少 pgvector 扩展——请使用 pgvector/pgvector 官方镜像（见 docker-compose.yml）',
      );
    }
    throw toPgError(e);
  }
}

export async function upsertChunksPg(params: {
  userId: number; collection: string; sourceName: string; model: string;
  chunks: VectorChunkRow[];
}): Promise<void> {
  const client = await (await getPool()).connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM vector_chunk WHERE user_id = $1 AND collection = $2 AND source_name = $3',
      [params.userId, params.collection, params.sourceName],
    );
    if (params.chunks.length > 0) {
      await client.query(buildUpsertInsertSql(params.chunks.length), params.chunks.flatMap((chunk) => [
        params.userId, params.collection, params.sourceName, chunk.seq, chunk.text,
        tokenize(chunk.text).join(' '), buildVectorLiteral(chunk.vector), params.model,
      ]));
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw toPgError(e);
  } finally {
    client.release();
  }
}

export async function searchFtsPg(params: {
  userId: number; collection: string; queryTokens: string[]; limit: number;
}): Promise<FusedHit[]> {
  if (params.queryTokens.length === 0) {
    return [];
  }
  try {
    await ensureSearchPg();
    const { sql } = buildFtsSql(params.collection !== '');
    const values = params.collection !== ''
      ? [buildFtsQuery(params.queryTokens), params.userId, params.collection, params.limit]
      : [buildFtsQuery(params.queryTokens), params.userId, params.limit];
    const result = await (await getPool()).query(sql, values);
    return (result.rows as Array<{ id: number; collection: string; source_name: string; text: string; score: number }>)
      .map((row, index) => ({
        chunkId: Number(row.id), sourceName: row.source_name,
        collection: row.collection, text: row.text,
        score: Number(row.score), rank: index + 1,
      }));
  } catch (e) {
    throw toPgError(e);
  }
}

export async function searchChunksPg(params: {
  userId: number; collection: string; model: string; queryVector: number[]; topK: number;
}): Promise<VectorHit[]> {
  try {
    await ensureSearchPg();
    const { sql } = buildVectorSql(params.collection !== '');
    const values = params.collection !== ''
      ? [buildVectorLiteral(params.queryVector), params.model, params.userId, params.collection, params.topK]
      : [buildVectorLiteral(params.queryVector), params.model, params.userId, params.topK];
    const result = await (await getPool()).query(sql, values);
    return (result.rows as Array<{ id: number; collection: string; source_name: string; text: string; score: number }>)
      .map((row) => ({
        chunkId: Number(row.id), sourceName: row.source_name,
        collection: row.collection, text: row.text, score: Number(row.score),
      }));
  } catch (e) {
    throw toPgError(e);
  }
}

export async function countCollectionPg(userId: number, collection: string): Promise<number> {
  try {
    const result = await (await getPool()).query(
      'SELECT COUNT(*)::int AS n FROM vector_chunk WHERE user_id = $1 AND collection = $2',
      [userId, collection],
    );
    return Number((result.rows[0] as { n: number }).n);
  } catch (e) {
    throw toPgError(e);
  }
}
```

> 注：落地时删除 Task 2 的 `_RUNTIME_LAYER_PLACEHOLDER` 行；`VectorStoreError` 从 `./vector-store` 值导入（server 版已有该 class）；`VectorChunkRow/VectorHit` type-only import；`ensureSearchPg` 首次建库成本由幂等保证（每次检索前调用，PG 端 IF NOT EXISTS 空跑毫秒级）。

- [ ] **Step 4: 跑测试验证通过**

Run: `cd apps/tianshu-server && npx jest test/core/graph-search-pg.spec.ts`
Expected: PASS 全绿（纯函数 + 运行时用例）。

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-server/src/core/graph/search-pg.ts apps/tianshu-server/test/core/graph-search-pg.spec.ts
git commit -m "feat(graph): search-pg 运行时层——Pool 单例/幂等建库/upsert 事务/双检索/错误码三态"
```

---

### Task 4: vector-store 路由接线 + drift 核算

**Files:**
- Modify: `apps/tianshu-server/src/core/graph/vector-store.ts`（四函数头部路由分支，~20 行）
- Test: `apps/tianshu-server/test/core/graph-search-pg.spec.ts`（追加路由分派用例）

**Interfaces:**
- Consumes: Task 3 的 `searchDbTarget/isPgSearchConfigured/upsertChunksPg/searchFtsPg/searchChunksPg/countCollectionPg`。
- Produces: `SEARCH_DB_URL` 非空时四函数全走 PG；空时现状路径零变化（既有 jest/vitest 消费用例不破）。

- [ ] **Step 1: 写失败测试（路由分派）**

```typescript
// ---- 追加：vector-store 路由分派 ----
describe('vector-store 检索路由', () => {
  const OLD = process.env.SEARCH_DB_URL;
  afterEach(() => { process.env.SEARCH_DB_URL = OLD; });

  it('SEARCH_DB_URL 空：searchFts 走本地（不触 pg Pool）', async () => {
    delete process.env.SEARCH_DB_URL;
    const { __query } = require('pg') as { __query: jest.Mock };
    __query.mockClear();
    // 本地路径依赖 graphExecutorRuntime——本用例仅断言未走 PG 分支：
    // 触发本地实现需 mock runtime，超出本任务面；用「未配置时 import 不炸 +
    // isPgSearchConfigured()===false」钉住分派前提
    const { isPgSearchConfigured } = await import('../../src/core/graph/search-pg');
    expect(isPgSearchConfigured()).toBe(false);
    expect(__query).not.toHaveBeenCalled();
  });

  it('SEARCH_DB_URL 非空：searchFts 分派到 PG 实现', async () => {
    process.env.SEARCH_DB_URL = 'postgres://u:p@h:5432/d';
    jest.resetModules();
    const { __query } = require('pg') as { __query: jest.Mock };
    __query.mockReset().mockResolvedValue({ rows: [
      { id: 1, collection: 'c', source_name: 's', text: '原文', score: 0.5 },
    ] });
    const { searchFts } = await import('../../src/core/graph/vector-store');
    const hits = await searchFts({ userId: 1, collection: 'c', queryTokens: ['容'], limit: 3 });
    expect(hits[0]).toMatchObject({ chunkId: 1, rank: 1 });
    expect(__query).toHaveBeenCalled();
  });
});
```

> 注：`SEARCH_DB_URL` 非空路径下 `vector-store` import `graphExecutorRuntime` 不得被求值（PG 分支先 return）——若模块级副作用导致本地 runtime 初始化报错，将路由分支放函数体最前并确认 `graphExecutorRuntime` 仅在本地分支内调用（它是函数调用非模块副作用，天然满足）。

- [ ] **Step 2: 跑测试验证失败**

Run: `cd apps/tianshu-server && npx jest test/core/graph-search-pg.spec.ts`
Expected: 路由用例 FAIL（vector-store 未接线）。

- [ ] **Step 3: 接线实现**

`apps/tianshu-server/src/core/graph/vector-store.ts`：import 区加

```typescript
import {
  countCollectionPg, isPgSearchConfigured, searchChunksPg,
  searchFtsPg, upsertChunksPg,
} from './search-pg';
```

四个导出函数体**最前**各加一行分派（以 searchFts 为例，其余同构；upsertChunks/countCollection 在空词元短路之后加）：

```typescript
export async function searchFts(params: {
  userId: number;
  collection: string;
  queryTokens: string[];
  limit: number;
}): Promise<FusedHit[]> {
  if (params.queryTokens.length === 0) {
    return [];
  }
  if (isPgSearchConfigured()) {
    return searchFtsPg(params); // SEARCH_DB_URL 指向 PG 检索库（单真源）
  }
  // …现状本地实现原样保留…
```

- [ ] **Step 4: 验证全绿 + drift**

Run: `cd apps/tianshu-server && npx jest`（全量——既有 suite 确认零回归，特别是消费 vector-store 的 graph-executor.spec）
Expected: 全绿（含新增）。
Run: 仓库根 `npm run check:drift`
Expected: graph-vector-store 增量在基线 12+2 容差内（接线 ~20 行；若意外超容差，检查是否误改了本地实现段）。

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-server/src/core/graph/vector-store.ts apps/tianshu-server/test/core/graph-search-pg.spec.ts
git commit -m "feat(graph): server 检索层 SEARCH_DB_URL 路由——四函数分派 PG 后端（本地零变化）"
```

---

### Task 5: 可选 e2e + 全量回归收尾

**Files:**
- Create: `tests/ai/server/e2e-graph-search-pg.ts`（mirror 仓 e2e 目录，照 `tests/ai/server/e2e-graph-smoke.ts` 的 spawn 模式）
- Modify: 根 `package.json`（script `test:e2e:graphPg`）

**Interfaces:**
- Consumes: Task 1-4 全部；e2e 门控 env `SEARCH_E2E_PG_URL`（语义同 spec 的 SEARCH_DB_URL，仅用于测试注入区分）。
- Produces: 真 PG 全链路验证（keyword 模式中文命中 + upsert 幂等 + count）；无 PG 环境 SKIP。

- [ ] **Step 1: 写 e2e 脚本**

先读 `tests/ai/server/e2e-graph-smoke.ts` 的 spawn/server 启动/临时库/断言工具函数模式，然后写（骨架 + 关键断言给全，工具复用按先例文件实际形态对齐）：

```typescript
// tests/ai/server/e2e-graph-search-pg.ts
/**
 * PG 检索层 e2e（可选，门控 SEARCH_E2E_PG_URL；未设则 SKIP）：
 * 真 server 子进程（注入 SEARCH_DB_URL）→ vectorChunk 直插中文样本
 * （带假向量）→ hybridSearch keyword 模式命中/剔除断言 → 重跑 upsert
 * 幂等（行数不翻倍）。semantic/hybrid 的向量 SQL 语义由单测钉板
 * （e2e 免真模型外呼），spec 已显式此取舍。
 */
const PG_URL = process.env.SEARCH_E2E_PG_URL;
if (!PG_URL) {
  console.log('SKIP: SEARCH_E2E_PG_URL 未配置（docker compose up search-pg 后设置）');
  process.exit(0);
}
// 1. 直连 PG 清理并建表（复用 server dist 的 PG_DDL 或内联同款 DDL）
// 2. spawn server 子进程（env 注入 SEARCH_DB_URL=PG_URL，DB 指临时 SQLite 主库
//    ——照 e2e-graph-smoke 的 SERVER_DB 模式）
// 3. 经 server API：graph save（vectorize 节点文本=中文样本 + hybridSearch
//    keyword 节点）→ run → 断言输出含目标条目名与「相关度」、无关条目剔除
//    （vectorize 走真 embedding？——否：本脚本 vectorize 节点不可用（真模型
//    门控），改为直插 PG vector_chunk 行（INSERT 带 to_tsvector），hybridSearch
//    keyword 节点检索断言——对齐 e2e-graph-smoke 的 seedHybridChunks 手法，
//    但写向 PG）
// 4. 重跑同 (user_id, collection, source_name) 直插 → SELECT COUNT 断言不翻倍
// 5. child kill + PG 清理（DROP TABLE IF EXISTS vector_chunk）
```

落地要点（先例对齐后细化）：spawn 参数/env 注入照抄 e2e-graph-smoke 的 server 启动段；直插 SQL 用 Task 2 的 `buildUpsertInsertSql` 同款语句（脚本内联，不 import server 内部模块——e2e 走进程边界）；断言「容错设计手册｜相关度」命中与「旅行日记」剔除（样本文案对齐既有 e2e 风格）。

根 `package.json` scripts 加：

```json
"test:e2e:graphPg": "node tests/ai/server/e2e-graph-search-pg.ts"
```

- [ ] **Step 2: 无 PG 环境 SKIP 验证 + 有 PG 环境 e2e**

Run: `npm run test:e2e:graphPg`
Expected: `SKIP: SEARCH_E2E_PG_URL 未配置…` exit 0。
若本机可起 compose（`cd apps/tianshu-server && docker compose up -d search-pg`，需 docker；无 docker 则记 SKIP 交付，由用户择机验证）：`SEARCH_E2E_PG_URL=postgres://tianshu:tianshu_search@localhost:5432/tianshu_search npm run test:e2e:graphPg`（compose 需放开 5432 端口映射）
Expected: 全链路断言通过。

- [ ] **Step 3: 全量回归**

Run: 仓库根 `npm run test`（mirror vitest 全量不回归）+ `cd apps/tianshu-server && npx jest`（全量含新 spec）+ `npm run typecheck`（恰 5 条既有 electron/ 基线）+ `npm run check:drift`（graph-vector-store 容差内）
Expected: 全部达标。

- [ ] **Step 4: 终验三项（跨段协议）**

① 错误码存在性：`search_pg_unavailable/search_pg_no_vector_ext/search_pg_unsupported_url` 在 search-pg.ts 齐全且经 vector-store 可达；② 接线面：四函数分派齐全（upsert/searchFts/searchChunks/countCollection），本地分支零改动（diff 仅新增行）；③ 零改动铁律核验：git diff 确认 mirror 侧文件与双端 graph-executor.ts 零 hunks。

- [ ] **Step 5: Commit**

```bash
git add tests/ai/server/e2e-graph-search-pg.ts package.json
git commit -m "test(graph): PG 检索层可选 e2e——keyword 中文命中/upsert 幂等/门控 SKIP"
```
