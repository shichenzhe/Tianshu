// tests/ai/graph-hybrid.test.ts
/**
 * 混合检索：searchFts 内存 BM25（FTS5 否决后 pivot，LangChain
 * BM25Retriever 形态）。mock 面以本任务为限（vectorChunk.findMany），
 * handler 级端到端用例 Task 5 扩。
 */
import { describe, expect, it, vi, afterEach } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`) },
  Notification: vi.fn(),
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    vectorChunk: { findMany: vi.fn() },
  },
}));

import prisma from "../../electron/commons/prisma-client";
import { searchFts } from "../../electron/domains/ai/orchestration/vector-store";

afterEach(() => {
  vi.mocked(prisma.vectorChunk.findMany).mockReset();
});

describe("vector-store searchFts（内存 BM25）", () => {
  it("空词元短路返回空（不查库）", async () => {
    const hits = await searchFts({
      userId: 1,
      collection: "",
      queryTokens: [],
      limit: 5,
    });
    expect(hits).toEqual([]);
    expect(prisma.vectorChunk.findMany).not.toHaveBeenCalled();
  });

  it("findMany 限定 select 且命中行经 rankBm25 排序返回 FusedHit 形态", async () => {
    vi.mocked(prisma.vectorChunk.findMany).mockResolvedValue([
      {
        id: 1,
        collection: "c",
        sourceName: "s1",
        text: "分布式系统的容错设计与故障恢复",
      },
      { id: 2, collection: "c", sourceName: "s2", text: "容错相关的其它讨论" },
      {
        id: 3,
        collection: "c",
        sourceName: "s3",
        text: "前端组件的状态管理最佳实践",
      },
    ] as never);
    // 词元为 tokenize 产物（"容错设计" 分作 容/错/设计——ICU 词典不收
    // "容错" 整词，调用方传分词结果，此处照实）
    const hits = await searchFts({
      userId: 1,
      collection: "c",
      queryTokens: ["容", "错", "设计"],
      limit: 2,
    });
    expect(prisma.vectorChunk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 1, collection: "c" },
        select: { id: true, collection: true, sourceName: true, text: true },
      }),
    );
    expect(hits.map((h) => h.chunkId)).toEqual([1, 2]); // 多词命中 > 少词命中，零命中剔除
    expect(hits[0]).toMatchObject({ sourceName: "s1", rank: 1 });
    expect(hits.every((h) => h.score > 0)).toBe(true);
  });
});
