import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { classifyError } from "../chat/error-classify";
import { createChatModel } from "../orchestration/langchain-model-factory";
import {
  parseExtraHeaders,
  type ProviderRuntimeInfo,
} from "./provider-runtime";
import type {
  ModelType,
  RemoteModel,
} from "../../../../src-react/domains/ai/api/model.api";

export interface TestConnectionResult {
  success: boolean;
  errorCode?: string;
  message: string;
}

export interface TestConnectionOptions {
  /** 模型类型（默认 llm 走 chat 补全；其余按 OpenAI 兼容专项端点探测） */
  modelType?: ModelType;
  /** 测试注入（供单测替身，仅 llm 生效） */
  injectModel?: BaseChatModel;
}

/**
 * 连通性测试：llm 走最小 invoke（injectModel 供测试注入）；
 * 非 llm 按 OpenAI 兼容专项端点最小请求探测（embedTexts 同口径）；
 * comfyui 无模型概念，走 GET /system_stats
 */
export async function testConnection(
  provider: ProviderRuntimeInfo,
  modelId: string,
  options?: TestConnectionOptions,
): Promise<TestConnectionResult> {
  if (provider.type === "comfyui") {
    return testComfyConnection(provider);
  }
  const modelType = options?.modelType ?? "llm";
  if (modelType === "llm") {
    return testLlmConnection(provider, modelId, options?.injectModel);
  }
  if (provider.type !== "openai-compatible") {
    return {
      success: false,
      errorCode: "UNSUPPORTED_TYPE_TEST",
      message: "",
    };
  }
  return testEndpointConnection(provider, modelId, modelType);
}

