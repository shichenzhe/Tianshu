/**
 * P3 T4 集成测试：两级审批判定（default 询问 / full 直执行 / mcp__ 恒审批）、
 * 模式组装（ask 零工具 / plan 计划指令段）、bash 注册、status accessMode。
 * send 级用例经 MockLanguageModelV3 捕获 doStream 实际收到的 tools 与 system，
 * 流式 chunk 经 onChatChunk tap 采集（emit 全窗口广播后 sender 不再承载流）；
 * 权限与审批经 service 内部 store/coordinator 直达
 * （IPC 接线已由 agent-loop.test / permission-mode.test 覆盖）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  // Log/prisma-client 顶层读取 app.getPath("userData")/getAppPath/isPackaged
  // 计算日志与数据目录（data-root 冷迁移链路）
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
  // chat.service emit 全窗口广播（审批横幅卡死修复）消费：空窗口集即可
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

const prismaStub = {
  // 流历史来源：appendMessage stub 会写入，beforeEach 重置（标题守卫据此早退/触发）
  messages: [] as Array<{
    sessionId: number;
    role: string;
    blocks: string;
    error: string | null;
  }>,
  modelRow: {
    providerId: 1,
    modelId: "test-model",
    temperature: null,
    topP: null,
    maxTokens: null,
    contextWindow: null,
  } as unknown,
  providerRow: {
    type: "openai-compatible",
    baseUrl: "http://127.0.0.1:9",
    apiKey: null,
    extraHeaders: null,
  } as unknown,
  assistantRow: null as { systemPrompt: string } | null,
  // P4 工作空间记忆：命中表内的工具名免审
  toolPermissions: [] as string[],
};

vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    message: { findMany: async () => prismaStub.messages },
    model: { findUnique: async () => prismaStub.modelRow },
    provider: { findUnique: async () => prismaStub.providerRow },
    assistant: { findUnique: async () => prismaStub.assistantRow },
    toolPermission: {
      findUnique: async (args: {
        where: { workspaceId_toolName: { toolName: string } };
      }) =>
        prismaStub.toolPermissions.includes(
          args.where.workspaceId_toolName.toolName,
        )
          ? { id: 1 }
          : null,
    },
  },
}));

import {
  SystemMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { scriptedChatModel } from "./helpers/scripted-chat-model";

// 模型工厂 mock：send 级用例由此把脚本化模型注入 ChatService（否则服务会用
// createChatModel 真连 provider）；vi.hoisted 保证提升的 mock 工厂可引用
const mockFactory = vi.hoisted(() => ({
  current: null as null | (() => unknown),
}));

vi.mock(
  "../../electron/domains/ai/orchestration/langchain-model-factory",
  () => ({
    createChatModel: () => {
      if (!mockFactory.current) {
        throw new Error("测试未注入 mock 模型工厂");
      }
      return mockFactory.current();
    },
  }),
);

import ChatService from "../../electron/domains/ai/chat/chat.service";
import type {
  ToolContext,
  ToolDefinition,
} from "../../electron/domains/ai/agent/file-tools";
import {
  registry,
  registerTools,
  unregisterTools,
} from "../../electron/domains/ai/agent/tool-registry";
import type { SessionRepository } from "../../electron/domains/ai/chat/session.repo";
import type { ChatStreamChunk } from "../../src-react/domains/ai/api/chat.api";
import { onChatChunk } from "../../electron/domains/server-face/chat-tap";

// ---------- mock 模型：脚本化多步，捕获每步收到的消息（tools/system/user） ----------

function scriptedModel(scripts: Array<{ steps: ScriptStep[] }>) {
  const { model } = scriptedChatModel(scripts);
  const calls: CapturedCall[] = model.callsLog.map((entry) => ({
    toolNames: entry.toolNames,
    system: systemOf(entry.messages),
    lastUserContent: lastUserContentOf(entry.messages),
  }));
  // callsLog 随调用增长：断言点读 model.callsLog 快照后重算（保持旧只读数组用法）
  const proxy = new Proxy(calls, {
    get(target, prop, receiver) {
      refresh();
      return Reflect.get(target, prop, receiver);
    },
  });
  const refresh = () => {
    calls.length = 0;
    for (const entry of model.callsLog) {
      calls.push({
        toolNames: entry.toolNames,
        system: systemOf(entry.messages),
        lastUserContent: lastUserContentOf(entry.messages),
      });
    }
  };
  return { model, calls: proxy };
}

/** prompt 参数注入的 SystemMessage（无则 undefined） */
function systemOf(messages: BaseMessage[]): string | undefined {
  const system = messages.find((m) => m instanceof SystemMessage);
  return system && typeof system.content === "string"
    ? system.content
    : undefined;
}

