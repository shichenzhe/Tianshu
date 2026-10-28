/**
 * model.repo 单测：type 字段链路——listAllEnabledAnyUser 过滤 llm
 * （记忆回退模型池只认 LLM）、create 透传 type（默认 llm）、test 按类型
 * 分派 connectivity.testConnection。IPC/DB 副作用 mock 三件套隔离
 * （同 assistant-repo.test.ts）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
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
    return { ...actual, testConnection: vi.fn(actual.testConnection) };
  },
);

import { ModelRepository } from "../../electron/domains/ai/provider/model.repo";
import { testConnection } from "../../electron/domains/ai/provider/connectivity";
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
