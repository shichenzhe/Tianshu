/**
 * chat 流式状态（仅流式期间的临时缓冲，持久化数据走 React Query）
 */

import { create } from "zustand";

export interface StreamContent {
  text: string;
  thinking: string;
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
  finishStream: (sessionId: number) => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  streams: {},
  isStreaming: {},
  startStream: (sessionId) =>
    set((state) => ({
      isStreaming: { ...state.isStreaming, [sessionId]: true },
      streams: { ...state.streams, [sessionId]: { text: "", thinking: "" } },
    })),
  // 以主进程快照整体覆盖（切回会话恢复半截内容），并标记为流式中
  setStreamContent: (sessionId, content) =>
    set((state) => ({
      streams: { ...state.streams, [sessionId]: content },
      isStreaming: { ...state.isStreaming, [sessionId]: true },
    })),
  appendDelta: (sessionId, kind, delta) =>
    set((state) => {
      const current = state.streams[sessionId] ?? { text: "", thinking: "" };
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
  finishStream: (sessionId) =>
    set((state) => {
      const streams = { ...state.streams };
      const isStreaming = { ...state.isStreaming };
      delete streams[sessionId];
      delete isStreaming[sessionId];
      return { streams, isStreaming };
    }),
}));
