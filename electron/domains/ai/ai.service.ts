/**
 * AI服务类
 * 通用 OpenAI 兼容调用封装：取激活配置 → 调用 chat.completions
 */
import { ipcMain } from "electron";
import OpenAI from "openai";
import { ModelConfigRepository } from "./model-config.repo";

export interface AIChatParams {
  content: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

export default class AIService {
  private modelConfigRepo: ModelConfigRepository;

  constructor(modelConfigRepo: ModelConfigRepository) {
    this.modelConfigRepo = modelConfigRepo;
    this.registerHandlers();
  }

  /**
   * 注册IPC处理程序
   */
  private registerHandlers() {
    ipcMain.handle("ai:chat", async (_, params: AIChatParams) => {
      return this.chat(params);
    });
  }

  /**
   * 获取OpenAI客户端实例
   */
  private async getOpenAIClient(): Promise<OpenAI> {
    const activeConfig = await this.modelConfigRepo.getActive();

    if (!activeConfig) {
      throw new Error("未找到激活的模型配置，请先在 AI 模块中配置并激活");
    }

    return new OpenAI({
      apiKey: activeConfig.apiKey,
      baseURL: activeConfig.baseUrl,
    });
  }

  /**
   * 单轮对话（通用 AI 调用入口）
   */
  async chat(params: AIChatParams): Promise<string> {
    try {
      const openai = await this.getOpenAIClient();
      const activeConfig = await this.modelConfigRepo.getActive();

      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
      if (params.systemPrompt) {
        messages.push({ role: "system", content: params.systemPrompt });
      }
      messages.push({ role: "user", content: params.content });

      const response = await openai.chat.completions.create({
        model: activeConfig!.modelName,
        messages,
        max_tokens: params.maxTokens ?? 1024,
        temperature: params.temperature ?? 0.7,
      });

      return response.choices[0]?.message?.content?.trim() || "";
    } catch (error) {
      console.error("AI 调用失败:", error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`AI 调用失败: ${message}`, { cause: error });
    }
  }
}
