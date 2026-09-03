/**
 * Chat 调用 API：发送（invoke）+ 流式事件订阅
 */

import { invoke, on } from "@/lib/ipc";

export interface ChatModelParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

export interface ChatSendParams {
  sessionId: number;
  content: string;
  modelId?: number;
  overrides?: ChatModelParams;
}

export type ChatStreamChunk =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "finish" }
  | { type: "error"; errorCode: string; message: string };

export default class ChatApi {
  /**
   * 发送消息（结果经 chat:stream:{sessionId} 事件推送，无返回值）
   */
  static async send(params: ChatSendParams): Promise<void> {
    return invoke<void>("chat:send", params);
  }

  /**
   * 重新生成最后一条回复（删除尾部消息原位重跑）
   */
  static async regenerate(sessionId: number): Promise<void> {
    return invoke<void>("chat:regenerate", sessionId);
  }

  /**
   * 停止会话进行中的流
   */
  static async stop(sessionId: number): Promise<void> {
    return invoke<void>("chat:stop", sessionId);
  }
}

/**
 * 订阅会话流式 chunk，返回卸载函数
 */
export function onChatStream(
  sessionId: number,
  listener: (chunk: ChatStreamChunk) => void,
): () => void {
  return on(`chat:stream:${sessionId}`, (_, chunk) =>
    listener(chunk as ChatStreamChunk),
  );
}
