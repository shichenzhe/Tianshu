/**
 * P2 T5 集成测试：chat.service ToolSet 合并 MCP 工具与 read_skill。
 * send 级用例经 MockLanguageModelV3 捕获 doStream 实际收到的 tools（最真实边界：
 * 组装错误或 jsonSchema 适配缺失会让 streamText 直接抛错）；
 * 审批与适配细节用 runChatStream 级用例定点覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
};

vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    message: { findMany: async () => prismaStub.messages },
    model: { findUnique: async () => prismaStub.modelRow },
    provider: { findUnique: async () => prismaStub.providerRow },
  },
}));

import { scriptedChatModel } from "./helpers/scripted-chat-model";

// 模型工厂 mock：send 级用例由此把脚本化模型注入 ChatService（否则服务会用
// createChatModel 真连 provider）；vi.hoisted 保证提升的 mock 工厂可引用
const mockFactory = vi.hoisted(() => ({
  current: null as null | (() => unknown),
}));

vi.mock(
  "../../electron/domains/ai/orchestration/langchain-model-factory",
  () => ({
    createChatModel: vi.fn(() => {
      if (!mockFactory.current) {
        throw new Error("测试未注入 mock 模型工厂");
      }
      return mockFactory.current();
    }),
  }),
);

import { createChatModel } from "../../electron/domains/ai/orchestration/langchain-model-factory";
import ChatService, {
  runChatStream,
} from "../../electron/domains/ai/chat/chat.service";
import type { AgentStreamOptions } from "../../electron/domains/ai/agent/tool-gate";
import { ApprovalCoordinator } from "../../electron/domains/ai/agent/approval";
import type { ToolDefinition } from "../../electron/domains/ai/agent/file-tools";
import {
  registerTools,
  unregisterTools,
} from "../../electron/domains/ai/agent/tool-registry";
import type { ChatStreamChunk } from "../../src-react/domains/ai/api/chat.api";
import type { SessionRepository } from "../../electron/domains/ai/chat/session.repo";

const userHistory = [
  {
    role: "user" as const,
    blocks: JSON.stringify([{ type: "text", text: "hi" }]),
  },
];

// ---------- mock 模型：脚本化多步（LangChain 替身），bindTools 捕获注入工具名 ----------

function scriptedModel(scripts: Array<{ steps: ScriptStep[] }>) {
  const { model } = scriptedChatModel(scripts);
  // send 级断言在 send 完成后读取：从调用日志重建快照数组
  const capturedToolNames: string[][] = [];
  Object.defineProperty(capturedToolNames, "refresh", {
    value: () => {
      capturedToolNames.length = 0;
      for (const entry of model.callsLog)
        capturedToolNames.push(entry.toolNames);
    },
  });
  const proxy = new Proxy(capturedToolNames, {
    get(target, prop, receiver) {
      (target as { refresh?: () => void }).refresh?.();
      return Reflect.get(target, prop, receiver);
    },
  });
  return { model, capturedToolNames: proxy };
}

// ---------- 夹具 ----------

/** MCP 假工具：parameters 为裸 JSON Schema（非 zod），兼作 jsonSchema 适配载体 */
const mcpEcho: ToolDefinition = {
  name: "mcp__srv__echo",
  description: "回声",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  kind: "read",
  execute: async () => "pong",
};

beforeEach(() => {
  registerTools([mcpEcho]);
  prismaStub.messages = [];
  prismaStub.modelRow = {
    providerId: 1,
    modelId: "test-model",
    temperature: null,
    topP: null,
    maxTokens: null,
    contextWindow: null,
  } as unknown;
});

afterEach(() => {
  unregisterTools("mcp__");
  mockFactory.current = null;
});

/** 会话/工作空间仓储 stub（directoryPath=null 即未绑定目录）。
 * appendMessage 落回 prismaStub：流历史非空是 streamText 的硬性要求 */
