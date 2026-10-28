/** 记忆面 AI 操作错码 → i18n 文案（协议包 MemoryErrorCode 五值；AI 操作
 *  业务失败是 ok:false 携码——wire 层 success 信封恒真，渲染层按码映射） */
import type { MemoryErrorCode, MemoryServiceResult } from "@tianshu/protocol";

const MEMORY_ERROR_KEYS: Record<MemoryErrorCode, string> = {
  MEMORY_DISABLED: "memory:errDisabled",
  MEMORY_MODEL_MISSING: "memory:errModelMissing",
  MEMORY_COMPILE_FAILED: "memory:errCompileFailed",
  MEMORY_NO_MATERIAL: "memory:errNoMaterial",
  MEMORY_BUSY: "memory:errBusy",
};

export function describeMemoryResult(
  result: MemoryServiceResult,
  t: (key: string) => string,
): string | null {
  if (result.ok || !result.error) return null;
  return t(MEMORY_ERROR_KEYS[result.error]);
}
