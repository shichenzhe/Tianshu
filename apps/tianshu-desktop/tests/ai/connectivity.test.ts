import { describe, expect, it, vi } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import {
  listRemoteModels,
  testConnection,
} from "../../electron/domains/ai/provider/connectivity";

/** 错误路径替身：_generate 直接抛预设错误（@langchain/core 1.x 测试模型
 * 无 _call 钩子，覆写 _generate 为等价收口） */
class ExplodingModel extends FakeListChatModel {
  readonly error: Error;
  constructor(error: Error) {
    super({ responses: ["x"] });
    this.error = error;
  }
  override async _generate(): Promise<never> {
    throw this.error;
  }
}

describe("testConnection", () => {
  it("成功", async () => {
    const fakeModel = new FakeListChatModel({ responses: ["hi"] });
    const result = await testConnection(
      { type: "openai-compatible", baseUrl: "https://x", apiKey: "k" },
      "m",
      { injectModel: fakeModel },
    );
    expect(result.success).toBe(true);
  });

  it("上游 401 映射 AUTH_FAILED", async () => {
    const bad = new ExplodingModel(
      Object.assign(new Error("Unauthorized"), { statusCode: 401 }),
    );
    const result = await testConnection(
      { type: "openai-compatible", baseUrl: "https://x", apiKey: "k" },
      "m",
      { injectModel: bad },
    );
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("AUTH_FAILED");
  });

  it("上游 401（provider SDK status 形状）映射 AUTH_FAILED", async () => {
    // @langchain/openai / @langchain/anthropic 抛的 APIError 携带 status
    const bad = new ExplodingModel(
      Object.assign(new Error("Incorrect API key provided"), { status: 401 }),
    );
    const result = await testConnection(
      { type: "openai-compatible", baseUrl: "https://x", apiKey: "k" },
      "m",
      { injectModel: bad },
    );
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("AUTH_FAILED");
  });

  it("上游 429（provider SDK status 形状）映射 RATE_LIMITED", async () => {
    const bad = new ExplodingModel(
      Object.assign(new Error("Rate limit reached"), { status: 429 }),
    );
    const result = await testConnection(
      { type: "openai-compatible", baseUrl: "https://x", apiKey: "k" },
      "m",
      { injectModel: bad },
    );
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("RATE_LIMITED");
  });

  it("网络错误映射 NETWORK", async () => {
    const bad = new ExplodingModel(new TypeError("fetch failed"));
    const result = await testConnection(
      { type: "openai-compatible", baseUrl: "https://x", apiKey: "k" },
      "m",
      { injectModel: bad },
    );
    expect(result.errorCode).toBe("NETWORK");
  });

  it("非流式 invoke 带 abortSignal（M7：半开连接不得永久挂起）", async () => {
    const fakeModel = new FakeListChatModel({ responses: ["hi"] });
    const invokeSpy = vi.spyOn(fakeModel, "invoke");
    await testConnection(
      { type: "openai-compatible", baseUrl: "https://x", apiKey: "k" },
      "m",
      { injectModel: fakeModel },
    );
    const options = invokeSpy.mock.calls[0]?.[1];
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("testConnection 非 LLM 类型分派（openai-compatible 端点探测）", () => {
  const provider = {
    type: "openai-compatible",
    baseUrl: "https://x.com/v1",
    apiKey: "sk-1",
  } as const;

  it("embedding：POST /embeddings 带 Bearer，强校验返回向量", async () => {
    const stub = stubFetch([
      {
        match: (u) => u.endsWith("/v1/embeddings"),
        status: 200,
        body: { data: [{ index: 0, embedding: [0.1, 0.2] }] },
      },
    ]);
    try {
      const result = await testConnection(provider, "text-embedding-3", {
        modelType: "embedding",
      });
      expect(result.success).toBe(true);
      const init = stub.calls[0].init;
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer sk-1");
      expect(JSON.parse(String(init?.body)).input).toEqual(["ping"]);
    } finally {
      stub.restore();
    }
  });

  it("embedding：200 但未返回向量判失败", async () => {
    const stub = stubFetch([
      {
        match: (u) => u.endsWith("/v1/embeddings"),
        status: 200,
        body: { data: [{ index: 0 }] },
      },
    ]);
    try {
      const result = await testConnection(provider, "text-embedding-3", {
        modelType: "embedding",
      });
      expect(result.success).toBe(false);
    } finally {
      stub.restore();
    }
  });

  it("tts：POST /audio/speech 带 input+voice，2xx 成功", async () => {
    const stub = stubFetch([
      {
        match: (u) => u.endsWith("/v1/audio/speech"),
        status: 200,
        body: {},
      },
    ]);
    try {
      const result = await testConnection(provider, "tts-1", {
        modelType: "tts",
      });
      expect(result.success).toBe(true);
      const body = JSON.parse(String(stub.calls[0].init?.body));
      expect(body.model).toBe("tts-1");
      expect(body.input).toBe("hi");
    } finally {
      stub.restore();
    }
  });

  it("asr：POST /audio/transcriptions 走 multipart 且 2xx 成功", async () => {
    const stub = stubFetch([
      {
        match: (u) => u.endsWith("/v1/audio/transcriptions"),
        status: 200,
        body: { text: "" },
      },
    ]);
    try {
      const result = await testConnection(provider, "whisper-1", {
        modelType: "asr",
      });
      expect(result.success).toBe(true);
      // multipart 形态：body 为 FormData（Content-Type/boundary 由 fetch 注入）
      const body = stub.calls[0].init?.body;
      expect(body).toBeInstanceOf(FormData);
      expect((body as FormData).get("model")).toBe("whisper-1");
      expect((body as FormData).get("file")).toBeInstanceOf(Blob);
    } finally {
      stub.restore();
    }
  });

  it("reranker：POST /rerank 带 query+documents，2xx 成功", async () => {
    const stub = stubFetch([
      {
        match: (u) => u.endsWith("/v1/rerank"),
        status: 200,
        body: { results: [{ index: 0, relevance_score: 0.9 }] },
      },
    ]);
    try {
      const result = await testConnection(provider, "rerank-1", {
        modelType: "reranker",
      });
      expect(result.success).toBe(true);
      const body = JSON.parse(String(stub.calls[0].init?.body));
      expect(body.query).toBe("ping");
      expect(body.documents).toEqual(["pong"]);
    } finally {
      stub.restore();
    }
  });

  it("400/422 参数拒但服务可达：判成功（鉴权与路由已验）", async () => {
    for (const status of [400, 422]) {
      const stub = stubFetch([
        {
          match: (u) => u.endsWith("/v1/audio/speech"),
          status,
          body: { error: { message: "voice not supported" } },
        },
      ]);
      try {
        const result = await testConnection(provider, "tts-1", {
          modelType: "tts",
        });
        expect(result.success).toBe(true);
      } finally {
        stub.restore();
      }
    }
  });

  it("提前返回路径 cancel 响应体（未读 body 不钉 undici 连接池）", async () => {
    for (const [status, modelType] of [
      [422, "tts"],
      [200, "tts"],
    ] as const) {
      const cancel = vi.fn().mockResolvedValue(undefined);
      const original = globalThis.fetch;
      globalThis.fetch = (async () => {
        const res = new Response("{}", { status });
        Object.defineProperty(res, "body", { get: () => ({ cancel }) });
        return res;
      }) as typeof fetch;
      try {
        const result = await testConnection(provider, "tts-1", { modelType });
        expect(result.success).toBe(true);
        expect(cancel).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.fetch = original;
      }
    }
  });

  it("401 映射 AUTH_FAILED", async () => {
    const stub = stubFetch([
      { match: (u) => u.endsWith("/v1/embeddings"), status: 401, body: {} },
    ]);
    try {
      const result = await testConnection(provider, "text-embedding-3", {
        modelType: "embedding",
      });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("AUTH_FAILED");
    } finally {
      stub.restore();
    }
  });

  it("404 映射 MODEL_NOT_FOUND", async () => {
    const stub = stubFetch([
      { match: (u) => u.endsWith("/v1/rerank"), status: 404, body: {} },
    ]);
    try {
      const result = await testConnection(provider, "rerank-1", {
        modelType: "reranker",
      });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("MODEL_NOT_FOUND");
    } finally {
      stub.restore();
    }
  });

  it("非 openai-compatible 协议返回 UNSUPPORTED_TYPE_TEST", async () => {
    for (const type of ["anthropic", "gemini", "ollama"]) {
      const result = await testConnection(
        { type, baseUrl: "https://x.com", apiKey: "k" },
        "tts-1",
        { modelType: "tts" },
      );
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("UNSUPPORTED_TYPE_TEST");
    }
  });
});

describe("comfyui", () => {
  it("system_stats 200 → 连通", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200 }) as Response),
    );
    const result = await testConnection(
      { type: "comfyui", baseUrl: "http://127.0.0.1:8188", apiKey: undefined },
      "",
    );
    expect(result.success).toBe(true);
    expect(String(vi.mocked(global.fetch).mock.calls[0][0])).toBe(
      "http://127.0.0.1:8188/system_stats",
    );
    vi.unstubAllGlobals();
  });

  it("HTTP 500 → 失败带状态码", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 }) as Response),
    );
    const result = await testConnection(
      { type: "comfyui", baseUrl: "http://127.0.0.1:8188", apiKey: undefined },
      "",
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("500");
    vi.unstubAllGlobals();
  });
});

