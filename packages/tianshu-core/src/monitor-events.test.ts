import { describe, expect, it, vi } from "vitest";
import { recordLlmCall, recordToolCall } from "./monitor-events";

describe("recordLlmCall meta 透传（专家团可观测性批）", () => {
  it("meta 字段随事件原样落 llmCallEvent.create（成员名/轮次承载）", async () => {
    const create = vi.fn(async () => ({}));
    await recordLlmCall(
      { llmCallEvent: { create } },
      {
        userId: 1,
        scene: "chat",
        modelId: 2,
        sessionId: 3,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1200,
        meta: JSON.stringify({ kind: "member", member: "顾大局", round: 1 }),
      },
    );
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scene: "chat",
        meta: '{"kind":"member","member":"顾大局","round":1}',
      }),
    });
  });

  it("meta 缺席不携带键（server 侧无列 schema 依赖此形态）", async () => {
    const create = vi.fn(async () => ({}));
    await recordLlmCall(
      { llmCallEvent: { create } },
      {
        scene: "chat",
        inputTokens: 1,
        outputTokens: 1,
      },
    );
    const data = create.mock.calls[0][0].data as Record<string, unknown>;
    expect("meta" in data).toBe(false);
  });

  it("prisma 缺席静默跳过（纯函数测试形态）", async () => {
    await expect(
      recordLlmCall(undefined, { scene: "chat", inputTokens: 1, outputTokens: 1 }),
    ).resolves.toBeUndefined();
  });
});

describe("recordToolCall 静默吞错", () => {
  it("create 抛错不外泄（埋点失败不影响主流程）", async () => {
    const create = vi.fn(async () => {
      throw new Error("db down");
    });
    await expect(
      recordToolCall(
        { toolCallEvent: { create } },
        { scene: "chat", toolName: "dispatch", state: "done" },
      ),
    ).resolves.toBeUndefined();
  });
});
