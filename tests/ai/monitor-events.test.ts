// monitor-events 单测：写入载荷、吞错、缺席跳过（skill-stats 先例）、
// usageFromBlocks 提取、buildGraphMonitorEvents trace → 事件映射
import { describe, expect, it, vi } from "vitest";
import {
  buildGraphMonitorEvents,
  recordLlmCall,
  recordToolCall,
  usageFromBlocks,
} from "@tianshu/core";

// Log 模块 mock 隔离（skill-stats.test 同款）：Log.ts 顶层读
// app.getPath("userData")，vitest node 环境无 electron 会收集期抛错
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

/** 捕获型 prisma stub（skill-stats.test 同款思路） */
function capturePrisma() {
  const calls = { llm: [] as unknown[], tools: [] as unknown[] };
  return {
    calls,
    llmCallEvent: {
      create: vi.fn(async (args: { data: unknown }) => {
        calls.llm.push(args.data);
      }),
    },
    toolCallEvent: {
      create: vi.fn(async (args: { data: unknown }) => {
        calls.tools.push(args.data);
      }),
    },
  };
}

describe("recordLlmCall/recordToolCall", () => {
  it("写入载荷字段完整、scene 透传", async () => {
    const p = capturePrisma();
    await recordLlmCall(p, {
      userId: 7,
      scene: "chat",
      modelId: 3,
      sessionId: 11,
      inputTokens: 100,
      outputTokens: 40,
      durationMs: 1200,
    });
    expect(p.calls.llm).toEqual([
      {
        userId: 7,
        scene: "chat",
        modelId: 3,
        sessionId: 11,
        inputTokens: 100,
        outputTokens: 40,
        durationMs: 1200,
      },
    ]);
    await recordToolCall(p, {
      userId: 7,
      scene: "graph",
      toolName: "write_file",
      state: "done",
      durationMs: 300,
      sessionId: 2,
    });
    expect(p.calls.tools).toEqual([
      {
        userId: 7,
        scene: "graph",
        toolName: "write_file",
        state: "done",
        durationMs: 300,
        sessionId: 2,
      },
    ]);
  });

  it("prisma 缺席静默跳过（不抛错）", async () => {
    await expect(
      recordLlmCall(undefined, {
        scene: "chat",
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).resolves.toBeUndefined();
    await expect(
      recordToolCall(undefined, {
        scene: "chat",
        toolName: "t",
        state: "done",
      }),
    ).resolves.toBeUndefined();
  });

  it("写库异常吞掉不外抛", async () => {
    const broken = {
      llmCallEvent: {
        create: vi.fn(async () => {
          throw new Error("db down");
        }),
      },
      toolCallEvent: {
        create: vi.fn(async () => {
          throw new Error("db down");
        }),
      },
    };
    await expect(
      recordLlmCall(broken, { scene: "chat", inputTokens: 1, outputTokens: 1 }),
    ).resolves.toBeUndefined();
    await expect(
      recordToolCall(broken, { scene: "chat", toolName: "t", state: "done" }),
    ).resolves.toBeUndefined();
  });
});

describe("usageFromBlocks", () => {
  it("取 usage 块；缺失返回 null（错误轮次/中止不产出 usage）", () => {
    expect(
      usageFromBlocks([
        { type: "text", text: "hi" },
        { type: "usage", input: 12, output: 5 },
      ]),
    ).toEqual({ input: 12, output: 5 });
    expect(usageFromBlocks([{ type: "text", text: "hi" }])).toBeNull();
  });
});

describe("buildGraphMonitorEvents", () => {
  it("带 tokens 节点 → llm 事件；toolCalls → 工具事件（ok→done / !ok→error）", () => {
    const { llm, tools } = buildGraphMonitorEvents({
      graphId: 9,
      userId: 7,
      sessionId: 4,
      trace: [
        {
          name: "n1",
          durationMs: 500,
          tokens: { promptTokens: 20, completionTokens: 8 },
        },
        {
          name: "n2",
          durationMs: 300,
          toolCalls: [
            { name: "write_file", ok: true, durationMs: 120 },
            { name: "run_command", ok: false, durationMs: 60 },
          ],
        },
        { name: "n3", durationMs: 10 },
      ],
    });
    expect(llm).toEqual([
      {
        userId: 7,
        scene: "graph",
        modelId: null,
        sessionId: 4,
        graphId: 9,
        inputTokens: 20,
        outputTokens: 8,
        durationMs: 500,
      },
    ]);
    expect(tools).toEqual([
      {
        userId: 7,
        scene: "graph",
        toolName: "write_file",
        state: "done",
        durationMs: 120,
        sessionId: 4,
      },
      {
        userId: 7,
        scene: "graph",
        toolName: "run_command",
        state: "error",
        durationMs: 60,
        sessionId: 4,
      },
    ]);
  });
});
