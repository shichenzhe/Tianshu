/**
 * LangChain 引擎的 AgentRunner 实现（AR-T1 第一实现，换基座预留插槽）：
 * 把回调风格的 runChatStream（chat.service 薄包装——固定注入
 * toLangChainTools 的 core 工具循环）桥接为 AgentRunner 契约（AsyncIterable
 * chunk 流 + 终值 Promise）。未来第二引擎（DeepSeek harness 等）实现同
 * 契约即可在编排层整链替换，chunk 协议/审批流/UI 零改动。
 *
 * 引擎经 deps 注入（不反向值依赖 chat.service，避免运行时循环导入）；
 * 类型仅 type-only 引用。streamAndPersist 已切至 runner.run() 消费
 * （AR-T2 焊实——编排层经 chunks 流 + result 终值驱动引擎）。
 */
import type {
  AgentRunner,
  AgentRunHandle,
  ChatStreamChunk,
  MessageBlock,
} from "@tianshu/protocol";
import type { ChatStreamOptions, ChatStreamResult } from "./chat.service";

/** chunk 推送队列：回调出口 → AsyncIterable（流式推送/等待者唤醒/终结广播） */
class ChunkQueue implements AsyncIterable<ChatStreamChunk> {
  private queue: ChatStreamChunk[] = [];
  private waiters: Array<(item: IteratorResult<ChatStreamChunk>) => void> = [];
  private finished = false;

  push(chunk: ChatStreamChunk): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: chunk, done: false });
      return;
    }
    this.queue.push(chunk);
  }

  /** 流终结（正常/错误同途——消费者按 error chunk/终值区分收敛形态） */
  close(): void {
    this.finished = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ChatStreamChunk> {
    return {
      next: (): Promise<IteratorResult<ChatStreamChunk>> => {
        const chunk = this.queue.shift();
        if (chunk !== undefined) {
          return Promise.resolve({ value: chunk, done: false });
        }
        if (this.finished) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

/** 引擎与审批出口注入（ChatService 装配：runChatStream + approvals.respond） */
export interface LangChainRunnerDeps {
  /** 回调风格引擎入口（onChunk 在 options 内——桥接层覆写聚合） */
  runStream: (options: ChatStreamOptions) => Promise<ChatStreamResult>;
  /** 审批应答出口（approvals.respond 同源——IPC/远控/runner 三口共用；
   *  返回同步 boolean（应答命中态）或 Promise，approve 内 await 归一） */
  respond: (toolCallId: string, approved: boolean) => unknown;
}

/** 构造 LangChain 引擎 runner（approve 经注入的 respond 直通审批协调器） */
export function createLangChainAgentRunner(
  deps: LangChainRunnerDeps,
): AgentRunner<ChatStreamOptions, MessageBlock> {
  return {
    run(options: ChatStreamOptions): AgentRunHandle<MessageBlock> {
      const queue = new ChunkQueue();
      let settle!: (result: ChatStreamResult) => void;
      let fail!: (error: unknown) => void;
      const result = new Promise<ChatStreamResult>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      // 回调桥接：引擎 chunk 即推即唤醒；终态 close 队列并落终值
      // （调用方已传 onChunk 的场景以桥接层为准——接缝单一出口）
      deps
        .runStream({ ...options, onChunk: (chunk) => queue.push(chunk) })
        .then(
          (final) => {
            queue.close();
            settle(final);
          },
          (error: unknown) => {
            queue.close();
            fail(error);
          },
        );
      return { chunks: queue, result };
    },
    async approve(toolCallId: string, approved: boolean): Promise<void> {
      await deps.respond(toolCallId, approved);
    },
  };
}
