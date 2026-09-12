import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  // Log 模块顶层读取 app.getPath("userData") 计算日志目录
  app: { getPath: vi.fn(() => "/tmp/tianshu-test-user-data") },
}));

type MessageUpdateArgs = { where: { id: number }; data: { blocks: string } };
type MessageDeleteManyArgs = { where: { id: { in: number[] } } };

// runChatStream 为纯函数；屏蔽 prisma-client 模块初始化对 electron app 路径的依赖。
// prismaStub 供自动标题守卫测试注入 message.findMany 结果（既有 runChatStream 测试不触 prisma 方法）
const prismaStub = {
  messages: [] as Array<{
    id: number;
    sessionId: number;
    role: string;
    blocks: string;
    error: string | null;
  }>,
  sessionTitle: "新会话" as string,
  /** message.update / deleteMany 写通道记录（editAndResend、regenerate 断言参数） */
  messageUpdate: vi.fn<(_: MessageUpdateArgs) => Promise<null>>(
    async () => null,
  ),
  messageDeleteMany: vi.fn<
    (_: MessageDeleteManyArgs) => Promise<{ count: number }>
  >(async () => ({ count: 0 })),
};

// assembleContext 读通道（项目会话 base 注入测试按需覆写返回值）；
// vi.hoisted 使 vi.mock 工厂执行前已初始化
const assembleReads = vi.hoisted(() => ({
  model: { findUnique: vi.fn() },
  provider: { findUnique: vi.fn() },
  assistant: { findUnique: vi.fn() },
}));

vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    message: {
      findMany: async () => prismaStub.messages,
      update: (args: MessageUpdateArgs) => prismaStub.messageUpdate(args),
      deleteMany: (args: MessageDeleteManyArgs) =>
        prismaStub.messageDeleteMany(args),
    },
    ...assembleReads,
  },
}));

// 技能扫描依赖 userData 目录的真实文件系统：固定空清单保证 base 断言确定性
vi.mock("../../electron/domains/ai/agent/skill-loader", () => ({
  loadSkills: () => [],
}));

import { MockLanguageModelV3 } from "ai/test";
import ChatService, {
  runChatStream,
} from "../../electron/domains/ai/chat/chat.service";
import type { SessionRepository } from "../../electron/domains/ai/chat/session.repo";

const userHistory = [
  {
    role: "user" as const,
    blocks: JSON.stringify([{ type: "text", text: "hi" }]),
  },
];

/** 两轮问答（id=3 的 user 为编辑目标，其后仅剩 id=4 的 assistant） */
const fourChatRows = () => [
  {
    id: 1,
    sessionId: 1,
    role: "user",
    blocks: JSON.stringify([{ type: "text", text: "你好" }]),
    error: null,
  },
  {
    id: 2,
    sessionId: 1,
    role: "assistant",
    blocks: JSON.stringify([{ type: "text", text: "你好！有什么可以帮你" }]),
    error: null,
  },
  {
    id: 3,
    sessionId: 1,
    role: "user",
    blocks: JSON.stringify([{ type: "text", text: "再问" }]),
    error: null,
  },
  {
    id: 4,
    sessionId: 1,
    role: "assistant",
    blocks: JSON.stringify([{ type: "text", text: "回答" }]),
    error: null,
  },
];

interface StreamModelOptions {
  error?: Error;
  /** 首个 delta 推送后挂起，直至该信号中止（模拟用户中途停止） */
  holdForAbort?: AbortSignal;
}

/**
 * 构造 mock 模型：按 ai@7 LanguageModelV3 流协议推送 chunk
 * （stream-start → text-start → text-delta(delta) → text-end → finish/error）
 */
function streamModel(chunks: string[], opts: StreamModelOptions = {}) {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t1" });
          for (const [index, delta] of chunks.entries()) {
            controller.enqueue({ type: "text-delta", id: "t1", delta });
            if (opts.holdForAbort && index === 0) {
              await new Promise<void>((resolve) =>
                opts.holdForAbort!.addEventListener("abort", () => resolve(), {
                  once: true,
                }),
              );
              // 中止后剩余内容不再推送；流可能已被消费端取消，静默收尾
              try {
                controller.close();
              } catch {
                /* noop */
              }
              return;
            }
          }
          controller.enqueue({ type: "text-end", id: "t1" });
          if (opts.error) {
            controller.enqueue({ type: "error", error: opts.error });
          } else {
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: {
                inputTokens: {
                  total: 3,
                  noCache: undefined,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 5, text: 5, reasoning: undefined },
              },
            });
          }
          controller.close();
        },
      }),
    }),
  });
}