/** fetch stub：按 URL 前缀返回预设响应；记录调用供断言 */
function stubFetch(
  routes: Array<{
    match: (url: string, init?: RequestInit) => boolean;
    status: number;
    body: unknown;
  }>,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const route = routes.find((r) => r.match(u, init));
    if (!route) {
      throw new Error(`unexpected fetch: ${u}`);
    }
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("listRemoteModels", () => {
  it("openai-compatible：Bearer 头 + extraHeaders 合并，data[].id/owned_by", async () => {
    const stub = stubFetch([
      {
        match: (u) => u.endsWith("/v1/models"),
        status: 200,
        body: {
          data: [
            { id: "m-a", owned_by: "qwen" },
            { id: "", owned_by: "x" },
          ],
        },
      },
    ]);
    try {
      const models = await listRemoteModels({
        type: "openai-compatible",
        baseUrl: "https://x.com/v1",
        apiKey: "sk-1",
        extraHeaders: '{"X-Custom":"c"}',
      });
      expect(models).toEqual([{ modelId: "m-a", ownedBy: "qwen" }]);
      const init = stub.calls[0].init;
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer sk-1");
      expect(headers["X-Custom"]).toBe("c");
      expect(stub.calls[0].url).toBe("https://x.com/v1/models");
    } finally {
      stub.restore();
    }
  });

  it("anthropic：x-api-key + anthropic-version，v1/models 路径", async () => {
    const stub = stubFetch([
      {
        match: (u) => u.endsWith("/v1/models"),
        status: 200,
        body: { data: [{ id: "claude-x", display_name: "Claude X" }] },
      },
    ]);
    try {
      const models = await listRemoteModels({
        type: "anthropic",
        baseUrl: "https://x.com",
        apiKey: "k",
      });
      expect(models).toEqual([{ modelId: "claude-x", ownedBy: "Claude X" }]);
      const headers = stub.calls[0].init?.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("k");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
    } finally {
      stub.restore();
    }
  });

  it("gemini：key 入 query，models[].name 剥离 models/ 前缀", async () => {
    const stub = stubFetch([
      {
        match: (u) => u.includes("/v1beta/models") && u.includes("key=K"),
        status: 200,
        body: { models: [{ name: "models/gemini-2.0" }] },
      },
    ]);
    try {
      const models = await listRemoteModels({
        type: "gemini",
        baseUrl: "https://x.com",
        apiKey: "K",
      });
      expect(models).toEqual([{ modelId: "gemini-2.0" }]);
    } finally {
      stub.restore();
    }
  });

  it("gemini：preset 形态 baseUrl（末尾含 /v1beta）不重复拼接", async () => {
    const stub = stubFetch([
      {
        match: (u) =>
          u.split("?")[0].endsWith("/v1beta/models") &&
          !u.includes("/v1beta/v1beta"),
        status: 200,
        body: { models: [{ name: "models/gemini-2.0" }] },
      },
    ]);
    try {
      const models = await listRemoteModels({
        type: "gemini",
        baseUrl: "https://x.com/v1beta",
        apiKey: "K",
      });
      expect(models).toEqual([{ modelId: "gemini-2.0" }]);
    } finally {
      stub.restore();
    }
  });

  it("ollama：复用 /api/tags", async () => {
    const stub = stubFetch([
      {
        match: (u) => u.endsWith("/api/tags"),
        status: 200,
        body: { models: [{ name: "llama3" }] },
      },
    ]);
    try {
      const models = await listRemoteModels({
        type: "ollama",
        baseUrl: "https://x.com",
      });
      expect(models).toEqual([{ modelId: "llama3" }]);
    } finally {
      stub.restore();
    }
  });

  it("comfyui：早退失败（无模型列表概念），不落 gemini 分支发请求", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const attempt = listRemoteModels({
        type: "comfyui",
        baseUrl: "http://127.0.0.1:8188",
      });
      await expect(attempt).rejects.toThrow("ComfyUI 无模型列表概念");
      await expect(attempt).rejects.toMatchObject({
        code: "UNSUPPORTED_TYPE_LIST",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("非 2xx 抛 HTTP {status} 且附 statusCode（repo 层 classifyError 归类）", async () => {
    const stub = stubFetch([
      { match: (u) => u.endsWith("/models"), status: 401, body: {} },
    ]);
    try {
      const attempt = listRemoteModels({
        type: "openai-compatible",
        baseUrl: "https://x.com/v1",
        apiKey: "k",
      });
      await expect(attempt).rejects.toThrow("HTTP 401");
      await expect(attempt).rejects.toMatchObject({ statusCode: 401 });
    } finally {
      stub.restore();
    }
  });
});
