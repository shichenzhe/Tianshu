// src-react/domains/ai/provider/lib/model-summary.ts
/** 模型参数摘要（spec §3.1）：仅显示非默认项——与 ModelDialog 新建
 *  缺省值同源（128K/64K）；value 格式化，label 由渲染端 i18n 拼 */
import type { ModelRecord } from "../../api/model.api";

const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_TOKENS = 65536;

export type ModelSummarySegment =
  | { key: "context"; value: string }
  | { key: "output"; value: string }
  | { key: "temperature"; value: string }
  | { key: "topP"; value: string };

/** 1024 进制 K/M 缩写（32768 → "32K"；非整千保留有效位） */
function formatTokens(n: number): string {
  if (n >= 1048576 && n % 1048576 === 0) {
    return `${n / 1048576}M`;
  }
  if (n >= 1024 && n % 1024 === 0) {
    return `${n / 1024}K`;
  }
  return String(n);
}

export function buildModelSummary(
  model: Pick<
    ModelRecord,
    "temperature" | "topP" | "maxTokens" | "contextWindow"
  >,
): ModelSummarySegment[] {
  const segments: ModelSummarySegment[] = [];
  if (
    model.contextWindow !== undefined &&
    model.contextWindow !== DEFAULT_CONTEXT_WINDOW
  ) {
    segments.push({ key: "context", value: formatTokens(model.contextWindow) });
  }
  if (model.maxTokens !== undefined && model.maxTokens !== DEFAULT_MAX_TOKENS) {
    segments.push({ key: "output", value: formatTokens(model.maxTokens) });
  }
  if (model.temperature !== undefined) {
    segments.push({ key: "temperature", value: String(model.temperature) });
  }
  if (model.topP !== undefined) {
    segments.push({ key: "topP", value: String(model.topP) });
  }
  return segments;
}
