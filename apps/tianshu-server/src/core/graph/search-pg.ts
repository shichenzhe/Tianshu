// apps/tianshu-server/src/core/graph/search-pg.ts
/**
 * PG 检索后端（server 独有，spec 2026-10-31）：SEARCH_DB_URL 指向的
 * 独立检索库，tsvector FTS + pgvector 向量（无维度列顺序扫，HNSW 留
 * v2 维度策略）；独立库 = 检索单一真源（vectorize 直写，主库无副本）。
 * 分词与融合复用 @tianshu/core（tokenize/rrfFuse），与 mirror 内存
 * BM25 检索行为同源。
 */
import { tokenize, type FusedHit } from '@tianshu/core';
import {
  VectorStoreError,
  type VectorChunkRow,
  type VectorHit,
} from './vector-store';

/** 幂等建库：扩展→表→索引（首次检索/入库前执行；扩展缺失由调用方
 * 转 search_pg_no_vector_ext 人话错误） */
export const PG_DDL: string[] = [
  'CREATE EXTENSION IF NOT EXISTS vector',
  `CREATE TABLE IF NOT EXISTS vector_chunk (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  collection TEXT NOT NULL,
  source_name TEXT NOT NULL,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  text_tsv tsvector NOT NULL,
  vector vector,
  model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
export function buildFtsSql(hasCollection: boolean): {
  sql: string;
  paramCount: number;
} {
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
export function buildVectorSql(hasCollection: boolean): {
  sql: string;
  paramCount: number;
} {
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

// ---------------------------------------------------------------------------
// 运行时层（Task 3）：Pool 单例/幂等建库/upsert 事务/双检索/错误码三态
// ---------------------------------------------------------------------------

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
      'SEARCH_DB_URL 仅支持 postgres:// 或 postgresql:// 连接串（当前配置不是 PG 地址）',
    );
  }
  return url;
}

/** 是否启用 PG 检索（经 searchDbTarget 透传——非法 scheme 即随本调用抛出，
 * vector-store 四函数入口统一经此报错） */
export function isPgSearchConfigured(): boolean {
  return searchDbTarget() !== null;
}

/** pg 依赖面最小结构类型：ts-jest 语言服务解析不到根 node_modules 的
 * @types/pg（tsc 可解析）——type 查询一律改结构类型，运行时值经
 * await import('pg') 动态取（db-client.ts 同款惯例） */
interface PgQueryResult {
  rows: unknown[];
}
interface PgClient {
  query(sql: string, values?: unknown[]): Promise<PgQueryResult>;
  release(): void;
}
interface PgPool {
  query(sql: string, values?: unknown[]): Promise<PgQueryResult>;
  connect(): Promise<PgClient>;
}

let pgPool: PgPool | null = null;

/** Pool 单例：动态 import 隔离 pg 依赖（未配 PG 的部署不加载） */
async function getPool(): Promise<PgPool> {
  if (!pgPool) {
    const { Pool } = await import('pg');
    // as PgPool：动态导入在 ts-jest 下为 any（不窄化联合），tsc 下与
    // pg.Pool 结构兼容——两世界同码通过
    pgPool = new Pool({ connectionString: searchDbTarget()! }) as PgPool;
  }
  return pgPool;
}

/** 连接类异常统一转人话 VectorStoreError（VectorStoreError 原样透传） */
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

/** 条目级 upsert（同 collection+sourceName 先删后插，事务包裹保原子）；
 * 前置幂等建库——fresh-PG 首跑 vectorize 直接 upsert 不依赖检索先行建表
 * （建库失败已在 ensureSearchPg 内统一转人话错误）；空数组仅清空不插
 * （buildUpsertInsertSql(0) 会产悬空 VALUES） */
export async function upsertChunksPg(params: {
  userId: number;
  collection: string;
  sourceName: string;
  model: string;
  chunks: VectorChunkRow[];
}): Promise<void> {
  await ensureSearchPg();
  // connect 在 try 外——取连接即失败无事务可回滚，就地转人话错误
  const client = await (await getPool()).connect().catch((e: unknown) => {
    throw toPgError(e);
  });
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM vector_chunk WHERE user_id = $1 AND collection = $2 AND source_name = $3',
      [params.userId, params.collection, params.sourceName],
    );
    if (params.chunks.length > 0) {
      await client.query(
        buildUpsertInsertSql(params.chunks.length),
        params.chunks.flatMap((chunk) => [
          params.userId,
          params.collection,
          params.sourceName,
          chunk.seq,
          chunk.text,
          tokenize(chunk.text).join(' '),
          buildVectorLiteral(chunk.vector),
          params.model,
        ]),
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw toPgError(e);
  } finally {
    client.release();
  }
}

/** FTS 检索：词元 OR 匹配 ts_rank 降序（rank 按 returned 序从 1 编号）；
 * 空词元短路不发查询（to_tsquery('') 语法非法） */
export async function searchFtsPg(params: {
  userId: number;
  collection: string;
  queryTokens: string[];
  limit: number;
}): Promise<FusedHit[]> {
  if (params.queryTokens.length === 0) {
    return [];
  }
  try {
    await ensureSearchPg();
    const { sql } = buildFtsSql(params.collection !== '');
    const values =
      params.collection !== ''
        ? [
            buildFtsQuery(params.queryTokens),
            params.userId,
            params.collection,
            params.limit,
          ]
        : [buildFtsQuery(params.queryTokens), params.userId, params.limit];
    const result = await (await getPool()).query(sql, values);
    return (
      result.rows as Array<{
        id: number;
        collection: string;
        source_name: string;
        text: string;
        score: number;
      }>
    ).map((row, index) => ({
      chunkId: Number(row.id),
      sourceName: row.source_name,
      collection: row.collection,
      text: row.text,
      score: Number(row.score),
      rank: index + 1,
    }));
  } catch (e) {
    throw toPgError(e);
  }
}

/** 向量检索：余弦距离排序（score = 1 - 距离）；model 过滤保维度防线 */
export async function searchChunksPg(params: {
  userId: number;
  collection: string;
  model: string;
  queryVector: number[];
  topK: number;
}): Promise<VectorHit[]> {
  try {
    await ensureSearchPg();
    const { sql } = buildVectorSql(params.collection !== '');
    const values =
      params.collection !== ''
        ? [
            buildVectorLiteral(params.queryVector),
            params.model,
            params.userId,
            params.collection,
            params.topK,
          ]
        : [
            buildVectorLiteral(params.queryVector),
            params.model,
            params.userId,
            params.topK,
          ];
    const result = await (await getPool()).query(sql, values);
    return (
      result.rows as Array<{
        id: number;
        collection: string;
        source_name: string;
        text: string;
        score: number;
      }>
    ).map((row) => ({
      chunkId: Number(row.id),
      sourceName: row.source_name,
      collection: row.collection,
      text: row.text,
      score: Number(row.score),
    }));
  } catch (e) {
    throw toPgError(e);
  }
}

/** collection 计数（删除确认/统计面）；前置幂等建库——fresh-PG 首查
 * 不依赖检索/入库先行建表 */
export async function countCollectionPg(
  userId: number,
  collection: string,
): Promise<number> {
  try {
    await ensureSearchPg();
    const result = await (
      await getPool()
    ).query(
      'SELECT COUNT(*)::int AS n FROM vector_chunk WHERE user_id = $1 AND collection = $2',
      [userId, collection],
    );
    return Number((result.rows[0] as { n: number }).n);
  } catch (e) {
    throw toPgError(e);
  }
}
