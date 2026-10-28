/**
 * 应用 ToolDefinition → LangChain Tool 适配（自 mirror
 * electron/domains/ai/orchestration/langchain-tool-adapter.ts 移植，
 * spec §1 安全红线）：执行必须经 tool-gate 导出的 runToolCall（命令门/
 * 文件门/批量删除/审批/审计全链继承），绝不直调 def.execute。
 * zod 参数 → DynamicStructuredTool；JSON Schema 裸对象 → DynamicTool
 * （字符串入参）。工具执行 chunk（running/审批/done 等工具态与
 * approval-request）与 finalStates 终态记录由 runToolCall 产出，经
 * opts.onChunk / opts.finalStates 透传——approval-request 不经引擎事件流，
 * 不透传则审批卡永不出现。toolCallId 优先取 config.toolCall.id
 * （langgraph ToolNode 经 ToolCall 调用时携带模型生成的 tool_call id，
 * 与 on_chat_model_end.tool_calls[].id 同源，保证块/chunk/审批三方 id
 * 一致）；直调（无 ToolCall 载荷）回落时间戳序号 id。
 */
import { z } from 'zod';
import {
  DynamicStructuredTool,
  DynamicTool,
  type StructuredToolInterface,
} from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { runToolCall, type AgentStreamOptions } from './tool-gate';
import type { ToolDefinition } from './tool-definition';
import type { ChatStreamChunk, ToolCallBlock } from '@tianshu/protocol';

/** toolCallId 唯一化：Date.now() 同毫秒内并发同名调用会碰撞（审批挂起键
 *  requestApproval 与审计/轨迹按 id 关联，碰撞即串线），后缀模块级单调序号 */
let toolCallSeq = 0;

export interface ToolAdapterOptions {
  abortSignal?: AbortSignal;
  /** 工具执行 chunk 出口（runToolCall 内工具态/审批卡推送） */
  onChunk?: (chunk: ChatStreamChunk) => void;
  /** 拒绝/中止终态记录（拒绝块 state=denied 等落库判定用，键 = toolCallId） */
  finalStates?: Map<string, ToolCallBlock['state']>;
}

export function toLangChainTools(
  defs: ToolDefinition[],
  agent: AgentStreamOptions,
  opts: ToolAdapterOptions,
): StructuredToolInterface[] {
  return defs.map((def) => {
    const dispatch = async (
      input: unknown,
      _runManager?: unknown,
      config?: RunnableConfig & { toolCall?: { id?: unknown } },
    ): Promise<string> => {
      const modelCallId = config?.toolCall?.id;
      const toolCallId =
        typeof modelCallId === 'string' && modelCallId
          ? modelCallId
          : `${def.name}-${Date.now()}-${toolCallSeq++}`;
      return await runToolCall(
        def,
        agent,
        toolCallId,
        input,
        opts.abortSignal,
        opts.onChunk,
        opts.finalStates,
      );
    };
    if (def.parameters instanceof z.ZodType) {
      return new DynamicStructuredTool({
        name: def.name,
        description: def.description,
        schema: def.parameters,
        func: dispatch,
      });
    }
    return new DynamicTool({
      name: def.name,
      description: `${def.description}\nInput JSON Schema: ${JSON.stringify(def.parameters)}`,
      func: async (
        raw: string,
        runManager?: unknown,
        config?: RunnableConfig & { toolCall?: { id?: unknown } },
      ) => {
        try {
          return await dispatch(JSON.parse(raw), runManager, config);
        } catch {
          return '错误: 工具参数不是合法 JSON，请按 Input JSON Schema 输出 JSON 字符串';
        }
      },
    });
  });
}
