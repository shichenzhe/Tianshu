/** LangChain 协议适配唯一收口：全应用唯一模型构造入口（2026-10-15 单栈收敛）。
 * 各构造参数名以安装版本 d.ts 为准（@langchain/openai 1.6.2 /
 * @langchain/anthropic 1.5.12 / @langchain/google-genai 2.3.2 / @langchain/ollama 1.3.0）。 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOllama } from "@langchain/ollama";
import {
  parseExtraHeaders,
  type ProviderRuntimeInfo,
} from "../provider/provider-runtime";

/**
 * 采样/限额参数（T3-3 R1：topP/maxTokens 静默失效修复）。
 * 四家构造字段名以本地安装版 d.ts 为准核对：
 * - openai（base.d.ts L173/L186）与 anthropic（chat_models L120/L122）：
 *   topP / maxTokens
 * - gemini（chat_models L73/L60）：topP / maxOutputTokens
 * - ollama（chat_models L393/L391）：topP / numPredict
 * undefined 字段全部省略保持各 SDK 默认值（沿用既有 temperature 省略模式）。
 */
export interface ModelCallOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

/** undefined/null 字段省略的对象压缩（保字段序稳定便于断言） */
function definedFields(
  entries: Array<[string, number | undefined]>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of entries) {
    // null 一并滤（终审 T9d）：现役调用链均经 repo `?? undefined` 消毒
    // DB 可空列，此处防未来新调用点直传裸值——topP: null 注入构造
    // 三家不容忍 null
    if (value !== undefined && value !== null) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 按协议类型构造 LangChain ChatModel（构造不发网络请求）。
 * 第三参为采样/限额选项，各家分派到正确构造字段名。
 */
export function createChatModel(
  provider: ProviderRuntimeInfo,
  modelId: string,
  options?: ModelCallOptions,
): BaseChatModel {
  const headers = parseExtraHeaders(provider.extraHeaders);
  const { temperature, topP, maxTokens } = options ?? {};
  const sampled = definedFields([
    ["temperature", temperature],
    ["topP", topP],
  ]);
  const capped = definedFields([["maxTokens", maxTokens]]);
  switch (provider.type) {
    case "anthropic":
      return new ChatAnthropic({
        anthropicApiUrl: provider.baseUrl,
        apiKey: provider.apiKey ?? "",
        model: modelId,
        clientOptions: { defaultHeaders: headers },
        ...sampled,
        ...capped,
      });
    case "gemini":
      return new ChatGoogleGenerativeAI({
        apiKey: provider.apiKey ?? "",
        model: modelId,
        customHeaders: headers,
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
        ...sampled,
        // gemini 限额字段名为 maxOutputTokens（chat_models.d.ts L60）
        ...definedFields([["maxOutputTokens", maxTokens]]),
      });
    case "ollama":
      return new ChatOllama({
        baseUrl: provider.baseUrl,
        model: modelId,
        headers,
        ...sampled,
        // ollama 限额字段名为 numPredict（chat_models.d.ts L391）
        ...definedFields([["numPredict", maxTokens]]),
      });
    case "openai-compatible":
    default:
      return new ChatOpenAI({
        configuration: {
          baseURL: provider.baseUrl,
          apiKey: provider.apiKey,
          defaultHeaders: headers,
        },
        model: modelId,
        ...sampled,
        ...capped,
      });
  }
}