describe("runChatStream", () => {
  it("累积 text 块并产出 usage 块，chunk 回调顺序推送", async () => {
    const received: string[] = [];
    const result = await runChatStream({
      model: streamModel(["你", "好"]),
      history: userHistory,
      params: {},
      onChunk: (chunk) => {
        if (chunk.type === "text-delta") {
          received.push(chunk.text);
        }
      },
    });
    expect(received).toEqual(["你", "好"]);
    expect(result.blocks).toEqual([
      { type: "text", text: "你好" },
      { type: "usage", input: 3, output: 5 },
    ]);
    expect(result.errorCode).toBeUndefined();
  });

  it("上游错误返回 errorCode 且保留已生成文本", async () => {
    const result = await runChatStream({
      model: streamModel(["部分"], {
        error: Object.assign(new Error("Unauthorized"), { statusCode: 401 }),
      }),
      history: userHistory,
      params: {},
    });
    expect(result.errorCode).toBe("AUTH_FAILED");
    expect(result.errorMessage).toBe("Unauthorized");
    // 错误路径的 finish 无真实 usage，不应产出 usage 块
    expect(result.blocks).toEqual([{ type: "text", text: "部分" }]);
  });

  it("模型流中途抛出等价于错误路径：保留已生成文本并分类", async () => {
    // ReadableStream 中途 error 会让消费端迭代直接抛出（statusCode 保留）；
    // 先让出事件循环一拍，保证已入队 delta 先行送达消费端
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t1" });
            controller.enqueue({ type: "text-delta", id: "t1", delta: "部分" });
            controller.enqueue({ type: "text-end", id: "t1" });
            await new Promise((resolve) => setTimeout(resolve, 10));
            controller.error(
              Object.assign(new Error("Unauthorized"), { statusCode: 401 }),
            );
          },
        }),
      }),
    });
    const result = await runChatStream({
      model,
      history: userHistory,
      params: {},
    });
    expect(result.errorCode).toBe("AUTH_FAILED");
    expect(result.errorMessage).toBe("Unauthorized");
    expect(result.blocks).toEqual([{ type: "text", text: "部分" }]);
  });

  it("用户中止不是错误：无 errorCode，已生成内容保留", async () => {
    // 中途中止：首个 delta 后停止，部分文本照常返回
    const abort = new AbortController();
    const midResult = await runChatStream({
      model: streamModel(["你", "好"], { holdForAbort: abort.signal }),
      history: userHistory,
      params: {},
      abortSignal: abort.signal,
      onChunk: (chunk) => {
        if (chunk.type === "text-delta") {
          abort.abort();
        }
      },
    });
    expect(midResult.errorCode).toBeUndefined();
    expect(midResult.errorMessage).toBeUndefined();
    expect(midResult.blocks).toEqual([{ type: "text", text: "你" }]);

    // 预先中止：直接返回空 blocks，同样无 errorCode
    const preAbort = new AbortController();
    preAbort.abort();
    const preResult = await runChatStream({
      model: streamModel(["你", "好"]),
      history: userHistory,
      params: {},
      abortSignal: preAbort.signal,
    });
    expect(preResult.errorCode).toBeUndefined();
    expect(preResult.blocks).toEqual([]);
  });
});

