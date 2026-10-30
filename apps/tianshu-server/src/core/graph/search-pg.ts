// apps/tianshu-server/src/core/graph/search-pg.ts
/**
 * PG 检索后端（server 独有，spec 2026-10-31）：SEARCH_DB_URL 指向的
 * 独立检索库，tsvector FTS + pgvector 向量（无维度列顺序扫，HNSW 留
 * v2 维度策略）；独立库 = 检索单一真源（vectorize 直写，主库无副本）。
 * 分词与融合复用 @tianshu/core（tokenize/rrfFuse），与 mirror 内存
 * BM25 检索行为同源。
 */
// import { tokenize } from '@tianshu/core'; // Task 3 启用（运行时层做查询前分词；本 Task 纯函数层暂不使用，避免空 import 告警）

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
