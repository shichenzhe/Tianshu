/**
 * AI 调用 API（可选模块）
 * 通过激活的模型配置调用 OpenAI 兼容接口
 */

import { invoke } from "@/lib/ipc";

export interface AIChatParams {
  content: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

export default class AIApi {
  /**
   * 单轮对话
   */
  static async chat(params: AIChatParams): Promise<string> {
    return invoke<string>("ai:chat", params);
  }
}
