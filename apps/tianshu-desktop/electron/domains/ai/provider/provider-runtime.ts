/** Provider 协议类型与运行时信息（chat/orchestration/automation 共用，
 * 自 provider-factory 抽出以便单栈收敛，见 2026-10-15 spec §4.1） */
export type ProviderType =
  "openai-compatible" | "anthropic" | "gemini" | "ollama";

export interface ProviderRuntimeInfo {
  type: string;
  baseUrl: string;
  apiKey?: string;
  extraHeaders?: string | null;
}

/** 解析 provider.extraHeaders JSON（畸形返回空对象） */
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
