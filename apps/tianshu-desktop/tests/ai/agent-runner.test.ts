// LangChain AgentRunner 桥接（AR-T1）：回调风格引擎 → AgentRunner 契约
// （AsyncIterable chunk 流 + 终值 Promise + approve 直通）。
// 引擎经 deps 注入 mock——只测桥接语义，不引入 LangChain 真身。
import { describe, expect, it, vi } from "vitest";

import { createLangChainAgentRunner } from "../../electron/domains/ai/chat/agent-runner";
import type { ChatStreamChunk } from "@tianshu/protocol";

/** 受控引擎桩：手动推 chunk/落终值/挂起等待（模拟流式时序） */
function makeEngine() {
  const pushed: Array<{ chunk: ChatStreamChunk }> = [];
  let onChunk: ((chunk: ChatStreamChunk) => void) | null = null;
  let settleResult: ((r: { blocks: unknown[] }) => void) | null = null;
  const runStream = vi.fn(
    (options: {
      onChunk?: (chunk: ChatStreamChunk) => void;
    }): Promise<{ blocks: unknown[] }> => {
      onChunk = options.onChunk ?? null;
      pushed.push({ chunk: { type: "finish" } }); // 占位防 TS 未使用
      pushed.pop();
      return new Promise((resolve) => {
        settleResult = resolve;
      });
    },
  );
  return {
    runStream,
    emit: (chunk: ChatStreamChunk) => onChunk?.(chunk),
    settle: (result: { blocks: unknown[] }) => settleResult?.(result),
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

describe("createLangChainAgentRunner", () => {
  it("chunks 保序透传 + 终值在流耗尽后落定", async () => {
    const engine = makeEngine();
    const runner = createLangChainAgentRunner({
      runStream: engine.runStream as never,
      respond: vi.fn(),
    });

    const handle = runner.run({} as never);
    const chunksDone = collect(handle.chunks);
    engine.emit({ type: "text-delta", text: "你" });
    engine.emit({ type: "text-delta", text: "好" });
    engine.emit({
      type: "tool-update",
      toolCallId: "t1",
      toolName: "write",
      state: "running",
    });
    engine.emit({ type: "finish" });
    const finalBlocks = [{ type: "text", text: "你好" }];
    engine.settle({ blocks: finalBlocks });

    const chunks = await chunksDone;
    expect(chunks.map((c) => c.type)).toEqual([
      "text-delta",
      "text-delta",
      "tool-update",
      "finish",
    ]);
    await expect(handle.result).resolves.toEqual({ blocks: finalBlocks });
  });

  it("run() 前已传的 onChunk 被桥接层覆写（接缝单一出口）", async () => {
    const engine = makeEngine();
    const callerChunk = vi.fn();
    const runner = createLangChainAgentRunner({
      runStream: engine.runStream as never,
      respond: vi.fn(),
    });

    runner.run({ onChunk: callerChunk } as never);
    engine.emit({ type: "finish" });
    engine.settle({ blocks: [] });

    expect(callerChunk).not.toHaveBeenCalled();
  });

  it("引擎 reject：流关闭 + result reject（消费者按 catch 收敛）", async () => {
    let rejectRun: ((e: unknown) => void) | null = null;
    const runStream = vi.fn(
      (): Promise<{ blocks: unknown[] }> =>
        new Promise((_resolve, reject) => {
          rejectRun = reject;
        }),
    );
    const runner = createLangChainAgentRunner({
      runStream: runStream as never,
      respond: vi.fn(),
    });

    const handle = runner.run({} as never);
    const chunksDone = collect(handle.chunks);
    const resultSpy = vi.fn();
    handle.result.catch(resultSpy);
    rejectRun?.(new Error("engine down"));

    expect(await chunksDone).toEqual([]);
    await Promise.resolve();
    expect(resultSpy).toHaveBeenCalledTimes(1);
  });

  it("approve：经注入 respond 直通（toolCallId/approved 逐字）", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const runner = createLangChainAgentRunner({
      runStream: vi.fn(),
      respond,
    });

    await runner.approve("tc-9", true);
    expect(respond).toHaveBeenCalledWith("tc-9", true);
    await runner.approve("tc-9", false);
    expect(respond).toHaveBeenLastCalledWith("tc-9", false);
  });
});
