/**
 * 桌面资料库写侧向量化接线（批2，docs/design/library-rag.md §6 P0-1）：
 * 编排本体在 @tianshu/core vectorizeLibraryContent（与 server 同源——
 * server 接线壳 src/core/library/library-vectorize.ts），本文件补桌面
 * 平台缺省：db=进程 prisma（embedding 模型查询）、embed 动态引
 * graph-executor embedTexts（OpenAI 兼容 /embeddings，静态 import 会
 * 成环）、upsert/deleteSource=orchestration/vector-store 真身、
 * onSkip=Log.warn。失败哲学同 server：skip/意外错误一律「跳过 + 日志」，
 * 绝不炸写面；deps 注入面（db/embed/upsert/deleteSource）供 vitest 替身。
 */
import {
  LIBRARY_VECTOR_COLLECTION,
  vectorizeLibraryContent,
  type EmbedTexts,
  type LibraryVectorizePrisma,
  type UpsertVectorChunksParams,
  type VectorizeLibraryContentParams,
  type VectorizeOutcome,
} from "@tianshu/core";
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import { deleteSourceChunks, upsertChunks } from "../orchestration/vector-store";

export { LIBRARY_VECTOR_COLLECTION };
export type {
  EmbedTexts,
  LibraryVectorizePrisma,
  UpsertVectorChunksParams,
  VectorizeLibraryContentParams,
  VectorizeOutcome,
};

/** 缺省 embedding 超时（server library-tools EMBED_TIMEOUT_MS 同值） */
const EMBED_TIMEOUT_MS = 60_000;

export interface LibraryVectorizeDeps {
  db?: LibraryVectorizePrisma;
  embed?: EmbedTexts;
  /** 入库注入面（测试替身；缺省 vector-store upsertChunks 真身） */
  upsert?: (params: UpsertVectorChunksParams) => Promise<void>;
  /** 条目级块清理注入面（repo delete/rename 清孤儿块消费；测试替身） */
  deleteSource?: (
    userId: number,
    collection: string,
    sourceName: string,
  ) => Promise<void>;
  /** 跳过/失败观测（缺省 Log.warn——与写面日志同宿） */
  onSkip?: (reason: string, detail: unknown) => void;
}

const defaultEmbed: EmbedTexts = async (modelId, texts, signal) => {
  const { embedTexts } = await import("../orchestration/graph-executor");
  return embedTexts(
    modelId,
    texts,
    signal ?? AbortSignal.timeout(EMBED_TIMEOUT_MS),
  );
};

const defaultOnSkip: (reason: string, detail: unknown) => void = (
  reason,
  detail,
) => {
  Log.warn(`library_vectorize_skip: ${reason}`, detail);
};

/**
 * 单条目向量化编排（桌面面）：deps 可选形态（缺省接进程真身），内填
 * 缺省后转 core 必填注入面。skip 态返回 'skipped'。
 */
export async function vectorizeLibraryContentDesktop(
  deps: LibraryVectorizeDeps,
  params: VectorizeLibraryContentParams,
): Promise<VectorizeOutcome> {
  return vectorizeLibraryContent(
    {
      db: deps.db ?? prisma,
      embed: deps.embed ?? defaultEmbed,
      upsert: deps.upsert ?? upsertChunks,
      onSkip: deps.onSkip ?? defaultOnSkip,
    },
    params,
  );
}

/** 写后 fire-and-forget 入口（repo 三写面消费）：响应不被 embedding 往返
 *  拖慢；编排外意外错误吞日志（同 server vectorizeAfterWrite 哲学） */
export function fireLibraryVectorize(
  deps: LibraryVectorizeDeps,
  params: VectorizeLibraryContentParams,
): void {
  vectorizeLibraryContentDesktop(deps, params).catch((e: unknown) => {
    (deps.onSkip ?? defaultOnSkip)("library_vectorize_unexpected", e);
  });
}

/** 条目级孤儿块清理（delete/rename 后；清理失败记日志放行不炸主面） */
export async function clearLibrarySourceChunks(
  deps: LibraryVectorizeDeps,
  userId: number,
  sourceName: string,
): Promise<void> {
  try {
    await (deps.deleteSource ?? deleteSourceChunks)(
      userId,
      LIBRARY_VECTOR_COLLECTION,
      sourceName,
    );
  } catch (error) {
    Log.warn(`资料库向量块清理失败（${sourceName}）`, error);
  }
}
