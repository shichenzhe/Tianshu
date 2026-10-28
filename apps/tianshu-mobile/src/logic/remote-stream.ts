/**
 * 远程会话流式状态归约（T18）：server:chunk:<connId>:<sessionId> 载荷
 * （ChatStreamChunk，与桌面端 chat:stream 同构）增量归并为 {thinking,
 * tools, text} 纯函数——渲染端与 RemoteMessageList 复用桌面端 blocks
 * 渲染管道（thinking + tools + text → MessageItem parsedBlocks）。
 * 终态：finish=done；chunk error / session.error 事件=error（外层置入）。
 * 移动端搬迁（T10）：原 import @/domains/ai/api/chat.api 的 ChatStreamChunk
 * 改自 @tianshu/protocol 直引（桌面端同为该包 re-export，类型同源）。
 * T15 审批队列：approval-request 入队 approvals（FIFO）；tool-update 使该
 * toolCallId 离开 awaiting-approval 即出队（含 running——本端/他端已应答
 * 与终态 done/denied/error 一并覆盖）；finish/error/fail 清空（流已收场，
 * 挂起审批不可再应答）。UI（ApprovalBanner）直接消费队列首项。
 */
import type { ChatStreamChunk } from "@tianshu/protocol";

export interface RemoteToolState {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  state: string;
  output?: string;
  argSummary?: string;
}

/** 待应答审批项（approval-request chunk 原样入队） */
export interface RemoteApproval {
  toolCallId: string;
  toolName: string;
  argSummary: string;
}

export interface RemoteStreamState {
  /** 流进行中（send 后 true；finish/error 置 false） */
  active: boolean;
  status: "streaming" | "done" | "error";
  text: string;
  thinking: string;
  toolOrder: string[];
  tools: Record<string, RemoteToolState>;
  /** 待应答审批队列（FIFO；ApprovalBanner 消费首项） */
  approvals: RemoteApproval[];
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
    approvals: [],
  };
}

/** 发送即开启新流（清场旧块） */
export function startRemoteStream(): RemoteStreamState {
  return { ...idleRemoteStream(), active: true, status: "streaming" };
}

/** approval-request 队列语义：同 id 重发刷新摘要不重复排队 */
function enqueueApproval(
  approvals: RemoteApproval[],
  chunk: Extract<ChatStreamChunk, { type: "approval-request" }>,
): RemoteApproval[] {
  const next: RemoteApproval = {
    toolCallId: chunk.toolCallId,
    toolName: chunk.toolName,
    argSummary: chunk.argSummary,
  };
  return approvals.some((a) => a.toolCallId === chunk.toolCallId)
    ? approvals.map((a) =>
        a.toolCallId === chunk.toolCallId ? { ...a, argSummary: chunk.argSummary } : a,
      )
    : [...approvals, next];
}

/** tool-update 出队语义：state 离开 awaiting-approval 即出队（他端已应答
 * 的 running 同样出队——双端先到先得，后到方 banner 即刻收起） */
function dequeueApproval(
  approvals: RemoteApproval[],
  toolCallId: string,
  state: string,
): RemoteApproval[] {
  if (state === "awaiting-approval") return approvals;
  return approvals.filter((a) => a.toolCallId !== toolCallId);
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
      return {
        ...state,
        tools,
        toolOrder: order,
        approvals: dequeueApproval(state.approvals, chunk.toolCallId, chunk.state),
      };
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
      return {
        ...state,
        tools,
        toolOrder: order,
        approvals: enqueueApproval(state.approvals, chunk),
      };
    }
    case "finish":
      return { ...state, active: false, status: "done", approvals: [] };
    case "error":
      return {
        ...state,
        active: false,
        status: "error",
        errorMessage: chunk.message,
        approvals: [],
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
  return {
    ...state,
    active: false,
    status: "error",
    errorMessage: message,
    approvals: [],
  };
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
