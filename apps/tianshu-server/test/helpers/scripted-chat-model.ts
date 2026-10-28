// 移植自 mirror tests/ai/helpers/scripted-chat-model.ts（统一 LLM 栈 T3-3）：
// vitest→jest 适配仅 prettier 归一，脚本步形状与断言面零改动。
//
// LangChain 脚本化假模型（agent-loop 等共用替身）：
// - 扩展点 `_streamResponseChunks`（core 1.x 的流式钩子，非 `_stream`），
//   逐 chunk yield 后手动调 runManager.handleLLMNewToken(..., {chunk})——
//   createReactAgent 的模型节点走 invoke()，on_chat_model_stream 事件靠模型
//   侧回调驱动（框架不代发），不调则流式 chunk 事件缺失
// - `bindTools` 捕获注入工具名（send 级组装断言用）并返回 this
// - 脚本步形状：text/reasoning/tool
import { AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';

export type ScriptStep =
  | { kind: 'text'; delta: string }
  | { kind: 'reasoning'; delta: string }
  | {
      kind: 'tool';
      toolCallId: string;
      toolName: string;
      /** MCP 字符串入参工具传 JSON 字符串，zod 工具传对象（原样到达 args） */
      input: unknown;
    };

export interface StepScript {
  steps: ScriptStep[];
  /** 该轮（一次模型调用）末个流式 chunk 携带的 usage_metadata——多轮各自
   * 上报，消费侧（emitter usage 记账）按 run_id 去重后跨轮累加 */
  usage?: { input: number; output: number };
  /** usage 仅随 on_chat_model_end 聚合消息上报（部分 provider 形态）：
   * 流式 chunk 不携带 usage，改挂在一个不触发 handleLLMNewToken 的静默
   * 收尾 chunk 上——core 仍按 concat 聚合进 end 消息，但流式事件侧不可见 */
  usageOnEndOnly?: boolean;
  /** 全部 chunk 推送完后抛出（错误路径用例；原样抛出保留 statusCode 等） */
  error?: unknown;
}

export interface CapturedCall {
  /** 本次调用收到的完整消息序列（system 注入/工具回喂断言用） */
  messages: BaseMessage[];
  /** bindTools 注入的工具名（组装断言用；按调用时点快照） */
  toolNames: string[];
}

interface ChunkFields {
  content?: unknown;
  additional_kwargs?: Record<string, unknown>;
  tool_calls?: Array<{
    id: string;
    name: string;
    args: unknown;
    type: 'tool_call';
  }>;
  usage_metadata?: { input_tokens: number; output_tokens: number };
}

/** runManager 最小面：仅需 handleLLMNewToken（token, …, {chunk}) */
interface NewTokenRunManager {
  handleLLMNewToken: (
    token: string,
    a?: unknown,
    b?: unknown,
    c?: unknown,
    d?: unknown,
    fields?: { chunk: ChatGenerationChunk },
  ) => Promise<unknown>;
}

export class ScriptedChatModel extends BaseChatModel {
  readonly scripts: StepScript[];
  /** 模型被调用次数（recursionLimit 保险丝断言用） */
  calls = 0;
  /** 每次调用收到的消息（tool-result 回喂断言用） */
  seenInputs: BaseMessage[][] = [];
  /** 调用日志（消息 + 工具名快照） */
  callsLog: CapturedCall[] = [];
  protected boundToolNames: string[] = [];

  constructor(scripts: StepScript[]) {
    super({});
    this.scripts = scripts;
  }

  _llmType(): string {
    return 'scripted-test';
  }

  /** 捕获注入工具名后原样返回（createReactAgent 构造时调用） */
  bindTools(tools: Array<{ name: string }>): ScriptedChatModel {
    this.boundToolNames = tools.map((tool) => tool.name);
    return this;
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    _options: never,
    runManager: NewTokenRunManager | undefined,
  ): AsyncGenerator<ChatGenerationChunk> {
    const index = this.calls;
    this.calls += 1;
    this.seenInputs.push(messages);
    this.callsLog.push({
      messages,
      toolNames: [...this.boundToolNames],
    });
    const script = this.scripts[index] ?? { steps: [] as ScriptStep[] };
    const chunks: ChunkFields[] = script.steps
      .filter((step) => step.kind !== 'tool')
      .map((step) =>
        step.kind === 'reasoning'
          ? {
              content: '',
              additional_kwargs: { reasoning_content: step.delta },
            }
          : { content: step.delta },
      );
    const toolCalls = script.steps
      .filter(
        (step): step is Extract<ScriptStep, { kind: 'tool' }> =>
          step.kind === 'tool',
      )
      .map((step) => ({
        id: step.toolCallId,
        name: step.toolName,
        args: step.input,
        type: 'tool_call' as const,
      }));
    if (toolCalls.length > 0) {
      chunks.push({ content: '', tool_calls: toolCalls });
    }
    if (script.usage && !script.usageOnEndOnly && chunks.length > 0) {
      chunks[chunks.length - 1].usage_metadata = {
        input_tokens: script.usage.input,
        output_tokens: script.usage.output,
      };
    }
    for (const fields of chunks) {
      // core 1.2.18 起 ChatGenerationChunk 构造要求显式 text（mirror 1.2.17
      // 可省）——字符串 content 原样、其余（reasoning/tool/usage 尾块）空串
      const generation = new ChatGenerationChunk({
        text: typeof fields.content === 'string' ? fields.content : '',
        message: new AIMessageChunk(fields as never),
      });
      yield generation;
      await runManager?.handleLLMNewToken(
        typeof fields.content === 'string' ? fields.content : '',
        void 0,
        void 0,
        void 0,
        void 0,
        { chunk: generation },
      );
    }
    if (script.usage && script.usageOnEndOnly) {
      // 静默收尾 chunk：进入 core 的 concat 聚合（on_chat_model_end 消息带
      // usage），但不调 handleLLMNewToken（流式事件侧无 usage）
      const usageFields: ChunkFields = {
        content: '',
        usage_metadata: {
          input_tokens: script.usage.input,
          output_tokens: script.usage.output,
        },
      };
      yield new ChatGenerationChunk({
        text: '',
        message: new AIMessageChunk(usageFields as never),
      });
    }
    if (script.error !== undefined) {
      // 原样抛出保留 statusCode 等载荷（错误路径用例断言形状）
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw script.error;
    }
  }

  /** 非流式兜底（聚合脚本输出）。触发条件：回调链无流式偏好 handler 的
   * invoke（如不经 streamEvents 直接调用）——本仓库 runChatStream/
   * streamEvents 链路不触发，属防御路径。返回形状按 core ChatResult */
  _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const index = this.calls;
    this.calls += 1;
    this.seenInputs.push(messages);
    const script = this.scripts[index] ?? { steps: [] as ScriptStep[] };
    let aggregate = new AIMessageChunk('');
    for (const step of script.steps) {
      if (step.kind === 'text') {
        aggregate = aggregate.concat(
          new AIMessageChunk({ content: step.delta }),
        );
      }
    }
    return Promise.resolve({
      generations: [
        new ChatGenerationChunk({
          text: typeof aggregate.content === 'string' ? aggregate.content : '',
          message: aggregate,
        }),
      ],
    });
  }
}

