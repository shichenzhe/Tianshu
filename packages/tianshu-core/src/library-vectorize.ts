/**
 * 资料库内容向量化入库编排（批2 收编三端单份）：源 server
 * src/core/library/library-vectorize.ts（spec 2026-11-02）——library 写面
 * （uploadFile/writeContent/addFiles）写成功后的向量化编排，'library'
 * 集合由此获得写入方，library_search 向量版检索面两端同源。分块用本包
 * chunkText（递归切分）；db/embed/upsert 为必填注入面（core 无平台缺省，
 * 消费方接线：server src/core/library/library-vectorize.ts 薄壳、桌面
 * electron/domains/ai/library/library-vectorize.ts 薄壳）。
 *
 * 失败哲学（server 批原文）：非文本内容/无可用 embedding 模型/embed
 * 失败一律「跳过 + 日志」，绝不炸写面（上传/写内容永远成功优先）；
 * 重建面 = 重新写内容自动 + 既有 graph vectorize 节点手动跑。
 */
import { chunkText } from "./retrieval";

/** 资料库向量块统一集合名（检索侧两端工具同源常量） */
export const LIBRARY_VECTOR_COLLECTION = "library";

/** 可文本分块的 fileType 白名单（binary/image/office 等一律跳过） */
const TEXTUAL_FILE_TYPES = new Set([
  "txt",
  "md",
  "markdown",
  "code",
  "json",
  "csv",
  "log",
  "yaml",
  "yml",
  "xml",
  "html",
]);

/** 内容可分块判定：mimeType text/* 或 fileType 属白名单 */
export function isTextualContent(
  mimeType: string | null,
  fileType: string | null,
): boolean {
  if (mimeType?.startsWith("text/")) {
    return true;
  }
  return fileType !== null && TEXTUAL_FILE_TYPES.has(fileType);
}

/** 缺省 embedding 模型查询面（prisma 最小结构；测试 stub 注入） */
export interface LibraryVectorizePrisma {
  model: {
    findFirst(args: {
      where: { enabled: boolean; type: string };
      orderBy: { id: "asc" };
      select: { id: true };
    }): Promise<{ id: number } | null>;
  };
}

/** embedding 函数形态（两端 graph-executor embedTexts 同签名注入面） */
export type EmbedTexts = (
  modelId: number,
  texts: string[],
  signal?: AbortSignal,
) => Promise<number[][]>;

/** upsert 注入面参数（两端 vector-store upsertChunks 同形） */
export interface UpsertVectorChunksParams {
  userId: number;
  collection: string;
  sourceName: string;
  model: string;
  chunks: Array<{ seq: number; text: string; vector: number[] }>;
}

/** 编排依赖（core 面全必填——无平台缺省，消费方薄壳负责接真身/替身） */
export interface LibraryVectorizeDeps {
  db: LibraryVectorizePrisma;
  embed: EmbedTexts;
  upsert: (params: UpsertVectorChunksParams) => Promise<void>;
  /** 跳过/失败观测（生产接日志；缺省 no-op） */
  onSkip?: (reason: string, detail: unknown) => void;
}

export interface VectorizeLibraryContentParams {
  userId: number;
  /** 条目名 = 检索回联 sourceName（同层 uniqueDbName 天然唯一） */
  sourceName: string;
  content: string;
  mimeType: string | null;
  fileType: string | null;
}

export type VectorizeOutcome = "indexed" | "skipped";

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
    return "skipped" as const;
  };
  if (!isTextualContent(params.mimeType, params.fileType)) {
    return skip("library_vectorize_skip_type", {
      name: params.sourceName,
      mimeType: params.mimeType,
      fileType: params.fileType,
    });
  }
  const chunks = chunkText(params.content);
  if (chunks.length === 0) {
    return skip("library_vectorize_skip_empty", { name: params.sourceName });
  }
  const model = await deps.db.model.findFirst({
    where: { enabled: true, type: "embedding" },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  if (!model) {
    return skip("library_vectorize_no_model", { name: params.sourceName });
  }
  let vectors: number[][];
  try {
    vectors = await deps.embed(model.id, chunks);
  } catch (e) {
    return skip("library_vectorize_embed_failed", {
      name: params.sourceName,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  if (!Array.isArray(vectors) || vectors.length !== chunks.length) {
    return skip("library_vectorize_embed_shape", { name: params.sourceName });
  }
  await deps.upsert({
    userId: params.userId,
    collection: LIBRARY_VECTOR_COLLECTION,
    sourceName: params.sourceName,
    model: String(model.id),
    chunks: chunks.map((text, i) => ({ seq: i, text, vector: vectors[i] })),
  });
  return "indexed";
}