const sessionsStub = (directoryPath: string | null): SessionRepository =>
  ({
    getSession: vi.fn(async () => ({
      id: 1,
      workspaceId: 1,
      assistantId: null,
      title: "新会话",
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
    getWorkspace: vi.fn(async () => ({ directoryPath })),
  }) as unknown as SessionRepository;

const makeAgent = (
  approvals: ApprovalCoordinator,
  fullAccess = false,
  allowedTools: string[] = [],
): AgentStreamOptions => ({
  sessionId: 1,
  workspacePath: "/tmp/ws",
  fullAccess: () => fullAccess,
  isToolAllowed: async (toolName: string) => allowedTools.includes(toolName),
  requestApproval: (toolCallId, argSummary) =>
    approvals.request(toolCallId, argSummary),
});

describe("ToolSet 组装（send 级集成）", () => {
  it("未绑定工作空间：read_skill 常驻 + mcp__ 透传，不含文件工具", async () => {
    const { model, capturedToolNames } = scriptedModel([
      { steps: [{ kind: "text", delta: "好" }] },
    ]);
    mockFactory.current = () => model;
    const service = new ChatService(sessionsStub(null));

    await service.send({ sessionId: 1, content: "hi" });

    const names = capturedToolNames[0] ?? [];
    expect(names).toContain("read_skill");
    expect(names).toContain("mcp__srv__echo");
    expect(names.filter((name) => name.startsWith("mcp__"))).toEqual([
      "mcp__srv__echo",
    ]);
    expect(names).not.toContain("read_file");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("list_dir");
    expect(names).not.toContain("search_files");
  });

  it("采样/限额参数随构造下发（T3-3 R1）：modelRow 的 topP/maxTokens 到达 createChatModel 第三参", async () => {
    // 行级覆盖共享 modelRow（mergeParams 链：modelRow → merged → 构造 options）
    prismaStub.modelRow = {
      providerId: 1,
      modelId: "test-model",
      temperature: 0.6,
      topP: 0.9,
      maxTokens: 2048,
      contextWindow: null,
    };
    const { model } = scriptedModel([
      { steps: [{ kind: "text", delta: "好" }] },
    ]);
    mockFactory.current = () => model;
    const service = new ChatService(sessionsStub(null));
    vi.mocked(createChatModel).mockClear();

    await service.send({ sessionId: 1, content: "hi" });

    expect(vi.mocked(createChatModel)).toHaveBeenCalledWith(
      expect.objectContaining({ type: "openai-compatible" }),
      "test-model",
      { temperature: 0.6, topP: 0.9, maxTokens: 2048 },
    );
  });

  it("绑定工作空间：文件五件 + read_skill + registry 注册的 mcp__ 全量", async () => {
    const { model, capturedToolNames } = scriptedModel([
      { steps: [{ kind: "text", delta: "好" }] },
    ]);
    mockFactory.current = () => model;
    const service = new ChatService(sessionsStub("/tmp/ws"));

    await service.send({ sessionId: 1, content: "hi" });

    const names = capturedToolNames[0] ?? [];
    // registry 顺序：read_skill 在前，其后为文件五件（read/write/list/search/delete）+
    // run_command（P3 注册）+ web 工具（web_fetch/open_browser，W3 注册）+
    // browser_use 四件（snapshot/navigate/click/type，操控绑定 tab），
    // mcp__ 注册序殿后
    expect(names.filter((name) => !name.startsWith("mcp__"))).toEqual([
      "read_skill",
      "read_file",
      "write_file",
      "list_dir",
      "search_files",
      "delete_file",
      "run_command",
      "web_fetch",
      "open_browser",
      "browser_snapshot",
      "browser_navigate",
      "browser_click",
      "browser_type",
      "show_widget",
    ]);
    expect(names).toContain("mcp__srv__echo");
  });
});

describe("MCP 审批与 jsonSchema 适配（runChatStream 级）", () => {
  it("完全访问豁免 MCP 写工具（P4 反馈 2.1 推翻 R7）：直执行不挂审批", async () => {
    const approvals = new ApprovalCoordinator();
    const executed: string[] = [];
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
        executed.push((args as { title: string }).title);
        return "已发布";
      },
    };
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
      { steps: [{ kind: "text", delta: "继续" }] },
    ]);
    const chunks: ChatStreamChunk[] = [];

    const result = await runChatStream({
      model,
      history: userHistory,
      params: {},
      toolDefinitions: [mcpPublish],
      agent: makeAgent(approvals, true), // 完全访问已开启
      onChunk: (chunk) => chunks.push(chunk),
    });

    // 新语义：full 下 MCP 直执行——无挂起、无审批 chunk、工具已跑
    expect(approvals.pendingCount).toBe(0);
    expect(chunks).not.toContainEqual(
      expect.objectContaining({ type: "approval-request" }),
    );
    expect(executed).toEqual(["hi"]);
    expect(result.blocks[0]).toMatchObject({
      type: "tool_call",
      toolName: "mcp__srv__publish",
      state: "done",
      output: "已发布",
    });
    expect(result.errorCode).toBeUndefined();
  });

  it("jsonSchema 适配：裸 JSON Schema parameters 注入 SDK 不崩且工具可执行", async () => {
    const { model } = scriptedModel([
      {
        steps: [
          {
            kind: "tool",
            toolCallId: "t1",
            toolName: "mcp__srv__echo",
            input: JSON.stringify({ text: "ping" }),
          },
        ],
      },
      { steps: [{ kind: "text", delta: "done" }] },
    ]);

    const result = await runChatStream({
      model,
      history: userHistory,
      params: {},
      toolDefinitions: [mcpEcho],
      agent: makeAgent(new ApprovalCoordinator()),
    });

    // 裸对象若未经 jsonSchema() 包装，streamText 组装 ToolSet 即抛错
    expect(result.errorCode).toBeUndefined();
    expect(result.blocks[0]).toMatchObject({
      type: "tool_call",
      toolName: "mcp__srv__echo",
      state: "done",
      output: "pong",
    });
  });
});
