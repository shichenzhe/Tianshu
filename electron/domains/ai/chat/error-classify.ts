/**
 * 上游错误码（渲染层按 chat:errors.<code> 映射 i18n 文案）
 */
export type ChatErrorCode =
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "MODEL_NOT_FOUND"
  | "TIMEOUT"
  | "NETWORK"
  | "UNKNOWN";

/**
 * AI SDK APICallError 按 statusCode 分类；其余按 message 关键字兜底
 */
export function classifyError(error: unknown): ChatErrorCode {
  const statusCode = (error as { statusCode?: number } | null)?.statusCode;
  if (statusCode === 401 || statusCode === 403) {
    return "AUTH_FAILED";
  }
  if (statusCode === 404) {
    return "MODEL_NOT_FOUND";
  }
  if (statusCode === 429) {
    return "RATE_LIMITED";
  }
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
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