/** 最小调用选项面：仅需 signal（abort 协作） */
interface AbortableOptions {
  signal?: AbortSignal;
}

/**
 * 永不产出模型（挂起流）：构造即注册调用（calls 计数可观察"已进入模型
 * 节点"），generator 挂起直至 AbortSignal 触发时 reject——并发守卫用例的
 * 中止靶。abort 协作与真实 provider 模型同款（fetch 在 signal 上 reject），
 * 中止链路（stop → signal → 流收尾）经此可端到端复现。
 */
export class HangingChatModel extends ScriptedChatModel {
  constructor() {
    super([]);
  }
  async *_streamResponseChunks(
    messages: BaseMessage[],
    options?: AbortableOptions,
  ): AsyncGenerator<ChatGenerationChunk> {
    // 与基类同款调用登记（calls 计数是"已进入模型节点"的观察面）
    this.calls += 1;
    this.seenInputs.push(messages);
    this.callsLog.push({ messages, toolNames: [...this.boundToolNames] });
    await new Promise<never>((_, reject) => {
      if (options?.signal?.aborted) {
        reject(new Error('aborted'));
        return;
      }
      options?.signal?.addEventListener(
        'abort',
        () => reject(new Error('aborted')),
        { once: true },
      );
    });
    yield undefined as never;
  }
}

/** 便捷构造：脚本数组 → { model, modelCallCount } */
export function scriptedChatModel(scripts: StepScript[]): {
  model: ScriptedChatModel;
  modelCallCount: () => number;
} {
  const model = new ScriptedChatModel(scripts);
  return { model, modelCallCount: () => model.calls };
}
