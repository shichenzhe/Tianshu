/**
 * provider 凭证列解密收口契约测试（批1A，TDD RED 先行）：
 * 加密生效（safeStorage 可用）的机器上 provider 行 apiKey/extraHeaders 以
 * enc:v1: 密文落库——聊天/交接/图编排引擎直读 prisma 行后必须解密再喂
 * createChatModel，密文直传会把密文当 Bearer 致全量 AUTH_FAILED
 * （docs/design/provider-model.md §3.2 ⚠ 未收口点 → 批1A 收口）。
 *
 * 替身注入法（参照 tianshu-retention-batch 两路替身）：master-key 模块
 * mock 固定 32B 测试密钥（不依赖真 safeStorage/option 表），provider 行
 * fixture 经真实 encryptField 产 enc:v1: 密文——加解密链路与生产同构。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** 固定 32B 测试主密钥（getMasterKey 替身恒返回） */
  key: Buffer.alloc(32, 0xab),
  providerRow: {
    id: 2,
    type: "openai-compatible",
    baseUrl: "https://x.example/v1",
    apiKey: "",
    extraHeaders: "",
    enabled: true,
    contextWindow: null,
  },
  modelRow: {
    id: 1,
    providerId: 2,
    modelId: "m",
    temperature: null,
    topP: null,
    maxTokens: null,
    contextWindow: null,
  },
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

// master-key 替身：固定密钥（isMasterKeyDegraded 状态由本文件不消费，
// 透出链路在 tests/security/master-key.test.ts 单独锁定）
vi.mock("../../electron/domains/security/master-key", () => ({
  getMasterKey: async () => mocks.key,
  isMasterKeyDegraded: () => false,
  resetMasterKeyCacheForTest: () => {},
}));

vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    // verifyUserId 用户存在性回查
    user: { findUnique: async () => ({ id: 1 }) },
    model: {
      findUnique: vi.fn(async () => mocks.modelRow),
      findFirst: vi.fn(async () => mocks.modelRow),
      findMany: vi.fn(async () => []),
    },
    provider: {
      findUnique: vi.fn(async () => mocks.providerRow),
      // polishText 两步查启用集（select id 投影）
      findMany: vi.fn(async () => [{ id: 2 }]),
    },
    assistant: { findUnique: vi.fn(async () => null) },
    message: { findMany: vi.fn(async () => []) },
    workspace: { findMany: vi.fn(async () => []) },
  },
}));

// createChatModel 替身：捕获构造参数（apiKey 断言锚），invoke 供非流式
// 补全链路（polish/polishNodePrompt）走通
const invokeStub = vi.hoisted(() => vi.fn(async () => ({ content: "ok" })));
const createChatModelMock = vi.hoisted(() =>
  vi.fn(() => ({ invoke: invokeStub })),
);
vi.mock(
  "../../electron/domains/ai/orchestration/langchain-model-factory",
  () => ({ createChatModel: createChatModelMock }),
);

// 技能扫描替身（assembleContext 消费，避免真实文件系统扫描）
vi.mock("../../electron/domains/ai/agent/skill-loader", () => ({
  loadSkills: vi.fn(() => []),
}));

import { encryptField } from "@tianshu/core";
import ChatService from "../../electron/domains/ai/chat/chat.service";
import { resolveHandoverModel } from "../../electron/domains/ai/chat/handover-summary";
import { polishNodePrompt } from "../../electron/domains/ai/orchestration/graph-executor";
import prisma from "../../electron/commons/prisma-client";
import type { SessionRepository } from "../../electron/domains/ai/chat/session.repo";

const PLAIN_API_KEY = "sk-plain-wire-123";
const PLAIN_EXTRA_HEADERS = JSON.stringify({ "X-Key": "v" });

/** 密文行 fixture：真实 encryptField 产 enc:v1:（AAD 绑定字段名同生产） */
function sealProviderRow() {
  mocks.providerRow = {
    ...mocks.providerRow,
    apiKey: encryptField(mocks.key, "provider.apiKey", PLAIN_API_KEY),
    extraHeaders: encryptField(
      mocks.key,
      "provider.extraHeaders",
      PLAIN_EXTRA_HEADERS,
    ),
  };
}

/** sessions stub（assembleContext/polish 最小面，照 chat.service.test.ts 先例） */
function makeSessions() {
  return {
    getSession: vi.fn().mockResolvedValue({
      id: 1,
      assistantId: null,
      workspaceId: 1,
      userId: 1,
      mode: null,
      scenario: null,
      compactedUpToId: null,
      summary: null,
      projectId: null,
    }),
    getEffectiveModelId: vi.fn().mockResolvedValue(1),
    getWorkspace: vi.fn().mockResolvedValue(null),
  };
}

/** 私有 assembleContext 访问（chat.service.test.ts 既有内部访问模式） */
function assemble(service: ChatService) {
  return (
    service as unknown as {
      assembleContext: (
        sessionId: number,
        userId: number,
      ) => Promise<{
        providerRow: { apiKey?: string | null; extraHeaders?: string | null };
      }>;
    }
  ).assembleContext(1, 1);
}

beforeEach(() => {
  vi.clearAllMocks();
  sealProviderRow();
});

describe("聊天引擎 provider 凭证解密收口（批1A）", () => {
  it("assembleContext：enc:v1: 密文行 → ctx.providerRow 明文（streamAndPersist/memberModelText/起标题共同数据源）", async () => {
    const service = new ChatService(
      makeSessions() as unknown as SessionRepository,
    );
    const ctx = await assemble(service);
    expect(ctx.providerRow.apiKey).toBe(PLAIN_API_KEY);
    expect(ctx.providerRow.extraHeaders).toBe(PLAIN_EXTRA_HEADERS);
  });

  it("polish：密文行 → createChatModel 收到明文 apiKey/extraHeaders", async () => {
    const sessions = makeSessions();
    sessions.getWorkspace.mockResolvedValue({
      id: 1,
      userId: 1,
      defaultModelId: null,
    });
    const service = new ChatService(sessions as unknown as SessionRepository);
    await service.polish(
      { workspaceId: 1, text: "润色我", style: "professional" },
      1,
    );
    expect(createChatModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: PLAIN_API_KEY,
        extraHeaders: PLAIN_EXTRA_HEADERS,
      }),
      "m",
    );
  });
});

describe("交接摘要模型解析解密收口（批1A）", () => {
  it("resolveHandoverModel：密文 provider 行 → 返回明文 apiKey/extraHeaders", async () => {
    const model = await resolveHandoverModel(
      {
        workspace: { findMany: async () => [] },
        model: {
          findMany: async () => [
            { id: 1, providerId: 2, modelId: "m", enabled: true },
          ],
        },
        provider: { findUnique: async () => mocks.providerRow },
        message: { findMany: async () => [] },
      },
      null,
    );
    expect(model?.apiKey).toBe(PLAIN_API_KEY);
    expect(model?.extraHeaders).toBe(PLAIN_EXTRA_HEADERS);
  });
});

describe("图编排模型装载解密收口（批1A）", () => {
  it("polishNodePrompt（loadModelRuntime）：密文行 → createChatModel 收到明文 apiKey", async () => {
    await polishNodePrompt(1, "帮我改写");
    expect(createChatModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: PLAIN_API_KEY,
        extraHeaders: PLAIN_EXTRA_HEADERS,
      }),
      "m",
    );
    // 契约锚：主进程确按 provider 行 id 查询（fixture 接线正确性）
    expect(
      (prisma.provider.findUnique as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0],
    ).toEqual({ where: { id: 2 } });
  });
});
