/** Provider 协议类型与运行时信息（chat/orchestration/automation 共用，
 * 自 provider-factory 抽出以便单栈收敛，见 2026-10-15 spec §4.1） */
import { openSecret } from "../../security/secret-field";

export type ProviderType =
  "openai-compatible" | "anthropic" | "gemini" | "ollama";

export interface ProviderRuntimeInfo {
  type: string;
  baseUrl: string;
  apiKey?: string;
  extraHeaders?: string | null;
}

/** provider 凭证列的 AAD 字段名（与 repo 写侧 sealSecret 同源） */
const API_KEY_FIELD = "provider.apiKey";
const EXTRA_HEADERS_FIELD = "provider.extraHeaders";

/**
 * 解密 provider 行凭证列（apiKey/extraHeaders，批1A 收口）：
 * 聊天/交接/图编排/自动化引擎直读 prisma provider 行后必须经此解密再喂
 * createChatModel——密文直传会把 enc:v1: 密文当 Bearer 致 AUTH_FAILED
 * （provider.repo getRuntimeInfo 同款，单源收口到此）。旧明文原样返回
 * （懒迁移），解密失败返回 undefined（呈现为凭证缺失，secret-field 语义）。
 */
export async function openProviderSecrets(row: {
  apiKey?: string | null;
  extraHeaders?: string | null;
}): Promise<{ apiKey?: string; extraHeaders?: string }> {
  const [apiKey, extraHeaders] = await Promise.all([
    openSecret(API_KEY_FIELD, row.apiKey ?? null),
    openSecret(EXTRA_HEADERS_FIELD, row.extraHeaders ?? null),
  ]);
  return {
    apiKey: apiKey ?? undefined,
    extraHeaders: extraHeaders ?? undefined,
  };
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