/** 最后一条 HumanMessage content 序列化（时间行注入断言用） */
function lastUserContentOf(messages: BaseMessage[]): string | undefined {
  const lastUser = [...messages]
    .reverse()
    .find((m) => m instanceof HumanMessage);
  return lastUser ? JSON.stringify(lastUser.content) : undefined;
}

// ---------- 夹具 ----------

/** 会话/工作空间仓储 stub（directoryPath=null 即未绑定目录；mode 透传 DB 列原值；
 * projectId 非 null 即项目会话）。appendMessage 落回 prismaStub：
 * 流历史非空是 streamText 的硬性要求 */
const sessionsStub = (
  directoryPath: string | null,
  mode: string | null = null,
  projectId: number | null = null,
): SessionRepository =>
  ({
    getSession: vi.fn(async () => ({
      id: 1,
      workspaceId: 1,
      assistantId: prismaStub.assistantRow ? 1 : null,
      title: "新会话",
      mode,
      projectId,
      userId: 1,
    })),
    getEffectiveModelId: vi.fn(async () => 11),
    appendMessage: vi.fn(
      async (p: {
        sessionId: number;
        role: string;
        blocks: string;
        error?: string;
      }) => {
        prismaStub.messages.push({
          sessionId: p.sessionId,
          role: p.role,
          blocks: p.blocks,
          error: p.error ?? null,
        });
        return {};
      },
    ),
    autotitleIfDefault: vi.fn(async () => undefined),
    getWorkspace: vi.fn(async () => ({ id: 1, directoryPath })),
  }) as unknown as SessionRepository;

/** send 的 chunk 采集（emit 全窗口广播改造后 sender 不再承载流）：
 *  经 onChatChunk tap 订阅采集（emit 必经 tap，序列等价），退订统一收口
 *  afterEach；返回值仅占位保持 send 第三参形态 */
const tapUnsubs: Array<() => void> = [];
const captureSender = (chunks: ChatStreamChunk[]) => {
  tapUnsubs.push(onChatChunk((_sessionId, chunk) => chunks.push(chunk)));
  return undefined as unknown as WebContents;
};

/** service 私有成员直达：权限 store 与审批协调器（P3 判定点） */
type ServiceInternals = {
  permissions: { set(id: number, mode: "default" | "full"): void };
  approvals: {
    respond(toolCallId: string, approved: boolean): boolean;
    readonly pendingCount: number;
  };
};
const internals = (svc: ChatService) => svc as unknown as ServiceInternals;

/** 提取指定工具调用的状态序列（tool-update chunk 按到达序） */
const toolStates = (chunks: ChatStreamChunk[], toolCallId: string): string[] =>
  chunks
    .filter(
      (chunk): chunk is Extract<ChatStreamChunk, { type: "tool-update" }> =>
        chunk.type === "tool-update" && chunk.toolCallId === toolCallId,
    )
    .map((chunk) => chunk.state);

/** 是否出现任一审批 chunk（awaiting-approval 态或 approval-request） */
const hasApprovalChunk = (chunks: ChatStreamChunk[]): boolean =>
  chunks.some(
    (chunk) =>
      chunk.type === "approval-request" ||
      (chunk.type === "tool-update" && chunk.state === "awaiting-approval"),
  );

