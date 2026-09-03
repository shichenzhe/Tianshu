import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLanguageModel,
  parseExtraHeaders,
} from "../../electron/domains/ai/provider/provider-factory";

describe("provider-factory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("gemini 分支透传 extraHeaders 与 apiKey", async () => {
    const captured: { url: string; headers: HeadersInit | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      async (url: unknown, init?: { headers?: HeadersInit }) => {
        captured.push({ url: String(url), headers: init?.headers });
        return new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
            ],
            usageMetadata: {
              promptTokenCount: 1,
              candidatesTokenCount: 1,
              totalTokenCount: 2,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );

    const model = createLanguageModel(
      {
        type: "gemini",
        baseUrl: "",
        apiKey: "k",
        extraHeaders: '{"X-A":"1"}',
      },
      "test-model",
    );
    const callable = model as unknown as {
      doGenerate: (options: { prompt: unknown }) => Promise<unknown>;
    };
    await callable.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    expect(captured).toHaveLength(1);
    const reqHeaders = new Headers(captured[0].headers);
    expect(reqHeaders.get("x-a")).toBe("1");
    expect(reqHeaders.get("x-goog-api-key")).toBe("k");
  });

  it("ollama 分支透传 extraHeaders 与 apiKey", async () => {
    const captured: { url: string; headers: HeadersInit | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      async (url: unknown, init?: { headers?: HeadersInit }) => {
        captured.push({ url: String(url), headers: init?.headers });
        return new Response(
          JSON.stringify({
            model: "test-model",
            created_at: new Date().toISOString(),
            message: { role: "assistant", content: "ok" },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 1,
            eval_count: 1,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );

    const model = createLanguageModel(
      {
        type: "ollama",
        baseUrl: "http://localhost:11434",
        apiKey: "k",
        extraHeaders: '{"X-A":"1"}',
      },
      "test-model",
    );
    const callable = model as unknown as {
      doGenerate: (options: { prompt: unknown }) => Promise<unknown>;
    };
    await callable.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    expect(captured).toHaveLength(1);
    const reqHeaders = new Headers(captured[0].headers);
    expect(reqHeaders.get("x-a")).toBe("1");
    expect(reqHeaders.get("authorization")).toBe("Bearer k");
  });
});
