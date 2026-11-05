/**
 * library_search 工具单测（批2 语义向量版）：deps 注入面（db/embed/search）
 * 直测——语义全链路（最新块定模型 → embed → searchChunks → 条目回联）、
 * 空库/语义零命中降级文件名关键词版（2026-11-01 初版形态）、embed 失败
 * 与块模型标识异常的 fail 文案。纯 Node 工具（禁止 import electron），
 * electron/prisma 经 vi.mock 替身。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  // 安全批：密封链引 safeStorage（降级形态——master-key 走 hex 路径）
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error("safeStorage unavailable in test");
    },
    decryptString: () => {
      throw new Error("safeStorage unavailable in test");
    },
  },
  ipcMain: { handle: vi.fn() },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {}, // 默认 db 面不进单测——恒注入 deps.db
}));

import {
  LIBRARY_SEARCH_EMPTY,
  LIBRARY_SEARCH_TOOL_NAME,
  makeLibrarySearchTool,
  type LibrarySearchToolDeps,
} from "../../electron/domains/ai/agent/library-search-tool";
import type { VectorHit } from "../../electron/domains/ai/orchestration/vector-store";

const ctx = () => ({ workspacePath: "/tmp/ws", sessionId: 1, userId: 7 });

/** db 替身：最新块模型（null=空库）+ 文件名行/回联行共用 findMany（按
 *  where.name 形态分派：contains=降级检索、in=命中回联） */
function makeDb(opts: {
  latestModel?: string | null;
  byWhere: (where: Record<string, unknown>) => Record<string, unknown>[];
}) {
  return {
    vectorChunk: {
      findFirst: vi.fn(async () =>
        opts.latestModel == null ? null : { model: opts.latestModel },
      ),
    },
    libraryItem: {
      findMany: vi.fn(
        async (args: { where: Record<string, unknown> }) =>
          opts.byWhere(args.where),
      ),
    },
  };
}

const hit = (sourceName: string, text: string, score: number): VectorHit => ({
  chunkId: sourceName.length,
  sourceName,
  collection: "library",
  text,
  score,
});

describe("makeLibrarySearchTool 语义向量版", () => {
  it("全链路：最新块定模型 → embed → searchChunks 同模型 topK → 条目回联（孤儿块回退纯名）", async () => {
    const db = makeDb({
      latestModel: "9",
      byWhere: (where) =>
        (where.name as { in: string[] }).in
          .map((name) => ({ id: 3, name, updatedAt: new Date() }))
          .filter((row) => row.name === "笔记.md"),
    });
    const embed = vi.fn(async (modelId: number, texts: string[]) => {
      expect(modelId).toBe(9);
      return texts.map(() => [0.1, 0.9]);
    });
    const search = vi.fn(async (params: { model: string; topK: number }) => {
      expect(params.model).toBe("9");
      expect(params.topK).toBe(5);
      return [hit("笔记.md", "命中片段甲", 0.87), hit("孤儿.txt", "片段乙", 0.42)];
    });
    const out = await makeLibrarySearchTool({ db, embed, search }).execute(
      ctx(),
      { query: "发版流程" },
    );
    expect(out).toContain("【笔记.md（条目 #3）｜相似度 0.87】命中片段甲");
    expect(out).toContain("【孤儿.txt｜相似度 0.42】片段乙"); // 回联缺行不丢命中
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("空库（无资料库块）降级文件名关键词版（初版形态），不发起向量化", async () => {
    const db = makeDb({
      latestModel: null,
      byWhere: (where) =>
        (where.name as { contains: string }).contains === "说明"
          ? [
              {
                id: 3,
                name: "H6发版说明.md",
                mimeType: "text/markdown",
                size: 8192,
                updatedAt: new Date("2026-10-30T00:00:00Z"),
              },
            ]
          : [],
    });
    const embed = vi.fn(async () => [[1]]);
    const out = await makeLibrarySearchTool({
      db,
      embed,
      search: vi.fn(),
    }).execute(ctx(), { query: "说明" });
    expect(out).toContain("命中 1 条");
    expect(out).toContain("条目 #3｜H6发版说明.md");
    expect(embed).not.toHaveBeenCalled();
  });

  it("语义零命中兜底文件名检索；双双无命中返回空文案", async () => {
    const filenameRows = [
      {
        id: 5,
        name: "notes.txt",
        mimeType: null,
        size: null,
        updatedAt: new Date("2026-10-29T00:00:00Z"),
      },
    ];
    const db = makeDb({
      latestModel: "9",
      byWhere: (where) =>
        where.name && "contains" in (where.name as object) ? filenameRows : [],
    });
    const out = await makeLibrarySearchTool({
      db,
      embed: async () => [[0.2]],
      search: async () => [],
    }).execute(ctx(), { query: "notes", topK: 3 });
    expect(out).toContain("命中 1 条");
    expect(out).toContain("条目 #5｜notes.txt");

    const emptyDb = makeDb({ latestModel: "9", byWhere: () => [] });
    const out2 = await makeLibrarySearchTool({
      db: emptyDb,
      embed: async () => [[0.2]],
      search: async () => [],
    }).execute(ctx(), { query: "不存在" });
    expect(out2).toBe(LIBRARY_SEARCH_EMPTY);
  });

  it("embed 失败与块模型标识异常返回 fail 文案（不炸不静默）", async () => {
    const badModelDb = makeDb({ latestModel: "xyz", byWhere: () => [] });
    const out = await makeLibrarySearchTool({
      db: badModelDb,
      embed: async () => [[1]],
      search: vi.fn(),
    }).execute(ctx(), { query: "q" });
    expect(out).toBe("错误: 资料库向量块模型标识异常: xyz");

    const db = makeDb({ latestModel: "9", byWhere: () => [] });
    const out2 = await makeLibrarySearchTool({
      db,
      embed: async () => {
        throw new Error("boom");
      },
      search: vi.fn(),
    }).execute(ctx(), { query: "q" });
    expect(out2).toBe("错误: 检索向量化失败: boom");
  });

  it("空白 query 返回空文案；kind=read；query 截 100 透传降级检索", async () => {
    const db = makeDb({ latestModel: null, byWhere: () => [] });
    const tool = makeLibrarySearchTool({ db, embed: vi.fn(), search: vi.fn() });
    expect(await tool.execute(ctx(), { query: "   " })).toBe(
      LIBRARY_SEARCH_EMPTY,
    );
    expect(tool.kind).toBe("read");
    expect(tool.name).toBe(LIBRARY_SEARCH_TOOL_NAME);
    await tool.execute(ctx(), { query: "x".repeat(300) });
    expect(db.libraryItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          name: { contains: "x".repeat(100) },
        }),
      }),
    );
  });

  it("deps 缺省形态可构造（生产接线：db=prisma、embed/search=真身）", () => {
    const tool = makeLibrarySearchTool();
    expect(tool.name).toBe(LIBRARY_SEARCH_TOOL_NAME);
  });
});
