/**
 * 远程会话流式状态归约（T18）：server:chunk:<connId>:<sessionId> 载荷
 * （ChatStreamChunk，与桌面端 chat:stream 同构）增量归并为 {thinking,
 * tools, text} 纯函数——渲染端与 RemoteMessageList 复用桌面端 blocks
 * 渲染管道（thinking + tools + text → MessageItem parsedBlocks）。
 * 终态：finish=done；chunk error / session.error 事件=error（外层置入）。
 */
import type { ChatStreamChunk } from "@/domains/ai/api/chat.api";

export interface RemoteToolState {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  state: string;
  output?: string;
  argSummary?: string;
}

export interface RemoteStreamState {
  /** 流进行中（send 后 true；finish/error 置 false） */
  active: boolean;
  status: "streaming" | "done" | "error";
  text: string;
  thinking: string;
  toolOrder: string[];
  tools: Record<string, RemoteToolState>;
  errorMessage?: string;
}

/** 空闲态（未发送/已收尾清场） */
export function idleRemoteStream(): RemoteStreamState {
  return {
    active: false,
    status: "done",
    text: "",
    thinking: "",
    toolOrder: [],
    tools: {},
  };
}

/** 发送即开启新流（清场旧块） */
export function startRemoteStream(): RemoteStreamState {
  return { ...idleRemoteStream(), active: true, status: "streaming" };
}

/** 单 chunk 归并（幂等纯函数；finish 后再到的迟到 chunk 忽略） */
export function applyRemoteChunk(
  state: RemoteStreamState,
  chunk: ChatStreamChunk,
): RemoteStreamState {
  switch (chunk.type) {
    case "text-delta":
      if (!state.active) return state;
      return { ...state, text: state.text + chunk.text };
    case "reasoning-delta":
      if (!state.active) return state;
      return { ...state, thinking: state.thinking + chunk.text };
    case "tool-update": {
      if (!state.active) return state;
      const tools = { ...state.tools };
      const order = [...state.toolOrder];
      if (!tools[chunk.toolCallId]) {
        order.push(chunk.toolCallId);
      }
      tools[chunk.toolCallId] = {
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        args: chunk.args,
        state: chunk.state,
        output: chunk.output,
        argSummary: tools[chunk.toolCallId]?.argSummary,
      };
      return { ...state, tools, toolOrder: order };
    }
    case "approval-request": {
      if (!state.active) return state;
      const tools = { ...state.tools };
      const order = [...state.toolOrder];
      if (!tools[chunk.toolCallId]) {
        order.push(chunk.toolCallId);
      }
      tools[chunk.toolCallId] = {
        ...(tools[chunk.toolCallId] ?? {
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          state: "awaiting-approval",
        }),
        state: "awaiting-approval",
        argSummary: chunk.argSummary,
      };
      return { ...state, tools, toolOrder: order };
    }
    case "finish":
      return { ...state, active: false, status: "done" };
    case "error":
      return {
        ...state,
        active: false,
        status: "error",
        errorMessage: chunk.message,
      };
    // title-updated：列表刷新经 session.updated 事件，无需本地态
    default:
      return state;
  }
}

/** session.error 事件（合并通道 server:event:<connId>）置错收尾 */
export function failRemoteStream(
  state: RemoteStreamState,
  message: string,
): RemoteStreamState {
  return { ...state, active: false, status: "error", errorMessage: message };
}

/** 流式 liveMessage 的 blocks 组装（MessageList liveMessage 同构） */
export function liveBlocks(state: RemoteStreamState) {
  const blocks: Array<
    | { type: "thinking"; text: string }
    | {
        type: "tool_call";
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
        state: string;
        output?: unknown;
      }
    | { type: "text"; text: string }
  > = [];
  if (state.thinking) {
    blocks.push({ type: "thinking", text: state.thinking });
  }
  for (const toolCallId of state.toolOrder) {
    const tool = state.tools[toolCallId];
    if (tool) {
      blocks.push({
        type: "tool_call",
        toolCallId,
        toolName: tool.toolName,
        args: (tool.args ?? {}) as Record<string, unknown>,
        state: tool.state,
        output: tool.output,
      });
    }
  }
  if (state.text) {
    blocks.push({ type: "text", text: state.text });
  }
  return blocks;
}
