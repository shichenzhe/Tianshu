import { describe, expect, it } from "vitest";
import {
  createLanguageModel,
  parseExtraHeaders,
} from "../../electron/domains/ai/provider/provider-factory";

describe("provider-factory", () => {
  it("parseExtraHeaders 容错", () => {
    expect(parseExtraHeaders(null)).toEqual({});
    expect(parseExtraHeaders("{bad")).toEqual({});
    expect(parseExtraHeaders('{"X-A":"1"}')).toEqual({ "X-A": "1" });
  });

  it("四种协议均产出模型实例（构造不发网络请求）", () => {
    const cases = [
      {
        type: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        apiKey: "k",
      },
      { type: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "k" },
      { type: "gemini", baseUrl: "", apiKey: "k" },
      { type: "ollama", baseUrl: "http://localhost:11434" },
    ];
    for (const p of cases) {
      const model = createLanguageModel(p, "test-model");
      expect(model).toBeTruthy();
      expect(typeof (model as { doGenerate: unknown }).doGenerate).toBe(
        "function",
      );
    }
  });

  it("未知 type 兜底为 openai-compatible", () => {
    expect(() =>
      createLanguageModel(
        { type: "mystery", baseUrl: "https://x.example/v1", apiKey: "k" },
        "m",
      ),
    ).not.toThrow();
  });
});
