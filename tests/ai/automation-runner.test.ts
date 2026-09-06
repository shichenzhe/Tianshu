// tests/ai/automation-runner.test.ts
import { describe, expect, it, vi } from "vitest";

// 传递依赖 resolve-attachments 的 skillsRootDir 惰性读 app.getPath
// ("userData")，照 chat.service.test.ts 先例 mock electron（无断言涉及）
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
// loadSkills 默认行为同先前空清单；vi.fn 化供引用注入用例按需覆写
// （技能聚焦用例改返回 A/B 清单，既有用例不受影响）
vi.mock("../../electron/domains/ai/agent/skill-loader", () => ({
  loadSkills: vi.fn(() => []),
}));
vi.mock("../../electron/domains/ai/provider/provider-factory", () => ({
  createLanguageModel: () => ({}),
}));
// 引用注入测试基建(brief mock 组合指示)：workspace-files 整模块 stub
// (resolveFilePath 拼接 + readWorkspaceFile 按用例覆写)；fs/promises 仅替
// readFile——runner 走 defaultResolveDeps.readSkillFile(fs.readFile)，技能
// 正文内容经此注入。importActual 保留 stat/writeFile 等(测试图内
// file-tools 仍引用，仅在工具 execute 时调用，此处不被触达)
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = vi.fn();
  return { ...actual, readFile, default: { ...actual, readFile } };
});
vi.mock("../../electron/domains/ai/chat/workspace-files", () => ({
  resolveFilePath: (dir: string, rel: string) => `${dir}/${rel}`,
  readWorkspaceFile: vi.fn(),
}));

import fs from "node:fs/promises";
import prisma from "../../electron/commons/prisma-client";
import { runChatStream } from "../../electron/domains/ai/chat/chat.service";
import { loadSkills } from "../../electron/domains/ai/agent/skill-loader";
import { readWorkspaceFile } from "../../electron/domains/ai/chat/workspace-files";
import {
  replaceVariables,
  extractUsage,
  executeTask,
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

/** once 任务行(advanceTask 终态语义用例:成功才 expired,失败留待重试扫描)。
 * runAt 相对真实时钟动态取过去时刻:nextRunAt=null 断言(需 runAt ≤ now)
 * 不依赖固定日历日期,任意时间运行均稳定 */
const onceRow = {
  ...taskRow,
  scheduleJson: JSON.stringify({
    mode: "periodic",
    kind: "once",
    runAt: new Date(Date.now() - 60_000).toISOString(),
  }),
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

/** once 终态两用例共用前置 stub(workspace/model/provider/session 均有效) */
async function stubOnceHappyPath() {
  const { executeTask } =
    await import("../../electron/domains/ai/automation/automation-runner");
  vi.mocked(prisma.automationRun.create).mockResolvedValue({ id: 1 } as never);
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
  vi.mocked(prisma.automationTask.update).mockClear();
  return executeTask;
}

describe("executeTask once 终态(成功才 expired,失败留待重试)", () => {
  it("once 成功 → task status=expired 且 nextRunAt=null", async () => {
    const executeTask = await stubOnceHappyPath();
    vi.mocked(runChatStream).mockResolvedValue({
      blocks: [{ type: "text", text: "ok" }],
    } as never);
    await executeTask(onceRow as never, {
      triggerType: "schedule",
      attempt: 1,
      abort: new AbortController().signal,
    });
    expect(prisma.automationTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "expired",
          nextRunAt: null,
          lastRunAt: expect.any(Date),
        }),
      }),
    );
  });
  it("once 非系统失败(stream 异常) → 不置 expired(nextRunAt=null 留给重试扫描)", async () => {
    const executeTask = await stubOnceHappyPath();
    vi.mocked(runChatStream).mockRejectedValue(new Error("ECONNRESET"));
    await executeTask(onceRow as never, {
      triggerType: "schedule",
      attempt: 1,
      abort: new AbortController().signal,
    });
    const data = vi.mocked(prisma.automationTask.update).mock.calls[0]?.[0]
      .data;
    expect(data).toMatchObject({
      nextRunAt: null,
      lastRunAt: expect.any(Date),
    });
    expect(data).not.toHaveProperty("status");
  });
});

describe("executeTask 引用注入", () => {
  const wsTask = {
    ...taskRow,
    id: 2,
    prompt: "@daily.md 汇总",
    workspaceId: 9,
  };

  function stubOkWorkspace() {
    // run.id 桩(brief stubOkWorkspace 未列：vi.fn 缺省 resolve undefined
    // 会在 streamAndRecord 读 run.id 抛错，照既有用例补桩，断言零改动)
    vi.mocked(prisma.automationRun.create).mockResolvedValue({
      id: 1,
    } as never);
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({
      id: 9,
      name: "ws",
      directoryPath: "/ws",
    } as never);
    vi.mocked(prisma.model.findUnique).mockResolvedValue({
      id: 1,
      providerId: 1,
      modelId: "m",
    } as never);
    vi.mocked(prisma.provider.findUnique).mockResolvedValue({
      id: 1,
      type: "openai",
      baseUrl: "http://x",
      apiKey: "k",
      extraHeaders: null,
    } as never);
    vi.mocked(prisma.session.create).mockResolvedValue({ id: 77 } as never);
  }

  it("带文件引用的任务:user 消息含 [引用文件] 前缀块", async () => {
    stubOkWorkspace();
    vi.mocked(readWorkspaceFile).mockResolvedValue({
      kind: "text",
      content: "AAA",
      size: 3,
    } as never);
    vi.mocked(runChatStream).mockResolvedValue({
      blocks: [{ type: "text", text: "ok" }],
    } as never);
    await executeTask(wsTask as never, {
      triggerType: "schedule",
      attempt: 1,
      abort: new AbortController().signal,
    });
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: "user",
          blocks: expect.stringContaining("[引用文件 daily.md]"),
        }),
      }),
    );
  });

  it("引用文件缺失 → run failed(attachment_missing)", async () => {
    stubOkWorkspace();
    vi.mocked(readWorkspaceFile).mockRejectedValue(new Error("ENOENT"));
    await executeTask(wsTask as never, {
      triggerType: "schedule",
      attempt: 1,
      abort: new AbortController().signal,
    });
    expect(prisma.automationRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "failed",
          error: expect.stringContaining("attachment_missing"),
        }),
      }),
    );
  });

  it("技能聚焦:⚡引用 → system 只含引用技能", async () => {
    stubOkWorkspace();
    // 被引用技能名须为纯 token 字符(⚡[\w-]+，CJK 不入 token)故名 "A"；
    // 未引用方保留 "B 技能"：聚焦失效时 system 必含该串，断言不落空
    vi.mocked(loadSkills).mockReturnValue([
      { name: "A", dir: "/s/a" },
      { name: "B 技能", dir: "/s/b" },
    ] as never);
    // defaultResolveDeps.readSkillFile 走 fs.readFile，技能正文经此注入
    vi.mocked(fs.readFile).mockResolvedValue("SKILL-A" as never);
    vi.mocked(runChatStream).mockResolvedValue({
      blocks: [{ type: "text", text: "ok" }],
    } as never);
    // mock 跨用例累积，清calls保 [0] 为本次调用
    vi.mocked(runChatStream).mockClear();
    await executeTask({ ...wsTask, prompt: "⚡A 汇总" } as never, {
      triggerType: "schedule",
      attempt: 1,
      abort: new AbortController().signal,
    });
    const call = vi.mocked(runChatStream).mock.calls[0]![0]!;
    expect(call.system).not.toContain("B 技能");
  });
});
