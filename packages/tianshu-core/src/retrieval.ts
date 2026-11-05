// packages/tianshu-core/src/retrieval.ts
/**
 * 检索纯逻辑（GA 系单份三端）：中文分词（Intl.Segmenter——Node 16+/
 * Chromium 内建 ICU 词典，零依赖；Hermes 未实测，Segmenter 惰性构造保
 * barrel 加载期零 Intl 副作用）、内存 BM25（FTS5 否决后 pivot，
 * LangChain BM25Retriever 形态）、RRF 融合、递归字符切块。分词器单点
 * 抽象：质量升级（jieba 等）只动 tokenize 一处。
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

// 移动端 Hermes 未实测 Intl.Segmenter——barrel 经 Metro 进包后模块级
// 构造会在 bundle 加载期执行，一旦缺失炸掉无关页面；惰性初始化（首次
// tokenize 才构造单例）把风险面收敛到真正调用检索的路径
let segmenter: Intl.Segmenter | null = null;
const TOKEN_RE = /[\p{Script=Han}\p{L}\p{N}]/u;

/** 分词：仅保留含文字/数字的词元（标点/符号剥离）；导出供测试 */
export function tokenize(text: string): string[] {
  segmenter ??= new Intl.Segmenter("zh-Hans", { granularity: "word" });
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

/* ---------- 递归字符切块（批2，library-rag §6 P1-2） ---------- */

/** 分隔符层级（段落 → 行 → 句 → 词；LangChain
 *  RecursiveCharacterTextSplitter 同型业界默认起点） */
const CHUNK_SEPARATORS = ["\n\n", "\n", "。", " "] as const;

/**
 * 递归字符切分：按层级分隔符回退把文本切成 ≤ size 的块，同级相邻子段用
 * 该级分隔符贴回（保留自然边界——句子带句号、段落带换行）；单层切不动
 * （子段仍超限）时下一层级递归，其产物边界更深不与本层贴回；全部层级
 * 切不动（无分隔符长串）退固定字符窗口 + 重叠（v1 形态兜底）。签名与
 * v1 保持（size/overlap 缺省 500/100），每块 ≤ size 为硬不变量；
 * overlap 以「旧块尾部整段子块」携带（≤ overlap），不产生拦腰新缝。
 */
export function chunkText(text: string, size = 500, overlap = 100): string[] {
  const clean = text.trim();
  if (clean === "") {
    return [];
  }
  if (clean.length <= size) {
    return [clean];
  }
  return splitRecursive(clean, size, overlap, 0);
}

function splitRecursive(
  text: string,
  size: number,
  overlap: number,
  level: number,
): string[] {
  if (level >= CHUNK_SEPARATORS.length) {
    return hardWindow(text, size, overlap);
  }
  const sep = CHUNK_SEPARATORS[level];
  const out: string[] = [];
  let group: string[] = []; // 本层直属子段（≤ size，按本层 sep 贴回）
  const flush = () => {
    if (group.length > 0) {
      out.push(...mergePieces(group, sep, size, overlap));
      group = [];
    }
  };
  for (const part of text.split(sep)) {
    if (part.length === 0) {
      continue;
    }
    if (part.length <= size) {
      group.push(part);
    } else {
      // 本层切不动：下一层级递归（产物边界更深，不与本层贴回）
      flush();
      out.push(...splitRecursive(part, size, overlap, level + 1));
    }
  }
  flush();
  return out;
}

/** 同级子段贪心装箱：超限时切新块并从旧块尾部回看携带 ≤ overlap 的
 *  整段子块（携带后与新段合计仍超限则弃携带保块上限） */
function mergePieces(
  pieces: string[],
  sep: string,
  size: number,
  overlap: number,
): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  for (const piece of pieces) {
    if (current.length > 0 && currentLen + sep.length + piece.length > size) {
      chunks.push(current.join(sep));
      const tail: string[] = [];
      let tailLen = 0;
      for (let i = current.length - 1; i >= 0; i -= 1) {
        const add = current[i].length + (tail.length > 0 ? sep.length : 0);
        if (tailLen + add > overlap) {
          break;
        }
        tail.unshift(current[i]);
        tailLen += add;
      }
      current = tail;
      currentLen = tailLen;
      if (currentLen + sep.length + piece.length > size) {
        current = [];
        currentLen = 0;
      }
    }
    current.push(piece);
    currentLen =
      current.length === 1
        ? piece.length
        : currentLen + sep.length + piece.length;
  }
  if (current.length > 0) {
    chunks.push(current.join(sep));
  }
  return chunks;
}

/** 最细层级仍超限的兜底：固定字符窗口 + 重叠（v1 chunkText 原形） */
function hardWindow(text: string, size: number, overlap: number): string[] {
  const step = Math.max(1, size - overlap);
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += step) {
    chunks.push(text.slice(start, start + size));
    if (start + size >= text.length) {
      break;
    }
  }
  return chunks;
}
