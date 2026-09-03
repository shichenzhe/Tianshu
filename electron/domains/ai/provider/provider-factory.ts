import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOllama } from "ai-sdk-ollama";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export type ProviderType =
  "openai-compatible" | "anthropic" | "gemini" | "ollama";

export interface ProviderRuntimeInfo {
  type: string;
  baseUrl: string;
  apiKey?: string;
  extraHeaders?: string | null;
}

/**
 * 解析 provider.extraHeaders JSON（畸形返回空对象）
 */
export function parseExtraHeaders(
  json?: string | null,
): Record<string, string> {
  if (!json) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * 按协议类型构造 AI SDK LanguageModel（协议适配唯一收口）
 */
export function createLanguageModel(
  provider: ProviderRuntimeInfo,
  modelId: string,
): LanguageModel {
  const headers = parseExtraHeaders(provider.extraHeaders);
  switch (provider.type) {
    case "anthropic":
      return createAnthropic({
        baseURL: provider.baseUrl,
        apiKey: provider.apiKey ?? "",
        headers,
      })(modelId);
    case "gemini":
      return createGoogleGenerativeAI({
        apiKey: provider.apiKey ?? "",
        headers,
        ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
      })(modelId);
    case "ollama":
      return createOllama({
        baseURL: provider.baseUrl,
        apiKey: provider.apiKey,
        headers,
      })(modelId);
    case "openai-compatible":
    default:
      return createOpenAICompatible({
        name: "custom",
        baseURL: provider.baseUrl,
        apiKey: provider.apiKey,
        headers,
      }).languageModel(modelId);
  }
}
