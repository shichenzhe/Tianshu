// 模型类型名称启发式（远端导入预填）：关键词命中判型，未命中回退 llm
// （误判可导入后手改，识别只求覆盖主流命名）
import { describe, expect, it } from "vitest";
import { guessModelType } from "../../src-react/domains/ai/provider/lib/model-type-guess";

describe("guessModelType", () => {
  it.each([
    ["text-embedding-3-large", "embedding"],
    ["BAAI/bge-m3-embedding", "embedding"],
    ["Qwen/Qwen3-Reranker-8B", "reranker"],
    ["bge-reranker-v2-m3", "reranker"],
    ["whisper-1", "asr"],
    ["fun-asr-large", "asr"],
    ["gpt-4o-transcribe", "asr"],
    ["tts-1-hd", "tts"],
    ["cosyvoice-v2", "tts"],
    ["kokoro-speech", "tts"],
    ["deepseek-v3", "llm"],
    ["gpt-4o", "llm"],
    ["gemini-2.5-flash", "llm"],
    // 未命中关键词的向量/识别模型回退 llm（导入后可手改）
    ["BAAI/bge-m3", "llm"],
  ])("%s → %s", (modelId, expected) => {
    expect(guessModelType(modelId)).toBe(expected);
  });
});
