import {
  afterAll,
  afterEach,
  beforeAll,
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
    // 拼 process.pid（library-files/library-repo 同款）：与并行测试
    // worker / 多会话并发实例隔离，固定路径互踩是历史 flaky 根因
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
}));

type MessageUpdateArgs = { where: { id: number }; data: { blocks: string } };
type MessageDeleteManyArgs = { where: { id: { in: number[] } } };
type MessageFindManyArgs = {
  where?: {
    sessionId?: number;
    role?: string | { not?: string };
    error?: null;
  };
  /** prisma 语义：orderBy 为顶层字段（兼容旧形态 where.orderBy） */
  orderBy?: { createdAt?: "asc" | "desc" };
  take?: number;
  select?: { blocks?: boolean };
};

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
  /**
   * message.findMany 读通道：模拟 prisma 查询语义（where 过滤 / orderBy /
   * take / select 投影），守卫测试断言查询参数用；无参形态退化为全量返回。
   * orderBy 为 args 顶层字段（prisma 语义）；role 支持等值与 { not } 形态
   * （compact 摘要回填按 role=assistant 倒序取末条）
   */
  messageFindMany: vi.fn<(args?: MessageFindManyArgs) => Promise<unknown>>(
    async (args) => {
      const where = args?.where ?? {};
      const matched = prismaStub.messages
        .filter(
          (row) =>
            (where.sessionId === undefined ||
              row.sessionId === where.sessionId) &&
            (typeof where.role === "string"
              ? row.role === where.role
              : !where.role?.not || row.role !== where.role.not) &&
            (!("error" in where) || row.error === where.error),
        )
        // id 自增与 createdAt 同向，以 id 代理排序（orderBy 为 args 顶层，
        // 兼容旧形态嵌在 where 内的调用）
        .sort((a, b) =>
          (args?.orderBy?.createdAt ?? where.orderBy?.createdAt) === "desc"
            ? b.id - a.id
            : a.id - b.id,
        );
      const rows = args?.take ? matched.slice(0, args.take) : matched;
      // select 投影保留全部请求列（如 assembleContext 取 role/blocks/error/createdAt）
      return args?.select
        ? rows.map((row) =>
            Object.fromEntries(
              Object.keys(args.select as Record<string, boolean>).map((key) => [
                key,
                (row as unknown as Record<string, unknown>)[key],
              ]),
            ),
          )
        : rows;
    },
  ),
  sessionTitle: "新会话" as string,
  /** message.update / deleteMany 写通道记录（editAndResend、regenerate 断言参数） */
  messageUpdate: vi.fn<(_: MessageUpdateArgs) => Promise<null>>(
    async () => null,
  ),
  messageDeleteMany: vi.fn<
    (_: MessageDeleteManyArgs) => Promise<{ count: number }>
  >(async () => ({ count: 0 })),
  /** SP6 系统授权卡：toolPermission 表读写通道（listRemembered / revoke* 断言用） */
  toolPermissions: [] as Array<{
    id: number;
    workspaceId: number;
    toolName: string;
    createdAt: Date;
  }>,
  /** 本人工作空间 id 集（v12 listRemembered/revoke* 先经 ownedWorkspaceIds 收敛） */
  ownedWorkspaceIds: [5, 6],
  toolPermissionFindMany: vi.fn(async () => prismaStub.toolPermissions),
  toolPermissionFindUnique: vi.fn(
    async ({ where: { id } }: { where: { id: number } }) =>
      prismaStub.toolPermissions.find((row) => row.id === id) ?? null,
  ),
  /** v12 revokeRemembered 走 findFirst（含 workspaceId in 本人空间过滤） */
  toolPermissionFindFirst: vi.fn(
    async ({
      where,
    }: {
      where: { id: number; workspaceId?: { in: number[] } };
    }) =>
      prismaStub.toolPermissions.find(
        (row) =>
          row.id === where.id &&
          (!where.workspaceId ||
            where.workspaceId.in.includes(row.workspaceId)),
      ) ?? null,
  ),
  toolPermissionDelete: vi.fn(async () => null),
  toolPermissionDeleteMany: vi.fn(async () => ({
    count: prismaStub.toolPermissions.length,
  })),
  workspaceFindMany: vi.fn(async () =>
    prismaStub.ownedWorkspaceIds.map((id) => ({ id })),
  ),
  /** 批 12 转办摘要：启用模型候选集（handover-summary 消费） */
  modelFindMany: vi.fn(async () => [] as unknown[]),
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
      findMany: (args?: MessageFindManyArgs) =>
        prismaStub.messageFindMany(args),
      update: (args: MessageUpdateArgs) => prismaStub.messageUpdate(args),
      deleteMany: (args: MessageDeleteManyArgs) =>
        prismaStub.messageDeleteMany(args),
    },
    toolPermission: {
      findMany: (args?: unknown) => prismaStub.toolPermissionFindMany(args),
      findUnique: (args: { where: { id: number } }) =>
        prismaStub.toolPermissionFindUnique(args),
      findFirst: (args?: unknown) => prismaStub.toolPermissionFindFirst(args),
      delete: (args: { where: { id: number } }) =>
        prismaStub.toolPermissionDelete(args),
      deleteMany: (args?: unknown) => prismaStub.toolPermissionDeleteMany(args),
    },
    workspace: {
      findMany: (args?: unknown) => prismaStub.workspaceFindMany(args),
    },
    ...assembleReads,
    model: {
      findUnique: assembleReads.model.findUnique,
      // 批 12 转办摘要：启用模型候选集（handover-summary 消费）
      findMany: (args?: unknown) => prismaStub.modelFindMany(args),
    },
  },
}));

// 技能扫描依赖 userData 目录的真实文件系统：默认空清单保证 base 断言确定性；
// 工具硬隔离测试按需覆写 skillScanStub.skills（默认空，既有断言不受影响）
const skillScanStub = vi.hoisted(() => ({
  skills: [] as Array<{
    name: string;
    description: string;
    dir: string;
    bodyPath: string;
    source: "user" | "workspace";
  }>,
}));
vi.mock("../../electron/domains/ai/agent/skill-loader", () => ({
  loadSkills: () => skillScanStub.skills,
}));

// M7 超时防护（T3-3 换栈后）：titleModelText 经 createChatModel 构造后
// invoke，mock 工厂换 langchain-model-factory——invoke 替身供参数断言
const invokeStub = vi.hoisted(() => vi.fn(async () => ({ content: "标题" })));
vi.mock(
  "../../electron/domains/ai/orchestration/langchain-model-factory",
  () => ({
    createChatModel: vi.fn(() => ({ invoke: invokeStub })),
  }),
);

import ChatService, {
  AUTO_COMPACT_DIRECTIVE,
  COMPACT_DIRECTIVE,
  runChatStream,
} from "../../electron/domains/ai/chat/chat.service";
import { createChatModel } from "../../electron/domains/ai/orchestration/langchain-model-factory";
import { ToolMessage } from "@langchain/core/messages";
import { fileURLToPath } from "node:url";
import { scriptedChatModel } from "./helpers/scripted-chat-model";
import type { SessionRepository } from "../../electron/domains/ai/chat/session.repo";
import {
  registerTools,
  unregisterTools,
} from "../../electron/domains/ai/agent/tool-registry";
import type { ToolDefinition } from "../../electron/domains/ai/agent/file-tools";
import type { ToolGroupGate } from "../../electron/domains/ai/agent/tool-groups";
import { ipcMain } from "electron";
import { generateUserToken } from "../../electron/commons/ipc-user";
import { PermissionStore } from "../../electron/domains/ai/agent/permission-mode";
import type { SecurityEvent } from "../../src-react/domains/security/model/types";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { appDataHome } from "../../electron/commons/paths";

/** handleUser 通道直调用 token（v12 起工具记忆 IPC 按用户过滤，userId=1） */
const TOKEN = generateUserToken({ id: 1, username: "tester" });

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
 * 构造 mock 模型（T3-3 换 LangChain 替身，脚本语义不变）：
 * chunks 逐段推送（text 增量）；holdForAbort 首段后挂起至中止；
 * error 时全部推送完后抛出（statusCode 等字段原样保留）
 */
