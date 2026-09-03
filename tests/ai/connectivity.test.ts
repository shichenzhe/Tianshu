import { describe, expect, it } from "vitest";
import { testConnection } from "../../electron/domains/ai/provider/connectivity";

// ai@7 的 ai/test 导出 MockLanguageModelV3/V4（无 V2）；
// doGenerate 返回形状须满足 LanguageModelV3GenerateResult（usage/finishReason 为嵌套结构）
import { MockLanguageModelV3 } from "ai/test";

function okModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      content: [{ type: "text", text: "hi" }],
    }),
  });
}

describe("testConnection", () => {
  it("成功", async () => {
    const result = await testConnection(
      { type: "openai-compatible", baseUrl: "https://x", apiKey: "k" },
      "m",
      okModel(),
    );
    expect(result.success).toBe(true);
  });

  it("上游 401 映射 AUTH_FAILED", async () => {
    const bad = new MockLanguageModelV3({
      doGenerate: async () => {
        throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
      },
    });
    const result = await testConnection(
      { type: "openai-compatible", baseUrl: "https://x", apiKey: "k" },
      "m",
      bad,
    );
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("AUTH_FAILED");
  });

  it("网络错误映射 NETWORK", async () => {
    const bad = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const result = await testConnection(
      { type: "openai-compatible", baseUrl: "https://x", apiKey: "k" },
      "m",
      bad,
    );
    expect(result.errorCode).toBe("NETWORK");
  });
});
