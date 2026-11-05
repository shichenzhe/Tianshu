import { describe, expect, it, vi } from "vitest";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOllama } from "@langchain/ollama";

// 传递依赖 prisma-client（provider-runtime→secret-field→master-key 链在
// 模块作用域读 app.isPackaged，无 electron mock 时 import 期即炸）——
// 本 suite 不触库，最小替身拦截（command-gate-integration.test 同款）
vi.mock("../../electron/commons/prisma-client", () => ({ default: {} }));

import { createChatModel } from "../../electron/domains/ai/orchestration/langchain-model-factory";
import { parseExtraHeaders } from "../../electron/domains/ai/provider/provider-runtime";

describe("parseExtraHeaders（归属 provider-runtime，工厂与 graph-executor 共用）", () => {
  it("null/畸形 JSON 容错为空对象，合法 JSON 原样解析", () => {
    expect(parseExtraHeaders(null)).toEqual({});
    expect(parseExtraHeaders("{bad")).toEqual({});
    expect(parseExtraHeaders('{"X-A":"1"}')).toEqual({ "X-A": "1" });
  });
});

describe("createChatModel", () => {
  it("openai-compatible → ChatOpenAI（baseUrl/apiKey/extraHeaders 透传）", () => {
    const m = createChatModel(
      {
        type: "openai-compatible",
        baseUrl: "http://x",
        apiKey: "k",
        extraHeaders: JSON.stringify({ a: "b" }),
      },
      "gpt-x",
    );
    expect(m).toBeInstanceOf(ChatOpenAI);
    const openai = m as ChatOpenAI;
    expect(openai.model).toBe("gpt-x");
    expect(openai.apiKey).toBe("k");
    expect(openai.clientConfig.baseURL).toBe("http://x");
    expect(openai.clientConfig.defaultHeaders).toMatchObject({ a: "b" });
  });

  it("anthropic → ChatAnthropic（anthropicApiUrl/apiKey/headers 经 clientOptions 透传）", () => {
    const m = createChatModel(
      {
        type: "anthropic",
        baseUrl: "http://y",
        apiKey: "k",
        extraHeaders: JSON.stringify({ a: "b" }),
      },
      "claude-x",
    );
    expect(m).toBeInstanceOf(ChatAnthropic);
    const anthropic = m as ChatAnthropic;
    expect(anthropic.model).toBe("claude-x");
    expect(anthropic.apiKey).toBe("k");
    expect(anthropic.apiUrl).toBe("http://y");
    expect(anthropic.clientOptions.defaultHeaders).toMatchObject({ a: "b" });
  });

  it("gemini → ChatGoogleGenerativeAI（apiKey 透传，空 baseUrl 不覆盖默认端点）", () => {
    const m = createChatModel(
      { type: "gemini", baseUrl: "", apiKey: "k" },
      "gem-x",
    );
    expect(m).toBeInstanceOf(ChatGoogleGenerativeAI);
    const gemini = m as ChatGoogleGenerativeAI;
    expect(gemini.model).toBe("gem-x");
    expect(gemini.apiKey).toBe("k");
    expect(gemini.baseUrl).toBeUndefined();
  });

  it("gemini 自定义 baseUrl 时透传", () => {
    const m = createChatModel(
      { type: "gemini", baseUrl: "http://g", apiKey: "k2" },
      "gem-y",
    );
    expect(m).toBeInstanceOf(ChatGoogleGenerativeAI);
    expect((m as ChatGoogleGenerativeAI).baseUrl).toBe("http://g");
    expect((m as ChatGoogleGenerativeAI).apiKey).toBe("k2");
  });

  it("ollama → ChatOllama（baseUrl/modelId 透传，headers 进 client）", () => {
    const m = createChatModel(
      {
        type: "ollama",
        baseUrl: "http://z",
        extraHeaders: JSON.stringify({ a: "b" }),
      },
      "qwen-x",
    );
    expect(m).toBeInstanceOf(ChatOllama);
    const ollama = m as ChatOllama;
    expect(ollama.model).toBe("qwen-x");
    expect(ollama.baseUrl).toBe("http://z");
    expect(
      (ollama.client as unknown as { config: { headers: unknown } }).config
        .headers,
    ).toMatchObject({ a: "b" });
  });

  it("未知 type 兜底为 ChatOpenAI（对齐 provider-factory 分流）", () => {
    const m = createChatModel(
      { type: "mystery", baseUrl: "http://x", apiKey: "k" },
      "m",
    );
    expect(m).toBeInstanceOf(ChatOpenAI);
    expect((m as ChatOpenAI).clientConfig.baseURL).toBe("http://x");
  });

  it("comfyui 显式拒绝（批5 §6 项 6）：无对话能力不落 openai default 分支", () => {
    // 现状曾落 openai default——类型系统与运行时行为不一致；显式分支后
    // 误用即刻抛错（comfyui 消费面在 graph imageGen 直取 provider，不构
    // ChatModel；连通测试/测速在 connectivity 层已先行分流）
    const attempt = () =>
      createChatModel(
        { type: "comfyui", baseUrl: "http://127.0.0.1:8188" },
        "m",
      );
    expect(attempt).toThrow("ComfyUI");
    expect(attempt).toThrow(
      expect.objectContaining({ code: "COMFYUI_NOT_CHAT" }),
    );
  });

  it("第三参 options 透传四协议构造字段；省略字段保持各 SDK 默认（T3-3 R1）", () => {
    const opts = { temperature: 0.7, topP: 0.8, maxTokens: 4096 };

    // openai/anthropic：topP / maxTokens（base.d.ts L173/L186、chat_models L120/L122）
    const openai = createChatModel(
      { type: "openai-compatible", baseUrl: "http://x", apiKey: "k" },
      "gpt-x",
      opts,
    ) as ChatOpenAI;
    expect(openai.temperature).toBe(0.7);
    expect(openai.topP).toBe(0.8);
    expect(openai.maxTokens).toBe(4096);

    const anthropic = createChatModel(
      { type: "anthropic", baseUrl: "http://y", apiKey: "k" },
      "claude-x",
      opts,
    ) as ChatAnthropic;
    expect(anthropic.temperature).toBe(0.7);
    expect(anthropic.topP).toBe(0.8);
    expect(anthropic.maxTokens).toBe(4096);

    // gemini：topP / maxOutputTokens（chat_models.d.ts L73/L60）
    const gemini = createChatModel(
      { type: "gemini", baseUrl: "", apiKey: "k" },
      "gem-x",
      opts,
    ) as ChatGoogleGenerativeAI;
    expect(gemini.temperature).toBe(0.7);
    expect(gemini.topP).toBe(0.8);
    expect(gemini.maxOutputTokens).toBe(4096);

    // ollama：topP / numPredict（chat_models.d.ts L393/L391）
    const ollama = createChatModel(
      { type: "ollama", baseUrl: "http://z" },
      "qwen-x",
      opts,
    ) as ChatOllama;
    expect(ollama.temperature).toBe(0.7);
    expect(ollama.topP).toBe(0.8);
    expect(ollama.numPredict).toBe(4096);

    // 部分提供：仅 temperature 时其余保持各家默认（不落 undefined 覆盖）
    const partial = createChatModel(
      { type: "openai-compatible", baseUrl: "http://x", apiKey: "k" },
      "gpt-x",
      { temperature: 0.3 },
    ) as ChatOpenAI;
    expect(partial.temperature).toBe(0.3);
    expect(partial.topP).toBeUndefined();
    expect(partial.maxTokens).toBeUndefined();

    // 全省略：字段缺席（沿用旧省略模式）
    const omitted = createChatModel(
      { type: "openai-compatible", baseUrl: "http://x", apiKey: "k" },
      "gpt-x",
    ) as ChatOpenAI;
    expect(omitted.temperature).toBeUndefined();
    expect(omitted.topP).toBeUndefined();
    expect(omitted.maxTokens).toBeUndefined();
  });

  it("畸形 extraHeaders 容错为无额外 header", () => {
    const m = createChatModel(
      {
        type: "openai-compatible",
        baseUrl: "http://x",
        apiKey: "k",
        extraHeaders: "{bad",
      },
      "gpt-x",
    );
    expect(m).toBeInstanceOf(ChatOpenAI);
    expect((m as ChatOpenAI).clientConfig.defaultHeaders ?? {}).toEqual({});
  });
});
