// tests/ai/automation-runner.test.ts
import { describe, expect, it, vi } from "vitest";

// 成功路径执行到 streamAndRecord 内的 app.getPath("userData")（技能目录），
// 照 chat.service.test.ts 先例 mock electron（仅 app.getPath，无断言涉及）
vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/mirror-test-user-data") },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    workspace: { findUnique: vi.fn() },
    model: { findUnique: vi.fn() },
    provider: { findUnique: vi.fn() },
    session: { create: vi.fn(), update: vi.fn() },
    message: { create: vi.fn() },
    automationRun: { create: vi.fn(), update: vi.fn() },
    automationTask: { update: vi.fn() },
  },
}));
// Log 顶层读 app.getPath("userData")（winston 目录），vitest 里 import 即崩——
// 照 Task 3/5 mock 三件套先例补（断言不涉及 Log，零改动）
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/domains/ai/chat/chat.service", () => ({
  runChatStream: vi.fn(),
  normalizeWorkspacePath: (p: string) => p,
}));
vi.mock("../../electron/domains/ai/agent/skill-loader", () => ({
  loadSkills: () => [],
}));
vi.mock("../../electron/domains/ai/provider/provider-factory", () => ({
  createLanguageModel: () => ({}),
}));

import prisma from "../../electron/commons/prisma-client";
import { runChatStream } from "../../electron/domains/ai/chat/chat.service";
import {
  replaceVariables,
  extractUsage,
} from "../../electron/domains/ai/automation/automation-runner";

describe("replaceVariables", () => {
  it("三个变量全部替换(2026-09-06 为周日)", () => {
    const out = replaceVariables(
      "今天 {{date}} 星期{{weekday}} {{time}}",
      new Date("2026-09-06T09:05:00"),
    );
    expect(out).toBe("今天 2026-09-06 星期日 09:05");
  });
  it("无变量原样返回", () => {
    expect(replaceVariables("plain", new Date())).toBe("plain");
  });
});

describe("extractUsage", () => {
  it("从 usage 块取 input/output;无块返回 undefined", () => {
    expect(
      extractUsage([
        { type: "text", text: "hi" },
        { type: "usage", input: 12, output: 34 },
      ] as never),
    ).toEqual({ promptTokens: 12, completionTokens: 34 });
    expect(
      extractUsage([{ type: "text", text: "hi" }] as never),
    ).toBeUndefined();
  });
});

/** executeTask 用例共用任务行（automationTask 表形状） */
const taskRow = {
  id: 1,
  name: "t",
  prompt: "p",
  workspaceId: 9,
  modelId: 1,
  temperature: 0.7,
  scheduleJson: '{"mode":"periodic","kind":"daily","time":"09:00"}',
  scheduleText: "每天 09:00",
  startAt: null,
  endAt: null,
  missedPolicy: "skip",
  enabled: true,
  status: "active",
  statusNote: null,
  lastRunAt: null,
  nextRunAt: null,
  templateSlug: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("executeTask 失败短路", () => {
  it("workspace 缺失 → run failed(workspace_missing) + task error", async () => {
    const { executeTask } =
      await import("../../electron/domains/ai/automation/automation-runner");
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue(null);
    // create 桩缺省 resolve undefined 会让 run.id 直接抛——补桩(仅 mock 值,断言零改动)
    vi.mocked(prisma.automationRun.create).mockResolvedValue({
      id: 1,
    } as never);
    await executeTask(taskRow as never, {
      triggerType: "schedule",
      attempt: 1,
      abort: new AbortController().signal,
    });
    expect(prisma.automationRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ taskId: 1, status: "running" }),
      }),
    );
    expect(prisma.automationRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "failed",
          error: "workspace_missing",
          finishedAt: expect.any(Date),
        }),
      }),
    );
    expect(prisma.automationTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "error",
          enabled: false,
          statusNote: "workspace_missing",
        }),
      }),
    );
    expect(runChatStream).not.toHaveBeenCalled();
  });
});

describe("executeTask 成功路径", () => {
  it("run 终态 update 关联 sessionId 且 status=success(spec §4 步骤7/§5 跳转)", async () => {
    const { executeTask } =
      await import("../../electron/domains/ai/automation/automation-runner");
    vi.mocked(prisma.automationRun.create).mockResolvedValue({
      id: 1,
    } as never);
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({
      id: 9,
      directoryPath: null,
    } as never);
    vi.mocked(prisma.model.findUnique).mockResolvedValue({
      id: 1,
      providerId: 2,
      modelId: "gpt-test",
    } as never);
    vi.mocked(prisma.provider.findUnique).mockResolvedValue({
      type: "openai-compatible",
      baseUrl: "https://api.test/v1",
      apiKey: "k",
      extraHeaders: null,
    } as never);
    vi.mocked(prisma.session.create).mockResolvedValue({ id: 99 } as never);
    vi.mocked(runChatStream).mockResolvedValue({
      blocks: [{ type: "text", text: "ok" }],
    } as never);
    await executeTask(taskRow as never, {
      triggerType: "schedule",
      attempt: 1,
      abort: new AbortController().signal,
    });
    expect(prisma.automationRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sessionId: 99,
          status: "success",
        }),
      }),
    );
    expect(prisma.message.create).toHaveBeenCalledTimes(2);
  });
});