describe("ChatService 并发防护", () => {
  it("并发 send 在首个 await 前注册：第二次调用立即拒绝，用户消息不重复且失败后无泄漏", async () => {
    const sessions = {
      getSession: vi.fn().mockResolvedValue({ id: 1, assistantId: null }),
      setSessionModel: vi.fn().mockResolvedValue(undefined),
      appendMessage: vi.fn().mockResolvedValue({}),
      autotitleIfDefault: vi.fn().mockResolvedValue(undefined),
      // 返回 null 迫使首个请求在模型解析处失败（不触网、不依赖 prisma）
      getEffectiveModelId: vi.fn().mockResolvedValue(null),
    };
    const service = new ChatService(sessions as unknown as SessionRepository);

    // 未 await：首个请求同步完成注册后才轮到第二次调用
    const first = service.send({ sessionId: 1, content: "hi" });
    await expect(service.send({ sessionId: 1, content: "hi" })).rejects.toThrow(
      "CONCURRENT_REQUEST",
    );

    // 首个请求完整走完只落库一条用户消息，被拒的并发请求未重复落库
    await expect(first).rejects.toThrow("NO_MODEL");
    expect(sessions.appendMessage).toHaveBeenCalledTimes(1);

    // 早期失败已清理注册：后续请求不再报并发错误
    await expect(
      service.send({ sessionId: 1, content: "again" }),
    ).rejects.toThrow("NO_MODEL");
  });
});

describe("ChatService.status（流中切回恢复）", () => {
  it("无进行中流：streaming=false 空内容", () => {
    const svc = new ChatService({} as never);
    expect(svc.status(99)).toEqual({
      streaming: false,
      accessMode: "default",
      text: "",
      thinking: "",
      tools: { order: [], map: {} },
    });
  });

  it("有进行中流：返回累积快照", () => {
    const svc = new ChatService({} as never);
    const internal = svc as unknown as {
      aborts: Map<number, AbortController>;
      snapshots: Map<
        number,
        { text: string; thinking: string; tools: unknown }
      >;
    };
    internal.aborts.set(7, new AbortController());
    internal.snapshots.set(7, {
      text: "半截",
      thinking: "",
      tools: { order: [], map: {} },
    });
    expect(svc.status(7)).toEqual({
      streaming: true,
      accessMode: "default",
      text: "半截",
      thinking: "",
      tools: { order: [], map: {} },
    });
  });

  it("流结束后 finally 清理注册与快照：status 恢复空闲态", () => {
    const svc = new ChatService({} as never);
    const internal = svc as unknown as {
      aborts: Map<number, AbortController>;
      snapshots: Map<
        number,
        { text: string; thinking: string; tools: unknown }
      >;
    };
    internal.aborts.set(7, new AbortController());
    internal.snapshots.set(7, {
      text: "半截",
      thinking: "",
      tools: { order: [], map: {} },
    });
    // 模拟 streamAndPersist 的 finally：删除注册与快照
    internal.aborts.delete(7);
    internal.snapshots.delete(7);
    expect(svc.status(7)).toEqual({
      streaming: false,
      accessMode: "default",
      text: "",
      thinking: "",
      tools: { order: [], map: {} },
    });
  });
});

