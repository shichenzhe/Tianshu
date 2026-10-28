/**
 * library_search 工具 server 版（PL-2，spec §2.2）：资料库语义检索。
 *
 * mirror 工具位查证（2026-10-18，node 全量扫描复核）：mirror
 * electron/domains/ai/agent/ **无** library_search（或同名）工具——mirror
 * 资料库检索面是 graph librarySearch 节点（关键词内容扫描，orchestration/
 * graph-executor searchLibrary）+ graph vectorSearch 节点（语义：query →
 * embedTexts → vector-store searchChunks）+ LibraryRepository.search（UI
 * IPC 关键词检索），agent 工具清单（tool-groups CORE/WORKFLOW/EXPERT）亦
 * 无资料库项。故 spec 预留位「mirror agent/web-tools 或独立」裁定为
 * **独立新建**（无 mirror 逐字同构基准），形态对齐 web-tools/browser 桥
 * 工具先例（name/description/zod/kind + 工厂依赖注入），命中输出形态对齐
 * vectorSearch 节点「【条目名｜相似度 x.xx】片段」并附 libraryItem 回联
 * 条目号（PL-T3 manifest 入册的 library 工具对本体）。
 *
 * 执行体接 src/core/graph/vector-store.ts 真检索：vector-store 本体不含
 * embedding 模型配置（纯存储+余弦，向量由调用方生成）——既有取法即 graph
 * vectorize/vectorSearch 节点的 embedTexts(modelId)。本工具按「用户资料库
 * 块现有 embedding 模型」取最新块的 model（块 model 列 = 索引时
 * String(modelId)），query 经该模型向量化后同模型余弦 topK（同模型过滤是
 * searchChunks 的维度混用防线）；块模型标识损坏 → fail 文案不静默。空库
 * （无资料库块）→ 空结果文案（不炸不伪造、不发起向量化——未配 embedding
 * 模型的空库同样如实返回空）。
 */
import { z } from 'zod';
import type { ToolDefinition } from '../tools/tool-definition';
import { fail } from '../tools/file-tools';
import { searchChunks, type VectorHit } from '../graph/vector-store';
import {
  LibraryRepository,
  type LibraryPrismaLike,
} from './library.repository';

/** 资料库向量块统一集合名：library 写侧（后续「library 同步/上传」批）
 *  入库契约；graph 工作流自建集合不经本工具检索（避免跨域泄漏） */
export const LIBRARY_COLLECTION = 'library';

/** 默认返回条数（graph vectorSearch 节点 topK 缺省 5 同值） */
const DEFAULT_TOP_K = 5;

/** 空库/无命中输出（语义如实——不炸不伪造；导出供测试断言） */
export const LIBRARY_EMPTY_OUTPUT = '资料库暂无已索引内容，无命中结果';

/** 缺省 embedding 超时（graph 节点 120s 减半——工具步内合理上限） */
const EMBED_TIMEOUT_MS = 60_000;

/** embedding 函数形态（graph-executor embedTexts 同签名注入面——测试替身注入） */
export type EmbedTexts = (
  modelId: number,
  texts: string[],
  signal?: AbortSignal,
) => Promise<number[][]>;

/**
 * vector-store 检索所需 prisma 面最小结构（真实客户端/测试 stub 均可注入；
 * OptionPrismaLike 先例）——vectorChunk 取最新块定模型，libraryItem 命中回联
 */
export interface LibraryToolPrismaLike extends LibraryPrismaLike {
  vectorChunk: {
    findFirst(args: {
      where: { userId: number; collection: string };
      orderBy: { id: 'desc' };
      select: { model: true };
    }): Promise<{ model: string } | null>;
  };
}

/** 工具依赖注入面：db 缺省经 graphExecutorRuntime() 取进程级句柄（graph
 *  模块工厂启动即安装——注册表单例在安装前构造，须取用时解析）；embed
 *  缺省动态引 graph-executor embedTexts（静态 import 会成环 ①
 *  tool-registry → library-tools → graph-executor → tool-registry，动态先例
 *  executor 内 `await import('./vector-store')`）。另登记静态环 ②（PL-T2
 *  review Minor）：chat-runner → library-tools → vector-store →
 *  executor-runtime →（resolveDataRoot）→ chat-runner——良性：环上仅函数
 *  绑定、取用时才调用（executor-runtime 顶层无求值副作用），动态化反而
 *  费解，保持静态 */
