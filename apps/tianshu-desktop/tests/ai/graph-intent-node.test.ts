// tests/ai/graph-intent-node.test.ts
/**
 * 意图识别节点（kind:intent，Coze Intent 式语义路由）：query 交模型
 * 分类到 intents 清单 → route=output=意图名；未命中走 fallback、无
 * fallback 则 intent_no_match 失败。mock 三件套沿用 graph-executor
 * .test.ts 先例（createChatModel mock 的 invoke 控制模型输出）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`) },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    // 去会话化：节点详情落 graphRunNode（session/message 两键已删；
    // 环图重入 upsert 聚合一行，mock 只需 upsert 键）
    graphRunNode: { upsert: vi.fn(async () => ({ id: 1 })) },
    automationRun: { create: vi.fn(async () => ({ id: 9 })), update: vi.fn() },
    automationTask: { update: vi.fn() },
    model: {
      findUnique: vi.fn(async () => ({
        id: 1,
        providerId: 2,
        modelId: "test-model",
      })),
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

const modelMock = { invoke: vi.fn() };
vi.mock(
  "../../electron/domains/ai/orchestration/langchain-model-factory",
  () => ({
    createChatModel: vi.fn(() => modelMock),
  }),
);

import prisma from "../../electron/commons/prisma-client";
import { executeGraphRun } from "../../electron/domains/ai/orchestration/graph-executor";

const lastUpdate = () =>
  vi.mocked(prisma.automationRun.update).mock.calls.at(-1)![0];
const traceOf = () => JSON.parse(lastUpdate().data.graphTrace as string);

/** 意图分流图：intent（pre/after 两意图）→ pre 走 follow 处理、after 直 END */
const graph = (extra: Record<string, unknown> = {}) =>
  ({
    id: 5,
    name: "intent-demo",
    graphJson: JSON.stringify({
      version: 1,
      inputSchema: { q: "string" },
      nodes: [
        {
          id: "cls",
          name: "意图识别",
          kind: "intent",
          modelId: 1,
          querySource: "{{input.q}}",
          intents: [
            { name: "pre", description: "售前咨询：价格、功能、试用" },
            { name: "after", description: "售后支持：故障、退款、工单" },
          ],
          ...extra,
        },
        {
          id: "follow",
          name: "售前跟进",
          kind: "llm",
          modelId: 1,
          prompt: "跟进 {{nodes.cls.output}}",
          tools: false,
          outputMode: "text",
        },
      ],
      edges: [
        {
          from: "cls",
          to: "follow",
          condition: { type: "branch", value: "pre" },
        },
        {
          from: "cls",
          to: "END",
          condition: { type: "branch", value: "after" },
        },
        { from: "follow", to: "END" },
      ],
    }),
    version: 1,
    enabled: true,
    userId: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as never;

const run = (extra: Record<string, unknown> = {}) =>
  executeGraphRun({
    graph: graph(extra),
    task: null,
    inputs: { q: "想了解一下价格" },
    triggerType: "manual" as const,
    attempt: 1,
    abort: new AbortController().signal,
    workspace: { id: 9, directoryPath: null },
  });

beforeEach(() => {
  vi.mocked(prisma.automationRun.update).mockClear();
  vi.mocked(prisma.graphRunNode.upsert).mockClear();
  modelMock.invoke.mockReset();
});

describe("intent 节点（语义路由）", () => {
  it("模型输出命中意图 → route=output=意图名，pre 分支下游执行", async () => {
    // AIMessage 形态：content + usage_metadata（节点行与 trace 同带 usage）
    modelMock.invoke.mockResolvedValue({
      content: '{"intent": "pre"}',
      usage_metadata: { input_tokens: 2, output_tokens: 3 },
    });
    const out = await run();
    expect(out).toBe("success");
    const byId = Object.fromEntries(
      traceOf().map((entry: { id: string }) => [entry.id, entry]),
    );
    expect(byId.cls.outputPreview).toBe("pre");
    expect(byId.follow.status).toBe("success");
    // 节点详情行同样落 usage（trace 侧既有，节点行补齐 2026-10-28 终审）
    const clsRow = vi
      .mocked(prisma.graphRunNode.upsert)
      .mock.calls.find((c) => c[0].create.nodeId === "cls")![0];
    expect(clsRow.create).toMatchObject({
      output: "pre",
      promptTokens: 2,
      completionTokens: 3,
    });
  });

  it("模型输出不在清单 → 走 fallback 兜底意图", async () => {
    modelMock.invoke.mockResolvedValue('{"intent": "别的"}');
    const out = await run({ fallback: "after" });
    expect(out).toBe("success");
    // 未选中分支的节点 trace 落 skipped 占位（condition 节点先例）
    const byId = Object.fromEntries(
      traceOf().map((entry: { id: string }) => [entry.id, entry]),
    );
    expect(byId.cls.outputPreview).toBe("after");
    expect(byId.follow.status).toBe("skipped");
  });

  it("未命中且无 fallback → intent_no_match 节点失败", async () => {
    modelMock.invoke.mockResolvedValue("无法分类");
    const out = await run();
    expect(out).toBe("failed");
    expect(lastUpdate().data.error).toMatch(/node:cls intent_no_match/);
  });
});