describe("AI 自动标题守卫（generateTitleIfFirstExchange）", () => {
  const makeSvc = (sessions: Record<string, unknown>) =>
    new ChatService(sessions as never);

  const ctx = {
    type: "openai-compatible",
    baseUrl: "https://x.example/v1",
    apiKey: "k",
    modelId: "m",
  };

  /** 恰好一轮问答（user 文本 "你好"，autotitle 截断态即 "你好"） */
  const twoMessages = () => [
    {
      id: 1,
      sessionId: 1,
      role: "user",
      blocks: JSON.stringify([{ type: "text", text: "你好" }]),
      error: null,
    },
    {
      id: 2,
      sessionId: 1,
      role: "assistant",
      blocks: JSON.stringify([{ type: "text", text: "你好！有什么可以帮你" }]),
      error: null,
    },
  ];

  /** 注入标题模型（可断言调用情况）并执行守卫 */
  const runGuard = async (
    svc: ChatService,
    titleModel: () => Promise<string>,
  ) => {
    (svc as unknown as { titleModelText: unknown }).titleModelText = titleModel;
    await (
      svc as unknown as {
        generateTitleIfFirstExchange: (
          sessionId: number,
          sender: undefined,
          ctx2: unknown,
        ) => Promise<void>;
      }
    ).generateTitleIfFirstExchange(1, undefined, ctx);
  };

  it("默认标题（新会话）→ 调用 renameSession", async () => {
    prismaStub.messages = twoMessages();
    prismaStub.sessionTitle = "新会话";
    const renamed: string[] = [];
    const svc = makeSvc({
      getSession: async () => ({ id: 1, title: prismaStub.sessionTitle }),
      renameSession: async (_id: number, title: string) => {
        renamed.push(title);
      },
    });
    // 注入假模型：直接测守卫与 rename 调用；标题文本固定
    await runGuard(svc, async () => "  今天的天气  ");
    expect(renamed).toEqual(["今天的天气"]);
  });

  it("P0 autotitle 截断态（title=首条消息前 20 字）→ 仍调用 renameSession", async () => {
    prismaStub.messages = twoMessages();
    const renamed: string[] = [];
    const svc = makeSvc({
      getSession: async () => ({ id: 1, title: "你好" }),
      renameSession: async (_id: number, title: string) => {
        renamed.push(title);
      },
    });
    await runGuard(svc, async () => "  今天的天气  ");
    expect(renamed).toEqual(["今天的天气"]);
  });

  it("手动改名过的会话（两个哨兵均不匹配）→ 不触发且不调模型", async () => {
    prismaStub.messages = twoMessages();
    const renamed: string[] = [];
    const svc = makeSvc({
      getSession: async () => ({ id: 1, title: "我的会话" }),
      renameSession: async (_id: number, title: string) => {
        renamed.push(title);
      },
    });
    const titleModel = vi.fn(async () => {
      throw new Error("标题模型不应被调用");
    });
    await runGuard(svc, titleModel);
    expect(renamed).toEqual([]);
    expect(titleModel).not.toHaveBeenCalled();
  });

  it("标题模型返回空白 → 不起名", async () => {
    prismaStub.messages = twoMessages();
    const renamed: string[] = [];
    const svc = makeSvc({
      getSession: async () => ({ id: 1, title: "你好" }),
      renameSession: async (_id: number, title: string) => {
        renamed.push(title);
      },
    });
    await runGuard(svc, async () => "   ");
    expect(renamed).toEqual([]);
  });

  it("多轮消息（3 条）不触发且不调模型", async () => {
    prismaStub.messages = [
      ...twoMessages(),
      {
        id: 3,
        sessionId: 1,
        role: "user",
        blocks: JSON.stringify([{ type: "text", text: "再问" }]),
        error: null,
      },
    ];
    const renamed: string[] = [];
    const svc = makeSvc({
      getSession: async () => ({ id: 1, title: "新会话" }),
      renameSession: async (_id: number, title: string) => {
        renamed.push(title);
      },
    });
    // 若守卫长度检查失效而走到模型调用，此 stub 显式抛错（响亮失败）
    const titleModel = vi.fn(async () => {
      throw new Error("标题模型不应被调用");
    });
    await runGuard(svc, titleModel);
    expect(renamed).toEqual([]);
    expect(titleModel).not.toHaveBeenCalled();
  });
});

/** 截断写通道断言前重置共享 prisma stub 的调用记录 */
const clearWriteCalls = () => {
  prismaStub.messageUpdate.mockClear();
  prismaStub.messageDeleteMany.mockClear();
};

/**
 * 组装 sessions stub + ChatService（editAndResend / regenerate 共用）：
 * getEffectiveModelId 返回 null 使截断后在模型解析处失败（不触网、不依赖
 * 更多 prisma 通道）；sessionOverrides 覆盖 getSession 返回值（如压缩点）
 */
const makeService = (sessionOverrides: Record<string, unknown> = {}) => {
  const sessions = {
    getSession: vi.fn().mockResolvedValue({
      id: 1,
      assistantId: null,
      compactedUpToId: null,
      ...sessionOverrides,
    }),
    getEffectiveModelId: vi.fn().mockResolvedValue(null),
    updateSummary: vi.fn().mockResolvedValue(undefined),
  };
  return {
    sessions,
    service: new ChatService(sessions as unknown as SessionRepository),
  };
};