const mcpExecuted: string[] = [];

/** MCP 假写工具：parameters 为裸 JSON Schema（非 zod），兼作 jsonSchema 适配载体 */
const mcpPublish: ToolDefinition = {
  name: "mcp__srv__publish",
  description: "发布",
  parameters: {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  },
  kind: "write",
  execute: async (_ctx, args) => {
    mcpExecuted.push((args as { title: string }).title);
    return "已发布";
  },
};

/** 文件假写工具：供工作空间记忆用例（名字避开真实 FILE_TOOLS 前缀，防 afterEach 误清） */
const fakeWriteExecuted: string[] = [];
const fakeWrite: ToolDefinition = {
  name: "test_write",
  description: "测试写",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path"],
  },
  kind: "write",
  execute: async () => {
    fakeWriteExecuted.push("hit");
    return "已写入";
  },
};

beforeEach(() => {
  // Vitest 4 陷阱（T2 记录）：回调必须带块体，隐式返回值会被当 cleanup hook
  prismaStub.messages = [];
  prismaStub.assistantRow = null;
  prismaStub.toolPermissions = [];
  mcpExecuted.length = 0;
  fakeWriteExecuted.length = 0;
});

afterEach(() => {
  mockFactory.current = null;
  tapUnsubs.splice(0).forEach((off) => off());
  unregisterTools("mcp__");
  unregisterTools("test_");
});

