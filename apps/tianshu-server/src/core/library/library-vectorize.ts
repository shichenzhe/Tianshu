/**
 * 资料库内容向量化入库（spec 2026-11-02-library-vectorize-server-design）：
 * 编排本体已收编 @tianshu/core vectorizeLibraryContent（批2 三端单份——
 * 桌面写侧向量化同源），本文件为 server 接线薄壳：补平台缺省——db 经
 * graphExecutorRuntime()（deps 未注入时）、embed 动态引 graph-executor
 * embedTexts（静态 import 会成环，先例 library-tools ①）、upsert 缺省
 * vector-store 真身（含 SEARCH_DB_URL PG 路由）。公开面（函数签名/
 * deps 可选形态）保持收编前不变——library.service 与既有单测零改动。
 *
 * 失败哲学（core 同源）：非文本内容/无可用 embedding 模型/embed 失败一律
 * 「跳过 + 日志」，绝不炸写面（上传/写内容永远成功优先）；重建面 = 重新
 * 写内容自动 + 既有 graph vectorize 节点手动跑。deps 注入面（测试替身）
 * 对齐 library-tools 先例（本仓 interop 形态下 partial mock 的 named
 * import 取 undefined 实测不可用，注入面即为此设计）。
 */
import {
  isTextualContent,
  LIBRARY_VECTOR_COLLECTION,
  vectorizeLibraryContent as runVectorize,
  type EmbedTexts,
  type LibraryVectorizePrisma,
  type UpsertVectorChunksParams,
  type VectorizeLibraryContentParams,
  type VectorizeOutcome,
} from '@tianshu/core';
import { upsertChunks } from '../graph/vector-store';

export { isTextualContent, LIBRARY_VECTOR_COLLECTION };
export type {
  EmbedTexts,
  LibraryVectorizePrisma,
  VectorizeLibraryContentParams,
  VectorizeOutcome,
};

/** 缺省 embedding 超时（对齐 library-tools EMBED_TIMEOUT_MS） */
const EMBED_TIMEOUT_MS = 60_000;

export interface LibraryVectorizeDeps {
  db?: LibraryVectorizePrisma;
  embed?: EmbedTexts;
  /** 入库注入面（测试替身；缺省 vector-store upsertChunks 真身——含
   *  SEARCH_DB_URL PG 路由） */
  upsert?: (params: UpsertVectorChunksParams) => Promise<void>;
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

/**
 * 单条目向量化编排（server 面）：deps 可选形态（缺省运行时解析），内填
 * 缺省后转 core 必填注入面。skip 态返回 'skipped'（调用方
 * fire-and-forget 场景仅日志观测）。
 */
export async function vectorizeLibraryContent(
  deps: LibraryVectorizeDeps,
  params: VectorizeLibraryContentParams,
): Promise<VectorizeOutcome> {
  const db =
    deps.db ??
    (await import('../graph/executor-runtime')).graphExecutorRuntime().db;
  return runVectorize(
    {
      db,
      embed: deps.embed ?? defaultEmbed,
      upsert: deps.upsert ?? upsertChunks,
      onSkip: deps.onSkip,
    },
    params,
  );
}
