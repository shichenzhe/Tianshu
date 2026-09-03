import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
}));

// runChatStream 为纯函数；屏蔽 prisma-client 模块初始化对 electron app 路径的依赖
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {},
}));

import { MockLanguageModelV3 } from "ai/test";
import ChatService, {
  runChatStream,
} from "../../electron/domains/ai/chat/chat.service";
import type { SessionRepository } from "../../electron/domains/ai/chat/session.repo";

const userHistory = [
  {
    role: "user" as const,
    blocks: JSON.stringify([{ type: "text", text: "hi" }]),
  },
];

interface StreamModelOptions {
  error?: Error;
  /** 首个 delta 推送后挂起，直至该信号中止（模拟用户中途停止） */
  holdForAbort?: AbortSignal;
}

/**
 * 构造 mock 模型：按 ai@7 LanguageModelV3 流协议推送 chunk
 * （stream-start → text-start → text-delta(delta) → text-end → finish/error）
 */
function streamModel(chunks: string[], opts: StreamModelOptions = {}) {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t1" });
          for (const [index, delta] of chunks.entries()) {
            controller.enqueue({ type: "text-delta", id: "t1", delta });
            if (opts.holdForAbort && index === 0) {
              await new Promise<void>((resolve) =>
                opts.holdForAbort!.addEventListener("abort", () => resolve(), {
                  once: true,
                }),
              );
              // 中止后剩余内容不再推送；流可能已被消费端取消，静默收尾
              try {
                controller.close();
              } catch {
                /* noop */
              }
              return;
            }
          }
          controller.enqueue({ type: "text-end", id: "t1" });
          if (opts.error) {
            controller.enqueue({ type: "error", error: opts.error });
          } else {
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: {
                inputTokens: {
                  total: 3,
                  noCache: undefined,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 5, text: 5, reasoning: undefined },
              },
            });
          }
          controller.close();
        },
      }),
    }),
  });
}

describe("runChatStream", () => {
  it("累积 text 块并产出 usage 块，chunk 回调顺序推送", async () => {
    const received: string[] = [];
    const result = await runChatStream({
      model: streamModel(["你", "好"]),
      history: userHistory,
      params: {},
      onChunk: (chunk) => {
        if (chunk.type === "text-delta") {
          received.push(chunk.text);
        }
      },
    });
    expect(received).toEqual(["你", "好"]);
    expect(result.blocks).toEqual([
      { type: "text", text: "你好" },
      { type: "usage", input: 3, output: 5 },
    ]);
    expect(result.errorCode).toBeUndefined();
  });

  it("上游错误返回 errorCode 且保留已生成文本", async () => {
    const result = await runChatStream({
      model: streamModel(["部分"], {
        error: Object.assign(new Error("Unauthorized"), { statusCode: 401 }),
      }),
      history: userHistory,
      params: {},
    });
    expect(result.errorCode).toBe("AUTH_FAILED");
    expect(result.errorMessage).toBe("Unauthorized");
    // 错误路径的 finish 无真实 usage，不应产出 usage 块
    expect(result.blocks).toEqual([{ type: "text", text: "部分" }]);
  });

  it("模型流中途抛出等价于错误路径：保留已生成文本并分类", async () => {
    // ReadableStream 中途 error 会让消费端迭代直接抛出（statusCode 保留）；
    // 先让出事件循环一拍，保证已入队 delta 先行送达消费端
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t1" });
            controller.enqueue({ type: "text-delta", id: "t1", delta: "部分" });
            controller.enqueue({ type: "text-end", id: "t1" });
            await new Promise((resolve) => setTimeout(resolve, 10));
            controller.error(
              Object.assign(new Error("Unauthorized"), { statusCode: 401 }),
            );
          },
        }),
      }),
    });
    const result = await runChatStream({
      model,
      history: userHistory,
      params: {},
    });
    expect(result.errorCode).toBe("AUTH_FAILED");
    expect(result.errorMessage).toBe("Unauthorized");
    expect(result.blocks).toEqual([{ type: "text", text: "部分" }]);
  });

  it("用户中止不是错误：无 errorCode，已生成内容保留", async () => {
    // 中途中止：首个 delta 后停止，部分文本照常返回
    const abort = new AbortController();
    const midResult = await runChatStream({
      model: streamModel(["你", "好"], { holdForAbort: abort.signal }),
      history: userHistory,
      params: {},
      abortSignal: abort.signal,
      onChunk: (chunk) => {
        if (chunk.type === "text-delta") {
          abort.abort();
        }
      },
    });
    expect(midResult.errorCode).toBeUndefined();
    expect(midResult.errorMessage).toBeUndefined();
    expect(midResult.blocks).toEqual([{ type: "text", text: "你" }]);

    // 预先中止：直接返回空 blocks，同样无 errorCode
    const preAbort = new AbortController();
    preAbort.abort();
    const preResult = await runChatStream({
      model: streamModel(["你", "好"]),
      history: userHistory,
      params: {},
      abortSignal: preAbort.signal,
    });
    expect(preResult.errorCode).toBeUndefined();
    expect(preResult.blocks).toEqual([]);
  });
});

describe("ChatService 并发防护", () => {
  it("并发 send 在首个 await 前注册：第二次调用立即拒绝，用户消息不重复且失败后无泄漏", async () => {
    const sessions = {
      getSession: vi.fn().mockResolvedValue({ id: 1, assistantId: null }),
      setSessionModel: vi.fn().mockResolvedValue(undefined),
      appendMessage: vi.fn().mockResolvedValue({}),
      autotitleIfDefault: vi.fn().mockResolvedValue(undefined),
      // 返回 null 迫使首个请求在模型解析处失败（不触网、不依赖 prisma）
      getEffectiveModelId: vi.fn().mockResolvedValue(null),
    };
    const service = new ChatService(sessions as unknown as SessionRepository);

    // 未 await：首个请求同步完成注册后才轮到第二次调用
    const first = service.send({ sessionId: 1, content: "hi" });
    await expect(service.send({ sessionId: 1, content: "hi" })).rejects.toThrow(
      "CONCURRENT_REQUEST",
    );

    // 首个请求完整走完只落库一条用户消息，被拒的并发请求未重复落库
    await expect(first).rejects.toThrow("NO_MODEL");
    expect(sessions.appendMessage).toHaveBeenCalledTimes(1);

    // 早期失败已清理注册：后续请求不再报并发错误
    await expect(
      service.send({ sessionId: 1, content: "again" }),
    ).rejects.toThrow("NO_MODEL");
  });
});