describe("ChatService.editAndResend（编辑重发）", () => {
  const abortsOf = (service: ChatService) =>
    (service as unknown as { aborts: Map<number, AbortController> }).aborts;

  beforeEach(clearWriteCalls);

  it("改写目标 user 消息内容并删除其后尾部，失败后清理并发注册", async () => {
    prismaStub.messages = fourChatRows();
    const { service } = makeService();
    await expect(service.editAndResend(1, 3, "改后的内容")).rejects.toThrow(
      "NO_MODEL",
    );
    // 仅改写 blocks：断言完整入参即证明 createdAt 等其余字段未被触碰
    expect(prismaStub.messageUpdate).toHaveBeenCalledWith({
      where: { id: 3 },
      data: {
        blocks: JSON.stringify([{ type: "text", text: "改后的内容" }]),
      },
    });
    expect(prismaStub.messageDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: [4] } },
    });
    expect(abortsOf(service).has(1)).toBe(false);
  });

  it("目标是 assistant（非 user）→ MESSAGE_NOT_FOUND，不触写通道", async () => {
    prismaStub.messages = fourChatRows();
    const { service } = makeService();
    await expect(service.editAndResend(1, 2, "改")).rejects.toThrow(
      "MESSAGE_NOT_FOUND",
    );
    expect(prismaStub.messageUpdate).not.toHaveBeenCalled();
    expect(prismaStub.messageDeleteMany).not.toHaveBeenCalled();
    expect(abortsOf(service).has(1)).toBe(false);
  });

  it("消息不存在 → MESSAGE_NOT_FOUND，不触写通道", async () => {
    prismaStub.messages = fourChatRows();
    const { service } = makeService();
    await expect(service.editAndResend(1, 99, "改")).rejects.toThrow(
      "MESSAGE_NOT_FOUND",
    );
    expect(prismaStub.messageUpdate).not.toHaveBeenCalled();
    expect(prismaStub.messageDeleteMany).not.toHaveBeenCalled();
    expect(abortsOf(service).has(1)).toBe(false);
  });

  it("并发（该会话已有进行中流）→ CONCURRENT_REQUEST，且不覆盖既有注册", async () => {
    prismaStub.messages = fourChatRows();
    const { service } = makeService();
    const existing = new AbortController();
    abortsOf(service).set(1, existing);
    await expect(service.editAndResend(1, 3, "改")).rejects.toThrow(
      "CONCURRENT_REQUEST",
    );
    expect(abortsOf(service).get(1)).toBe(existing);
    expect(prismaStub.messageUpdate).not.toHaveBeenCalled();
    expect(prismaStub.messageDeleteMany).not.toHaveBeenCalled();
  });

  it("压缩点在被删尾部 → 摘要失效清空", async () => {
    prismaStub.messages = fourChatRows();
    const { sessions, service } = makeService({ compactedUpToId: 4 });
    await expect(service.editAndResend(1, 3, "改")).rejects.toThrow("NO_MODEL");
    expect(sessions.updateSummary).toHaveBeenCalledWith(1, null, null);
  });

  it("压缩点在保留区 → 摘要保留", async () => {
    prismaStub.messages = fourChatRows();
    const { sessions, service } = makeService({ compactedUpToId: 2 });
    await expect(service.editAndResend(1, 3, "改")).rejects.toThrow("NO_MODEL");
    expect(sessions.updateSummary).not.toHaveBeenCalled();
  });
});

describe("ChatService.regenerate（截断抽取后行为不变）", () => {
  beforeEach(clearWriteCalls);

  it("删除目标 assistant 前最后一条 user 之后全部尾部并重跑流", async () => {
    prismaStub.messages = fourChatRows();
    const { service } = makeService();
    // 目标 id=2（assistant），其前最后一条 user 为 id=1 → 删 [2,3,4]
    await expect(service.regenerate(1, 2)).rejects.toThrow("NO_MODEL");
    expect(prismaStub.messageDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: [2, 3, 4] } },
    });
    expect(prismaStub.messageUpdate).not.toHaveBeenCalled();
  });

  it("目标消息不存在或非 assistant → MESSAGE_NOT_FOUND", async () => {
    prismaStub.messages = fourChatRows();
    const { service } = makeService();
    await expect(service.regenerate(1, 99)).rejects.toThrow(
      "MESSAGE_NOT_FOUND",
    );
    // id=3 是 user 而非 assistant，同样拒绝
    await expect(service.regenerate(1, 3)).rejects.toThrow("MESSAGE_NOT_FOUND");
    expect(prismaStub.messageDeleteMany).not.toHaveBeenCalled();
  });
});