export interface LibrarySearchDeps {
  db?: LibraryToolPrismaLike;
  embed?: EmbedTexts;
}

const defaultEmbed: EmbedTexts = async (modelId, texts, signal) => {
  const { embedTexts } = await import('../graph/graph-executor');
  return embedTexts(
    modelId,
    texts,
    signal ?? AbortSignal.timeout(EMBED_TIMEOUT_MS),
  );
};

/** 命中 →「【名（条目 #id）｜相似度 x.xx】片段」回喂文本（孤儿块无
 *  libraryItem 行时回退纯 sourceName 形态，不因回联缺行丢命中） */
function formatHits(
  hits: readonly VectorHit[],
  entryIdByName: ReadonlyMap<string, number>,
): string {
  return hits
    .map((hit) => {
      const entryId = entryIdByName.get(hit.sourceName);
      const title =
        entryId === undefined
          ? hit.sourceName
          : `${hit.sourceName}（条目 #${entryId}）`;
      return `【${title}｜相似度 ${hit.score.toFixed(2)}】${hit.text}`;
    })
    .join('\n\n');
}

/**
 * library_search 工具工厂：deps 可注入（chat 会话传显式 prisma——不经
 * graph 运行时解析；测试注入假 embedding/临时库）
 */
export function makeLibrarySearchTool(
  deps: LibrarySearchDeps = {},
): ToolDefinition<{ query: string; topK?: number }> {
  const embed = deps.embed ?? defaultEmbed;
  return {
    name: 'library_search',
    description: '检索用户资料库（语义向量检索，返回命中文件条目与内容片段）',
    parameters: z.object({
      query: z.string().min(1).describe('检索问题或关键词'),
      topK: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('返回条数，缺省 5'),
    }),
    kind: 'read',
    execute: async (ctx, { query, topK }) => {
      const userId = ctx.userId ?? 0;
      const db =
        deps.db ??
        (await import('../graph/executor-runtime')).graphExecutorRuntime().db;
      // 空库短路：无资料库块即无命中（不向量化——未配 embedding 模型的
      // 空库同样如实返回空，语义不炸不伪造）
      const latest = await db.vectorChunk.findFirst({
        where: { userId, collection: LIBRARY_COLLECTION },
        orderBy: { id: 'desc' },
        select: { model: true },
      });
      if (!latest) {
        return LIBRARY_EMPTY_OUTPUT;
      }
      const modelId = Number(latest.model);
      if (!Number.isInteger(modelId) || modelId <= 0) {
        return fail(`资料库向量块模型标识异常: ${latest.model}`);
      }
      let vectors: number[][];
      try {
        vectors = await embed(modelId, [query]);
      } catch (e) {
        return fail(
          `检索向量化失败: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const queryVector = vectors[0];
      if (!Array.isArray(queryVector) || queryVector.length === 0) {
        return fail('检索向量化返回空向量');
      }
      const hits = await searchChunks({
        userId,
        collection: LIBRARY_COLLECTION,
        model: latest.model,
        queryVector,
        topK: topK ?? DEFAULT_TOP_K,
      });
      if (hits.length === 0) {
        return LIBRARY_EMPTY_OUTPUT;
      }
      const repo = new LibraryRepository(db);
      const entries = await repo.findFilesByNames(
        hits.map((hit) => hit.sourceName),
        userId,
      );
      return formatHits(
        hits,
        new Map(entries.map((row) => [row.name, row.id])),
      );
    },
  };
}

/** 注册表静态装配用的单例（定义无状态、db 取用时解析，进程内共享安全——
 *  BROWSER_BRIDGE_TOOLS 先例；graph LLM 节点 tools:true 经 registry 自动获得） */
export const LIBRARY_SEARCH_TOOL = makeLibrarySearchTool();
