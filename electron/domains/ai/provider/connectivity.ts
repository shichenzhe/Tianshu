import { generateText } from "ai";
import type { LanguageModel } from "ai";
import { classifyError } from "../chat/error-classify";
import {
  createLanguageModel,
  type ProviderRuntimeInfo,
} from "./provider-factory";

export interface TestConnectionResult {
  success: boolean;
  errorCode?: string;
  message: string;
}

/**
 * 连通性测试：最小 generateText 请求（injectModel 供测试注入）
 */
export async function testConnection(
  provider: ProviderRuntimeInfo,
  modelId: string,
  injectModel?: LanguageModel,
): Promise<TestConnectionResult> {
  try {
    const model = injectModel ?? createLanguageModel(provider, modelId);
    await generateText({ model, prompt: "hi", maxOutputTokens: 5 });
    return { success: true, message: "" };
  } catch (error) {
    return {
      success: false,
      errorCode: classifyError(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface OllamaRemoteModel {
  modelId: string;
}

/**
 * 拉取 Ollama 已安装模型（/api/tags）
 */
export async function listOllamaModels(
  baseUrl: string,
): Promise<OllamaRemoteModel[]> {
  const url = new URL("/api/tags", baseUrl).toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    models?: Array<{ name?: string; model?: string }>;
  };
  return (data.models ?? [])
    .map((m) => ({ modelId: m.name ?? m.model ?? "" }))
    .filter((m) => m.modelId !== "");
}