/**
 * assembleContext 项目会话 base 注入（项目模块一期 spec §5）：
 * 项目会话 base = 项目指令 + 挂载专家 prompt + 能力软约束声明；
 * 非项目会话 / 项目上下文为空 / repo 缺席 → 回退助手 prompt（行为不变）。
 * 直接调私有 assembleContext 断言 systemWithSummary（本文件既有内部访问模式）。
 */
describe("ChatService.assembleContext（项目会话 base 注入）", () => {
  const modelRow = {
    id: 1,
    providerId: 2,
    modelId: "m",
    temperature: null,
    topP: null,
    maxTokens: null,
    contextWindow: null,
  };
  const providerRow = {
    id: 2,
    type: "openai-compatible",
    baseUrl: "https://x.example/v1",
    apiKey: "k",
    extraHeaders: null,
  };

  const makeProjectSvc = (
    sessionOverrides: Record<string, unknown>,
    getPromptContext: () => Promise<unknown>,
  ) => {
    const sessions = {
      getSession: vi.fn().mockResolvedValue({
        id: 1,
        assistantId: 1,
        workspaceId: 1,
        mode: null,
        compactedUpToId: null,
        summary: null,
        projectId: null,
        ...sessionOverrides,
      }),
      getEffectiveModelId: vi.fn().mockResolvedValue(1),
      getWorkspace: vi.fn().mockResolvedValue(null),
    };
    const projectRepo = { getPromptContext: vi.fn(getPromptContext) };
    const service = new ChatService(
      sessions as unknown as SessionRepository,
      undefined,
      projectRepo as never,
    );
    return { projectRepo, service };
  };

  const assemble = (service: ChatService) =>
    (
      service as unknown as {
        assembleContext: (
          sessionId: number,
        ) => Promise<{ systemWithSummary: string | undefined }>;
      }
    ).assembleContext(1);

  beforeEach(() => {
    vi.clearAllMocks();
    assembleReads.model.findUnique.mockResolvedValue(modelRow);
    assembleReads.provider.findUnique.mockResolvedValue(providerRow);
    assembleReads.assistant.findUnique.mockResolvedValue({
      id: 1,
      systemPrompt: "助手指令",
      temperature: null,
      topP: null,
      maxTokens: null,
    });
  });

  it("项目会话：base 换为项目指令+挂载专家+能力软约束声明", async () => {
    const { service } = makeProjectSvc({ projectId: 11 }, async () => ({
      projectName: "p",
      systemPrompt: "项目指令",
      boundAssistantPrompts: ["专家A", "专家B"],
      boundSkillNames: ["技能1"],
      boundConnectorNames: ["连接器1"],
    }));
    const ctx = await assemble(service);
    expect(ctx.systemWithSummary).toBe(
      "项目指令\n\n专家A\n\n专家B\n\n【本项目可用能力】\n技能：技能1\n连接器：连接器1\n本项目对话中请优先（且仅）使用以上已挂载能力。",
    );
  });

  it("非项目会话：不查项目上下文，base 仍为助手 prompt", async () => {
    const { projectRepo, service } = makeProjectSvc({}, async () => null);
    const ctx = await assemble(service);
    expect(ctx.systemWithSummary).toBe("助手指令");
    expect(projectRepo.getPromptContext).not.toHaveBeenCalled();
  });

  it("项目上下文为空（无指令无专家）→ 回退助手 prompt", async () => {
    const { service } = makeProjectSvc({ projectId: 11 }, async () => ({
      projectName: "p",
      systemPrompt: null,
      boundAssistantPrompts: [],
      boundSkillNames: [],
      boundConnectorNames: [],
    }));
    const ctx = await assemble(service);
    expect(ctx.systemWithSummary).toBe("助手指令");
  });

  it("项目 repo 缺席（测试/降级）→ 项目会话回退助手 prompt", async () => {
    const sessions = {
      getSession: vi.fn().mockResolvedValue({
        id: 1,
        assistantId: 1,
        workspaceId: 1,
        mode: null,
        compactedUpToId: null,
        summary: null,
        projectId: 11,
      }),
      getEffectiveModelId: vi.fn().mockResolvedValue(1),
      getWorkspace: vi.fn().mockResolvedValue(null),
    };
    const service = new ChatService(sessions as unknown as SessionRepository);
    const ctx = await assemble(service);
    expect(ctx.systemWithSummary).toBe("助手指令");
  });
});
