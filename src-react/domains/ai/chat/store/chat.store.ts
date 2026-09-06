/**
 * chat 流式状态（仅流式期间的临时缓冲，持久化数据走 React Query）
 */

import { create } from "zustand";

/** 单个工具调用的流式状态（与 chat.api ChatStatusResult.tools.map 值同构） */
export interface ToolStreamState {
  toolName: string;
  args?: unknown;
  /** 主进程透传的字符串（含 tool-update 前瞬态 ""），渲染层不做枚举收窄 */
  state: string;
  output?: string;
  argSummary?: string;
}

/** 流式工具集合：order 保序，map 按 toolCallId 索引 */
export interface ToolStreamMap {
  order: string[];
  map: Record<string, ToolStreamState>;
}

export interface StreamContent {
  text: string;
  thinking: string;
  tools: ToolStreamMap;
}

/** 空 tools 集合（startStream / 兜底创建用） */
const emptyTools = (): ToolStreamMap => ({ order: [], map: {} });

/** 去除 patch 中的 undefined 值：迟到的 tool-update 缺省 args/output 不得抹掉已有值 */
function definedPatch(
  patch: Partial<ToolStreamState> & { toolName: string },
): Partial<ToolStreamState> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<ToolStreamState>;
}

interface ChatStore {
  streams: Record<number, StreamContent>;
  isStreaming: Record<number, boolean>;
  startStream: (sessionId: number) => void;
  setStreamContent: (sessionId: number, content: StreamContent) => void;
  appendDelta: (
    sessionId: number,
    kind: "text" | "thinking",
    delta: string,
  ) => void;
  /** 工具 chunk 合入：新 toolCallId 追加 order，patch 浅合并（与主进程快照语义一致） */
  updateTool: (
    sessionId: number,
    toolCallId: string,
    patch: Partial<ToolStreamState> & { toolName: string },
  ) => void;
  finishStream: (sessionId: number) => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  streams: {},
  isStreaming: {},
  startStream: (sessionId) =>
    set((state) => ({
      isStreaming: { ...state.isStreaming, [sessionId]: true },
      streams: {
        ...state.streams,
        [sessionId]: { text: "", thinking: "", tools: emptyTools() },
      },
    })),
  // 以主进程快照整体覆盖（切回会话恢复半截内容，含 tools agent 进度），并标记为流式中
  setStreamContent: (sessionId, content) =>
    set((state) => ({
      streams: { ...state.streams, [sessionId]: content },
      isStreaming: { ...state.isStreaming, [sessionId]: true },
    })),
  appendDelta: (sessionId, kind, delta) =>
    set((state) => {
      const current = state.streams[sessionId] ?? {
        text: "",
        thinking: "",
        tools: emptyTools(),
      };
      return {
        streams: {
          ...state.streams,
          [sessionId]: {
            ...current,
            [kind]: current[kind] + delta,
          },
        },
      };
    }),
  updateTool: (sessionId, toolCallId, patch) =>
    set((state) => {
      const current = state.streams[sessionId] ?? {
        text: "",
        thinking: "",
        tools: emptyTools(),
      };
      const existing = current.tools.map[toolCallId];
      // 与主进程 applyToolChunk 同构：新条目兜底 state 为 ""（审批请求可先于 tool-update）
      const merged: ToolStreamState = {
        ...(existing ?? { toolName: patch.toolName, state: "" }),
        ...definedPatch(patch),
      };
      return {
        streams: {
          ...state.streams,
          [sessionId]: {
            ...current,
            tools: {
              order: existing
                ? current.tools.order
                : [...current.tools.order, toolCallId],
              map: { ...current.tools.map, [toolCallId]: merged },
            },
          },
        },
      };
    }),
  finishStream: (sessionId) =>
    set((state) => {
      const streams = { ...state.streams };
      const isStreaming = { ...state.isStreaming };
      delete streams[sessionId];
      delete isStreaming[sessionId];
      return { streams, isStreaming };
    }),
}));
