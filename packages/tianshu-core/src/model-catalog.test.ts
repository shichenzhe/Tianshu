// 内置模型目录单测（provider-model §6 项 1b/5：常见模型 id →
// contextWindow/价格/能力，别名形态容错 + effectiveContextWindow 四层兜底）。
import { describe, expect, it } from "vitest";
import { effectiveContextWindow, lookupModelCatalog } from "./model-catalog";

describe("lookupModelCatalog", () => {
  it("精确命中：OpenAI/Anthropic/Gemini/DeepSeek 条目", () => {
    expect(lookupModelCatalog("gpt-4o")).toMatchObject({
      contextWindow: 128_000,
      vision: true,
      tools: true,
    });
    expect(lookupModelCatalog("claude-sonnet-4-5")).toMatchObject({
      contextWindow: 200_000,
      vision: true,
      tools: true,
    });
    expect(lookupModelCatalog("gemini-2.5-pro")?.contextWindow).toBe(1_048_576);
    expect(lookupModelCatalog("deepseek-chat")?.priceInPerMTokens).toBe(0.27);
  });

  it("大小写/首尾空白容错", () => {
    expect(lookupModelCatalog("  GPT-4O ")).toMatchObject({
      contextWindow: 128_000,
    });
    expect(lookupModelCatalog("Claude-Sonnet-4-5")?.contextWindow).toBe(
      200_000,
    );
  });

  it("ollama 冒号变体：qwen3:8b 命中 qwen3（tag 后缀剥离）", () => {
    expect(lookupModelCatalog("qwen3:8b")).toMatchObject({ tools: true });
    expect(lookupModelCatalog("llama3.1:8b-instruct-q4_K_M")).toMatchObject({
      contextWindow: 128_000,
    });
    expect(lookupModelCatalog("qwen3:latest")).toMatchObject({ tools: true });
  });

  it("provider 路径前缀：openai/gpt-4o / ollama/qwen3 剥前缀命中", () => {
    expect(lookupModelCatalog("openai/gpt-4o-mini")).toMatchObject({
      contextWindow: 128_000,
    });
    expect(lookupModelCatalog("ollama/qwen3")).toMatchObject({ tools: true });
  });

  it("OpenAI 日期后缀：gpt-4o-2024-07-18 命中 gpt-4o", () => {
    expect(lookupModelCatalog("gpt-4o-2024-07-18")).toMatchObject({
      contextWindow: 128_000,
      priceInPerMTokens: 2.5,
    });
  });

  it("别名表：claude-3-5-sonnet（无 -latest）命中 3.5 sonnet 条目", () => {
    expect(lookupModelCatalog("claude-3-5-sonnet")?.contextWindow).toBe(
      200_000,
    );
  });

  it("本地 ollama 模型无价格（undefined ≠ 0）", () => {
    const llama = lookupModelCatalog("llama3.1");
    expect(llama?.contextWindow).toBe(128_000);
    expect(llama?.priceInPerMTokens).toBeUndefined();
    expect(llama?.priceOutPerMTokens).toBeUndefined();
  });

  it("未知模型返回 undefined", () => {
    expect(lookupModelCatalog("totally-unknown-model")).toBeUndefined();
    expect(lookupModelCatalog("")).toBeUndefined();
  });
});

describe("effectiveContextWindow 四层兜底（model > 目录 > provider > 131072）", () => {
  it("model 显式值最优先（目录/桌面 provider 值不覆盖）", () => {
    expect(effectiveContextWindow("gpt-4o", 65_536, 8_192)).toBe(65_536);
  });

  it("model 空时目录值接管（gpt-4o → 128K，先于 provider）", () => {
    expect(effectiveContextWindow("gpt-4o", null, 8_192)).toBe(128_000);
    expect(effectiveContextWindow("gpt-4o", undefined, null)).toBe(128_000);
  });

  it("model/目录均空回落 provider 级默认", () => {
    expect(effectiveContextWindow("my-private-model", null, 8_192)).toBe(8_192);
  });

  it("全空兜底 DEFAULT_CONTEXT_WINDOW 131072", () => {
    expect(effectiveContextWindow("my-private-model", null, null)).toBe(
      131_072,
    );
    expect(
      effectiveContextWindow("my-private-model", undefined, undefined),
    ).toBe(131_072);
  });
});
