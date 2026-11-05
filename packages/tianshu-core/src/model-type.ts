/**
 * 模型类型名称启发式（Task 9 批 5 小项：桌面 guessModelType 与移动
 * inferModelType 双份收编 @tianshu/core 单源）：关键词命中判型，未命中
 * 回退 llm——误判可导入后手改，识别只求覆盖主流命名，不做模型库检索。
 *
 * 判定顺序取桌面版（embedding/reranker 最特异 → asr 先于 tts：whisper
 * 系命名含 speech 的不被 tts 抢判）；移动旧版 tts 先于 asr 且缺
 * voice/transcri 关键词，收编后统一到本表（"whisper-tts" 形态现归 asr）。
 */
export type ModelTypeGuess = "llm" | "embedding" | "tts" | "reranker" | "asr";

/** 判定顺序：embedding/reranker 关键词最特异，asr 先于 tts（whisper
 *  系命名含 speech 的不被 tts 抢判），voice/speech 归 tts */
const GUESS_RULES: Array<{ pattern: RegExp; type: ModelTypeGuess }> = [
  { pattern: /embed/i, type: "embedding" },
  { pattern: /rerank/i, type: "reranker" },
  { pattern: /whisper|asr|transcri/i, type: "asr" },
  { pattern: /tts|voice|speech/i, type: "tts" },
];

export function guessModelType(modelId: string): ModelTypeGuess {
  const hit = GUESS_RULES.find((rule) => rule.pattern.test(modelId));
  return hit?.type ?? "llm";
}
