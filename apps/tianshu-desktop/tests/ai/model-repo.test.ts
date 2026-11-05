/**
 * model.repo 单测：type 字段链路——listAllEnabledAnyUser 过滤 llm
 * （记忆回退模型池只认 LLM）、create 透传 type（默认 llm）、test 按类型
 * 分派 connectivity.testConnection。IPC/DB 副作用 mock 三件套隔离
 * （同 assistant-repo.test.ts）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  // 安全批：密封链引 safeStorage（降级形态——master-key 走 hex 路径）
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error("safeStorage unavailable in test");
    },
    decryptString: () => {
      throw new Error("safeStorage unavailable in test");
    },
  },
  ipcMain: { handle: vi.fn() },
}));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    model: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    provider: {
      findMany: vi.fn(),
    },
  },
}));
vi.mock(
  "../../electron/domains/ai/provider/connectivity",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../electron/domains/ai/provider/connectivity")
      >();
    return {
      ...actual,
      testConnection: vi.fn(actual.testConnection),
      benchModel: vi.fn(),
    };
  },
);

import { ModelRepository } from "../../electron/domains/ai/provider/model.repo";
import {
  benchModel,
  testConnection,
} from "../../electron/domains/ai/provider/connectivity";
import prisma from "../../electron/commons/prisma-client";

const UID = 1;
const providerRepo = {
  assertOwned: vi.fn(),
  getRuntimeInfo: vi.fn(),
};
const repo = new ModelRepository(
  providerRepo as unknown as ConstructorParameters<typeof ModelRepository>[0],
);

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  providerId: 2,
  modelId: "text-embedding-3",
  name: null,
  enabled: true,
  type: "embedding",
  temperature: null,
  topP: null,
  maxTokens: null,
  contextWindow: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("type 字段链路", () => {
  it("listAllEnabledAnyUser 过滤 llm（回退模型池只认 LLM）", async () => {
    (prisma.model.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      row({ type: "llm", modelId: "gpt-4o" }),
    ]);
    const result = await repo.listAllEnabledAnyUser();
    expect(prisma.model.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ enabled: true, type: "llm" }),
      }),
    );
    expect(result[0].type).toBe("llm");
  });

  it("create 透传 type，未传默认 llm", async () => {
    (prisma.model.create as ReturnType<typeof vi.fn>).mockImplementation(
      ({ data }) => row({ ...data }),
    );
    await repo.create({ providerId: 2, modelId: "m1" }, UID);
    expect(prisma.model.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "llm" }),
      }),
    );
    await repo.create(
      { providerId: 2, modelId: "text-embedding-3", type: "embedding" },
      UID,
    );
    expect(prisma.model.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "embedding" }),
      }),
    );
  });

  it("test 按模型 type 分派 testConnection", async () => {
    (prisma.model.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      row(),
    );
    providerRepo.getRuntimeInfo.mockResolvedValue({
      type: "openai-compatible",
      baseUrl: "https://x.com/v1",
      apiKey: "k",
    });
    (testConnection as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      message: "",
    });
    await repo.test(1, UID);
    expect(testConnection).toHaveBeenCalledWith(
      expect.anything(),
      "text-embedding-3",
      { modelType: "embedding" },
    );
  });
});

describe("能力矩阵列链路（批5 §6 项 5）", () => {
  it("toRecord：capabilities JSON 解析为对象，畸形/空落 undefined；价格/备选透传", async () => {
    (prisma.model.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      row({
        type: "llm",
        modelId: "gpt-4o",
        capabilities: '{"vision":true,"tools":true}',
        priceInPerMTokens: 2.5,
        priceOutPerMTokens: 10,
        fallbackModelId: 7,
      }),
    );
    const record = await repo.getById(1);
    expect(record?.capabilities).toEqual({ vision: true, tools: true });
    expect(record?.priceInPerMTokens).toBe(2.5);
    expect(record?.priceOutPerMTokens).toBe(10);
    expect(record?.fallbackModelId).toBe(7);

    // 畸形 JSON：降级 undefined 不炸
    (prisma.model.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      row({ capabilities: "{oops" }),
    );
    expect((await repo.getById(1))?.capabilities).toBeUndefined();
    (prisma.model.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      row({ capabilities: null }),
    );
    expect((await repo.getById(1))?.capabilities).toBeUndefined();
  });

  it("create/update：capabilities 对象序列化 JSON、未传落 null", async () => {
    (prisma.model.create as ReturnType<typeof vi.fn>).mockImplementation(
      ({ data }) => row({ ...data }),
    );
    await repo.create(
      {
        providerId: 2,
        modelId: "gpt-4o",
        capabilities: { vision: true },
        priceInPerMTokens: 2.5,
        fallbackModelId: 3,
      },
      UID,
    );
    expect(prisma.model.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          capabilities: '{"vision":true}',
          priceInPerMTokens: 2.5,
          priceOutPerMTokens: undefined,
          fallbackModelId: 3,
        }),
      }),
    );

    (prisma.model.update as ReturnType<typeof vi.fn>).mockImplementation(
      ({ data }) => row({ ...data }),
    );
    await repo.update(
      { id: 1, capabilities: null, fallbackModelId: null },
      UID,
    );
    expect(prisma.model.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          capabilities: null,
          fallbackModelId: null,
        }),
      }),
    );
  });
});

describe("bench 测速 IPC（批5 §6 项 4）", () => {
  it("bench 分派 connectivity.benchModel（llm）", async () => {
    (prisma.model.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      row({ type: "llm", modelId: "gpt-4o" }),
    );
    providerRepo.getRuntimeInfo.mockResolvedValue({
      type: "openai-compatible",
      baseUrl: "https://x.com/v1",
      apiKey: "k",
    });
    (benchModel as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      message: "",
      firstChunkMs: 320,
      completeMs: 900,
      tokensPerSec: 42,
      outputTokens: 30,
    });
    const result = await repo.bench(1, UID);
    expect(benchModel).toHaveBeenCalledWith(expect.anything(), "gpt-4o");
    expect(result.firstChunkMs).toBe(320);
    expect(result.tokensPerSec).toBe(42);
  });

  it("非 llm / comfyui 模型结构化拒绝（不发起测速）", async () => {
    (prisma.model.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      row({ type: "embedding" }),
    );
    providerRepo.getRuntimeInfo.mockResolvedValue({
      type: "openai-compatible",
      baseUrl: "https://x.com/v1",
      apiKey: "k",
    });
    const result = await repo.bench(1, UID);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("UNSUPPORTED_TYPE_BENCH");
    expect(benchModel).not.toHaveBeenCalled();
  });
});
