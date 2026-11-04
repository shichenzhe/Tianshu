// src-react/domains/ai/provider/lib/model-type-guess.ts
/** 模型类型名称启发式（远端导入预填）：关键词命中判型，未命中回退
 *  llm——误判可导入后手改，识别只求覆盖主流命名，不做模型库检索 */
import type { ModelType } from "../../api/model.api";

/** 判定顺序：embedding/reranker 关键词最特异，asr 先于 tts（whisper
 *  系命名含 speech 的不被 tts 抢判），voice/speech 归 tts */
const GUESS_RULES: Array<{ pattern: RegExp; type: ModelType }> = [
  { pattern: /embed/i, type: "embedding" },
  { pattern: /rerank/i, type: "reranker" },
  { pattern: /whisper|asr|transcri/i, type: "asr" },
  { pattern: /tts|voice|speech/i, type: "tts" },
];

export function guessModelType(modelId: string): ModelType {
  const hit = GUESS_RULES.find((rule) => rule.pattern.test(modelId));
  return hit?.type ?? "llm";
}
