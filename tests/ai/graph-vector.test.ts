// tests/ai/graph-vector.test.ts
/**
 * 向量管线：chunkText/cosine 纯函数；embedTexts（fetch 打桩，批次切分
 * 与 index 归位）；vectorize→vectorSearch 端到端（真跑内存余弦，embed
 * 打桩为确定性向量）。
 */
import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`) },
  Notification: vi.fn(),
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    // 去会话化：节点详情落 graphRunNode（session/message 两键已删）
    graphRunNode: { upsert: vi.fn(async () => ({ id: 1 })) },
    automationRun: { create: vi.fn(async () => ({ id: 9 })), update: vi.fn() },
    automationTask: { update: vi.fn() },
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
    graphDefinition: { findFirst: vi.fn() },
    vectorChunk: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async () => ({})),
      findMany: vi.fn(),
      count: vi.fn(async () => 0),
    },
    $transaction: vi.fn(async (ops) => ops),
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
import {
  executeGraphRun,
  embedTexts,
} from "../../electron/domains/ai/orchestration/graph-executor";
import {
  chunkText,
  cosine,
} from "../../electron/domains/ai/orchestration/vector-store";

const fetchMock = vi.fn();
beforeAll(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
  vi.mocked(prisma.vectorChunk.findMany).mockReset();
});

describe("chunkText / cosine（纯函数）", () => {
  it("短文本单块；长文本按窗口+重叠切块；空串零块", () => {
    expect(chunkText("短", 500, 100)).toEqual(["短"]);
    expect(chunkText("", 500, 100)).toEqual([]);
    const long = "a".repeat(1200);
    const chunks = chunkText(long, 500, 100);
    // 1200 字符 / step 400 → 起始 0/400/800 三块
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(500);
  });

  it("余弦：同向 1、正交 0、零向量防除零", () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 3])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("embedTexts（fetch 打桩）", () => {
  it("批量切分 + index 乱序归位；错误码 embed_api_error", async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: body.input.map((_text, i) => {
            const at = body.input.length - 1 - i; // 故意乱序
            return {
              index: at,
              embedding: [body.input[at].length, 1], // 与 index 对应文本一致
            };
          }),
        }),
      };
    });
    const vectors = await embedTexts(1, ["a", "bb", "ccc"]);
    expect(vectors).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({}),
    });
    await expect(embedTexts(1, ["x"])).rejects.toThrow(/embed_api_error|429/);
  });

  it("signal 透传 fetch（向量节点超时通道）", async () => {
    const controller = new AbortController();
    const signals: unknown[] = [];
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      signals.push(init?.signal);
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ index: 0, embedding: [1, 2] }] }),
      };
    });
    await embedTexts(1, ["hi"], controller.signal);
    expect(signals[0]).toBe(controller.signal);
  });
});

describe("vectorize → vectorSearch 端到端（embed 打桩）", () => {
  const run = (nodes: object[], edges: object[], inputs = {}) =>
    executeGraphRun({
      graph: {
        id: 5,
        name: "vec-demo",
        graphJson: JSON.stringify({
          version: 1,
          inputSchema: {},
          nodes,
          edges,
        }),
        version: 1,
        enabled: true,
        userId: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never,
      task: null,
      inputs,
      triggerType: "manual" as const,
      attempt: 1,
      abort: new AbortController().signal,
      workspace: { id: 9, directoryPath: null },
    });

  const lastUpdate = () =>
    vi.mocked(prisma.automationRun.update).mock.calls.at(-1)![0];
  const traceOf = () => JSON.parse(lastUpdate().data.graphTrace as string);

  it("入库落块 → 检索按余弦排序输出条目名+相似度", async () => {
    // embed：用首字符 ASCII 构造可区分向量（cat→[99,1]、car→[97,1]）
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: body.input.map((text, index) => ({
            index,
            embedding: [text.charCodeAt(0), text.charCodeAt(1)],
          })),
        }),
      };
    });

    vi.mocked(prisma.vectorChunk.findMany).mockResolvedValue([]);
    const out = await run(
      [
        {
          id: "ingest",
          name: "入库",
          kind: "vectorize",
          collection: "animals",
          sourceName: "词典A",
          text: "cat\n",
          modelId: 1,
          chunkSize: 500,
          chunkOverlap: 100,
        },
        {
          id: "find",
          name: "检索",
          kind: "vectorSearch",
          collection: "animals",
          searchQuery: "car",
          modelId: 1,
          topK: 5,
        },
      ],
      [
        { from: "ingest", to: "find" },
        { from: "find", to: "END" },
      ],
    );
    expect(out).toBe("success");
    // 入库 upsert 先删后插
    expect(prisma.vectorChunk.deleteMany).toHaveBeenCalledWith({
      where: { userId: 1, collection: "animals", sourceName: "词典A" },
    });
    expect(prisma.vectorChunk.create).toHaveBeenCalled();
    // 检索：内存余弦消费了入库向量（findMany 返回入库行）
    const created = vi.mocked(prisma.vectorChunk.create).mock.calls[0][0];
    vi.mocked(prisma.vectorChunk.findMany).mockResolvedValue([
      {
        id: 1,
        userId: 1,
        collection: "animals",
        sourceName: "词典A",
        seq: 0,
        text: "cat",
        vector: JSON.stringify(created.data.vector),
        model: "1",
        createdAt: new Date(),
      },
    ] as never);
    const out2 = await run(
      [
        {
          id: "find",
          name: "检索",
          kind: "vectorSearch",
          collection: "animals",
          searchQuery: "car",
          modelId: 1,
          topK: 5,
        },
      ],
      [{ from: "find", to: "END" }],
    );
    expect(out2).toBe("success");
    const preview = traceOf()[0].outputPreview;
    expect(preview).toContain("词典A");
    expect(preview).toContain("相似度");
  });
});
