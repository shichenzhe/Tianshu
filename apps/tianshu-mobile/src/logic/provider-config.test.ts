import { describe, expect, it } from "vitest";

import {
  buildModelSave,
  buildProviderSave,
  buildRemoteModelSave,
  importRemoteModels,
  prepareRemoteModels,
  type ModelFormValues,
  type ProviderFormValues,
} from "./provider-config";

const providerInput: ProviderFormValues = {
  name: "  OpenAI  ",
  type: "openai-compatible",
  baseUrl: "  https://api.openai.com/v1  ",
  apiKey: "  secret  ",
  extraHeaders: '  {"X-Key":"v"}  ',
  enabled: true,
  clearApiKey: false,
  clearExtraHeaders: false,
};

const modelInput: ModelFormValues = {
  modelId: "  gpt-5  ",
  name: "  GPT 5  ",
  type: "llm",
  temperature: "0.7",
  topP: "0.9",
  maxTokens: "4096",
  contextWindow: "8192",
};

describe("buildProviderSave", () => {
  it("creates a trimmed provider and omits empty optional secrets", () => {
    const result = buildProviderSave({
      ...providerInput,
      apiKey: " ",
      extraHeaders: " ",
    });

    expect(result).toStrictEqual({
      ok: true,
      item: {
        name: "OpenAI",
        type: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        enabled: true,
      },
    });
  });

  it("preserves, updates, or explicitly clears an edited API key", () => {
    const preserved = buildProviderSave({ ...providerInput, apiKey: "" }, 7);
    const updated = buildProviderSave(providerInput, 7);
    const cleared = buildProviderSave(
      { ...providerInput, apiKey: "", clearApiKey: true },
      7,
    );

    expect(preserved.ok && preserved.item.apiKey).toBeUndefined();
    expect(preserved.ok && preserved.item).not.toHaveProperty("apiKey");
    expect(updated.ok && updated.item.apiKey).toBe("secret");
    expect(cleared.ok && cleared.item.apiKey).toBeNull();
    expect(preserved.ok && preserved.item.id).toBe(7);
  });

  it("preserves blank edited headers unless explicitly cleared", () => {
    const preserved = buildProviderSave(
      { ...providerInput, extraHeaders: "" },
      7,
    );
    const cleared = buildProviderSave(
      { ...providerInput, extraHeaders: "", clearExtraHeaders: true },
      7,
    );

    expect(preserved.ok && preserved.item).not.toHaveProperty("extraHeaders");
    expect(cleared.ok && cleared.item.extraHeaders).toBeNull();
  });

  it("rejects malformed header JSON", () => {
    const invalid = buildProviderSave({
      ...providerInput,
      extraHeaders: "{bad json}",
    });

    expect(invalid).toStrictEqual({ ok: false, error: "invalidJson" });
  });

  it.each([
    '["sk-real"]',
    '"sk-real"',
    "42",
    "null",
    '{"X-Auth":{"token":"sk-real"}}',
    '{"X-Auth":["sk-real"]}',
    '{"X-Auth":42}',
    '{"X-Auth":true}',
  ])("rejects non-flat extraHeaders: %s", (extraHeaders) => {
    expect(buildProviderSave({ ...providerInput, extraHeaders })).toStrictEqual(
      {
        ok: false,
        error: "invalidJson",
      },
    );
  });
});

describe("buildModelSave", () => {
  it("builds numeric LLM parameters from valid input", () => {
    expect(buildModelSave(3, modelInput)).toStrictEqual({
      ok: true,
      item: {
        providerId: 3,
        modelId: "gpt-5",
        name: "GPT 5",
        type: "llm",
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 4096,
        contextWindow: 8192,
      },
    });
  });

  it.each([
    [{ ...modelInput, maxTokens: "1.5" }, "invalidNumber"],
    [{ ...modelInput, maxTokens: "0" }, "positiveIntRequired"],
    [{ ...modelInput, contextWindow: "-1" }, "positiveIntRequired"],
    [
      { ...modelInput, maxTokens: "8192", contextWindow: "8192" },
      "maxTokensLtContext",
    ],
  ])("rejects invalid token limits", (input, error) => {
    expect(buildModelSave(3, input)).toStrictEqual({ ok: false, error });
  });

  it("uses null to clear optional values when editing", () => {
    const result = buildModelSave(
      3,
      {
        ...modelInput,
        name: "",
        temperature: "",
        topP: "",
        maxTokens: "",
        contextWindow: "",
      },
      11,
    );

    expect(result).toStrictEqual({
      ok: true,
      item: {
        id: 11,
        providerId: 3,
        modelId: "gpt-5",
        name: null,
        type: "llm",
        temperature: null,
        topP: null,
        maxTokens: null,
        contextWindow: null,
      },
    });
  });
});

describe("remote model imports", () => {
  it("deduplicates remote IDs and moves already imported rows to the end", () => {
    expect(
      prepareRemoteModels(
        [
          { modelId: "existing" },
          { modelId: "new-b", name: "New B" },
          { modelId: "new-a" },
          { modelId: "new-b", name: "Duplicate" },
        ],
        new Set(["existing"]),
      ),
    ).toStrictEqual([
      { modelId: "new-b", name: "New B", imported: false },
      { modelId: "new-a", imported: false },
      { modelId: "existing", imported: true },
    ]);
  });

  it("retries only failed models after a partial import", async () => {
    const rows = [
      { modelId: "a", imported: false },
      { modelId: "b", imported: false },
      { modelId: "c", imported: false },
      { modelId: "existing", imported: true },
    ];
    const firstAttempts: string[] = [];
    const first = await importRemoteModels(
      4,
      rows,
      new Set(["a", "b", "c", "existing"]),
      async (item) => {
        firstAttempts.push(item.modelId);
        return item.modelId !== "b";
      },
    );

    expect(firstAttempts).toStrictEqual(["a", "b", "c"]);
    expect(first).toStrictEqual({
      succeeded: new Set(["a", "c"]),
      failed: new Set(["b"]),
    });

    const retryAttempts: string[] = [];
    const retry = await importRemoteModels(
      4,
      rows,
      first.failed,
      async (item) => {
        retryAttempts.push(item.modelId);
        return true;
      },
    );
    expect(retryAttempts).toStrictEqual(["b"]);
    expect(retry.failed).toStrictEqual(new Set());
  });

  it.each([
    ["text-embedding-3-large", "embedding"],
    ["gpt-4o-mini-tts", "tts"],
    ["bge-reranker-v2", "reranker"],
    ["whisper-1", "asr"],
    ["gpt-5", "llm"],
  ])("infers %s as %s", (modelId, type) => {
    expect(buildRemoteModelSave(4, { modelId }).type).toBe(type);
  });
});