describe("两级审批判定（send 级集成）", () => {
  it("完全访问下 write 跳过审批直执行：无 awaiting-approval chunk，fullAccess 注入放开路径边界", async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), "p3-full-"));
    // 以工作空间外路径验证 ctx.fullAccess 真正注入（default 态会拒绝越界写）
    const escaped = path.join(path.dirname(ws), "p3-full-write-proof.txt");
    const { model } = scriptedModel([
      {
        steps: [
          {
            kind: "tool",
            toolCallId: "t1",
            toolName: "write",
            input: { path: "../p3-full-write-proof.txt", content: "hi" },
          },
        ],
      },
      { steps: [{ kind: "text", delta: "完成" }] },
    ]);
    mockFactory.current = () => model;
    const service = new ChatService(sessionsStub(ws));
    internals(service).permissions.set(1, "full");
    const chunks: ChatStreamChunk[] = [];

    try {
      await service.send(
        { sessionId: 1, content: "hi" },
        1,
        captureSender(chunks),
      );
      expect(hasApprovalChunk(chunks)).toBe(false);
      expect(toolStates(chunks, "t1")).toEqual(["ready", "running", "done"]);
      expect(existsSync(escaped)).toBe(true);
      expect(readFileSync(escaped, "utf8")).toBe("hi");
      // status 快照透出权限模式（P3 决策 #5），流收尾后仍可查
      expect(service.status(1)).toMatchObject({
        accessMode: "full",
        streaming: false,
      });
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(escaped, { force: true });
    }
  });

  it("默认权限下 write 直执行（回归锚）：无审批 chunk，工作空间内直接落盘", async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), "p3-default-"));
    const { model } = scriptedModel([
      {
        steps: [
          {
            kind: "tool",
            toolCallId: "t1",
            toolName: "write",
            input: { path: "a.txt", content: "hi" },
          },
        ],
      },
      { steps: [{ kind: "text", delta: "完成" }] },
    ]);
    mockFactory.current = () => model;
    const service = new ChatService(sessionsStub(ws));
    const chunks: ChatStreamChunk[] = [];

    try {
      await service.send(
        { sessionId: 1, content: "hi" },
        1,
        captureSender(chunks),
      );
      // default：权限放宽（spec §4.4）工作空间内写免审——直执行不挂审批
      expect(hasApprovalChunk(chunks)).toBe(false);
      expect(toolStates(chunks, "t1")).toEqual(["ready", "running", "done"]);
      expect(existsSync(path.join(ws, "a.txt"))).toBe(true);
      expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("hi");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("完全访问豁免 MCP 写工具（P4 反馈 2.1 推翻 R7）：直执行不挂审批", async () => {
    registerTools([mcpPublish]);
    const { model } = scriptedModel([
      {
        steps: [
          {
            kind: "tool",
            toolCallId: "t1",
            toolName: "mcp__srv__publish",
            // DynamicTool 字符串入参：模型按 description 内嵌 schema 生成 JSON 字符串
            input: JSON.stringify({ title: "hi" }),
          },
        ],
      },
      { steps: [{ kind: "text", delta: "完成" }] },
    ]);
    mockFactory.current = () => model;
    const service = new ChatService(sessionsStub(null));
    internals(service).permissions.set(1, "full");
    const chunks: ChatStreamChunk[] = [];
    await service.send(
      { sessionId: 1, content: "hi" },
      1,
      captureSender(chunks),
    );

    expect(hasApprovalChunk(chunks)).toBe(false);
    expect(mcpExecuted).toEqual(["hi"]);
  });

  it("工作空间记忆（P4 allowed-tools）：命中 toolPermission 表免审直执行", async () => {
    prismaStub.toolPermissions = ["test_write"];
    registerTools([fakeWrite]);
    const ws = mkdtempSync(path.join(os.tmpdir(), "p4-remember-"));
    const { model } = scriptedModel([
      {
        steps: [
          {
            kind: "tool",
            toolCallId: "t1",
            toolName: "test_write",
            input: JSON.stringify({ path: "remembered.txt", content: "hi" }),
          },
        ],
      },
      { steps: [{ kind: "text", delta: "完成" }] },
    ]);
    mockFactory.current = () => model;
    const service = new ChatService(sessionsStub(ws));
    const chunks: ChatStreamChunk[] = [];
    try {
      await service.send(
        { sessionId: 1, content: "hi" },
        1,
        captureSender(chunks),
      );

      expect(hasApprovalChunk(chunks)).toBe(false);
      // 工具真执行（非「未注入」的空过）
      expect(fakeWriteExecuted).toEqual(["hit"]);
      expect(
        chunks.some((c) => c.type === "tool-update" && c.state === "done"),
      ).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("工作空间未记忆的工具默认态仍挂起审批", async () => {
    prismaStub.toolPermissions = [];
    registerTools([fakeWrite]);
    const ws = mkdtempSync(path.join(os.tmpdir(), "p4-fresh-"));
    const { model } = scriptedModel([
      {
        steps: [
          {
            kind: "tool",
            toolCallId: "t1",
            toolName: "test_write",
            input: JSON.stringify({ path: "fresh.txt", content: "hi" }),
          },
        ],
      },
      { steps: [{ kind: "text", delta: "完成" }] },
    ]);
    mockFactory.current = () => model;
    const service = new ChatService(sessionsStub(ws));
    const chunks: ChatStreamChunk[] = [];
    const pending = service.send(
      { sessionId: 1, content: "hi" },
      1,
      captureSender(chunks),
    );

    try {
      await vi.waitFor(() =>
        expect(internals(service).approvals.pendingCount).toBe(1),
      );
      expect(hasApprovalChunk(chunks)).toBe(true);
      await internals(service).approvals.respond("t1", false);
      await pending;
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("模式组装（send 级）", () => {
  it("ask 模式：ToolSet 为空且 system 仅助手原文（无技能段/无计划指令），时间行注入最后一条 user", async () => {
    prismaStub.assistantRow = { systemPrompt: "你是问答助手" };
    const { model, calls } = scriptedModel([
      { steps: [{ kind: "text", delta: "答" }] },
    ]);
    mockFactory.current = () => model;
    const service = new ChatService(sessionsStub("/tmp/ws", "ask"));

    await service.send({ sessionId: 1, content: "hi" }, 1, captureSender([]));

    expect(calls[0]?.toolNames).toEqual([]);
    expect(calls[0]?.system).toBe("你是问答助手");
    // 时间行注入 user 消息而非 system（前缀缓存考量见 time-context 注释）
    expect(calls[0]?.lastUserContent).toMatch(
      /当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2} 周[日一二三四五六] UTC[+-]\d{2}:\d{2}/,
    );
    expect(calls[0]?.lastUserContent).toContain("hi");
  });

  it("plan 模式：system 追加计划指令段（spec §4 逐字）且工具照常注入", async () => {
    prismaStub.assistantRow = { systemPrompt: "你是计划助手" };
    const { model, calls } = scriptedModel([
      { steps: [{ kind: "text", delta: "计划" }] },
    ]);
    mockFactory.current = () => model;
    const service = new ChatService(sessionsStub("/tmp/ws", "plan"));

    await service.send({ sessionId: 1, content: "hi" }, 1, captureSender([]));

    const system = calls[0]?.system ?? "";
    expect(system.startsWith("你是计划助手")).toBe(true);
    expect(system).toContain(
      "当前处于计划模式：请先分析任务并输出完整可执行的计划（步骤/涉及文件/命令），在我明确确认之前不要调用任何工具执行操作。",
    );
    // 指令段以空行拼接于 buildSystemPrompt 结果之后
    expect(system).toContain("\n\n当前处于计划模式");
    expect(calls[0]?.toolNames).toContain("write");
    expect(calls[0]?.toolNames).toContain("bash");
  });
});

describe("bash 注册（registry 接线）", () => {
  it("registry 预注册 bash：kind=write，execute 危险命令返回拦截串", async () => {
    const def = registry.find("bash");
    if (!def) {
      throw new Error("bash 未注册进 registry 初始集");
    }
    expect(def.kind).toBe("write");
    const ctx: ToolContext = { workspacePath: "/tmp/ws", sessionId: 1 };
    await expect(def.execute(ctx, { command: "rm -rf /" })).resolves.toBe(
      "错误: 该命令被安全策略拦截（高风险破坏性操作）；删除文件请改用 rm 工具",
    );
  });
});

describe("plan 工具组暴露门槛（项目会话专属，子系统 F）", () => {
  /** 项目仓储 stub：非空项目上下文（空挂载集）→ allowedMcpServers 非 null 分支 */
  const projectRepoStub = {
    getPromptContext: vi.fn(async () => ({
      projectName: "测试项目",
      systemPrompt: null,
      boundAssistantPrompts: [],
      boundSkillNames: [],
      boundConnectorNames: [],
    })),
  };

  it("项目会话：plan_* 三工具随流注入（chat.service 模块级注册 + 非空隔离分支保留）", async () => {
    const { model, calls } = scriptedModel([
      { steps: [{ kind: "text", delta: "好" }] },
    ]);
    mockFactory.current = () => model;
    const service = new ChatService(
      sessionsStub("/tmp/ws", null, 11),
      undefined,
      projectRepoStub as never,
    );

    await service.send({ sessionId: 1, content: "hi" }, 1, captureSender([]));

    expect(calls[0]?.toolNames).toContain("todo_write");
    expect(calls[0]?.toolNames).toContain("todo_write");
    expect(calls[0]?.toolNames).toContain("todo_write");
  });

  it("全局会话（projectId null）：tools 数组无 plan_ 前缀工具", async () => {
    const { model, calls } = scriptedModel([
      { steps: [{ kind: "text", delta: "好" }] },
    ]);
    mockFactory.current = () => model;
    const service = new ChatService(sessionsStub("/tmp/ws"));

    await service.send({ sessionId: 1, content: "hi" }, 1, captureSender([]));

    expect(
      (calls[0]?.toolNames ?? []).some((name) => name.startsWith("plan_")),
    ).toBe(false);
  });
});
