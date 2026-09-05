/**
 * P3 T4 集成测试：两级审批判定（default 询问 / full 直执行 / mcp__ 恒审批）、
 * 模式组装（ask 零工具 / plan 计划指令段）、run_command 注册、status accessMode。
 * send 级用例经 MockLanguageModelV3 捕获 doStream 实际收到的 tools 与 system，
 * 经假 sender 捕获流式 chunk；权限与审批经 service 内部 store/coordinator 直达
 * （IPC 接线已由 agent-loop.test / permission-mode.test 覆盖）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";

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
  assistantRow: null as { systemPrompt: string } | null,
};

vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    message: { findMany: async () => prismaStub.messages },
    model: { findUnique: async () => prismaStub.modelRow },
    provider: { findUnique: async () => prismaStub.providerRow },
    assistant: { findUnique: async () => prismaStub.assistantRow },
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

// ---------- mock 模型：脚本化多步，并捕获每步实际收到的 tools 与 system ----------

type ScriptStep =
  | { kind: "text"; delta: string }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
    };

interface CapturedCall {
  toolNames: string[];
  system: string | undefined;
}

function scriptedModel(scripts: Array<{ steps: ScriptStep[] }>) {
  const calls: CapturedCall[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (callOptions) => {
      const index = calls.length;
      const script = scripts[index] ?? { steps: [] as ScriptStep[] };
      // v7 协议：system 映射为 prompt 首个 role:"system" 消息（content 为字符串）
      const systemMessage = callOptions.prompt.find(
        (message) => message.role === "system",
      );
      calls.push({
        toolNames: ((callOptions.tools ?? []) as Array<{ name: string }>).map(
          (tool) => tool.name,
        ),
        system:
          systemMessage && systemMessage.role === "system"
            ? systemMessage.content
            : undefined,
      });
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
  return { model, calls };
}

// ---------- 夹具 ----------

/** 会话/工作空间仓储 stub（directoryPath=null 即未绑定目录；mode 透传 DB 列原值）。
 * appendMessage 落回 prismaStub：流历史非空是 streamText 的硬性要求 */
