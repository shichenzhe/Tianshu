/**
 * P2 T5 集成测试：chat.service ToolSet 合并 MCP 工具与 read_skill。
 * send 级用例经 MockLanguageModelV3 捕获 doStream 实际收到的 tools（最真实边界：
 * 组装错误或 jsonSchema 适配缺失会让 streamText 直接抛错）；
 * 审批与适配细节用 runChatStream 级用例定点覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  // Log 模块顶层读取 app.getPath("userData") 计算日志目录
  app: { getPath: vi.fn(() => "/tmp/mirror-test-user-data") },
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

import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";

// 模型工厂 mock：send 级用例由此把脚本化模型注入 ChatService（否则服务会用
// createLanguageModel 真连 provider）；vi.hoisted 保证提升的 mock 工厂可引用
const mockFactory = vi.hoisted(() => ({
  current: null as null | (() => unknown),
}));

vi.mock("../../electron/domains/ai/provider/provider-factory", () => ({
  createLanguageModel: () => {
    if (!mockFactory.current) {
      throw new Error("测试未注入 mock 模型工厂");
    }
    return mockFactory.current() as LanguageModel;
  },
}));

import ChatService, {
  runChatStream,
  type AgentStreamOptions,
} from "../../electron/domains/ai/chat/chat.service";
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

// ---------- mock 模型：脚本化多步，并捕获每步实际收到的 tools 名单 ----------

type ScriptStep =
  | { kind: "text"; delta: string }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
    };

function scriptedModel(scripts: Array<{ steps: ScriptStep[] }>) {
  const capturedToolNames: string[][] = [];
  const model = new MockLanguageModelV3({
    doStream: async (callOptions) => {
      const index = capturedToolNames.length;
      const script = scripts[index] ?? { steps: [] as ScriptStep[] };
      capturedToolNames.push(
        ((callOptions.tools ?? []) as Array<{ name: string }>).map(
          (tool) => tool.name,
        ),
      );
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            const hasTool = script.steps.some((step) => step.kind === "tool");
            let textOpen = false;
            for (const step of script.steps) {
              if (step.kind === "text") {
                if (!textOpen) {
                  controller.enqueue({ type: "text-start", id: `t${index}` });
                  textOpen = true;
                }
                controller.enqueue({
                  type: "text-delta",
                  id: `t${index}`,
                  delta: step.delta,
                });
              } else {
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: step.toolCallId,
                  toolName: step.toolName,
                  input: JSON.stringify(step.input),
                });
              }
            }
            if (textOpen) {
              controller.enqueue({ type: "text-end", id: `t${index}` });
            }
            controller.enqueue({
              type: "finish",
              // v7 协议：finishReason 为 {unified, raw} 对象
              finishReason: hasTool
                ? { unified: "tool-calls", raw: "tool-calls" }
                : { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: undefined,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
            });
            controller.close();
          },
        }),
      };
    },
  });
  return { model, capturedToolNames };
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
): AgentStreamOptions => ({
  sessionId: 1,
  sessionWorkspaceId: 5,
  workspacePath: "/tmp/ws",
  fullAccess: () => fullAccess,
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

  it("绑定工作空间：文件四件 + read_skill + registry 注册的 mcp__ 全量", async () => {
    const { model, capturedToolNames } = scriptedModel([
      { steps: [{ kind: "text", delta: "好" }] },
    ]);
    mockFactory.current = () => model;
    const service = new ChatService(sessionsStub("/tmp/ws"));

    await service.send({ sessionId: 1, content: "hi" });

    const names = capturedToolNames[0] ?? [];
    // registry 顺序：read_skill 在前，其后为文件四件（read/write/list/search）+
    // run_command（P3 注册），mcp__ 注册序殿后
    expect(names.filter((name) => !name.startsWith("mcp__"))).toEqual([
      "read_skill",
      "read_file",
      "write_file",
      "list_dir",
      "search_files",
      "run_command",
    ]);
    expect(names).toContain("mcp__srv__echo");
  });
});

describe("MCP 审批与 jsonSchema 适配（runChatStream 级）", () => {
  it("MCP 写工具不受完全访问豁免：full 下仍挂起审批，批准后才执行（R7）", async () => {
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
            input: { title: "hi" },
          },
        ],
      },
      { steps: [{ kind: "text", delta: "继续" }] },
    ]);
    const chunks: ChatStreamChunk[] = [];

    const pending = runChatStream({
      model,
      history: userHistory,
      params: {},
      toolDefinitions: [mcpPublish],
      agent: makeAgent(approvals, true), // 完全访问已开启
      onChunk: (chunk) => chunks.push(chunk),
    });

    // 关键断言：fullAccess=true 仍走 awaiting-approval，且执行先于决议挂起
    await vi.waitFor(() => expect(approvals.pendingCount).toBe(1));
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: "approval-request",
        toolName: "mcp__srv__publish",
      }),
    );
    expect(executed).toEqual([]);

    await approvals.respond("t1", true);
    const result = await pending;

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
            input: { text: "ping" },
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
