// packages/tianshu-core/src/retrieval.ts
/**
 * 检索纯逻辑（GA 系单份三端）：中文分词（Intl.Segmenter——Node 16+/
 * Chromium 内建 ICU 词典，零依赖）、内存 BM25（FTS5 否决后 pivot，
 * LangChain BM25Retriever 形态）、RRF 融合。分词器单点抽象：质量升级
 * （jieba 等）只动 tokenize 一处。
 */
export interface Bm25Doc {
  chunkId: number;
  sourceName: string;
  collection: string;
  text: string;
}

export interface Bm25Hit extends Bm25Doc {
  score: number;
}

export interface FusedHit {
  chunkId: number;
  sourceName: string;
  collection: string;
  text: string;
  score: number;
  rank: number;
}

/** Okapi BM25 业界默认参数（rank-bm25/LangChain BM25Retriever 同参） */
export const BM25_K1 = 1.5;
export const BM25_B = 0.75;

const segmenter = new Intl.Segmenter("zh-Hans", { granularity: "word" });
const TOKEN_RE = /[\p{Script=Han}\p{L}\p{N}]/u;

/** 分词：仅保留含文字/数字的词元（标点/符号剥离）；导出供测试 */
export function tokenize(text: string): string[] {
  return [...segmenter.segment(text)]
    .map((seg) => seg.segment.trim())
    .filter((token) => token.length > 0 && TOKEN_RE.test(token));
}

/** 内存 BM25 评分：Lucene 式 +1 平滑 IDF（防负），每查询全量分词评分
 * （与 searchChunks 全表余弦同构，万级毫秒级）；零命中剔除、降序切 topK */
export function rankBm25(
  queryTokens: string[],
  docs: Bm25Doc[],
  topK: number,
  k1 = BM25_K1,
  b = BM25_B,
): Bm25Hit[] {
  if (queryTokens.length === 0 || docs.length === 0) {
    return [];
  }
  const docTokens = docs.map((d) => tokenize(d.text));
  const avgLen =
    docTokens.reduce((sum, tokens) => sum + tokens.length, 0) /
    docTokens.length;
  const df = new Map<string, number>();
  for (const tokens of docTokens) {
    for (const term of new Set(tokens)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  const idf = (term: string) => {
    const n = df.get(term) ?? 0;
    return Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
  };
  const hits: Bm25Hit[] = [];
  docs.forEach((doc, i) => {
    const tokens = docTokens[i];
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    let score = 0;
    for (const term of new Set(queryTokens)) {
      const freq = tf.get(term) ?? 0;
      if (freq === 0) {
        continue;
      }
      score +=
        (idf(term) * (freq * (k1 + 1))) /
        (freq + k1 * (1 - b + (b * tokens.length) / avgLen));
    }
    if (score > 0) {
      hits.push({ ...doc, score });
    }
  });
  hits.sort((a, x) => x.score - a.score);
  return hits.slice(0, topK);
}

/** RRF 融合（k=60 论文值/ES rank_constant 默认）：按 chunkId 累加
 * 1/(k+rank)，只看排名不看原始分（量纲免疫）；融合后 rank 从 1 重编 */
export function rrfFuse(
  vecHits: FusedHit[],
  ftsHits: FusedHit[],
  k = 60,
): FusedHit[] {
  const merged = new Map<number, FusedHit>();
  const absorb = (hits: FusedHit[]) => {
    hits.forEach((h, i) => {
      const contribution = 1 / (k + i + 1);
      const prev = merged.get(h.chunkId);
      if (prev) {
        prev.score += contribution;
      } else {
        merged.set(h.chunkId, { ...h, score: contribution });
      }
    });
  };
  absorb(vecHits);
  absorb(ftsHits);
  return [...merged.values()]
    .sort((a, b2) => b2.score - a.score)
    .map((h, i) => ({ ...h, rank: i + 1 }));
}