const sessionsStub = (
  directoryPath: string | null,
  mode: string | null = null,
): SessionRepository =>
  ({
    getSession: vi.fn(async () => ({
      id: 1,
      workspaceId: 1,
      assistantId: prismaStub.assistantRow ? 1 : null,
      title: "新会话",
      mode,
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

/** send 的 sender 替身：捕获 emit 推送的流式 chunk（窗口未销毁） */
const captureSender = (chunks: ChatStreamChunk[]) =>
  ({
    isDestroyed: () => false,
    send: (_channel: string, chunk: ChatStreamChunk) => {
      chunks.push(chunk);
    },
  }) as unknown as WebContents;

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

beforeEach(() => {
  // Vitest 4 陷阱（T2 记录）：回调必须带块体，隐式返回值会被当 cleanup hook
  prismaStub.messages = [];
  prismaStub.assistantRow = null;
  mcpExecuted.length = 0;
});

afterEach(() => {
  mockFactory.current = null;
  unregisterTools("mcp__");
});

describe("两级审批判定（send 级集成）", () => {
  it("完全访问下 write_file 跳过审批直执行：无 awaiting-approval chunk，fullAccess 注入放开路径边界", async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), "p3-full-"));
    // 以工作空间外路径验证 ctx.fullAccess 真正注入（default 态会拒绝越界写）
    const escaped = path.join(path.dirname(ws), "p3-full-write-proof.txt");
    const { model } = scriptedModel([
      {
        steps: [
          {
            kind: "tool",
            toolCallId: "t1",
            toolName: "write_file",
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

  it("默认权限下 write_file 挂起审批（回归锚）：awaiting-approval 后批准才执行", async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), "p3-default-"));
    const { model } = scriptedModel([
      {
        steps: [
          {
            kind: "tool",
            toolCallId: "t1",
            toolName: "write_file",
            input: { path: "a.txt", content: "hi" },
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
      captureSender(chunks),
    );

    // default：write 挂起等待审批，决议前工具本体不执行
    await vi.waitFor(() =>
      expect(internals(service).approvals.pendingCount).toBe(1),
    );
    expect(hasApprovalChunk(chunks)).toBe(true);
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: "approval-request",
        toolName: "write_file",
        argSummary: "write_file → a.txt",
      }),
    );

    await internals(service).approvals.respond("t1", true);
    try {
      await pending;
      expect(toolStates(chunks, "t1")).toEqual([
        "ready",
        "awaiting-approval",
        "running",
        "done",
      ]);
      expect(existsSync(path.join(ws, "a.txt"))).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("完全访问不豁免 MCP 写工具：mcp__ 前缀 write 恒挂起审批（R7）", async () => {
    registerTools([mcpPublish]);
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
      { steps: [{ kind: "text", delta: "完成" }] },
    ]);
    mockFactory.current = () => model;
    const service = new ChatService(sessionsStub(null));
    internals(service).permissions.set(1, "full");
    const chunks: ChatStreamChunk[] = [];
    const pending = service.send(
      { sessionId: 1, content: "hi" },
      captureSender(chunks),
    );

    await vi.waitFor(() =>
      expect(internals(service).approvals.pendingCount).toBe(1),
    );
    expect(hasApprovalChunk(chunks)).toBe(true);
    expect(mcpExecuted).toEqual([]);

    await internals(service).approvals.respond("t1", true);
    await pending;
    expect(mcpExecuted).toEqual(["hi"]);
  });
});

describe("模式组装（send 级）", () => {
  it("ask 模式：ToolSet 为空且 system 仅助手原文（无技能段/无计划指令）", async () => {
    prismaStub.assistantRow = { systemPrompt: "你是问答助手" };
    const { model, calls } = scriptedModel([
      { steps: [{ kind: "text", delta: "答" }] },
    ]);
    mockFactory.current = () => model;
    const service = new ChatService(sessionsStub("/tmp/ws", "ask"));

    await service.send({ sessionId: 1, content: "hi" }, captureSender([]));

    expect(calls[0]?.toolNames).toEqual([]);
    expect(calls[0]?.system).toBe("你是问答助手");
  });

  it("plan 模式：system 追加计划指令段（spec §4 逐字）且工具照常注入", async () => {
    prismaStub.assistantRow = { systemPrompt: "你是计划助手" };
    const { model, calls } = scriptedModel([
      { steps: [{ kind: "text", delta: "计划" }] },
    ]);
    mockFactory.current = () => model;
    const service = new ChatService(sessionsStub("/tmp/ws", "plan"));

    await service.send({ sessionId: 1, content: "hi" }, captureSender([]));

    const system = calls[0]?.system ?? "";
    expect(system.startsWith("你是计划助手")).toBe(true);
    expect(system).toContain(
      "当前处于计划模式：请先分析任务并输出完整可执行的计划（步骤/涉及文件/命令），在我明确确认之前不要调用任何工具执行操作。",
    );
    // 指令段以空行拼接于 buildSystemPrompt 结果之后
    expect(system).toContain("\n\n当前处于计划模式");
    expect(calls[0]?.toolNames).toContain("write_file");
    expect(calls[0]?.toolNames).toContain("run_command");
  });
});

describe("run_command 注册（registry 接线）", () => {
  it("registry 预注册 run_command：kind=write，execute 危险命令返回拦截串", async () => {
    const def = registry.find("run_command");
    if (!def) {
      throw new Error("run_command 未注册进 registry 初始集");
    }
    expect(def.kind).toBe("write");
    const ctx: ToolContext = { workspacePath: "/tmp/ws", sessionId: 1 };
    await expect(def.execute(ctx, { command: "rm -rf /" })).resolves.toBe(
      "错误: 该命令被安全策略拦截（高风险破坏性操作）",
    );
  });
});