/** llm 探测：最小 invoke 请求 */
async function testLlmConnection(
  provider: ProviderRuntimeInfo,
  modelId: string,
  injectModel?: BaseChatModel,
): Promise<TestConnectionResult> {
  try {
    const model = injectModel ?? createChatModel(provider, modelId);
    // M7：非流式补全必须带超时——provider 半开连接时 IPC 永久 pending
    await model.invoke("hi", { signal: AbortSignal.timeout(10_000) });
    return { success: true, message: "" };
  } catch (error) {
    return {
      success: false,
      errorCode: classifyError(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** comfyui 探测：GET /system_stats（无模型概念，modelId 不消费） */
async function testComfyConnection(
  provider: ProviderRuntimeInfo,
): Promise<TestConnectionResult> {
  try {
    const base = provider.baseUrl.replace(/\/+$/, "");
    const res = await fetch(`${base}/system_stats`, {
      ...(provider.apiKey
        ? { headers: { Authorization: `Bearer ${provider.apiKey}` } }
        : {}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return {
        success: false,
        errorCode: classifyError(
          Object.assign(new Error(`HTTP ${res.status}`), {
            statusCode: res.status,
          }),
        ),
        message: `HTTP ${res.status}`,
      };
    }
    return { success: true, message: "" };
  } catch (error) {
    // 对齐文件内既有 catch 的错误映射风格（classifyError 归类）
    return {
      success: false,
      errorCode: classifyError(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 端点探测超时（M7 同判词：半开连接不得永久挂起） */
const PROBE_TIMEOUT_MS = 10_000;

/** 各类型最小请求体（OpenAI 兼容形态）；asr 走 multipart（fetch 自带 boundary） */
function buildProbeRequest(
  provider: ProviderRuntimeInfo,
  modelId: string,
  modelType: Exclude<ModelType, "llm">,
): { path: string; init: RequestInit } {
  const headers = {
    ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    ...parseExtraHeaders(provider.extraHeaders),
  };
  if (modelType === "asr") {
    const form = new FormData();
    form.append(
      "file",
      new Blob([makeSilentWav()], { type: "audio/wav" }),
      "ping.wav",
    );
    form.append("model", modelId);
    return {
      path: "audio/transcriptions",
      init: { method: "POST", headers, body: form },
    };
  }
  const bodyByType: Record<Exclude<ModelType, "llm" | "asr">, unknown> = {
    embedding: { model: modelId, input: ["ping"] },
    tts: { model: modelId, input: "hi", voice: "alloy" },
    reranker: { model: modelId, query: "ping", documents: ["pong"] },
  };
  const pathByType: Record<Exclude<ModelType, "llm" | "asr">, string> = {
    embedding: "embeddings",
    tts: "audio/speech",
    reranker: "rerank",
  };
  return {
    path: pathByType[modelType],
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(bodyByType[modelType]),
    },
  };
}

/** 极小静音 wav（44 字节头 + 8 字节 PCM，16bit 单声道 8kHz）：asr 探测载荷 */
function makeSilentWav(): ArrayBuffer {
  const buffer = new ArrayBuffer(52);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true); // fmt 块长
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, 8000, true); // 采样率
  view.setUint32(28, 16000, true); // 字节率
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true); // 位深
  writeText(36, "data");
  view.setUint32(40, 8, true); // 数据长（4 样本静音）
  return buffer;
}

/** 非 llm 端点探测：400/422 参数拒也证明路由存在且鉴权通过 → 判可达成功；
 *  其余状态码沿用 classifyError 归类；embedding 额外强校验返回向量 */
async function testEndpointConnection(
  provider: ProviderRuntimeInfo,
  modelId: string,
  modelType: Exclude<ModelType, "llm">,
): Promise<TestConnectionResult> {
  const { path, init } = buildProbeRequest(provider, modelId, modelType);
  let response: Response;
  try {
    response = await fetch(joinUrl(provider.baseUrl, path), {
      ...init,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      success: false,
      errorCode: classifyError(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (response.status === 400 || response.status === 422) {
    // 错误体不消费：cancel 归还连接（未读 body 会钉住 undici 连接池直至超时）
    void response.body?.cancel();
    return { success: true, message: "" };
  }
  if (!response.ok) {
    void response.body?.cancel();
    return {
      success: false,
      errorCode: classifyError(
        Object.assign(new Error(`HTTP ${response.status}`), {
          statusCode: response.status,
        }),
      ),
      message: `HTTP ${response.status}`,
    };
  }
  return verifyProbeResponse(modelType, response);
}

/** 2xx 响应校验：embedding 须真回向量（向量节点在用）；其余类型可达即可 */
async function verifyProbeResponse(
  modelType: ModelType,
  response: Response,
): Promise<TestConnectionResult> {
  if (modelType !== "embedding") {
    // 可达即成功：成功体（tts 合成音频等）不下载，cancel 归还连接
    void response.body?.cancel();
    return { success: true, message: "" };
  }
  const payload = (await response.json().catch(() => null)) as {
    data?: Array<{ embedding?: number[] }>;
  } | null;
  const vector = payload?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    return {
      success: false,
      errorCode: "UNKNOWN",
      message: "probe response has no embedding vector",
    };
  }
  return { success: true, message: "" };
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

/** 相对路径拼接：base 末段不丢（"https://x/v1" + "models" → ".../v1/models"） */
function joinUrl(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

/** 非流式模型列表请求超时（半开连接不得永久挂起，M7 同判词） */
const LIST_TIMEOUT_MS = 10_000;

/**
 * 拉取远端模型列表（spec §4.1）：四协议分派——openai-compatible
 * GET {base}/models（Bearer）、anthropic GET {base}/v1/models（x-api-key +
 * anthropic-version）、gemini GET {base}/v1beta/models?key=（name 剥
 * models/ 前缀）、ollama 复用 listOllamaModels；comfyui 无模型列表概念
 * 早退抛错（前端拉取入口已隐藏，此为误用守卫）。非 2xx 抛携
 * statusCode 的 Error("HTTP {status}")，由 repo 层 classifyError 归类。
 */
export async function listRemoteModels(
  provider: ProviderRuntimeInfo,
): Promise<RemoteModel[]> {
  if (provider.type === "comfyui") {
    // ComfyUI 无模型列表概念（checkpoint 在 workflow JSON 内指定）：
    // 早退失败，勿落 gemini 分支对 /v1beta/models 发必 404 的误导请求
    throw Object.assign(
      new Error("ComfyUI 无模型列表概念（checkpoint 在 workflow JSON 内指定）"),
      { code: "UNSUPPORTED_TYPE_LIST" },
    );
  }
  const extra = parseExtraHeaders(provider.extraHeaders);
  if (provider.type === "ollama") {
    return listOllamaModels(provider.baseUrl);
  }
  let url: string;
  const headers: Record<string, string> = { ...extra };
  if (provider.type === "openai-compatible") {
    url = joinUrl(provider.baseUrl, "models");
    if (provider.apiKey) {
      headers.Authorization = `Bearer ${provider.apiKey}`;
    }
  } else if (provider.type === "anthropic") {
    url = joinUrl(provider.baseUrl, "v1/models");
    headers["x-api-key"] = provider.apiKey ?? "";
    headers["anthropic-version"] = "2023-06-01";
  } else {
    // gemini baseUrl 约定含 /v1beta（与 @langchain/google-genai 默认端点同款），先剥再拼避免重复
    const geminiBase = provider.baseUrl.replace(/\/v1beta\/?$/, "");
    url = `${joinUrl(geminiBase, "v1beta/models")}?key=${encodeURIComponent(provider.apiKey ?? "")}`;
  }
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
  });
  if (!res.ok) {
    // 附 statusCode 供 classifyError 归类（401/403→AUTH_FAILED 等，拉取兼任连通测试的结论载体）
    throw Object.assign(new Error(`HTTP ${res.status}`), {
      statusCode: res.status,
    });
  }
  const data = (await res.json()) as Record<string, unknown>;
  return parseRemoteModels(provider.type, data);
}

/** 各协议响应 → RemoteModel[]（过滤空 id） */
function parseRemoteModels(
  type: string,
  data: Record<string, unknown>,
): RemoteModel[] {
  if (type === "openai-compatible" || type === "anthropic") {
    const rows =
      (data.data as Array<Record<string, unknown>> | undefined) ?? [];
    return rows
      .map((r) => ({
        modelId: String(r.id ?? ""),
        ownedBy:
          r.owned_by !== undefined
            ? String(r.owned_by)
            : r.display_name !== undefined
              ? String(r.display_name)
              : undefined,
      }))
      .filter((m) => m.modelId !== "");
  }
  const rows =
    (data.models as Array<Record<string, unknown>> | undefined) ?? [];
  return rows
    .map((r) => ({ modelId: String(r.name ?? "").replace(/^models\//, "") }))
    .filter((m) => m.modelId !== "");
}