function streamModel(chunks: string[], opts: StreamModelOptions = {}) {
  const { model } = scriptedChatModel([
    {
      steps: chunks.map((delta) => ({ kind: "text" as const, delta })),
      usage: opts.error ? undefined : { input: 3, output: 5 },
      holdForAbort: opts.holdForAbort,
      error: opts.error,
    },
  ]);
  return model;
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
    // 本脚本 error 步显式置 usage: undefined，故不产 usage 块；带累计
    // usage 的错误路径会产块（见 agent-chunk-emitter E3 用例）
    expect(result.blocks).toEqual([{ type: "text", text: "部分" }]);
  });

  it("模型流中途抛出等价于错误路径：保留已生成文本并分类", async () => {
    // 替身推送"部分"后抛 401（statusCode 经 streamEvents 表面保留，
    // T3-3 探针实证）；已送达 delta 先行进入事件流，错误随后终绝迭代
    const result = await runChatStream({
      model: streamModel(["部分"], {
        error: Object.assign(new Error("Unauthorized"), { statusCode: 401 }),
      }),
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

  it("旧轮超限工具输出回喂瘦身：模型收到截断标注，入参 history 原文不动", async () => {
    // spec §18 项 1：旧轮 read_file 输出 8000 字符超 6000 阈值 → 头 3000 +
    // 截断标注 + 尾 1000；最近 2 个工具轮（含超限的末轮）整条豁免
    const longOutput = "H".repeat(3000) + "M".repeat(4000) + "T".repeat(1000);
    const recentLongOutput = "R".repeat(8000);
    const history = [
      // 第 3 工具轮（从尾数）→ 截断
      {
        role: "assistant" as const,
        blocks: JSON.stringify([
          {
            type: "tool_call",
            toolCallId: "old-1",
            toolName: "read_file",
            args: {},
            state: "done",
            output: longOutput,
          },
        ]),
      },
      {
        role: "user" as const,
        blocks: JSON.stringify([{ type: "text", text: "继续" }]),
      },
      // 第 2 工具轮 → 整条豁免
      {
        role: "assistant" as const,
        blocks: JSON.stringify([
          {
            type: "tool_call",
            toolCallId: "mid-1",
            toolName: "read_file",
            args: {},
            state: "done",
            output: "ok-1",
          },
        ]),
      },
      {
        role: "user" as const,
        blocks: JSON.stringify([{ type: "text", text: "再看" }]),
      },
      // 最近工具轮：虽超限也整条豁免
      {
        role: "assistant" as const,
        blocks: JSON.stringify([
          {
            type: "tool_call",
            toolCallId: "new-1",
            toolName: "read_file",
            args: {},
            state: "done",
            output: recentLongOutput,
          },
        ]),
      },
      {
        role: "user" as const,
        blocks: JSON.stringify([{ type: "text", text: "总结" }]),
      },
    ];
    const { model } = scriptedChatModel([
      {
        steps: [{ kind: "text", delta: "好" }],
        usage: { input: 3, output: 5 },
      },
    ]);
    await runChatStream({ model, history, params: {} });
    const toolContents = model.seenInputs[0]
      .filter((m): m is ToolMessage => m instanceof ToolMessage)
      .map((m) => String(m.content));
    expect(toolContents).toHaveLength(3);
    expect(toolContents[0]).toContain("[已截断 4000 字符]");
    expect(toolContents[0].startsWith("HHHH")).toBe(true);
    expect(toolContents[0].endsWith("TTTT")).toBe(true);
    expect(toolContents[0]).not.toContain("MMMM");
    expect(toolContents[1]).toBe("ok-1");
    // 最近轮超限输出整条回喂，无截断标注
    expect(toolContents[2]).toBe(recentLongOutput);
    expect(toolContents[2]).not.toContain("已截断");
    // 入参 history JSON 原文不动（DB blocks/编辑重发/回看不受影响）
    expect(JSON.parse(history[0].blocks)[0].output).toBe(longOutput);
    expect(JSON.parse(history[4].blocks)[0].output).toBe(recentLongOutput);
  });
});

describe("ChatService 并发防护", () => {
  it("并发 send 在首个 await 前注册：第二次调用立即拒绝，用户消息不重复且失败后无泄漏", async () => {
    const sessions = {
      getSession: vi
        .fn()
        .mockResolvedValue({ id: 1, assistantId: null, userId: 1 }),
      setSessionModel: vi.fn().mockResolvedValue(undefined),
      appendMessage: vi.fn().mockResolvedValue({}),
      autotitleIfDefault: vi.fn().mockResolvedValue(undefined),
      // 返回 null 迫使首个请求在模型解析处失败（不触网、不依赖 prisma）
      getEffectiveModelId: vi.fn().mockResolvedValue(null),
    };
    const service = new ChatService(sessions as unknown as SessionRepository);

    // 未 await：首个请求同步完成注册后才轮到第二次调用
    const first = service.send({ sessionId: 1, content: "hi" }, 1);
    await expect(
      service.send({ sessionId: 1, content: "hi" }, 1),
    ).rejects.toThrow("CONCURRENT_REQUEST");

    // 首个请求完整走完只落库一条用户消息，被拒的并发请求未重复落库
    await expect(first).rejects.toThrow("NO_MODEL");
    expect(sessions.appendMessage).toHaveBeenCalledTimes(1);

    // 早期失败已清理注册：后续请求不再报并发错误
    await expect(
      service.send({ sessionId: 1, content: "again" }, 1),
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

  it("标题模型调用带 abortSignal（M7：非流式补全半开连接不得永久挂起）", async () => {
    invokeStub.mockClear();
    const svc = makeSvc({});
    const title = await svc.titleModelText({
      type: "openai-compatible",
      baseUrl: "https://x.example/v1",
      apiKey: "k",
      modelId: "m",
      userText: "u",
      assistantText: "a",
    });
    expect(title).toBe("标题");
    const invokeArgs = invokeStub.mock.calls.at(-1)?.[1];
    expect(invokeArgs?.signal).toBeInstanceOf(AbortSignal);
  });

  it("首轮判定查询下推限量：role/error 过滤进 where、take 3、只取 blocks 列", async () => {
    prismaStub.messages = twoMessages();
    prismaStub.messageFindMany.mockClear();
    const svc = makeSvc({
      getSession: async () => ({ id: 1, title: "新会话" }),
      renameSession: async () => undefined,
    });
    await runGuard(svc, async () => "标题");
    const args = prismaStub.messageFindMany.mock.calls[0]?.[0];
    // 每次发送都触发该守卫：查询必须下推限量，禁止整会话 blocks 全量读回
    expect(args?.take).toBe(3);
    expect(args?.where).toMatchObject({
      sessionId: 1,
      role: { not: "system" },
      error: null,
    });
    expect(args?.select).toEqual({ blocks: true });
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
      // v12 隔离：getSession 返回行携带 userId（send/editAndResend 归属比对）
      userId: 1,
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
    await expect(service.editAndResend(1, 1, 3, "改后的内容")).rejects.toThrow(
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
    await expect(service.editAndResend(1, 1, 2, "改")).rejects.toThrow(
      "MESSAGE_NOT_FOUND",
    );
    expect(prismaStub.messageUpdate).not.toHaveBeenCalled();
    expect(prismaStub.messageDeleteMany).not.toHaveBeenCalled();
    expect(abortsOf(service).has(1)).toBe(false);
  });

  it("目标带 image 块：编辑只换 text 块，image 块随行保留", async () => {
    // send 落库结构（[text, ...images]）的编辑目标：多模态图片不因重发丢失
    const imageBlock = {
      type: "image",
      imagePath: "attachments/a1b2.png",
      mime: "image/png",
      name: "截图.png",
    };
    prismaStub.messages = fourChatRows().map((row) =>
      row.id === 3
        ? {
            ...row,
            blocks: JSON.stringify([
              { type: "text", text: "再问" },
              imageBlock,
            ]),
          }
        : row,
    );
    const { service } = makeService();
    await expect(service.editAndResend(1, 1, 3, "改后的内容")).rejects.toThrow(
      "NO_MODEL",
    );
    expect(prismaStub.messageUpdate).toHaveBeenCalledWith({
      where: { id: 3 },
      data: {
        blocks: JSON.stringify([
          { type: "text", text: "改后的内容" },
          imageBlock,
        ]),
      },
    });
  });

  it("消息不存在 → MESSAGE_NOT_FOUND，不触写通道", async () => {
    prismaStub.messages = fourChatRows();
    const { service } = makeService();
    await expect(service.editAndResend(1, 1, 99, "改")).rejects.toThrow(
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
    await expect(service.editAndResend(1, 1, 3, "改")).rejects.toThrow(
      "CONCURRENT_REQUEST",
    );
    expect(abortsOf(service).get(1)).toBe(existing);
    expect(prismaStub.messageUpdate).not.toHaveBeenCalled();
    expect(prismaStub.messageDeleteMany).not.toHaveBeenCalled();
  });

  it("压缩点在被删尾部 → 摘要失效清空", async () => {
    prismaStub.messages = fourChatRows();
    const { sessions, service } = makeService({ compactedUpToId: 4 });
    await expect(service.editAndResend(1, 1, 3, "改")).rejects.toThrow(
      "NO_MODEL",
    );
    expect(sessions.updateSummary).toHaveBeenCalledWith(1, null, null);
  });

  it("压缩点在保留区 → 摘要保留", async () => {
    prismaStub.messages = fourChatRows();
    const { sessions, service } = makeService({ compactedUpToId: 2 });
    await expect(service.editAndResend(1, 1, 3, "改")).rejects.toThrow(
      "NO_MODEL",
    );
    expect(sessions.updateSummary).not.toHaveBeenCalled();
  });
});

describe("ChatService.regenerate（截断抽取后行为不变）", () => {
  beforeEach(clearWriteCalls);

  it("删除目标 assistant 前最后一条 user 之后全部尾部并重跑流", async () => {
    prismaStub.messages = fourChatRows();
    const { service } = makeService();
    // 目标 id=2（assistant），其前最后一条 user 为 id=1 → 删 [2,3,4]
    await expect(service.regenerate(1, 1, 2)).rejects.toThrow("NO_MODEL");
    expect(prismaStub.messageDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: [2, 3, 4] } },
    });
    expect(prismaStub.messageUpdate).not.toHaveBeenCalled();
  });

  it("目标消息不存在或非 assistant → MESSAGE_NOT_FOUND", async () => {
    prismaStub.messages = fourChatRows();
    const { service } = makeService();
    await expect(service.regenerate(1, 1, 99)).rejects.toThrow(
      "MESSAGE_NOT_FOUND",
    );
    // id=3 是 user 而非 assistant，同样拒绝
    await expect(service.regenerate(1, 1, 3)).rejects.toThrow(
      "MESSAGE_NOT_FOUND",
    );
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
        assembleContext: (sessionId: number) => Promise<{
          systemWithSummary: string | undefined;
          history: Array<{ role: string; blocks: string }>;
        }>;
      }
    ).assembleContext(1);

  beforeEach(() => {
    vi.clearAllMocks();
    // 时间注入用例按需覆写，清空防泄漏到同 describe 其他用例
    prismaStub.messages = [];
    assembleReads.model.findUnique.mockResolvedValue(modelRow);
    assembleReads.provider.findUnique.mockResolvedValue(providerRow);
    assembleReads.assistant.findUnique.mockResolvedValue({
      id: 1,
      systemPrompt: "助手指令",
      temperature: null,
      topP: null,
      maxTokens: null,
    });
    skillScanStub.skills = [];
  });

  it("项目会话：base = 项目指令+挂载专家(预设)+会话所选助手+预设能力声明", async () => {
    // 二期 §3.7 修正：挂载集是预设——会话所选助手 prompt 叠加生效
    //（会话中切换专家即时可用），声明段为软约束引导（不再「且仅」）
    skillScanStub.skills = [
      {
        name: "技能1",
        description: "挂载技能",
        dir: "/skills/技能1",
        bodyPath: "/skills/技能1/SKILL.md",
        source: "user",
      },
    ];
    const { service } = makeProjectSvc({ projectId: 11 }, async () => ({
      projectName: "p",
      systemPrompt: "项目指令",
      boundAssistantPrompts: ["专家A", "专家B"],
      boundSkillNames: ["技能1"],
      boundConnectorNames: ["连接器1"],
    }));
    const ctx = await assemble(service);
    // base（项目指令+预设专家+会话助手+声明）之后按 P2 组装规则追加技能清单段
    expect(ctx.systemWithSummary).toBe(
      "项目指令\n\n专家A\n\n专家B\n\n助手指令\n\n【项目预设能力】\n技能：技能1\n连接器：连接器1\n以上为本项目预设能力，对话中请优先使用；用户要求使用预设外的技能或连接器时，可按需直接调用。" +
        "\n\n你可以使用以下技能（调用 read_skill 工具并传入技能名可获取完整使用指引；指引中引用的技能包内文件（如 references/jira.md）以 path 参数读取）：" +
        "\n- 技能1: 挂载技能",
    );
  });

  it("非项目会话：不查项目上下文，base 仍为助手 prompt；时间行注入最后一条 user", async () => {
    // 时间注入断言（time-context）：system 不动，最后一条 user 消息
    // blocks 头部插「当前时间：」block（前缀缓存考量见 time-context 注释）
    prismaStub.messages = [
      {
        id: 1,
        sessionId: 1,
        role: "user",
        blocks: JSON.stringify([{ type: "text", text: "hi" }]),
        error: null,
      },
      {
        id: 2,
        sessionId: 1,
        role: "assistant",
        blocks: "[]",
        error: null,
      },
    ];
    const { projectRepo, service } = makeProjectSvc({}, async () => null);
    const ctx = await assemble(service);
    expect(ctx.systemWithSummary).toBe("助手指令");
    expect(projectRepo.getPromptContext).not.toHaveBeenCalled();
    const injected = JSON.parse(ctx.history[0].blocks);
    expect(injected[0].text).toMatch(/^当前时间：\d{4}-\d{2}-\d{2} /);
    expect(injected[1]).toEqual({ type: "text", text: "hi" });
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

/**
 * 项目会话能力预设（项目模块二期 §3.7 修正：预设≠围墙）：
 * 项目会话（ask 外）工具集不做挂载硬过滤——mcp__ 全量注入、read_skill
 * 收全量启用集（预设外技能会话中按需可读）；技能清单仍按挂载集收窄
 *（system 预设聚焦）；plan_* 项目专属工具仅项目会话注入；
 * 非项目会话全量但滤 plan_*（回归锚点）。
 * registry 为模块级真实现：注册两个伪 mcp 工具断言过滤，收尾清理防泄漏。
 */
describe("ChatService.assembleContext（项目会话能力预设）", () => {
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
  const assistantRow = {
    id: 1,
    systemPrompt: "助手指令",
    temperature: null,
    topP: null,
    maxTokens: null,
  };

  const makeSvc = (
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
      // 未绑定目录 → 文件四件不注入，工具集聚焦 mcp__ 与 create_skill/read_skill
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

  /** assembleContext 内部返回（本文件既有内部访问模式） */
  const assemble = (service: ChatService) =>
    (
      service as unknown as {
        assembleContext: (sessionId: number) => Promise<{
          mode: string;
          skills: Array<{ name: string }>;
          allSkills: Array<{ name: string }>;
          isProjectSession: boolean;
          agent: { workspacePath?: string };
          systemWithSummary: string | undefined;
          /** 专家团调度注入面（二期 T3）：非 team 会话为 null */
          team: { members: Array<{ id: string }> } | null;
          /** 工具分组场景门控判定输入（spec §20 项 B） */
          toolGate: ToolGroupGate;
        }>;
      }
    ).assembleContext(1);

  /** 生产同口径组装注入工具集（streamAndPersist/getUsageBreakdown 的调用式；
   *  abortSignal 仅 streamAndPersist 补入，名断言不触达 modelText） */
  const collectTools = async (service: ChatService) => {
    const ctx = await assemble(service);
    if (ctx.mode === "ask") return [];
    return (
      service as unknown as {
        collectToolDefinitions: (
          agent: { workspacePath?: string },
          skills: Array<{ name: string }>,
          isProjectSession: boolean,
          team: { members: Array<{ id: string }> } | null,
          gate: ToolGroupGate,
        ) => ToolDefinition[];
      }
    ).collectToolDefinitions(
      ctx.agent,
      ctx.allSkills,
      ctx.isProjectSession,
      ctx.team,
      ctx.toolGate,
    );
  };

  const toolNames = async (service: ChatService) =>
    (await collectTools(service)).map((def) => def.name);

  /** 伪 mcp 工具（注册进真 registry；execute 不被触达） */
  const mcpTool = (name: string): ToolDefinition => ({
    name,
    description: `伪工具 ${name}`,
    parameters: {},
    kind: "read",
    execute: async () => "ok",
  });

  const projectCtx = (overrides: Record<string, unknown> = {}) => ({
    projectName: "p",
    systemPrompt: "项目指令",
    boundAssistantPrompts: [],
    boundSkillNames: [],
    boundConnectorNames: [],
    ...overrides,
  });

  beforeAll(() => {
    registerTools([mcpTool("mcp__alpha__query"), mcpTool("mcp__beta__fetch")]);
  });
  afterAll(() => {
    unregisterTools("mcp__");
  });
  beforeEach(() => {
    vi.clearAllMocks();
    assembleReads.model.findUnique.mockResolvedValue(modelRow);
    assembleReads.provider.findUnique.mockResolvedValue(providerRow);
    assembleReads.assistant.findUnique.mockResolvedValue(assistantRow);
    skillScanStub.skills = [];
  });

  it("项目会话：mcp 工具全量注入（挂载集是预设软约束，不做硬过滤）", async () => {
    const { service } = makeSvc({ projectId: 11 }, async () =>
      projectCtx({ boundConnectorNames: ["alpha"] }),
    );
    const names = await toolNames(service);
    // 未绑定目录：文件四件缺席（create_skill 由 SkillRepository 注册，
    // 测试环境不实例化）；仅挂载 alpha 但 beta 也注入（预设外可按需用）
    expect(names).toEqual([
      "read_skill",
      "run_command",
      "show_widget",
      "mcp__alpha__query",
      "mcp__beta__fetch",
    ]);
  });

  it("项目会话：技能清单 = 启用扫描 ∩ 挂载集（system 预设聚焦），read_skill 收全量", async () => {
    skillScanStub.skills = [
      {
        name: "技能1",
        description: "挂载技能",
        dir: "/skills/技能1",
        bodyPath: "/skills/技能1/SKILL.md",
        source: "user",
      },
      {
        name: "技能2",
        description: "未挂载技能",
        dir: "/skills/技能2",
        bodyPath: "/skills/技能2/SKILL.md",
        source: "user",
      },
    ];
    const { service } = makeSvc({ projectId: 11 }, async () =>
      projectCtx({
        boundSkillNames: ["技能1"],
        boundConnectorNames: ["alpha"],
      }),
    );
    const ctx = await assemble(service);
    // 清单与声明段仅列挂载集（预设聚焦，声明不含未安装技能名）
    expect(ctx.skills.map((skill) => skill.name)).toEqual(["技能1"]);
    expect(ctx.systemWithSummary).toContain("技能：技能1");
    expect(ctx.systemWithSummary).not.toContain("技能2");
    const tools = await collectTools(service);
    expect(tools.map((def) => def.name)).toContain("read_skill");
    // 全量启用集保留挂载外技能：read_skill 工具可按需读（预设≠围墙）
    expect(ctx.allSkills.map((skill) => skill.name)).toEqual([
      "技能1",
      "技能2",
    ]);
  });

  it("项目会话挂载空连接器集 → mcp 工具仍全量（预设可为空，不隔离）", async () => {
    const { service } = makeSvc({ projectId: 11 }, async () => projectCtx());
    const names = await toolNames(service);
    expect(names).toEqual([
      "read_skill",
      "run_command",
      "show_widget",
      "mcp__alpha__query",
      "mcp__beta__fetch",
    ]);
  });

  it("非项目会话：工具集与技能清单全量（回归锚点）", async () => {
    skillScanStub.skills = [
      {
        name: "技能1",
        description: "d1",
        dir: "/d1",
        bodyPath: "/d1/SKILL.md",
        source: "user",
      },
      {
        name: "技能2",
        description: "d2",
        dir: "/d2",
        bodyPath: "/d2/SKILL.md",
        source: "user",
      },
    ];
    const { projectRepo, service } = makeSvc({}, async () => null);
    const ctx = await assemble(service);
    expect(ctx.isProjectSession).toBe(false);
    expect(ctx.skills.map((skill) => skill.name)).toEqual(["技能1", "技能2"]);
    expect(await toolNames(service)).toEqual([
      "read_skill",
      "run_command",
      "show_widget",
      "mcp__alpha__query",
      "mcp__beta__fetch",
    ]);
    expect(projectRepo.getPromptContext).not.toHaveBeenCalled();
  });

  it("ask 模式项目会话：零工具零技能，声明段保持一期挂载集口径", async () => {
    skillScanStub.skills = [
      {
        name: "技能1",
        description: "d1",
        dir: "/d1",
        bodyPath: "/d1/SKILL.md",
        source: "user",
      },
    ];
    const { service } = makeSvc({ projectId: 11, mode: "ask" }, async () =>
      projectCtx({ boundSkillNames: ["技能1"] }),
    );
    const ctx = await assemble(service);
    expect(ctx.isProjectSession).toBe(false);
    expect(ctx.skills).toEqual([]);
    expect(await toolNames(service)).toEqual([]);
    // ask 不做运行时交集（无实际工具集可对齐），声明沿用挂载集
    expect(ctx.systemWithSummary).toContain("技能：技能1");
  });

  it("SP6 运行时禁用钉住（Task 2 移交）：注入 runtimeFilter 后工具集不含禁用名，缺席不滤", async () => {
    const sessions = {
      getSession: vi.fn().mockResolvedValue({
        id: 1,
        assistantId: 1,
        workspaceId: 1,
        mode: null,
        compactedUpToId: null,
        summary: null,
        projectId: null,
      }),
      getEffectiveModelId: vi.fn().mockResolvedValue(1),
      // 绑定目录：文件四件 + run_command 实际进入注入集（过滤断言才有意义）
      getWorkspace: vi
        .fn()
        .mockResolvedValue({ id: 1, name: "空间", directoryPath: "/tmp/ws" }),
    };
    const mkSvc = (runtimeFilter?: () => string[]) =>
      new ChatService(
        sessions as unknown as SessionRepository,
        undefined,
        undefined,
        undefined,
        undefined,
        runtimeFilter,
      );
    expect(await toolNames(mkSvc(() => ["run_command"]))).not.toContain(
      "run_command",
    );
    // 缺席（测试不注入）：不滤（回归锚点）
    expect(await toolNames(mkSvc())).toContain("run_command");
  });
});

/**
 * 专家 2.0 运行时接线（Task 4）：
 * ① 绑定专家 → 附带技能并入 sessionSkills（并入 = 启用集 ∪ (扫描全集 ∩
 *   skillNames)：未启用可补入、既启用不重复、已卸载静略）；
 * ② 未绑专家且 agent 模式 → 个性化段之后、场景段之前注入专家目录推荐
 *   指令段（绑定专家 / ask / plan 均不注入）。
 * 直接调私有 assembleContext（本文件既有内部访问模式）。
 */
describe("ChatService.assembleContext（专家 2.0 运行时接线）", () => {
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

  const skillStub = (name: string) => ({
    name,
    description: `d-${name}`,
    dir: `/skills/${name}`,
    bodyPath: `/skills/${name}/SKILL.md`,
    source: "user" as const,
  });

  /**
   * @param sessionOverrides 会话行覆写（assistantId/mode/scenario/projectId）
   * @param opts.assistantRow findUnique 返回（null=未绑专家）
   * @param opts.skillRepo 禁用查询 stub（缺席不滤——生产同语义）；
   *  listGateStatus 可选提供（spec §20 项 B 工作流门控三列清单）
   * @param opts.projectRepo 项目上下文（非空即项目会话）
   * @param opts.runtimeFilter 运行时工具禁用清单闭包（缺席不滤——SP6 同语义）
   */
  const makeSvc = (
    sessionOverrides: Record<string, unknown>,
    opts: {
      assistantRow?: Record<string, unknown> | null;
      skillRepo?: {
        getDisabledNames: () => Promise<Set<string>>;
        listGateStatus?: () => Promise<
          Array<{ name: string; source: string; enabled: boolean }>
        >;
      };
      projectRepo?: { getPromptContext: () => Promise<unknown> };
      runtimeFilter?: () => string[];
    } = {},
  ) => {
    const sessions = {
      getSession: vi.fn().mockResolvedValue({
        id: 1,
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
    const service = new ChatService(
      sessions as unknown as SessionRepository,
      opts.skillRepo as never,
      opts.projectRepo as never,
      undefined,
      undefined,
      opts.runtimeFilter,
    );
    return { service };
  };

  const assemble = (service: ChatService) =>
    (
      service as unknown as {
        assembleContext: (sessionId: number) => Promise<{
          skills: Array<{ name: string }>;
          allSkills: Array<{ name: string }>;
          systemWithSummary: string | undefined;
          mode: string;
          isProjectSession: boolean;
          agent: { workspacePath?: string };
          /** 专家团调度注入面（二期 T3）：非 team 会话为 null */
          team: { members: Array<{ id: string }> } | null;
          /** 工具分组场景门控判定输入（spec §20 项 B） */
          toolGate: ToolGroupGate;
        }>;
      }
    ).assembleContext(1);

  /** 生产同口径注入工具集名（二期 T3）：第 4 参 team 从 ctx 取（与
   *  getUsageBreakdown 调用式一致；modelText 由 assembleContext 装配，
   *  名断言不触达） */
  const toolNames = async (service: ChatService) => {
    const ctx = await assemble(service);
    if (ctx.mode === "ask") return [];
    return (
      service as unknown as {
        collectToolDefinitions: (
          agent: { workspacePath?: string },
          skills: Array<{ name: string }>,
          isProjectSession: boolean,
          team: { members: Array<{ id: string }> } | null,
          gate: ToolGroupGate,
        ) => ToolDefinition[];
      }
    )
      .collectToolDefinitions(
        ctx.agent,
        ctx.allSkills,
        ctx.isProjectSession,
        ctx.team,
        ctx.toolGate,
      )
      .map((def) => def.name);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prismaStub.messages = [];
    assembleReads.model.findUnique.mockResolvedValue(modelRow);
    assembleReads.provider.findUnique.mockResolvedValue(providerRow);
    skillScanStub.skills = [];
  });

  it("绑定专家：附带技能并入（未启用补入/既启用不重复/已卸载静略）", async () => {
    // 全集 a/b/c；b 用户禁用（未启用）、c 启用、gone 不在全集（已卸载）
    skillScanStub.skills = [skillStub("a"), skillStub("b"), skillStub("c")];
    assembleReads.assistant.findUnique.mockResolvedValue({
      id: 1,
      systemPrompt: "专家指令",
      temperature: null,
      topP: null,
      maxTokens: null,
      skillNames: JSON.stringify(["b", "c", "gone"]),
    });
    const { service } = makeSvc(
      { assistantId: 1 },
      { skillRepo: { getDisabledNames: async () => new Set(["b"]) } },
    );
    const ctx = await assemble(service);
    // 并入 = 启用集 [a,c] ∪ 全集∩skillNames（b 补入、c 已在、gone 静略）
    expect(ctx.skills.map((s) => s.name)).toEqual(["a", "c", "b"]);
    // read_skill 消费集与 system 清单同源（展示=可用：禁用的 b 经专家
    // 附带既入清单也读得到）
    expect(ctx.allSkills.map((s) => s.name)).toEqual(["a", "c", "b"]);
    // 并入的 b 进 system 技能清单段，c 只出现一次，gone 不出现
    const system = ctx.systemWithSummary ?? "";
    expect(system).toContain("- b: d-b");
    expect(system.split("- c: d-c").length - 1).toBe(1);
    expect(system).not.toContain("gone");
  });

  it("未绑专家 agent 会话：目录段注入，无 base 时单独成段无开头空行", async () => {
    const { service } = makeSvc({ assistantId: null });
    const ctx = await assemble(service);
    const system = ctx.systemWithSummary ?? "";
    // 无助手 prompt/无技能/个性化默认 → 目录段即 system 全文（非空拼接种模式）
    expect(system.startsWith("【专家目录】")).toBe(true);
    expect(system).toContain("recommend_experts");
    expect(system).toContain("code-review-expert");
  });

  it("注入位置：个性化段（含技能清单）之后、场景段之前", async () => {
    skillScanStub.skills = [skillStub("s1")];
    const { service } = makeSvc({
      assistantId: null,
      scenario: "coding",
    });
    const ctx = await assemble(service);
    const system = ctx.systemWithSummary ?? "";
    const skillIdx = system.indexOf("你可以使用以下技能");
    const catalogIdx = system.indexOf("【专家目录】");
    const scenarioIdx = system.indexOf("当前处于代码开发场景");
    expect(skillIdx).toBeGreaterThanOrEqual(0);
    expect(catalogIdx).toBeGreaterThan(skillIdx);
    expect(scenarioIdx).toBeGreaterThan(catalogIdx);
  });

  it("绑定专家 / ask / plan：均不注入目录段", async () => {
    // 已绑专家（agent 模式）
    assembleReads.assistant.findUnique.mockResolvedValue({
      id: 1,
      systemPrompt: "专家指令",
      temperature: null,
      topP: null,
      maxTokens: null,
    });
    const bound = await assemble(makeSvc({ assistantId: 1 }).service);
    expect(bound.systemWithSummary).not.toContain("【专家目录】");
    // 未绑专家但 ask 模式：无 base（无助手/项目/个性化）时 system 整体为
    // undefined——先钉 undefined 再空串兜底断言，防恒真（终审顺手修）
    const askCtx = await assemble(
      makeSvc({ assistantId: null, mode: "ask" }).service,
    );
    expect(askCtx.systemWithSummary).toBeUndefined();
    expect(askCtx.systemWithSummary ?? "").not.toContain("【专家目录】");
    // 未绑专家但 plan 模式：注入计划指令段（string），仅断言不含目录段
    const planCtx = await assemble(
      makeSvc({ assistantId: null, mode: "plan" }).service,
    );
    expect(planCtx.systemWithSummary ?? "").not.toContain("【专家目录】");
  });

  it("禁用 recommend_experts：不注入目录段（system 不指示调用被禁工具）", async () => {
    const { service } = makeSvc(
      { assistantId: null },
      { runtimeFilter: () => ["recommend_experts"] },
    );
    const ctx = await assemble(service);
    // 未绑专家 agent 会话本应注入目录段；工具被安全中心禁用后整段不注入
    //（注入层 filterDisabledTools 同一 runtimeFilter 来源），无 base 时
    // system 回落 undefined
    expect(ctx.systemWithSummary).toBeUndefined();
    // 其他工具禁用不影响目录段（门控只对 recommend_experts 生效）
    const other = await assemble(
      makeSvc({ assistantId: null }, { runtimeFilter: () => ["run_command"] })
        .service,
    );
    expect(other.systemWithSummary ?? "").toContain("【专家目录】");
  });

  it("项目会话：挂载集收窄优先，专家附带技能不并入", async () => {
    skillScanStub.skills = [skillStub("s1"), skillStub("s2")];
    assembleReads.assistant.findUnique.mockResolvedValue({
      id: 1,
      systemPrompt: "专家指令",
      temperature: null,
      topP: null,
      maxTokens: null,
      skillNames: JSON.stringify(["s2"]),
    });
    const { service } = makeSvc(
      { assistantId: 1, projectId: 11 },
      {
        projectRepo: {
          getPromptContext: async () => ({
            projectName: "p",
            systemPrompt: "项目指令",
            boundAssistantPrompts: [],
            boundSkillNames: ["s1"],
            boundConnectorNames: [],
          }),
        },
      },
    );
    const ctx = await assemble(service);
    // isolation 分支胜出：清单 = 启用扫描 ∩ 挂载集，专家附带 s2 不并入
    expect(ctx.skills.map((s) => s.name)).toEqual(["s1"]);
    // 项目会话 read_skill 消费集维持挂载收窄前的全量启用扫描集
    expect(ctx.allSkills.map((s) => s.name)).toEqual(["s1", "s2"]);
    expect(ctx.systemWithSummary).not.toContain("d-s2");
  });

  /** 专家团助手行（二期 T2：expertType team + members 为 JSON 原始字符串列） */
  const teamAssistantRow = () => ({
    id: 1,
    systemPrompt: "你是交易团主理人。",
    temperature: null,
    topP: null,
    maxTokens: null,
    expertType: "team",
    members: JSON.stringify([
      {
        id: "macro-analyst",
        name: "顾大局",
        profession: "宏观分析师",
        systemPrompt: "宏观分析……",
      },
      {
        id: "risk-officer",
        name: "严守仓",
        profession: "风控官",
        systemPrompt: "风控审查……",
      },
    ]),
  });

  it("专家团会话：base 换主理人组装（成员清单行+铁律）；非 team 为裸 prompt", async () => {
    assembleReads.assistant.findUnique.mockResolvedValue(teamAssistantRow());
    const ctx = await assemble(makeSvc({ assistantId: 1 }).service);
    const system = ctx.systemWithSummary ?? "";
    expect(system).toContain("你是交易团主理人。");
    expect(system).toContain("macro-analyst｜顾大局（宏观分析师）");
    expect(system).toContain("risk-officer｜严守仓（风控官）");
    expect(system).toContain("严禁");
    expect(system).toContain("dispatch_member");
    // 非 team：expertType null / "agent"（即使带 members 列）均为裸 prompt
    //（以 expertType==="team" 判别——T1 信息项：toRecord 恒数组不可依赖）
    assembleReads.assistant.findUnique.mockResolvedValue({
      ...teamAssistantRow(),
      expertType: null,
      members: null,
    });
    const bare = await assemble(makeSvc({ assistantId: 1 }).service);
    expect(bare.systemWithSummary).toBe("你是交易团主理人。");
    assembleReads.assistant.findUnique.mockResolvedValue({
      ...teamAssistantRow(),
      expertType: "agent",
    });
    const agent = await assemble(makeSvc({ assistantId: 1 }).service);
    expect(agent.systemWithSummary).toBe("你是交易团主理人。");
  });

  it("禁用 dispatch_member：铁律段与工具说明不组装（对照禁用 run_command 时铁律段仍在）", async () => {
    assembleReads.assistant.findUnique.mockResolvedValue(teamAssistantRow());
    const disabled = await assemble(
      makeSvc({ assistantId: 1 }, { runtimeFilter: () => ["dispatch_member"] })
        .service,
    );
    const system = disabled.systemWithSummary ?? "";
    expect(system).not.toContain("【协作铁律】");
    expect(system).not.toContain("dispatch_member");
    expect(system).toContain("macro-analyst"); // 成员清单仍在（展示语义）
    // 其他工具禁用不影响铁律段（门控只对 dispatch_member 生效）
    const other = await assemble(
      makeSvc({ assistantId: 1 }, { runtimeFilter: () => ["run_command"] })
        .service,
    );
    expect(other.systemWithSummary ?? "").toContain("【协作铁律】");
  });

  it("项目会话 + 专家团：主理人组装嵌入助手槽位，项目指令段保留", async () => {
    skillScanStub.skills = [skillStub("s1")];
    assembleReads.assistant.findUnique.mockResolvedValue(teamAssistantRow());
    const { service } = makeSvc(
      { assistantId: 1, projectId: 11 },
      {
        projectRepo: {
          getPromptContext: async () => ({
            projectName: "p",
            systemPrompt: "项目指令",
            boundAssistantPrompts: [],
            boundSkillNames: ["s1"],
            boundConnectorNames: [],
          }),
        },
      },
    );
    const ctx = await assemble(service);
    const system = ctx.systemWithSummary ?? "";
    // 嵌入而非替换：项目指令段与主理人组装（成员清单+铁律）同在
    expect(system).toContain("项目指令");
    expect(system).toContain("你是交易团主理人。");
    expect(system).toContain("macro-analyst｜顾大局（宏观分析师）");
    expect(system).toContain("【协作铁律】");
    // 槽位顺序：项目指令在前、主理人组装在后（buildProjectSystemBase 段序）
    expect(system.indexOf("项目指令")).toBeLessThan(
      system.indexOf("【团队成员】"),
    );
  });

  it("ask 模式 + 专家团：零工具 → 铁律段与工具说明不组装（成员清单保留）", async () => {
    assembleReads.assistant.findUnique.mockResolvedValue(teamAssistantRow());
    const ctx = await assemble(
      makeSvc({ assistantId: 1, mode: "ask" }).service,
    );
    const system = ctx.systemWithSummary ?? "";
    expect(system).toContain("macro-analyst｜顾大局（宏观分析师）");
    expect(system).not.toContain("严禁"); // 铁律缺席
    expect(system).not.toContain("dispatch_member");
    // ask 零工具本就空集（调用方在 collectToolDefinitions 前短路）
    expect(
      await toolNames(makeSvc({ assistantId: 1, mode: "ask" }).service),
    ).toEqual([]);
  });

  it("专家团会话（T3）：工具集注入 dispatch_member；非 team 会话不含", async () => {
    assembleReads.assistant.findUnique.mockResolvedValue(teamAssistantRow());
    const team = await toolNames(makeSvc({ assistantId: 1 }).service);
    expect(team).toContain("dispatch_member");
    // 非 team：expertType "agent"（带 members 列）与未绑专家均不含
    assembleReads.assistant.findUnique.mockResolvedValue({
      ...teamAssistantRow(),
      expertType: "agent",
    });
    expect(await toolNames(makeSvc({ assistantId: 1 }).service)).not.toContain(
      "dispatch_member",
    );
    assembleReads.assistant.findUnique.mockResolvedValue(null);
    expect(
      await toolNames(makeSvc({ assistantId: null }).service),
    ).not.toContain("dispatch_member");
  });

  it("禁用 dispatch_member：工具集缺席（SP6 禁用=对模型不存在，与铁律段同口径）", async () => {
    assembleReads.assistant.findUnique.mockResolvedValue(teamAssistantRow());
    const disabled = await toolNames(
      makeSvc({ assistantId: 1 }, { runtimeFilter: () => ["dispatch_member"] })
        .service,
    );
    expect(disabled).not.toContain("dispatch_member");
    // 其他工具禁用不影响注入（门控只对 dispatch_member 生效）
    const other = await toolNames(
      makeSvc({ assistantId: 1 }, { runtimeFilter: () => ["run_command"] })
        .service,
    );
    expect(other).toContain("dispatch_member");
  });
});

/**
 * 工具分组场景门控（spec §20 项 B）：工作流六件套/专家两件套按会话场景
 * 与 workflow-creator 技能状态挂载；与 SP6 disabledTools 两层叠加（场景
 * 门控先、用户禁用后）。伪门控组工具注册进真 registry（mcp 伪工具同款
 * 先例——门控是注册表无关的名字过滤），afterAll 逐名反注册防污染同文件
 * 其他套件的精确名单断言。
 */
describe("ChatService.collectToolDefinitions（工具分组场景门控）", () => {
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

  /** skillRepo stub：禁用集 + 门控三列清单双通道（spec §20 项 B 判定输入；
   *  workflow-creator 行按 source/enabled 组态提供，其余技能行陪跑） */
  const skillRepoWith = (
    creator: { source: string; enabled: boolean } | null,
    disabled: string[] = [],
  ) => ({
    getDisabledNames: async () => new Set(disabled),
    listGateStatus: async () => [
      { name: "skill-creator", source: "builtin", enabled: true },
      ...(creator ? [{ name: "workflow-creator", ...creator }] : []),
    ],
  });

  const makeSvc = (
    sessionOverrides: Record<string, unknown>,
    opts: {
      skillRepo?: ReturnType<typeof skillRepoWith>;
      runtimeFilter?: () => string[];
    } = {},
  ) => {
    const sessions = {
      getSession: vi.fn().mockResolvedValue({
        id: 1,
        assistantId: null,
        workspaceId: 1,
        mode: null,
        compactedUpToId: null,
        summary: null,
        projectId: null,
        scenario: null,
        ...sessionOverrides,
      }),
      getEffectiveModelId: vi.fn().mockResolvedValue(1),
      // 绑定目录：工作流组等工具在未绑定目录时本就不注入（workspaceScoped
      // 白名单前置层），门控测试须绑定目录才能观测到门控组差异
      getWorkspace: vi.fn().mockResolvedValue({
        id: 1,
        directoryPath: `/tmp/tianshu-gate-ws-${process.pid}`,
      }),
    };
    const service = new ChatService(
      sessions as unknown as SessionRepository,
      opts.skillRepo as never,
      undefined,
      undefined,
      undefined,
      opts.runtimeFilter,
    );
    return { service };
  };

  const assemble = (service: ChatService) =>
    (
      service as unknown as {
        assembleContext: (sessionId: number) => Promise<{
          mode: string;
          agent: { workspacePath?: string };
          allSkills: Array<{ name: string }>;
          isProjectSession: boolean;
          team: { members: Array<{ id: string }> } | null;
          toolGate: ToolGroupGate;
          systemWithSummary?: string;
        }>;
      }
    ).assembleContext(1);

  const toolNames = async (service: ChatService) => {
    const ctx = await assemble(service);
    if (ctx.mode === "ask") return [];
    return collectDefs(service, ctx).map((def) => def.name);
  };

  /** 反射调 private collectToolDefinitions（read_skill 钩子用例需取工具真身） */
  const collectDefs = (
    service: ChatService,
    ctx: Awaited<ReturnType<typeof assemble>>,
  ) =>
    (
      service as unknown as {
        collectToolDefinitions: (
          agent: { workspacePath?: string },
          skills: Array<{ name: string }>,
          isProjectSession: boolean,
          team: { members: Array<{ id: string }> } | null,
          gate: ToolGroupGate,
        ) => ToolDefinition[];
      }
    ).collectToolDefinitions(
      ctx.agent,
      ctx.allSkills,
      ctx.isProjectSession,
      ctx.team,
      ctx.toolGate,
    );

  /** 伪门控组工具（注册进真 registry；execute 不被触达） */
  const gatedTool = (name: string): ToolDefinition => ({
    name,
    description: `伪工具 ${name}`,
    parameters: {},
    kind: "read",
    execute: async () => "ok",
  });
  const WORKFLOW_SIX = [
    "create_workflow",
    "list_workflows",
    "get_workflow",
    "update_workflow",
    "run_workflow",
    "get_workflow_run",
  ];

  beforeAll(() => {
    registerTools([
      ...WORKFLOW_SIX.map(gatedTool),
      gatedTool("create_expert"),
      gatedTool("update_expert"),
    ]);
  });
  afterAll(() => {
    for (const name of [...WORKFLOW_SIX, "create_expert", "update_expert"]) {
      unregisterTools(name);
    }
  });
  beforeEach(() => {
    vi.clearAllMocks();
    assembleReads.model.findUnique.mockResolvedValue(modelRow);
    assembleReads.provider.findUnique.mockResolvedValue(providerRow);
    assembleReads.assistant.findUnique.mockResolvedValue(null);
    skillScanStub.skills = [];
  });

  it("automation 场景会话：工作流六件套注入（gate 判定输入随 ctx 携带）", async () => {
    const { service } = makeSvc({ scenario: "automation" });
    const ctx = await assemble(service);
    expect(ctx.toolGate.scenario).toBe("automation");
    expect(ctx.toolGate.workflowCreatorEnabled).toBe(false);
    const names = await toolNames(service);
    expect(names).toEqual(expect.arrayContaining(WORKFLOW_SIX));
  });

  it("daily 场景会话：工作流组与专家组均不注入（核心组照旧）", async () => {
    const names = await toolNames(makeSvc({ scenario: "daily" }).service);
    for (const wf of WORKFLOW_SIX) {
      expect(names).not.toContain(wf);
    }
    expect(names).not.toContain("create_expert");
    expect(names).not.toContain("update_expert");
    // 核心组不受场景门控（绑定目录下 file5/browser4/web 三系全在；
    // create_skill 由 SkillRepository 构造注册，测试环境缺席属正常）
    expect(names).toEqual(
      expect.arrayContaining([
        "read_file",
        "write_file",
        "list_dir",
        "search_files",
        "delete_file",
        "browser_snapshot",
        "browser_navigate",
        "browser_click",
        "browser_type",
        "open_browser",
        "web_fetch",
        "run_command",
        "read_skill",
      ]),
    );
  });

  it("workflow-creator 用户侧安装且启用（daily 场景）：开门注入；内置态（自愈安装 enabled 默认 true）不开门", async () => {
    // 非内置（market/local 安装）且启用：开门
    const userSide = makeSvc(
      { scenario: "daily" },
      { skillRepo: skillRepoWith({ source: "market", enabled: true }) },
    );
    expect(
      (await assemble(userSide.service)).toolGate.workflowCreatorEnabled,
    ).toBe(true);
    expect(await toolNames(userSide.service)).toContain("create_workflow");
    // 内置且 enabled（启动自愈安装的默认态）：不开门（F1 裁定——否则
    // 门控失效，daily/design 会话恒注入工作流组）
    const builtin = makeSvc(
      { scenario: "daily" },
      { skillRepo: skillRepoWith({ source: "builtin", enabled: true }) },
    );
    expect(
      (await assemble(builtin.service)).toolGate.workflowCreatorEnabled,
    ).toBe(false);
    expect(await toolNames(builtin.service)).not.toContain("create_workflow");
    // 用户侧安装但被禁用：同样不开门
    const disabled = makeSvc(
      { scenario: "daily" },
      { skillRepo: skillRepoWith({ source: "market", enabled: false }) },
    );
    expect(
      (await assemble(disabled.service)).toolGate.workflowCreatorEnabled,
    ).toBe(false);
  });

  it("内置不开门时 coding 场景照旧开门（逃生门=场景，非技能态）", async () => {
    const names = await toolNames(
      makeSvc(
        { scenario: "coding" },
        { skillRepo: skillRepoWith({ source: "builtin", enabled: true }) },
      ).service,
    );
    expect(names).toContain("create_workflow");
  });

  it("会话内 read_skill 读 workflow-creator：自此开门（使用即意图信号，builtin 态照开——恢复被自愈纠 source 熄灭的技能信号）", async () => {
    skillScanStub.skills = [
      {
        name: "workflow-creator",
        description: "指导创建工作流",
        dir: fileURLToPath(
          new URL(
            "../../electron/resources/builtin-skills/workflow-creator/",
            import.meta.url,
          ),
        ),
        bodyPath: fileURLToPath(
          new URL(
            "../../electron/resources/builtin-skills/workflow-creator/SKILL.md",
            import.meta.url,
          ),
        ),
        source: "user",
      },
    ];
    const { service } = makeSvc(
      { scenario: "daily" },
      { skillRepo: skillRepoWith({ source: "builtin", enabled: true }) },
    );
    // builtin 态（f49349d7 自愈纠 source 后的常态）：初始不开门
    expect((await assemble(service)).toolGate.workflowCreatorEnabled).toBe(
      false,
    );
    // 从工具集取 read_skill 执行读取（模型行为的等价物）
    const readSkill = collectDefs(service, await assemble(service)).find(
      (d) => d.name === "read_skill",
    );
    const out = await readSkill!.execute(
      { workspacePath: `/tmp/tianshu-gate-ws-${process.pid}`, sessionId: 1 },
      { name: "workflow-creator" },
    );
    expect(out).toContain("# 工作流创作指南");
    expect(out).toContain("工作流工具"); // 意图尾注在场
    // 该会话自此开门、工具组挂载
    expect((await assemble(service)).toolGate.workflowCreatorEnabled).toBe(
      true,
    );
    expect(await toolNames(service)).toContain("create_workflow");
  });

  it("读非 workflow-creator 技能不触发开门（意图信号按技能名精确）", async () => {
    skillScanStub.skills = [
      {
        name: "deploy",
        description: "部署",
        dir: `/tmp/tianshu-gate-ws-${process.pid}`,
        // 正文内容与判定无关，仅 bodyPath 可读即可
        bodyPath: fileURLToPath(
          new URL(
            "../../electron/resources/builtin-skills/workflow-creator/SKILL.md",
            import.meta.url,
          ),
        ),
        source: "user",
      },
    ];
    const { service } = makeSvc(
      { scenario: "daily" },
      { skillRepo: skillRepoWith({ source: "builtin", enabled: true }) },
    );
    const readSkill = collectDefs(service, await assemble(service)).find(
      (d) => d.name === "read_skill",
    );
    await readSkill!.execute(
      { workspacePath: `/tmp/tianshu-gate-ws-${process.pid}`, sessionId: 1 },
      { name: "deploy" },
    );
    expect((await assemble(service)).toolGate.workflowCreatorEnabled).toBe(
      false,
    );
  });

  it("skillRepo 窄 stub（无 listGateStatus，测试缺省形态）：视为未启用", async () => {
    const { service } = makeSvc(
      { scenario: "daily" },
      {
        skillRepo: {
          getDisabledNames: async () => new Set<string>(),
        } as never,
      },
    );
    expect((await assemble(service)).toolGate.workflowCreatorEnabled).toBe(
      false,
    );
  });

  it("绑定专家会话：create/update_expert 注入；未绑定缺席", async () => {
    const bound = await toolNames(makeSvc({ assistantId: 1 }).service);
    expect(bound).toContain("create_expert");
    expect(bound).toContain("update_expert");
    expect(
      await toolNames(makeSvc({ assistantId: null }).service),
    ).not.toContain("create_expert");
  });

  it("两层叠加：场景放行 + 用户禁用 → 工具不注入（场景门控先、禁用后）", async () => {
    const names = await toolNames(
      makeSvc(
        { scenario: "coding" },
        { runtimeFilter: () => ["create_workflow"] },
      ).service,
    );
    expect(names).not.toContain("create_workflow");
    // 同场景其余五件套不受连带（用户禁用是逐工具语义）
    expect(names).toContain("run_workflow");
  });

  // ---------- 工作流挂载元说明（未挂载时 system 注入解锁路径指引） ----------

  /** 技能集内造 workflow-creator（dir/bodyPath 指真内置目录，1988 用例同款） */
  const creatorSkill = () => ({
    name: "workflow-creator",
    description: "指导创建工作流",
    dir: fileURLToPath(
      new URL(
        "../../electron/resources/builtin-skills/workflow-creator/",
        import.meta.url,
      ),
    ),
    bodyPath: fileURLToPath(
      new URL(
        "../../electron/resources/builtin-skills/workflow-creator/SKILL.md",
        import.meta.url,
      ),
    ),
    source: "user" as const,
  });

  it("挂载元说明：daily 场景未挂载且 workflow-creator 可读 → system 注入挂载路径指引", async () => {
    skillScanStub.skills = [creatorSkill()];
    const ctx = await assemble(
      makeSvc(
        { scenario: "daily" },
        { skillRepo: skillRepoWith({ source: "builtin", enabled: true }) },
      ).service,
    );
    expect(ctx.systemWithSummary).toContain("【工作流工具挂载】");
    expect(ctx.systemWithSummary).toContain("workflow-creator");
  });

  it("挂载元说明：automation 场景已挂载 → 不注入（指引只在未挂载时出现）", async () => {
    skillScanStub.skills = [creatorSkill()];
    const ctx = await assemble(
      makeSvc(
        { scenario: "automation" },
        { skillRepo: skillRepoWith({ source: "builtin", enabled: true }) },
      ).service,
    );
    expect(ctx.systemWithSummary ?? "").not.toContain("【工作流工具挂载】");
  });

  it("挂载元说明：ask 模式 → 不注入（零工具语境指引无意义）", async () => {
    skillScanStub.skills = [creatorSkill()];
    const ctx = await assemble(
      makeSvc({ mode: "ask", scenario: "daily" }).service,
    );
    expect(ctx.systemWithSummary ?? "").not.toContain("【工作流工具挂载】");
  });

  it("挂载元说明：workflow-creator 不在可读技能集（禁用态）→ 不注入（指引指向 read_skill 死路）", async () => {
    skillScanStub.skills = [];
    const ctx = await assemble(
      makeSvc(
        { scenario: "daily" },
        {
          skillRepo: skillRepoWith(null, ["workflow-creator"]),
        },
      ).service,
    );
    expect(ctx.systemWithSummary ?? "").not.toContain("【工作流工具挂载】");
  });

  it("挂载元说明：read_skill 被安全中心禁用 → 不注入（目录段 G1 门控同款联动）", async () => {
    skillScanStub.skills = [creatorSkill()];
    const ctx = await assemble(
      makeSvc(
        { scenario: "daily" },
        {
          skillRepo: skillRepoWith({ source: "builtin", enabled: true }),
          runtimeFilter: () => ["read_skill"],
        },
      ).service,
    );
    expect(ctx.systemWithSummary ?? "").not.toContain("【工作流工具挂载】");
  });
});

/**
 * SP6 系统授权 IPC（spec §4）：full 会话总览/一键收回 + 工具记忆查看/撤销。
 * ipcMain.handle 为模块级 vi.fn：每次构造累积注册，取该通道最近一次注册的
 * handler 直调（渲染层 invoke 的等价最小面）。
 */
describe("ChatService 系统授权 IPC（SP6 spec §4）", () => {
  /** 该通道最近一次注册的 handler（对应本测试刚构造的 service） */
  const handlerOf = (channel: string) => {
    const calls = (ipcMain.handle as unknown as Mock).mock.calls.filter(
      ([name]) => name === channel,
    );
    const latest = calls[calls.length - 1];
    if (!latest) {
      throw new Error(`IPC 未注册: ${channel}`);
    }
    return latest[1] as (...args: unknown[]) => unknown;
  };

  /** 标题/空间名查询 stub：值为 "fail" 时抛错（断言回落文案），缺省查无行 */
  const grantSessions = (
    titles: Record<number, string | "fail">,
    workspaces: Record<number, string | "fail"> = {},
  ) => ({
    getSession: async (id: number) => {
      const title = titles[id];
      if (title === "fail") throw new Error("会话查询失败");
      return title === undefined ? null : { title };
    },
    getWorkspace: async (id: number) => {
      const name = workspaces[id];
      if (name === "fail") throw new Error("工作空间查询失败");
      return name === undefined ? null : { name };
    },
  });

  /** 构造 service：auditSink 缺省捕获审计事件，permissions 私有 store 直达 */
  const makeGrantSvc = (
    sessions: ReturnType<typeof grantSessions>,
    withAuditSink = true,
  ) => {
    const auditEvents: SecurityEvent[] = [];
    const service = new ChatService(
      sessions as unknown as SessionRepository,
      undefined,
      undefined,
      withAuditSink ? (event) => auditEvents.push(event) : undefined,
    );
    return {
      auditEvents,
      permissions: (service as unknown as { permissions: PermissionStore })
        .permissions,
    };
  };

  beforeEach(() => {
    prismaStub.toolPermissions = [];
    prismaStub.toolPermissionFindMany.mockClear();
    prismaStub.toolPermissionFindUnique.mockClear();
    prismaStub.toolPermissionFindFirst.mockClear();
    prismaStub.toolPermissionDelete.mockClear();
    prismaStub.toolPermissionDeleteMany.mockClear();
    prismaStub.workspaceFindMany.mockClear();
  });

  it("listFullGrants：只列 full 会话并 join 标题；查询失败行回落「会话 #id」不整表失败", async () => {
    const svc = makeGrantSvc(grantSessions({ 1: "任务A", 3: "任务C" }));
    svc.permissions.set(1, "full");
    svc.permissions.set(2, "full"); // 查无行（mock titles 无该键）→ 回落文案
    svc.permissions.set(3, "full");
    svc.permissions.set(4, "default"); // 非 full 不列出
    const list = (await handlerOf("permission:listFullGrants")()) as Array<{
      sessionId: number;
      title: string;
    }>;
    expect(list).toEqual([
      { sessionId: 1, title: "任务A" },
      { sessionId: 2, title: "会话 #2" },
      { sessionId: 3, title: "任务C" },
    ]);
  });

  it("revokeAllFull：全部 set 回 default 并审计 count；空集再调 no-op 不审计", async () => {
    const svc = makeGrantSvc(grantSessions({}));
    svc.permissions.set(1, "full");
    svc.permissions.set(2, "full");
    await handlerOf("permission:revokeAllFull")();
    expect(svc.permissions.get(1)).toBe("default");
    expect(svc.permissions.get(2)).toBe("default");
    expect(svc.auditEvents).toEqual([
      {
        eventType: "permission.full-revoked",
        decision: "info",
        detail: { count: 2 },
      },
    ]);
    // 再调（已空）：no-op 不再审计
    await handlerOf("permission:revokeAllFull")();
    expect(svc.auditEvents).toHaveLength(1);
  });

  it("revokeAllFull：auditSink 缺席（未接线）静默照常收回", async () => {
    const svc = makeGrantSvc(grantSessions({}), false);
    svc.permissions.set(1, "full");
    await handlerOf("permission:revokeAllFull")();
    expect(svc.permissions.get(1)).toBe("default");
  });

  it("listRemembered：按时间倒序并 join 工作空间名；join 失败行回落 #workspaceId", async () => {
    prismaStub.toolPermissions = [
      {
        id: 7,
        workspaceId: 5,
        toolName: "run_command",
        createdAt: new Date("2026-09-01T08:00:00Z"),
      },
      {
        id: 8,
        workspaceId: 6,
        toolName: "write_file",
        createdAt: new Date("2026-09-02T08:00:00Z"),
      },
    ];
    makeGrantSvc(grantSessions({}, { 5: "我的空间", 6: "fail" }));
    const list = (await handlerOf("permission:listRemembered")(
      null,
      TOKEN,
    )) as Array<{
      id: number;
      workspaceName: string;
      toolName: string;
      createdAt: string;
    }>;
    // v12：先收敛本人空间 id，再限定 toolPermission 范围
    expect(prismaStub.workspaceFindMany).toHaveBeenCalledWith({
      where: { userId: 1 },
      select: { id: true },
    });
    expect(prismaStub.toolPermissionFindMany).toHaveBeenCalledWith({
      where: { workspaceId: { in: [5, 6] } },
      orderBy: { createdAt: "desc" },
    });
    expect(list).toEqual([
      {
        id: 7,
        workspaceName: "我的空间",
        toolName: "run_command",
        createdAt: "2026-09-01T08:00:00.000Z",
      },
      {
        id: 8,
        workspaceName: "#6",
        toolName: "write_file",
        createdAt: "2026-09-02T08:00:00.000Z",
      },
    ]);
  });

  it("revokeRemembered：删单行并审计 tool/workspace；不存在 id 幂等 no-op 不审计", async () => {
    prismaStub.toolPermissions = [
      {
        id: 7,
        workspaceId: 5,
        toolName: "run_command",
        createdAt: new Date(),
      },
    ];
    const svc = makeGrantSvc(grantSessions({}, { 5: "我的空间" }));
    await handlerOf("permission:revokeRemembered")(null, 7, TOKEN);
    // v12：findFirst 限定本人空间（非本人空间的记忆行不可撤销）
    expect(prismaStub.toolPermissionFindFirst).toHaveBeenCalledWith({
      where: { id: 7, workspaceId: { in: [5, 6] } },
    });
    expect(prismaStub.toolPermissionDelete).toHaveBeenCalledWith({
      where: { id: 7 },
    });
    expect(svc.auditEvents).toEqual([
      {
        eventType: "permission.remembered-revoked",
        decision: "info",
        detail: { tool: "run_command", workspace: "我的空间" },
      },
    ]);
    // 不存在 id：no-op 成功，不重复删也不审计
    await expect(
      handlerOf("permission:revokeRemembered")(null, 99, TOKEN),
    ).resolves.toBeUndefined();
    expect(prismaStub.toolPermissionDelete).toHaveBeenCalledTimes(1);
    expect(svc.auditEvents).toHaveLength(1);
  });

  it("revokeAllRemembered：deleteMany 全表并审计 count；空表 no-op 不审计", async () => {
    prismaStub.toolPermissions = [
      {
        id: 7,
        workspaceId: 5,
        toolName: "run_command",
        createdAt: new Date(),
      },
      {
        id: 8,
        workspaceId: 6,
        toolName: "write_file",
        createdAt: new Date(),
      },
    ];
    const svc = makeGrantSvc(grantSessions({}));
    await handlerOf("permission:revokeAllRemembered")(null, TOKEN);
    // v12：deleteMany 限定本人空间（不再是全表裸删）
    expect(prismaStub.toolPermissionDeleteMany).toHaveBeenCalledWith({
      where: { workspaceId: { in: [5, 6] } },
    });
    expect(svc.auditEvents).toEqual([
      {
        eventType: "permission.remembered-revoked-all",
        decision: "info",
        detail: { count: 2 },
      },
    ]);
    // 空表再调：no-op 不再审计
    prismaStub.toolPermissions = [];
    await handlerOf("permission:revokeAllRemembered")(null, TOKEN);
    expect(svc.auditEvents).toHaveLength(1);
  });
});

describe("ChatService.handoverSummary（批 12 转办交接摘要）", () => {
  /** 会话归属/读取 stub（handoverSummary 只消费这两个面） */
  const handoverSessions = () => ({
    assertSessionOwned: vi.fn().mockResolvedValue(undefined),
    getSession: vi
      .fn()
      .mockResolvedValue({ id: 1, currentModelId: 7, userId: 1 }),
  });
  const chatRows = () => [
    {
      id: 1,
      sessionId: 1,
      role: "user",
      blocks: JSON.stringify([{ type: "text", text: "把项目交接出去" }]),
      error: null,
    },
    {
      id: 2,
      sessionId: 1,
      role: "assistant",
      blocks: JSON.stringify([{ type: "text", text: "好的，整理交接文档" }]),
      error: null,
    },
  ];
  const enabledModel = {
    id: 7,
    providerId: 3,
    modelId: "gpt-x",
    enabled: true,
  };
  const providerRow = {
    type: "openai-compatible",
    baseUrl: "https://api.demo.com",
    apiKey: null,
    extraHeaders: null,
    enabled: true,
  };

  it("正常：读消息 → 模型补全（会话当前模型）→ 返回剥围栏后 markdown", async () => {
    prismaStub.messages = chatRows();
    prismaStub.modelFindMany.mockResolvedValueOnce([enabledModel]);
    assembleReads.provider.findUnique.mockResolvedValueOnce(providerRow);
    const modelText = vi.fn(
      async () => "```markdown\n## 工作目标\n接管项目\n```",
    );
    const service = new ChatService(
      handoverSessions() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      modelText,
    );

    const result = await service.handoverSummary(1, 1);

    const [system, prompt] = modelText.mock.calls[0];
    expect(system).toContain("工作交接助手");
    expect(prompt).toContain("用户：把项目交接出去");
    expect(prompt).toContain("助手：好的，整理交接文档");
    expect(result).toContain("## 工作目标");
    expect(result).not.toContain("```");
  });

  it("无消息：明确报错，不调模型", async () => {
    prismaStub.messages = [];
    const modelText = vi.fn();
    const service = new ChatService(
      handoverSessions() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      modelText,
    );

    await expect(service.handoverSummary(1, 1)).rejects.toThrow("会话暂无消息");
    expect(modelText).not.toHaveBeenCalled();
  });

  it("无可用模型：明确报错（候选序全落空）", async () => {
    prismaStub.messages = chatRows();
    // 无启用模型：会话模型 7 不在启用集 → 候选序空
    prismaStub.modelFindMany.mockResolvedValueOnce([]);
    const service = new ChatService(handoverSessions() as never);

    await expect(service.handoverSummary(1, 1)).rejects.toThrow(
      "未配置可用模型",
    );
  });

  it("模型调用失败：错误原样上抛（前端 toast）", async () => {
    prismaStub.messages = chatRows();
    prismaStub.modelFindMany.mockResolvedValueOnce([enabledModel]);
    assembleReads.provider.findUnique.mockResolvedValueOnce(providerRow);
    const service = new ChatService(
      handoverSessions() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      vi.fn(async () => {
        throw new Error("TIMEOUT");
      }),
    );

    await expect(service.handoverSummary(1, 1)).rejects.toThrow("TIMEOUT");
  });
});

describe("ChatService.send workspace 图片附件收编（T11 文件窗图片 tab）", () => {
  /**
   * 空间绑定目录在数据根外：附件绝对路径落在空间内时收编（复制）进
   * attachments 根，ImageBlock 存数据根相对路径——不收编会被
   * imageAttachmentBlocks 白名单 + readImageAsDataUrl 防越根校验降级成
   * 「[图片 … 无法读取]」占位（模型收不到图、气泡永久失效）。
   * getEffectiveModelId=null：appendMessage 落库后 NO_MODEL 拒绝，不触网
   */
  const makeSendService = (workspaceRow: unknown) => {
    const sessions = {
      getSession: vi.fn().mockResolvedValue({
        id: 1,
        userId: 1,
        assistantId: null,
        archivedAt: null,
        workspaceId: 7,
      }),
      getWorkspace: vi.fn().mockResolvedValue(workspaceRow),
      appendMessage: vi.fn().mockResolvedValue(undefined),
      autotitleIfDefault: vi.fn().mockResolvedValue(undefined),
      getEffectiveModelId: vi.fn().mockResolvedValue(null),
    };
    return {
      sessions,
      service: new ChatService(sessions as unknown as SessionRepository),
    };
  };

  const sendBlocksOf = (sessions: {
    appendMessage: Mock;
  }): Array<{ type: string; text?: string; imagePath?: string }> =>
    JSON.parse(sessions.appendMessage.mock.calls[0][0].blocks);

  it("空间内图片收编进 attachments：落库 ImageBlock（相对数据根），不降级占位", async () => {
    const wsDir = await mkdtemp(nodePath.join(tmpdir(), "tianshu-ws-"));
    const img = nodePath.join(wsDir, "img", "shot.png");
    await mkdir(nodePath.dirname(img), { recursive: true });
    await writeFile(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { sessions, service } = makeSendService({
      id: 7,
      directoryPath: wsDir,
    });
    await expect(
      service.send(
        { sessionId: 1, content: "这是什么图", images: [{ absPath: img }] },
        1,
      ),
    ).rejects.toThrow("NO_MODEL"); // 用户消息已先行落库，模型解析才失败
    const blocks = sendBlocksOf(sessions);
    expect(blocks[0]).toEqual({ type: "text", text: "这是什么图" });
    // name 随收编副本（ws-<时间戳>-<随机>.png，同粘贴截图 paste-* 命名语义）
    expect(blocks[1]).toMatchObject({
      type: "image",
      mime: "image/png",
    });
    expect(String(blocks[1].name)).toMatch(/^ws-\d{14}-[0-9a-f]{8}\.png$/);
    // imagePath 为 attachments/ 下相对数据根路径：展示（file:readMessageImage）
    // 与模型回喂（loadImage）读回通道全兼容，且收编副本真实落盘
    expect(blocks[1].imagePath?.startsWith(`attachments${nodePath.sep}`)).toBe(
      true,
    );
    const copied = nodePath.join(appDataHome(), blocks[1].imagePath!);
    expect((await stat(copied)).isFile()).toBe(true);
  });

  it("空间未绑定目录 / 路径在空间外：维持白名单降级占位（安全语义不变）", async () => {
    const wsDir = await mkdtemp(nodePath.join(tmpdir(), "tianshu-ws-"));
    const foreign = await mkdtemp(nodePath.join(tmpdir(), "tianshu-notws-"));
    await writeFile(nodePath.join(foreign, "x.png"), Buffer.from([0x89]));
    for (const [row, images] of [
      [
        { id: 7, directoryPath: null },
        [{ absPath: nodePath.join(foreign, "x.png") }],
      ],
      [
        { id: 7, directoryPath: wsDir },
        [{ absPath: nodePath.join(foreign, "x.png") }],
      ],
    ] as const) {
      const { sessions, service } = makeSendService(row);
      await expect(
        service.send(
          { sessionId: 1, content: "问", images: images as never },
          1,
        ),
      ).rejects.toThrow("NO_MODEL");
      expect(sendBlocksOf(sessions)[1]).toEqual({
        type: "text",
        text: "[图片 x.png 无法读取]",
      });
    }
  });
});

describe("ChatService 自动压缩（spec §18 项 2）", () => {
  /** createChatModel 模块 mock 的可覆写入口（默认形态与 vi.mock 工厂一致） */
  const createChatModelMock = createChatModel as unknown as Mock;
  const restoreModelFactory = () =>
    createChatModelMock.mockImplementation(() => ({ invoke: invokeStub }));

  const providerRow = {
    id: 1,
    type: "openai-compatible",
    baseUrl: "https://x.example/v1",
    apiKey: "k",
    extraHeaders: null,
  };

  /**
   * 全链路替身：模型行（contextWindow/maxTokens 可调）+ provider 行 +
   * sessions 仓储 stub（send/compact 触及的方法全覆盖）。prismaStub.messages
   * 为静态种子（appendMessage 不回写）——压缩摘要回填读末条 assistant 行
   */
  const makeAutoService = () => {
    const sessions = {
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
    };
    return {
      sessions,
      service: new ChatService(sessions as unknown as SessionRepository),
      /** contextWindow 传 null 模拟未配置 */
      setModelRow: (contextWindow: number | null) => {
        assembleReads.model.findUnique.mockResolvedValue({
          id: 5,
          providerId: 1,
          modelId: "m",
          temperature: null,
          topP: null,
          maxTokens: 100,
          contextWindow,
        });
      },
    };
  };

  /** 大块历史种子：3 条 2 万字符文本（≈1.5 万 token，超小窗预算）+ 末条 id=900 assistant 摘要行（压缩回填读它） */
  const seedHistory = () => [
    {
      id: 1,
      sessionId: 1,
      role: "user",
      blocks: JSON.stringify([{ type: "text", text: "u".repeat(20000) }]),
      error: null,
    },
    {
      id: 2,
      sessionId: 1,
      role: "assistant",
      blocks: JSON.stringify([{ type: "text", text: "a".repeat(20000) }]),
      error: null,
    },
    {
      id: 3,
      sessionId: 1,
      role: "user",
      blocks: JSON.stringify([{ type: "text", text: "u".repeat(20000) }]),
      error: null,
    },
    {
      id: 900,
      sessionId: 1,
      role: "assistant",
      blocks: JSON.stringify([{ type: "text", text: "种子摘要" }]),
      error: null,
    },
  ];

  /** 脚本化模型接管 createChatModel：各次流式调用按累积序消费脚本 */
  const useScriptedModel = (...texts: string[]) => {
    const { model } = scriptedChatModel(
      texts.map((delta) => ({ steps: [{ kind: "text" as const, delta }] })),
    );
    createChatModelMock.mockImplementation(() => model);
    return model;
  };

  /** appendMessage 落库的指定角色首块文本（按调用序） */
  const persistedTextsOf = (
    sessions: { appendMessage: Mock },
    role: "user" | "assistant",
  ): string[] =>
    sessions.appendMessage.mock.calls
      .filter((call) => call[0].role === role)
      .map(
        (call) =>
          (JSON.parse(call[0].blocks)[0] as { text?: string }).text ?? "",
      );

  beforeEach(() => {
    prismaStub.messages = seedHistory();
    assembleReads.provider.findUnique.mockResolvedValue(providerRow);
    assembleReads.assistant.findUnique.mockResolvedValue(null);
    skillScanStub.skills = [];
  });

  afterEach(() => {
    restoreModelFactory();
    assembleReads.model.findUnique.mockReset();
    assembleReads.provider.findUnique.mockReset();
    assembleReads.assistant.findUnique.mockReset();
  });

  it("预算达 80% 阈值：压缩轮先于用户消息落库，指令带[自动压缩]前缀，摘要回填", async () => {
    const { sessions, service, setModelRow } = makeAutoService();
    setModelRow(10000);
    useScriptedModel("摘要内容", "回答");
    await service.send({ sessionId: 1, content: "用户问题" }, 1);
    // 清态 + 回填（回填读种子末条 assistant 行）
    expect(sessions.updateSummary.mock.calls).toEqual([
      [1, null, null],
      [1, "种子摘要", 900],
    ]);
    // 落库顺序：[自动压缩]指令 user → 摘要 assistant → 原用户消息 → 回答
    expect(persistedTextsOf(sessions, "user")).toEqual([
      AUTO_COMPACT_DIRECTIVE,
      "用户问题",
    ]);
    expect(persistedTextsOf(sessions, "assistant")).toEqual([
      "摘要内容",
      "回答",
    ]);
    // 时序：清态先于指令轮、摘要回填先于用户消息（压缩先于原发送）
    const summaryOrders = sessions.updateSummary.mock.invocationCallOrder;
    const appendOrders = sessions.appendMessage.mock.invocationCallOrder;
    expect(summaryOrders[0]).toBeLessThan(appendOrders[0]);
    expect(summaryOrders[1]).toBeLessThan(appendOrders[2]);
  });

  it("未达阈值（contextWindow 充裕）：不压缩，直接落库用户消息", async () => {
    const { sessions, service, setModelRow } = makeAutoService();
    setModelRow(1000000);
    useScriptedModel("回答");
    await service.send({ sessionId: 1, content: "用户问题" }, 1);
    expect(sessions.updateSummary).not.toHaveBeenCalled();
    expect(persistedTextsOf(sessions, "user")).toEqual(["用户问题"]);
    expect(persistedTextsOf(sessions, "assistant")).toEqual(["回答"]);
  });

  it("压缩指令轮豁免检测：手动/自动指令原文直发不再触发压缩", async () => {
    const { sessions, service, setModelRow } = makeAutoService();
    setModelRow(10000);
    const model = useScriptedModel("回答", "回答");
    // 手动指令原文（超限历史 + 小窗也不触发——防摘要轮递归）
    await service.send({ sessionId: 1, content: COMPACT_DIRECTIVE }, 1);
    expect(sessions.updateSummary).not.toHaveBeenCalled();
    // 自动指令原文（自动压缩轮的重放同样豁免）
    await service.send({ sessionId: 1, content: AUTO_COMPACT_DIRECTIVE }, 1);
    expect(sessions.updateSummary).not.toHaveBeenCalled();
    expect(model.calls).toBe(2);
    expect(persistedTextsOf(sessions, "user")).toEqual([
      COMPACT_DIRECTIVE,
      AUTO_COMPACT_DIRECTIVE,
    ]);
  });

  it("contextWindow 未配置：不检测不压缩（与 truncateHistory 现状一致）", async () => {
    const { sessions, service, setModelRow } = makeAutoService();
    setModelRow(null);
    useScriptedModel("回答");
    await service.send({ sessionId: 1, content: "用户问题" }, 1);
    expect(sessions.updateSummary).not.toHaveBeenCalled();
    expect(persistedTextsOf(sessions, "user")).toEqual(["用户问题"]);
  });

  it("冷却带：压缩后成本未涨 20% 不再压；涨过后再压", async () => {
    const { sessions, service, setModelRow } = makeAutoService();
    setModelRow(10000);
    useScriptedModel("摘要1", "答1", "答2", "摘要2", "答3");
    // 首发触发（种子静态：压缩后即时成本与触发成本同值）
    await service.send({ sessionId: 1, content: "问题1" }, 1);
    expect(sessions.updateSummary).toHaveBeenCalledTimes(2);
    // 再发：成本未涨 20% → 冷却跳过（无清态/回填，只有原消息轮）
    await service.send({ sessionId: 1, content: "问题2" }, 1);
    expect(sessions.updateSummary).toHaveBeenCalledTimes(2);
    expect(persistedTextsOf(sessions, "user")).toEqual([
      AUTO_COMPACT_DIRECTIVE,
      "问题1",
      "问题2",
    ]);
    // 历史再涨 ≥20%（追加 2 万字符 ≈ +1 万 token）→ 解除冷却再压
    prismaStub.messages.splice(3, 0, {
      id: 4,
      sessionId: 1,
      role: "user",
      blocks: JSON.stringify([{ type: "text", text: "z".repeat(20000) }]),
      error: null,
    });
    await service.send({ sessionId: 1, content: "问题3" }, 1);
    expect(sessions.updateSummary).toHaveBeenCalledTimes(4);
    expect(persistedTextsOf(sessions, "user")).toEqual([
      AUTO_COMPACT_DIRECTIVE,
      "问题1",
      "问题2",
      AUTO_COMPACT_DIRECTIVE,
      "问题3",
    ]);
  });

  it("压缩失败静默放行：用户消息照常发送（硬截兜底仍在 truncateHistory）", async () => {
    const { sessions, service, setModelRow } = makeAutoService();
    setModelRow(10000);
    useScriptedModel("回答");
    sessions.updateSummary.mockRejectedValueOnce(new Error("DB 写失败"));
    await expect(
      service.send({ sessionId: 1, content: "用户问题" }, 1),
    ).resolves.toBeUndefined();
    expect(persistedTextsOf(sessions, "user")).toEqual(["用户问题"]);
    expect(persistedTextsOf(sessions, "assistant")).toEqual(["回答"]);
    // 失败未写冷却基线：下次超限仍会再试压缩
    expect(sessions.updateSummary).toHaveBeenCalledTimes(1);
  });

  it("压缩轮摘要落库抛错：吞错 catch 重注册 abort，原发送期间注册不缺位（spec §19 项 2）", async () => {
    const { sessions, service, setModelRow } = makeAutoService();
    setModelRow(10000);
    useScriptedModel("摘要内容", "回答");
    const internal = service as unknown as {
      aborts: Map<number, AbortController>;
    };
    // 每次 appendMessage 落库时点的注册表快照：预期四次（压缩指令 user →
    // 摘要 assistant 抛错 → 原用户消息 → 回答）注册全在场——修复前第
    // 3/4 次缺位（吞错 catch 未重注册，原发送期间 stop/并发守卫失效）
    const registeredOnAppend: boolean[] = [];
    sessions.appendMessage.mockImplementation(async () => {
      registeredOnAppend.push(internal.aborts.has(1));
      if (registeredOnAppend.length === 2) {
        throw new Error("DB 写失败");
      }
    });
    await expect(
      service.send({ sessionId: 1, content: "用户问题" }, 1),
    ).resolves.toBeUndefined();
    expect(registeredOnAppend).toEqual([true, true, true, true]);
    expect(persistedTextsOf(sessions, "user")).toEqual([
      AUTO_COMPACT_DIRECTIVE,
      "用户问题",
    ]);
    // 摘要 assistant 落库「尝试」仍在调用记录中（实现抛错于记录之后），
    // 实际写入失败；原发送的回答轮正常落库
    expect(persistedTextsOf(sessions, "assistant")).toEqual([
      "摘要内容",
      "回答",
    ]);
  });

  it("手动 /compact 路径回归：指令不带前缀，清态/回填流程不变", async () => {
    const { sessions, service, setModelRow } = makeAutoService();
    setModelRow(10000);
    useScriptedModel("摘要内容");
    await service.compact(1, 1);
    expect(sessions.updateSummary.mock.calls).toEqual([
      [1, null, null],
      [1, "种子摘要", 900],
    ]);
    expect(persistedTextsOf(sessions, "user")).toEqual([COMPACT_DIRECTIVE]);
    expect(persistedTextsOf(sessions, "assistant")).toEqual(["摘要内容"]);
  });

  it("chat:compact handler 接线不变：IPC 直达手动压缩且指令无前缀", async () => {
    const { sessions, setModelRow } = makeAutoService();
    setModelRow(10000);
    useScriptedModel("摘要内容");
    // 最新注册的 chat:compact handler 即本 service 构造时注册的那个
    const handler = (ipcMain.handle as unknown as Mock).mock.calls
      .filter(([name]) => name === "chat:compact")
      .at(-1)![1] as (
      event: { sender: unknown },
      sessionId: number,
      token: string,
    ) => Promise<void>;
    await handler({ sender: undefined }, 1, TOKEN);
    expect(sessions.updateSummary.mock.calls).toEqual([
      [1, null, null],
      [1, "种子摘要", 900],
    ]);
    expect(persistedTextsOf(sessions, "user")).toEqual([COMPACT_DIRECTIVE]);
  });
});
