/**
 * 上游错误码（渲染层按 chat:errors.<code> 映射 i18n 文案）
 */
export type ChatErrorCode =
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "MODEL_NOT_FOUND"
  | "IMAGE_UNSUPPORTED"
  | "TIMEOUT"
  | "NETWORK"
  | "UNKNOWN";

/**
 * 按 HTTP 状态码分类，其余按 message 关键字兜底。
 * 状态码双形状：statusCode（repo 层 listRemoteModels 自抛的 HTTP 错误）与
 * status（@langchain/openai / @langchain/anthropic 透传的 provider SDK
 * APIError——openai 与 @anthropic-ai/sdk 的 core/error.d.ts 均 readonly
 * status；google-genai 底层 GoogleGenerativeAIFetchError 亦为 status）
 */
export function classifyError(error: unknown): ChatErrorCode {
  const httpError = error as { statusCode?: number; status?: number } | null;
  const statusCode = httpError?.statusCode ?? httpError?.status;
  if (statusCode === 401 || statusCode === 403) {
    return "AUTH_FAILED";
  }
  if (statusCode === 404) {
    return "MODEL_NOT_FOUND";
  }
  if (statusCode === 429) {
    return "RATE_LIMITED";
  }
  // 兼容 Error 实例与普通对象（带 message 字段的 provider 错误形状）
  const message = String(
    (error as { message?: unknown } | null)?.message ?? error,
  ).toLowerCase();
  // 非视觉模型收到 image part：OpenAI 兼容端点（vLLM 等）普遍 400 拒绝
  if (statusCode === 400 && /image|vision|multimodal/.test(message)) {
    return "IMAGE_UNSUPPORTED";
  }
  if (message.includes("timed out") || message.includes("timeout")) {
    return "TIMEOUT";
  }
  if (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("econnrefused")
  ) {
    return "NETWORK";
  }
  return "UNKNOWN";
}
