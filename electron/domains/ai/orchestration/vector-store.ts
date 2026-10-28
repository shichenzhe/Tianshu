// electron/domains/ai/orchestration/vector-store.ts
/**
 * 向量存储 v1（SQLite BLOB/JSON + 内存余弦）：桌面单机万级 chunk 毫秒
 * 级。接口抽象 VectorStore——后续升级 sqlite-vec（同库加扩展）或远端
 * （Qdrant 等，配置切换）时替换实现，节点/执行器零改动。
 * 维度混用防线：块携带 embedding 模型 id，检索按同模型过滤（不同模型
 * 维度不同，余弦无意义）。
 */
import prisma from "../../../commons/prisma-client";

export interface VectorChunkRow {
  seq: number;
  text: string;
  vector: number[];
}

export interface VectorHit {
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
    this.name = "VectorStoreError";
  }
}

/** 文本分块：固定字符窗口 + 重叠（导出供测试；段落边界 v2 再对齐） */
export function chunkText(text: string, size = 500, overlap = 100): string[] {
  const clean = text.trim();
  if (clean === "") {
    return [];
  }
  if (clean.length <= size) {
    return [clean];
  }
  const step = Math.max(1, size - overlap);
  const chunks: string[] = [];
  for (let start = 0; start < clean.length; start += step) {
    chunks.push(clean.slice(start, start + size));
    if (start + size >= clean.length) {
      break;
    }
  }
  return chunks;
}

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
  await prisma.$transaction([
    prisma.vectorChunk.deleteMany({
      where: {
        userId: params.userId,
        collection: params.collection,
        sourceName: params.sourceName,
      },
    }),
    ...params.chunks.map((chunk) =>
      prisma.vectorChunk.create({
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
  const rows = await prisma.vectorChunk.findMany({
    where: {
      userId: params.userId,
      model: params.model,
      ...(params.collection ? { collection: params.collection } : {}),
    },
  });
  const hits: VectorHit[] = rows.map((row) => ({
    sourceName: row.sourceName,
    collection: row.collection,
    text: row.text,
    score: cosine(params.queryVector, JSON.parse(row.vector) as number[]),
  }));
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, params.topK);
}

/** 集合块数清点（入库回执用） */
export async function countCollection(
  userId: number,
  collection: string,
): Promise<number> {
  return prisma.vectorChunk.count({
    where: { userId, collection },
  });
}
