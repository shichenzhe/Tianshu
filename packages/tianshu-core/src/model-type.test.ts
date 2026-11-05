// guessModelType 收编单源用例（Task 9 批 5）：桌面/移动双份启发式统一到
// core——判定序 embedding/reranker → asr（whisper 先于 tts）→ tts。
import { describe, expect, it } from "vitest";
import { guessModelType } from "./model-type";

describe("guessModelType", () => {
  it.each([
    ["text-embedding-3-large", "embedding"],
    ["BAAI/bge-m3-embedding", "embedding"],
    ["Qwen/Qwen3-Reranker-8B", "reranker"],
    ["whisper-1", "asr"],
    ["fun-asr-large", "asr"],
    ["gpt-4o-transcribe", "asr"],
    ["tts-1-hd", "tts"],
    ["cosyvoice-v2", "tts"],
    ["kokoro-speech", "tts"],
    ["deepseek-v3", "llm"],
    ["gpt-4o", "llm"],
    // 收编差异锚定：移动旧版 tts 先于 asr，统一后 whisper-tts 归 asr
    ["whisper-tts", "asr"],
  ])("%s → %s", (modelId, expected) => {
    expect(guessModelType(modelId)).toBe(expected);
  });
});
