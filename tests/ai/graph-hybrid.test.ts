// tests/ai/graph-hybrid.test.ts
/**
 * 混合检索：searchFts 内存 BM25（FTS5 否决后 pivot，LangChain
 * BM25Retriever 形态）+ hybridSearch 节点 handler 三模式端到端
 * （keyword/semantic/hybrid——直调导出的 handler 工厂，runId=null
 * 即席不落库；embed 走 fetch 打桩 + prisma model/provider mock，先例
 * graph-vector.test.ts）。
 */
import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`) },
  Notification: vi.fn(),
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    vectorChunk: { findMany: vi.fn() },
    // embedTexts → loadModelRuntime（model/provider 两跳）——hybrid/
    // semantic 模式查询向量化用
    model: {
      findUnique: vi.fn(async () => ({ id: 1, providerId: 2, modelId: "emb" })),
    },
    provider: {
      findUnique: vi.fn(async () => ({
        id: 2,
        type: "openai-compatible",
        baseUrl: "http://localhost:9",
        apiKey: "k",
        extraHeaders: null,
      })),
    },
  },
}));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/domains/ai/agent/skill-loader", () => ({
  loadSkills: vi.fn(() => []),
}));
vi.mock("../../electron/domains/security/command-gate", () => ({
  commandGate: vi.fn(() => "allow" as const),
}));

import prisma from "../../electron/commons/prisma-client";
import { searchFts } from "../../electron/domains/ai/orchestration/vector-store";
import {
  makeHybridSearchNodeHandler,
  makeRerankNodeHandler,
  type NodeContext,
} from "../../electron/domains/ai/orchestration/graph-executor";
import type {
  HybridSearchNode,
  NodeResult,
  RerankNode,
} from "@tianshu/core";

const fetchMock = vi.fn();
beforeAll(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
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

  it("collection 空串：where 不含 collection 键（全集合语义）", async () => {
    vi.mocked(prisma.vectorChunk.findMany).mockResolvedValue([
      {
        id: 1,
        collection: "c1",
        sourceName: "s1",
        text: "容错设计的原文",
      },
    ] as never);
    const hits = await searchFts({
      userId: 1,
      collection: "",
      queryTokens: ["容", "设计"],
      limit: 3,
    });
    expect(hits.length).toBeGreaterThan(0);
    // where 恰为 { userId }——空串展开省略 collection 键，若实现误带
    // collection: "" 会以多键被 deep equal 拒绝
    expect(prisma.vectorChunk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 1 },
      }),
    );
  });
});

describe("hybridSearch 节点 handler（三模式）", () => {
  const baseNode: HybridSearchNode = {
    id: "hs1",
    kind: "hybridSearch",
    name: "混合检索",
    searchQuery: "容错 设计",
    collection: "c",
    mode: "hybrid",
    topK: 3,
    modelId: 1,
  };

  /** handler 级即席 ctx：runId=null 节点详情不落库（writeNodeRecord
   * 短路）；hybrid 路径不触 agent/deps，空对象占位 */
  const makeCtx = (): NodeContext => ({
    runId: null,
    abort: new AbortController().signal,
    workspace: { id: 9, directoryPath: null },
    userId: 1,
    codeAuthorized: false,
    subflowStack: [],
    skills: [],
    agent: {} as NodeContext["agent"],
    now: new Date(),
    trace: [],
    modelCache: new Map(),
    deps: {} as NodeContext["deps"],
  });

  /** 直调 handler 工厂（导出供测试）取节点状态更新本体——hits 旁路
   * 只落 state，图执行入口不透出；查询词元须对齐 tokenize 宗旨
   * （"容错 设计" 实分 容/错/设计，mock 行文须含词元才有 BM25 分） */
  const runHybrid = async (overrides: Partial<HybridSearchNode> = {}) => {
    const handler = makeHybridSearchNodeHandler(
      { ...baseNode, ...overrides },
      makeCtx(),
    );
    const update = await handler({ inputs: {}, nodes: {} });
    return update.nodes!.hs1;
  };

  it("keyword 模式：不调 embedding、输出相关度文案、挂 hits", async () => {
    // 行文含查询词元（容/错/设计）才有 BM25 分——裸"原文片段"零词元
    // 重叠会被零命中剔除，故以"容错设计的原文片段"为行文
    vi.mocked(prisma.vectorChunk.findMany).mockResolvedValue([
      {
        id: 1,
        collection: "c",
        sourceName: "s1",
        text: "容错设计的原文片段",
      },
    ] as never);
    const done = await runHybrid({ mode: "keyword", modelId: undefined });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(done.output).toContain("【s1｜相关度");
    expect(done.hits?.[0]).toMatchObject({
      chunkId: 1,
      sourceName: "s1",
    });
  });

  it("semantic 模式缺 modelId 报 hybrid_model_missing", async () => {
    await expect(
      runHybrid({ mode: "semantic", modelId: undefined }),
    ).rejects.toMatchObject({ code: "hybrid_model_missing" });
  });

  it("hybrid 模式：两路并行 RRF 融合（同 chunk 累加居首）", async () => {
    // embedding fetch 打桩为确定性向量 [1,0]（先例）；findMany mock 行
    // 同时携带 vector（余弦路 JSON.parse）与 text（BM25 路评分）——
    // 向量路命中 chunk 1（同向余弦 1），BM25 路命中 chunk 1 与 chunk 2
    // （chunk 3 零命中剔除），融合后同源 chunkId 1 双贡献居首
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: body.input.map((_text, index) => ({
            index,
            embedding: [1, 0],
          })),
        }),
      };
    });
    vi.mocked(prisma.vectorChunk.findMany).mockResolvedValue([
      {
        id: 1,
        userId: 1,
        collection: "c",
        sourceName: "s1",
        text: "分布式系统的容错设计与故障恢复",
        vector: JSON.stringify([1, 0]),
        model: "1",
        seq: 0,
        createdAt: new Date(),
      },
      {
        id: 2,
        userId: 1,
        collection: "c",
        sourceName: "s2",
        text: "容错相关的其它讨论",
        vector: JSON.stringify([0, 1]),
        model: "1",
        seq: 0,
        createdAt: new Date(),
      },
      {
        id: 3,
        userId: 1,
        collection: "c",
        sourceName: "s3",
        text: "前端组件的状态管理最佳实践",
        vector: JSON.stringify([0, 1]),
        model: "1",
        seq: 0,
        createdAt: new Date(),
      },
    ] as never);
    const done = await runHybrid();
    expect(done.hits?.[0].chunkId).toBe(1);
    expect(done.output).toContain("【s1｜相关度");
  });

  it("hybrid 模式 FTS 单路先败：节点显式失败且无 unhandled rejection", async () => {
    // embed 路正常解析；FTS 路（searchFts 的 findMany）先拒却——护栏
    // 缺失时该拒却在 await embedPromise 期间无 handler，即
    // unhandled rejection 现场；节点仍须以 FTS 真实错误显式失败。
    // embed 路注入真实宏任务间隙（setTimeout），复现慢 HTTP 下 FTS
    // 先败的检查点窗口（纯微任务级 mock 不会触发 Node 的检测）
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: body.input.map((_text, index) => ({
            index,
            embedding: [1, 0],
          })),
        }),
      };
    });
    vi.mocked(prisma.vectorChunk.findMany).mockRejectedValue(
      new Error("SQLITE_BUSY: database is locked"),
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(runHybrid()).rejects.toMatchObject({
        message: expect.stringContaining("SQLITE_BUSY"),
      });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    // 走完检查点再断言零事件（护栏缺失时事件在 embed 间隙即抛出）
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  });

  it("semantic 模式：纯向量路（不走 FTS）、相似度文案、rank 从 1 编", async () => {
    // 同款确定性 embed [1,0]；semantic 只发向量路——findMany 仅一次
    // （searchChunks），FTS 面（searchFts 的第二次 findMany）不触达
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: body.input.map((_text, index) => ({
            index,
            embedding: [1, 0],
          })),
        }),
      };
    });
    vi.mocked(prisma.vectorChunk.findMany).mockResolvedValue([
      {
        id: 1,
        userId: 1,
        collection: "c",
        sourceName: "s1",
        text: "分布式系统的容错设计与故障恢复",
        vector: JSON.stringify([1, 0]),
        model: "1",
        seq: 0,
        createdAt: new Date(),
      },
      {
        id: 2,
        userId: 1,
        collection: "c",
        sourceName: "s2",
        text: "容错相关的其它讨论",
        vector: JSON.stringify([0, 1]),
        model: "1",
        seq: 0,
        createdAt: new Date(),
      },
    ] as never);
    const done = await runHybrid({ mode: "semantic" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // 查询向量化一次
    expect(prisma.vectorChunk.findMany).toHaveBeenCalledTimes(1); // 仅余弦路查库
    expect(done.output).toContain("【s1｜相似度");
    expect(done.hits?.[0]).toMatchObject({ chunkId: 1, rank: 1 });
  });

  it("空查询词元：keyword 短路输出空串不炸图", async () => {
    const done = await runHybrid({ mode: "keyword", searchQuery: "！！" });
    expect(done.output).toBe("");
    expect(done.hits).toEqual([]);
  });
});

describe("rerank 节点", () => {
  const rerankNode: RerankNode = {
    id: "rr1",
    kind: "rerank",
    name: "重排",
    query: "容错 设计",
    sourceNodeId: "hs1",
    modelId: 9,
    topN: 3,
  };
  const seedHits = (n = 2) =>
    Array.from({ length: n }, (_, i) => ({
      chunkId: i + 1,
      sourceName: `s${i + 1}`,
      collection: "c",
      text: `原文片段${i + 1}`,
      score: 0.5,
      rank: i + 1,
    }));

  /** model.findUnique 桩指向 reranker 型模型（provider 桩为模块级既有：
   * openai-compatible / http://localhost:9 / apiKey k，不随 afterEach 复位） */
  const mockRerankerModel = () => {
    vi.mocked(prisma.model.findUnique).mockResolvedValue({
      id: 9,
      providerId: 2,
      modelId: "m",
      type: "reranker",
    } as never);
  };

  const jsonResponse = (payload: unknown) => ({
    ok: true,
    status: 200,
    json: async () => payload,
  });

  /** 直调 handler 工厂（先例 runHybrid）：runId=null 即席不落库；取本
   * 节点状态更新本体（hits 旁路只落 state，图执行入口不透出） */
  const runRerank = async (
    node: RerankNode,
    nodes: Record<string, NodeResult>,
  ) => {
    const handler = makeRerankNodeHandler(node, {
      runId: null,
      abort: new AbortController().signal,
      workspace: { id: 9, directoryPath: null },
      userId: 1,
      codeAuthorized: false,
      subflowStack: [],
      skills: [],
      agent: {} as NodeContext["agent"],
      now: new Date(),
      trace: [],
      modelCache: new Map(),
      deps: {} as NodeContext["deps"],
    });
    const update = await handler({ inputs: {}, nodes });
    return update.nodes![node.id];
  };

  it("模型非 reranker 报 rerank_model_type", async () => {
    vi.mocked(prisma.model.findUnique).mockResolvedValue({
      id: 9,
      providerId: 2,
      modelId: "m",
      type: "llm",
    } as never);
    await expect(
      runRerank(rerankNode, { hs1: { output: "x", hits: seedHits() } }),
    ).rejects.toMatchObject({ code: "rerank_model_type" });
  });

  it("来源无 hits 字段（未连线/非检索）报 rerank_source_invalid；空数组透传空", async () => {
    mockRerankerModel();
    await expect(
      runRerank(rerankNode, { other: { output: "x" } }),
    ).rejects.toMatchObject({ code: "rerank_source_invalid" });
    const done = await runRerank(rerankNode, {
      hs1: { output: "", hits: [] },
    });
    expect(done.output).toBe("");
    expect(done.hits).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rerank API 全链路：请求体形态/index 回挂/降序切 topN/hits 旁路", async () => {
    mockRerankerModel();
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [
          { index: 1, relevance_score: 0.91 },
          { index: 0, relevance_score: 0.42 },
        ],
      }),
    );
    const done = await runRerank(rerankNode, {
      hs1: { output: "x", hits: seedHits() },
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(fetchMock.mock.calls[0][0]).toContain("/rerank");
    expect(body).toMatchObject({ model: "m", query: "容错 设计", top_n: 3 });
    expect(body.documents).toEqual(["原文片段1", "原文片段2"]);
    expect(done.hits![0]).toMatchObject({
      sourceName: "s2",
      score: 0.91,
      rank: 1,
    });
    expect(done.output).toContain("【s2｜相关度 0.91】原文片段2");
  });

  it("候选 250 上限截断 + 单文档 2000 字符截断 + API 失败显式 rerank_api_error", async () => {
    mockRerankerModel();
    const many = seedHits(260).map((h, i) => ({
      ...h,
      text: "长".repeat(2100) + i,
    }));
    fetchMock.mockResolvedValue(
      jsonResponse({ results: [{ index: 0, relevance_score: 0.5 }] }),
    );
    await runRerank(rerankNode, { hs1: { output: "x", hits: many } });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.documents).toHaveLength(250);
    expect(body.documents[0].length).toBe(2000);
    fetchMock.mockResolvedValue(new Response("err", { status: 502 }));
    await expect(
      runRerank(rerankNode, { hs1: { output: "x", hits: seedHits() } }),
    ).rejects.toMatchObject({ code: "rerank_api_error" });
  });
});
