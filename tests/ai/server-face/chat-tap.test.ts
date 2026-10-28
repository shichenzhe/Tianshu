// chat 流 tap 点（server-face T10）集成测试：ChatService.emit 旁路广播——
// 无论渲染层 sender 在场与否，onChatChunk 订阅者都收到 (sessionId, chunk)；
// 退订后不再收。构造手法照 chat.service.test.ts「自动压缩」套件（mock
// prisma 读通道/skill-loader/模型工厂 + sessions 仓储 stub + 脚本模型）。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  // Log/prisma-client 顶层读取 app.getPath("userData")/getAppPath/isPackaged
  // 计算日志与数据目录（data-root 冷迁移链路）
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
}));

// assembleContext 读通道（vi.hoisted 使 vi.mock 工厂执行前已初始化）
const assembleReads = vi.hoisted(() => ({
  model: { findUnique: vi.fn() },
  provider: { findUnique: vi.fn() },
  assistant: { findUnique: vi.fn() },
}));

vi.mock("../../../electron/commons/prisma-client", () => ({
  default: {
    // 历史空仓：首轮发送（组装上下文/标题守卫 visible.length!==2 均短路，
    // 无迟到 title-updated 干扰断言）；llmCallEvent 兜 usage 埋点写入
    message: { findMany: vi.fn(async () => []) },
    ...assembleReads,
    llmCallEvent: { create: vi.fn(async () => null) },
  },
}));

// 技能扫描依赖 userData 真实文件系统：空清单保证确定性
vi.mock("../../../electron/domains/ai/agent/skill-loader", () => ({
  loadSkills: () => [],
}));

// 模型工厂收口：默认 invoke 替身（标题补全等非流式路径），用例内覆写为脚本模型
const invokeStub = vi.hoisted(() => vi.fn(async () => ({ content: "标题" })));
vi.mock(
  "../../../electron/domains/ai/orchestration/langchain-model-factory",
  () => ({
    createChatModel: vi.fn(() => ({ invoke: invokeStub })),
  }),
);

import ChatService from "../../../electron/domains/ai/chat/chat.service";
import { onChatChunk } from "../../../electron/domains/server-face/chat-tap";
import { createChatModel } from "../../../electron/domains/ai/orchestration/langchain-model-factory";
import { scriptedChatModel } from "../helpers/scripted-chat-model";
import type { SessionRepository } from "../../../electron/domains/ai/chat/session.repo";
import type { ChatStreamChunk } from "../../../src-react/domains/ai/api/chat.api";

const createChatModelMock = createChatModel as unknown as Mock;

/** sessions 仓储 stub：send 全链路触达方法（照 makeAutoService 形态） */
const makeSessions = () => ({
  getSession: vi.fn().mockResolvedValue({
    id: 1,
    userId: 1,
    assistantId: null,
    archivedAt: null,
    workspaceId: null,
    projectId: null,
    mode: null,
    compactedUpToId: null,
    summary: null,
    title: "会话",
  }),
  getEffectiveModelId: vi.fn().mockResolvedValue(5),
  getWorkspace: vi.fn().mockResolvedValue(null),
  setSessionModel: vi.fn().mockResolvedValue(undefined),
  appendMessage: vi.fn().mockResolvedValue(undefined),
  autotitleIfDefault: vi.fn().mockResolvedValue(undefined),
  updateSummary: vi.fn().mockResolvedValue(undefined),
  renameSession: vi.fn().mockResolvedValue(undefined),
});

/** 脚本化模型接管工厂：每次流式调用按累积序消费一个脚本 */
const useScriptedModel = (...stepsPerCall: string[][]) => {
  const { model } = scriptedChatModel(
    stepsPerCall.map((deltas) => ({
      steps: deltas.map((delta) => ({ kind: "text" as const, delta })),
    })),
  );
  createChatModelMock.mockImplementation(() => model);
  return model;
};

describe("chat 流 tap 点（server-face T10）", () => {
  beforeEach(() => {
    // 大窗（100 万 token）确保预算探测不触发自动压缩；provider/助手行最小形态
    assembleReads.model.findUnique.mockResolvedValue({
      id: 5,
      providerId: 1,
      modelId: "m",
      temperature: null,
      topP: null,
      maxTokens: 100,
      contextWindow: 1000000,
    });
    assembleReads.provider.findUnique.mockResolvedValue({
      id: 1,
      type: "openai-compatible",
      baseUrl: "https://x.example/v1",
      apiKey: "k",
      extraHeaders: null,
    });
    assembleReads.assistant.findUnique.mockResolvedValue(null);
  });

  afterEach(() => {
    createChatModelMock.mockImplementation(() => ({ invoke: invokeStub }));
    assembleReads.model.findUnique.mockReset();
    assembleReads.provider.findUnique.mockReset();
    assembleReads.assistant.findUnique.mockReset();
  });

  it("sender 缺席仍广播：text-delta 按序 + finish 收尾，sessionId 随帧", async () => {
    useScriptedModel(["你", "好"]);
    const service = new ChatService(
      makeSessions() as unknown as SessionRepository,
    );
    const received: Array<[number, ChatStreamChunk]> = [];
    const off = onChatChunk((sessionId, chunk) =>
      received.push([sessionId, chunk]),
    );

    // sender=undefined：无渲染层的无头发送（被控面 T12 send 桥同款形态）
    await service.send({ sessionId: 1, content: "hi" }, 1, undefined);
    off();

    expect(received).toEqual([
      [1, { type: "text-delta", text: "你" }],
      [1, { type: "text-delta", text: "好" }],
      [1, { type: "finish" }],
    ]);
  });

  it("退订后不再收：后续发送的 chunk 不进已退订订阅者", async () => {
    useScriptedModel(["一"], ["二"]);
    const service = new ChatService(
      makeSessions() as unknown as SessionRepository,
    );
    const received: Array<[number, ChatStreamChunk]> = [];
    const off = onChatChunk((sessionId, chunk) =>
      received.push([sessionId, chunk]),
    );

    await service.send({ sessionId: 1, content: "一" }, 1, undefined);
    const baseline = received.length;
    off();

    await service.send({ sessionId: 1, content: "二" }, 1, undefined);
    expect(received.length).toBe(baseline);
  });

  // T10 复审 deferred 必做：订阅者抛错被 emitChatChunk 隔离——流不死，
  // 正常订阅者照常收齐全部 chunk（send 本身也顺利完成持久化收尾）
  it("订阅者抛错不炸流：抛错订阅者不殃及他人，后续 chunk 继续送达", async () => {
    useScriptedModel(["你", "好"]);
    const service = new ChatService(
      makeSessions() as unknown as SessionRepository,
    );
    const throwingOff = onChatChunk(() => {
      throw new Error("订阅者自身故障");
    });
    const received: ChatStreamChunk[] = [];
    const off = onChatChunk((_sessionId, chunk) => received.push(chunk));

    try {
      // 若异常未被隔离，此处 send 将 reject（流中断、落库不收尾）
      await expect(
        service.send({ sessionId: 1, content: "hi" }, 1, undefined),
      ).resolves.toBeUndefined();
      expect(received).toEqual([
        { type: "text-delta", text: "你" },
        { type: "text-delta", text: "好" },
        { type: "finish" },
      ]);
    } finally {
      throwingOff();
      off();
    }
  });
});
