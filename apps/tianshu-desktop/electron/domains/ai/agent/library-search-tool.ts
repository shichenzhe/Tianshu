/**
 * library_search 内置工具——语义向量版（批2，docs/design/library-rag.md
 * §6 P0-1；2026-11-01 审查余项⑨的文件名版保留为降级）：library 集合
 * （写侧向量化批起有写入方）有块时按 server 形态检索——最新块定
 * embedding 模型（块 model 列 = 索引时 String(modelId)）→ embedTexts
 * (query) → vector-store searchChunks 同模型余弦 topK（同模型过滤是
 * 维度混用防线）→ libraryItem 精确名回联条目号。降级两径：无块（未配
 * embedding 模型或尚无文本写入）/语义零命中 → 文件名关键词版（初版
 * 形态，检索形态与 UI search 同款）。纯 Node 实现（禁止 import
 * electron），deps 注入面（db/embed/search）供 vitest 替身。
 */
import { z } from "zod";
import {
  LIBRARY_VECTOR_COLLECTION,
  type EmbedTexts,
} from "@tianshu/core";
import prisma from "../../../commons/prisma-client";
import { searchChunks, type VectorHit } from "../orchestration/vector-store";
import { fail, type ToolDefinition } from "./file-tools";

export const LIBRARY_SEARCH_TOOL_NAME = "library_search";

/** 默认返回条数（server 版 DEFAULT_TOP_K 同值；graph vectorSearch 5 同源） */
const DEFAULT_TOP_K = 5;

/** 空结果文案（导出供测试断言；语义如实不炸不伪造） */
export const LIBRARY_SEARCH_EMPTY = "资料库无命中条目";

/** 缺省 embedding 超时（server 版 EMBED_TIMEOUT_MS 同值——工具步内上限） */
const EMBED_TIMEOUT_MS = 60_000;

const argsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("检索问题或关键词（语义匹配文件内容，未建索引时降级匹配文件名）"),
  topK: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("返回条数，缺省 5"),
});

export type LibrarySearchArgs = z.infer<typeof argsSchema>;

/** 检索面最小 prisma 结构（真实客户端/测试 stub 均可注入；server
 *  LibraryToolPrismaLike 先例）——vectorChunk 取最新块定模型，
 *  libraryItem 文件名降级与命中回联 */
interface LibraryToolDb {
  vectorChunk: {
    findFirst(args: {
      where: { userId: number; collection: string };
      orderBy: { id: "desc" };
      select: { model: true };
    }): Promise<{ model: string } | null>;
  };
  libraryItem: {
    findMany(args: {
      where: {
        kind: string;
        userId: number;
        name?: { contains?: string; in?: string[] };
      };
      orderBy?: { updatedAt: "desc" };
      take?: number;
    }): Promise<LibraryItemRow[]>;
  };
}

interface LibraryItemRow {
  id: number;
  name: string;
  mimeType?: string | null;
  size?: number | null;
  updatedAt: Date;
}

export interface LibrarySearchToolDeps {
  db?: LibraryToolDb;
  embed?: EmbedTexts;
  search?: typeof searchChunks;
}

const defaultEmbed: EmbedTexts = async (modelId, texts, signal) => {
  const { embedTexts } = await import("../orchestration/graph-executor");
  return embedTexts(
    modelId,
    texts,
    signal ?? AbortSignal.timeout(EMBED_TIMEOUT_MS),
  );
};

/** 文件名关键词降级版（2026-11-01 初版形态）：library 集合无块或语义
 *  零命中时的保底检索 */
async function searchByFilename(
  db: LibraryToolDb,
  userId: number,
  keyword: string,
  limit: number,
): Promise<string> {
  const rows = await db.libraryItem.findMany({
    where: {
      kind: "file",
      name: { contains: keyword },
      userId,
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });
  if (rows.length === 0) {
    return LIBRARY_SEARCH_EMPTY;
  }
  const lines = rows.map(
    (row) =>
      `- 条目 #${row.id}｜${row.name}（${row.mimeType ?? "未知类型"}${
        row.size != null ? `，${Math.max(1, Math.round(row.size / 1024))}KB` : ""
      }，更新于 ${row.updatedAt.toISOString().slice(0, 10)}）`,
  );
  return `资料库命中 ${rows.length} 条：\n${lines.join("\n")}`;
}

/** 命中 →「【名（条目 #id）｜相似度 x.xx】片段」回喂文本（server
 *  library-tools formatHits 同形；孤儿块无 libraryItem 行时回退纯
 *  sourceName，不因回联缺行丢命中） */
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
    .join("\n\n");
}

export function makeLibrarySearchTool(
  deps: LibrarySearchToolDeps = {},
): ToolDefinition<LibrarySearchArgs> {
  return {
    name: LIBRARY_SEARCH_TOOL_NAME,
    description:
      "检索用户资料库（语义向量检索文件内容，返回命中文件条目与内容" +
      "片段；资料库未建语义索引时降级为文件名关键词匹配）；命中后如需" +
      "读取文件内容，请提示用户在输入框 @ 该文件引用（引用将注入文件全文）",
    parameters: argsSchema,
    kind: "read",
    execute: async (ctx, { query, topK }) => {
      const userId = ctx.userId ?? 0;
      const trimmed = query.trim().slice(0, 100);
      if (!trimmed) {
        return LIBRARY_SEARCH_EMPTY;
      }
      const limit = topK ?? DEFAULT_TOP_K;
      const db = deps.db ?? prisma;
      // 空库短路：无资料库块即无语义索引（不发起向量化）→ 降级文件名版
      const latest = await db.vectorChunk.findFirst({
        where: { userId, collection: LIBRARY_VECTOR_COLLECTION },
        orderBy: { id: "desc" },
        select: { model: true },
      });
      if (!latest) {
        return searchByFilename(db, userId, trimmed, limit);
      }
      const modelId = Number(latest.model);
      if (!Number.isInteger(modelId) || modelId <= 0) {
        return fail(`资料库向量块模型标识异常: ${latest.model}`);
      }
      let vectors: number[][];
      try {
        vectors = await (deps.embed ?? defaultEmbed)(modelId, [trimmed]);
      } catch (e) {
        return fail(
          `检索向量化失败: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const queryVector = vectors[0];
      if (!Array.isArray(queryVector) || queryVector.length === 0) {
        return fail("检索向量化返回空向量");
      }
      const hits = await (deps.search ?? searchChunks)({
        userId,
        collection: LIBRARY_VECTOR_COLLECTION,
        model: latest.model,
        queryVector,
        topK: limit,
      });
      if (hits.length === 0) {
        // 语义零命中兜底：精确文件名场景再捞一轮
        return searchByFilename(db, userId, trimmed, limit);
      }
      // 命中块回联条目（精确名批量读；folder/他用户行天然排除）
      const entries = await db.libraryItem.findMany({
        where: {
          kind: "file",
          name: { in: hits.map((hit) => hit.sourceName) },
          userId,
        },
      });
      return formatHits(
        hits,
        new Map(entries.map((row) => [row.name, row.id])),
      );
    },
  };
}
