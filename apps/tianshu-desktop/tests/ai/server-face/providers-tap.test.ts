import { describe, expect, it } from "vitest";
import { REDACTED_SECRET } from "@tianshu/protocol";

import { createProvidersFace } from "../../../electron/domains/server-face/providers-tap";
import type {
  ProviderCreateParams,
  ProviderRecord,
  ProviderUpdateParams,
} from "../../../src-react/domains/ai/api/provider.api";
import type {
  ListRemoteResult,
  ModelCreateParams,
  ModelRecord,
  ModelUpdateParams,
} from "../../../src-react/domains/ai/api/model.api";

const UID = 7;
const NOW = "2026-10-25T00:00:00.000Z";

type ProviderRow = ProviderRecord & { userId: number };

function providerRow(id: number, name: string): ProviderRow {
  return {
    id,
    userId: UID,
    name,
    type: "openai-compatible",
    baseUrl: "https://api.acme.test",
    apiKey: "sk-real",
    extraHeaders: '{"X-Key":"header-real"}',
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

class ProviderRepoDouble {
  rows: ProviderRow[];

  constructor(rows: ProviderRow[] = [providerRow(1, "one")]) {
    this.rows = rows;
  }

  async list(userId: number): Promise<ProviderRecord[]> {
    return this.rows.filter((row) => row.userId === userId);
  }

  async create(
    params: ProviderCreateParams,
    userId: number,
  ): Promise<ProviderRecord> {
    const row: ProviderRow = {
      id: Math.max(0, ...this.rows.map((item) => item.id)) + 1,
      userId,
      name: params.name,
      type: params.type,
      baseUrl: params.baseUrl,
      ...(params.apiKey !== undefined ? { apiKey: params.apiKey } : {}),
      ...(params.extraHeaders !== undefined
        ? { extraHeaders: params.extraHeaders }
        : {}),
      enabled: params.enabled ?? true,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.rows.push(row);
    return row;
  }

  async update(
    params: ProviderUpdateParams,
    userId: number,
  ): Promise<ProviderRecord> {
    const row = this.rows.find(
      (item) => item.id === params.id && item.userId === userId,
    );
    if (!row) throw new Error("PROVIDER_NOT_FOUND");
    if (params.name !== undefined) row.name = params.name;
    if (params.type !== undefined) row.type = params.type;
    if (params.baseUrl !== undefined) row.baseUrl = params.baseUrl;
    if (params.enabled !== undefined) row.enabled = params.enabled;
    if (params.apiKey !== undefined) {
      if (params.apiKey === null) delete row.apiKey;
      else row.apiKey = params.apiKey;
    }
    if (params.extraHeaders !== undefined) {
      if (params.extraHeaders === null) delete row.extraHeaders;
      else row.extraHeaders = params.extraHeaders;
    }
    return row;
  }

  async delete(id: number, userId: number): Promise<void> {
    const index = this.rows.findIndex(
      (row) => row.id === id && row.userId === userId,
    );
    if (index < 0) throw new Error("PROVIDER_NOT_FOUND");
    this.rows.splice(index, 1);
  }
}

class ModelRepoDouble {
  rows: ModelRecord[] = [];

  constructor(private providers: ProviderRepoDouble) {}

  private ownedProvider(providerId: number, userId: number): boolean {
    return this.providers.rows.some(
      (row) => row.id === providerId && row.userId === userId,
    );
  }

  async listAll(userId: number): Promise<ModelRecord[]> {
    return this.rows.filter((row) =>
      this.ownedProvider(row.providerId, userId),
    );
  }

  async create(
    params: ModelCreateParams,
    userId: number,
  ): Promise<ModelRecord> {
    if (!this.ownedProvider(params.providerId, userId)) {
      throw new Error("PROVIDER_NOT_FOUND");
    }
    const row: ModelRecord = {
      id: Math.max(0, ...this.rows.map((item) => item.id)) + 1,
      providerId: params.providerId,
      modelId: params.modelId,
      name: params.name,
      type: params.type ?? "llm",
      enabled: true,
      temperature: params.temperature,
      topP: params.topP,
      maxTokens: params.maxTokens,
      contextWindow: params.contextWindow,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.rows.push(row);
    return row;
  }

  async update(
    params: ModelUpdateParams,
    userId: number,
  ): Promise<ModelRecord> {
    const row = this.rows.find((item) => item.id === params.id);
    if (!row || !this.ownedProvider(row.providerId, userId)) {
      throw new Error("MODEL_NOT_FOUND");
    }
    if (params.modelId !== undefined) row.modelId = params.modelId;
    if (params.enabled !== undefined) row.enabled = params.enabled;
    if (params.type !== undefined) row.type = params.type;
    for (const key of [
      "name",
      "temperature",
      "topP",
      "maxTokens",
      "contextWindow",
    ] as const) {
      const value = params[key];
      if (value !== undefined) {
        if (value === null) delete row[key];
        else row[key] = value;
      }
    }
    return row;
  }

  async delete(id: number, userId: number): Promise<void> {
    const row = this.rows.find((item) => item.id === id);
    if (!row || !this.ownedProvider(row.providerId, userId)) {
      throw new Error("MODEL_NOT_FOUND");
    }
    this.rows = this.rows.filter((item) => item.id !== id);
  }

  async listRemote(): Promise<ListRemoteResult> {
    return { success: true, message: "", models: [] };
  }
}

function makeFace(rows?: ProviderRow[]) {
  const providerRepo = new ProviderRepoDouble(rows);
  const modelRepo = new ModelRepoDouble(providerRepo);
  const face = createProvidersFace({ providerRepo, modelRepo });
  return { face, providerRepo, modelRepo };
}

describe("providers-tap", () => {
  it("掩码回写保留 apiKey/extraHeaders 现值，响应 bundle 全脱敏", async () => {
    const { face, providerRepo } = makeFace();
    const result = await face.save(
      {
        providers: [
          {
            id: 1,
            name: "renamed",
            type: "openai-compatible",
            baseUrl: "https://api.acme.test/v2",
            apiKey: REDACTED_SECRET,
            extraHeaders: `{"X-Key":"${REDACTED_SECRET}"}`,
            enabled: false,
          },
        ],
      },
      UID,
    );

    expect(providerRepo.rows[0]).toMatchObject({
      name: "renamed",
      baseUrl: "https://api.acme.test/v2",
      apiKey: "sk-real",
      extraHeaders: '{"X-Key":"header-real"}',
      enabled: false,
    });
    expect(result.providers[0]).toMatchObject({
      apiKey: REDACTED_SECRET,
      extraHeaders: `{"X-Key":"${REDACTED_SECRET}"}`,
      enabled: false,
    });
    expect(JSON.stringify(result)).not.toContain("sk-real");
    expect(JSON.stringify(result)).not.toContain("header-real");
  });

  it("显式 null 清除密钥与请求头", async () => {
    const { face, providerRepo } = makeFace();
    await face.save(
      {
        providers: [
          {
            id: 1,
            name: "one",
            type: "openai-compatible",
            baseUrl: "https://api.acme.test",
            apiKey: null,
            extraHeaders: null,
          },
        ],
      },
      UID,
    );

    expect(providerRepo.rows[0].apiKey).toBeUndefined();
    expect(providerRepo.rows[0].extraHeaders).toBeUndefined();
  });

  it("异常 extraHeaders 形状 fail-closed，嵌套秘密不回泄", async () => {
    const rows = [
      { ...providerRow(1, "array"), extraHeaders: '["sk-real-array"]' },
      { ...providerRow(2, "scalar"), extraHeaders: '"sk-real-scalar"' },
      { ...providerRow(3, "number"), extraHeaders: "42" },
      {
        ...providerRow(4, "nested"),
        extraHeaders:
          '{"X-Auth":{"token":"sk-real-nested"},"X-List":["sk-real-list"],"X-Count":2}',
      },
    ];
    const { face } = makeFace(rows);
    const result = await face.listBundle(UID);

    expect(
      result.providers.map((row) => (row as ProviderRecord).extraHeaders),
    ).toEqual([
      REDACTED_SECRET,
      REDACTED_SECRET,
      REDACTED_SECRET,
      `{"X-Auth":"${REDACTED_SECRET}","X-List":"${REDACTED_SECRET}","X-Count":"${REDACTED_SECRET}"}`,
    ]);
    expect(JSON.stringify(result)).not.toContain("sk-real");
  });

  it("新建服务商和模型完成字段桥接，成功响应不泄真实秘密", async () => {
    const { face, modelRepo } = makeFace([]);
    const result = await face.save(
      {
        providers: [
          {
            name: "created",
            type: "openai-compatible",
            baseUrl: "https://api.created.test",
            apiKey: "sk-created",
            extraHeaders: '{"X-Created":"secret"}',
            enabled: true,
          },
        ],
        models: [
          {
            providerId: 1,
            modelId: "gpt-created",
            name: "Created model",
            type: "llm",
            enabled: false,
            temperature: 0.4,
            topP: 0.8,
            maxTokens: 1024,
            contextWindow: 4096,
          },
        ],
      },
      UID,
    );

    expect(modelRepo.rows[0]).toMatchObject({
      providerId: 1,
      modelId: "gpt-created",
      enabled: false,
      temperature: 0.4,
      topP: 0.8,
      maxTokens: 1024,
      contextWindow: 4096,
    });
    expect(JSON.stringify(result)).not.toContain("sk-created");
    expect(JSON.stringify(result)).not.toContain('{"X-Created":"secret"}');
  });

  it("归属失败错误携带当前服务商项标识", async () => {
    const { face } = makeFace();
    await expect(
      face.save(
        {
          providers: [
            {
              id: 99,
              name: "missing-provider",
              type: "openai-compatible",
              baseUrl: "https://missing.test",
            },
          ],
        },
        UID,
      ),
    ).rejects.toThrow("服务商「missing-provider」保存失败：PROVIDER_NOT_FOUND");
  });

  it("批量保存部分失败即停，不继续写后续项", async () => {
    const { face, providerRepo } = makeFace([
      providerRow(1, "first-old"),
      providerRow(2, "third-old"),
    ]);
    await expect(
      face.save(
        {
          providers: [
            {
              id: 1,
              name: "first-new",
              type: "openai-compatible",
              baseUrl: "https://first.test",
            },
            {
              id: 99,
              name: "missing-middle",
              type: "openai-compatible",
              baseUrl: "https://missing.test",
            },
            {
              id: 2,
              name: "third-new",
              type: "openai-compatible",
              baseUrl: "https://third.test",
            },
          ],
        },
        UID,
      ),
    ).rejects.toThrow("missing-middle");

    expect(providerRepo.rows.map((row) => row.name)).toEqual([
      "first-new",
      "third-old",
    ]);
  });
});
