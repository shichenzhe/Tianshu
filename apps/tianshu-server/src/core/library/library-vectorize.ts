/**
 * 资料库内容向量化入库（spec 2026-11-02-library-vectorize-server-design）：
 * library 写面（uploadFile/writeContent）写成功后的向量化编排——
 * LIBRARY_COLLECTION='library' 集合由此获得写入方（此前 library_search
 * 向量版检索面就位但集合恒空）。分块复用 vector-store chunkText、入库
 * 复用 upsertChunks（含 PG 路由）、向量化复用 graph-executor embedTexts。
 *
 * 失败哲学：非文本内容/无可用 embedding 模型/embed 失败一律「跳过 +
 * 日志」，绝不炸写面（上传/写内容永远成功优先）；重建面 = 重新写内容
 * 自动 + 既有 graph vectorize 节点手动跑。deps 注入面（测试替身）对齐
 * library-tools 先例。
 */
import { chunkText, upsertChunks } from '../graph/vector-store';
import type { EmbedTexts } from './library-tools';

/** 资料库向量块统一集合名（检索侧 library-tools 同源常量） */
export const LIBRARY_VECTOR_COLLECTION = 'library';

/** 可文本分块的 fileType 白名单（binary/image/office 等一律跳过） */
const TEXTUAL_FILE_TYPES = new Set([
  'txt',
  'md',
  'markdown',
  'code',
  'json',
  'csv',
  'log',
  'yaml',
  'yml',
  'xml',
  'html',
]);

/** 内容可分块判定：mimeType text/* 或 fileType 属白名单 */
export function isTextualContent(
  mimeType: string | null,
  fileType: string | null,
): boolean {
  if (mimeType?.startsWith('text/')) {
    return true;
  }
  return fileType !== null && TEXTUAL_FILE_TYPES.has(fileType);
}

/** 缺省 embedding 模型查询面（prisma 最小结构；测试 stub 注入） */
export interface LibraryVectorizePrisma {
  model: {
    findFirst(args: {
      where: { enabled: boolean; type: string };
      orderBy: { id: 'asc' };
      select: { id: true };
    }): Promise<{ id: number } | null>;
  };
}

/** 缺省 embedding 超时（对齐 library-tools EMBED_TIMEOUT_MS） */
const EMBED_TIMEOUT_MS = 60_000;

export interface LibraryVectorizeDeps {
  db?: LibraryVectorizePrisma;
  embed?: EmbedTexts;
  /** 入库注入面（测试替身；缺省 vector-store upsertChunks 真身——含
   *  SEARCH_DB_URL PG 路由） */
  upsert?: typeof upsertChunks;
  /** 条目级块清理注入面（service delete/rename 清孤儿块消费；测试替身） */
  deleteSource?: (
    userId: number,
    collection: string,
    sourceName: string,
  ) => Promise<void>;
  /** 跳过/失败观测（生产接 LoggerFactory；缺省 no-op） */
  onSkip?: (reason: string, detail: unknown) => void;
}

const defaultEmbed: EmbedTexts = async (modelId, texts, signal) => {
  const { embedTexts } = await import('../graph/graph-executor');
  return embedTexts(
    modelId,
    texts,
    signal ?? AbortSignal.timeout(EMBED_TIMEOUT_MS),
  );
};

export interface VectorizeLibraryContentParams {
  userId: number;
  /** 条目名 = 检索回联 sourceName（同层 uniqueDbName 天然唯一） */
  sourceName: string;
  content: string;
  mimeType: string | null;
  fileType: string | null;
}

export type VectorizeOutcome = 'indexed' | 'skipped';

/**
 * 单条目向量化编排：文本判定 → chunkText 分块 → 缺省 embedding 模型
 * （enabled type='embedding' 首个，确定性）→ embedTexts → upsertChunks
 * （同 sourceName 先删后插幂等）。任何 skip 态返回 'skipped'（调用方
 * fire-and-forget 场景仅日志观测）
 */
export async function vectorizeLibraryContent(
  deps: LibraryVectorizeDeps,
  params: VectorizeLibraryContentParams,
): Promise<VectorizeOutcome> {
  const skip = (reason: string, detail: unknown = undefined) => {
    deps.onSkip?.(reason, detail);
    return 'skipped' as const;
  };
  if (!isTextualContent(params.mimeType, params.fileType)) {
    return skip('library_vectorize_skip_type', {
      name: params.sourceName,
      mimeType: params.mimeType,
      fileType: params.fileType,
    });
  }
  const chunks = chunkText(params.content);
  if (chunks.length === 0) {
    return skip('library_vectorize_skip_empty', { name: params.sourceName });
  }
  let model: { id: number } | null;
  if (deps.db) {
    model = await deps.db.model.findFirst({
      where: { enabled: true, type: 'embedding' },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
  } else {
    const { graphExecutorRuntime } = await import('../graph/executor-runtime');
    model = await graphExecutorRuntime().db.model.findFirst({
      where: { enabled: true, type: 'embedding' },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
  }
  if (!model) {
    return skip('library_vectorize_no_model', { name: params.sourceName });
  }
  const embed = deps.embed ?? defaultEmbed;
  let vectors: number[][];
  try {
    vectors = await embed(model.id, chunks);
  } catch (e) {
    return skip('library_vectorize_embed_failed', {
      name: params.sourceName,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  if (!Array.isArray(vectors) || vectors.length !== chunks.length) {
    return skip('library_vectorize_embed_shape', { name: params.sourceName });
  }
  await (deps.upsert ?? upsertChunks)({
    userId: params.userId,
    collection: LIBRARY_VECTOR_COLLECTION,
    sourceName: params.sourceName,
    model: String(model.id),
    chunks: chunks.map((text, i) => ({ seq: i, text, vector: vectors[i] })),
  });
  return 'indexed';
}
