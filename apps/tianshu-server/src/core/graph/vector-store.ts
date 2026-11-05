// electron/domains/ai/orchestration/vector-store.ts
/**
 * 自 mirror electron/domains/ai/orchestration/vector-store.ts 直摘（GA-T4）。
 * 改造点 1（授权面 2）：mirror 模块级 prisma 单例 → executor-runtime
 * 进程级句柄（graphExecutorRuntime().db.vectorChunk——server 自有
 * PrismaService，vectorChunk 表 GA-T3 已摘）。其余逐行保持。
 */
/**
 * 向量存储 v1（SQLite BLOB/JSON + 内存余弦）：桌面单机万级 chunk 毫秒
 * 级。接口抽象 VectorStore——后续升级 sqlite-vec（同库加扩展）或远端
 * （Qdrant 等，配置切换）时替换实现，节点/执行器零改动。
 * 维度混用防线：块携带 embedding 模型 id，检索按同模型过滤（不同模型
 * 维度不同，余弦无意义）。
 */
import { rankBm25, chunkText, type FusedHit } from '@tianshu/core';
import { graphExecutorRuntime } from './executor-runtime';
import {
  countCollectionPg,
  deleteSourceChunksPg,
  isPgSearchConfigured,
  searchChunksPg,
  searchFtsPg,
  upsertChunksPg,
} from './search-pg';

export interface VectorChunkRow {
  seq: number;
  text: string;
  vector: number[];
}

export interface VectorHit {
  chunkId: number;
  sourceName: string;
  collection: string;
  text: string;
  score: number;
}

export class VectorStoreError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'VectorStoreError';
  }
}

/** 文本分块：递归字符切分（批2 升级，@tianshu/core 单份——分隔符层级
 *  回退 + 整段子块重叠；graph-executor/资料库向量化消费再导出） */
export { chunkText };

/** 余弦相似度（零向量防除零） */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 条目级 upsert：同 collection+sourceName 先删后插（重跑幂等） */
export async function upsertChunks(params: {
  userId: number;
  collection: string;
  sourceName: string;
  model: string;
  chunks: VectorChunkRow[];
}): Promise<void> {
  if (isPgSearchConfigured()) {
    return upsertChunksPg(params); // SEARCH_DB_URL 指向 PG 检索库（单真源）
  }
  await graphExecutorRuntime().db.$transaction([
    graphExecutorRuntime().db.vectorChunk.deleteMany({
      where: {
        userId: params.userId,
        collection: params.collection,
        sourceName: params.sourceName,
      },
    }),
    ...params.chunks.map((chunk) =>
      graphExecutorRuntime().db.vectorChunk.create({
        data: {
          userId: params.userId,
          collection: params.collection,
          sourceName: params.sourceName,
          seq: chunk.seq,
          text: chunk.text,
          vector: JSON.stringify(chunk.vector),
          model: params.model,
        },
      }),
    ),
  ]);
}

/** 语义检索：按同模型块内存余弦取 topK（collection 空串 = 全集合） */
export async function searchChunks(params: {
  userId: number;
  collection: string;
  model: string;
  queryVector: number[];
  topK: number;
}): Promise<VectorHit[]> {
  if (isPgSearchConfigured()) {
    return searchChunksPg(params); // SEARCH_DB_URL 指向 PG 检索库（单真源）
  }
  const rows = await graphExecutorRuntime().db.vectorChunk.findMany({
    where: {
      userId: params.userId,
      model: params.model,
      ...(params.collection ? { collection: params.collection } : {}),
    },
  });
  const hits: VectorHit[] = rows.map((row) => ({
    chunkId: row.id,
    sourceName: row.sourceName,
    collection: row.collection,
    text: row.text,
    score: cosine(params.queryVector, JSON.parse(row.vector) as number[]),
  }));
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, params.topK);
}

/** BM25 全文检索（内存，与 searchChunks 全表余弦同构——FTS5 否决后
 * pivot，LangChain BM25Retriever 形态）：空词元短路；不过滤 model（全文
 * 与 embedding 模型无关）；万级毫秒级，与全表余弦成本同量级 */
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
  const rows = await graphExecutorRuntime().db.vectorChunk.findMany({
    where: {
      userId: params.userId,
      ...(params.collection ? { collection: params.collection } : {}),
    },
    select: { id: true, collection: true, sourceName: true, text: true },
  });
  const hits = rankBm25(
    params.queryTokens,
    rows.map((row) => ({
      chunkId: row.id,
      sourceName: row.sourceName,
      collection: row.collection,
      text: row.text,
    })),
    params.limit,
  );
  return hits.map((hit, index) => ({ ...hit, rank: index + 1 }));
}

/** 集合块数清点（入库回执用） */
export async function countCollection(
  userId: number,
  collection: string,
): Promise<number> {
  if (isPgSearchConfigured()) {
    return countCollectionPg(userId, collection); // SEARCH_DB_URL 指向 PG 检索库（单真源）
  }
  return graphExecutorRuntime().db.vectorChunk.count({
    where: { userId, collection },
  });
}

/** 条目级块清理（spec 2026-11-02 资料库向量化批）：library delete/rename
 *  后清旧 sourceName 块防孤儿检索（upsert 语义只覆盖同名的写路径） */
export async function deleteSourceChunks(
  userId: number,
  collection: string,
  sourceName: string,
): Promise<void> {
  if (isPgSearchConfigured()) {
    return deleteSourceChunksPg(userId, collection, sourceName);
  }
  await graphExecutorRuntime().db.vectorChunk.deleteMany({
    where: { userId, collection, sourceName },
  });
}
