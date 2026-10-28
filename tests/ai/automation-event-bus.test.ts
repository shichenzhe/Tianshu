// tests/ai/automation-event-bus.test.ts
// 事件总线单测：matchEventTasks 匹配矩阵 + MAX_CHAIN_DEPTH 防环上限 +
// publishAutomationEvent 行为（链深超限/在途互斥/inputs 透传/异常吞掉链续）。
// 基建三件套照 automation-scheduler 测试先例整模块 mock（runner 顶层 import
// electron 在 vitest node 环境即崩）；matchEventTasks 断言与 brief 逐字一致。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserWindow } from "electron";
import { AUTOMATION_CHANGED_EVENT } from "../../src-react/domains/ai/automation/api/automation.api";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    automationTask: { findMany: vi.fn() },
    automationRun: { create: vi.fn() },
  },
}));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/domains/ai/automation/automation-runner", () => ({
  executeTask: vi.fn(),
}));

import {
  matchEventTasks,
  MAX_CHAIN_DEPTH,
  publishAutomationEvent,
} from "../../electron/domains/ai/automation/automation-event-bus";
import { executeTask } from "../../electron/domains/ai/automation/automation-runner";
import { inflight } from "../../electron/domains/ai/automation/automation-inflight";
import prisma from "../../electron/commons/prisma-client";

const task = (id: number, eventJson: string | null) => ({
  id,
  eventJson,
  enabled: true,
  status: "active",
});

describe("matchEventTasks", () => {
  it("appStarted 命中", () => {
    const hits = matchEventTasks(
      [task(1, JSON.stringify({ source: "appStarted" }))],
      { source: "appStarted" },
    );
    expect(hits).toHaveLength(1);
  });
  it("taskFinished 按 targetType/targetId/on 过滤，并注入 outcome", () => {
    const rows = [
      task(
        1,
        JSON.stringify({
          source: "taskFinished",
          targetType: "task",
          targetId: 3,
          on: "success",
        }),
      ),
      task(
        2,
        JSON.stringify({
          source: "taskFinished",
          targetType: "graph",
          targetId: 7,
          on: "any",
        }),
      ),
      task(
        3,
        JSON.stringify({
          source: "taskFinished",
          targetType: "task",
          targetId: 3,
          on: "failed",
        }),
      ),
    ];
    const hits = matchEventTasks(rows, {
      source: "taskFinished",
      targetType: "task",
      targetId: 3,
      outcome: "success",
    });
    expect(hits.map((h) => h.task.id)).toEqual([1]);
    expect(hits[0].inputs).toEqual({ outcome: "success" });
  });
  it("坏 eventJson 行静默跳过；disabled/error 不入选（findMany where 已滤，函数再容错）", () => {
    expect(
      matchEventTasks([task(1, "{bad")], { source: "appStarted" }),
    ).toHaveLength(0);
  });
});
it("链深上限常量为 5", () => expect(MAX_CHAIN_DEPTH).toBe(5));

/** 行为测试行：匹配视图字段 + taskFinishedEvent 需要的 targetKind/graphId */
const row = (id: number, eventJson: string | null) => ({
  id,
  eventJson,
  enabled: true,
  status: "active",
  targetKind: "prompt",
  graphId: null,
});
const APP_STARTED = JSON.stringify({ source: "appStarted" });
const onTask = (targetId: number, on: "success" | "failed" | "any") =>
  JSON.stringify({ source: "taskFinished", targetType: "task", targetId, on });

describe("publishAutomationEvent 行为（链深/互斥/透传/链续）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.automationTask.findMany).mockReset();
    vi.mocked(prisma.automationRun.create).mockReset();
    vi.mocked(executeTask).mockReset();
    // 缺省无匹配任务(防漏设 impl 时 findMany 返回 undefined 炸迭代)
    vi.mocked(prisma.automationTask.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.automationRun.create).mockResolvedValue({
      id: 1,
    } as never);
    inflight.clear();
  });

  it("链深超限落 skipped(chain_depth_exceeded) 且不调 executeTask", async () => {
    vi.mocked(prisma.automationTask.findMany).mockResolvedValue([
      row(1, APP_STARTED),
    ] as never);
    await publishAutomationEvent({ source: "appStarted" }, MAX_CHAIN_DEPTH + 1);
    expect(prisma.automationRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taskId: 1,
          triggerType: "event",
          status: "skipped",
          error: "chain_depth_exceeded",
        }),
      }),
    );
    expect(executeTask).not.toHaveBeenCalled();
  });

  it("在途互斥：inflight 占用落 skipped(event_skipped_running)", async () => {
    vi.mocked(prisma.automationTask.findMany).mockResolvedValue([
      row(2, APP_STARTED),
    ] as never);
    inflight.set(2, new AbortController());
    await publishAutomationEvent({ source: "appStarted" });
    expect(prisma.automationRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taskId: 2,
          triggerType: "event",
          status: "skipped",
          error: "event_skipped_running",
        }),
      }),
    );
    expect(executeTask).not.toHaveBeenCalled();
  });

  it("appStarted 匹配任务注入空 inputs 执行", async () => {
    vi.mocked(prisma.automationTask.findMany).mockResolvedValueOnce([
      row(3, APP_STARTED),
    ] as never);
    vi.mocked(executeTask).mockResolvedValue("success" as never);
    await publishAutomationEvent({ source: "appStarted" });
    expect(executeTask).toHaveBeenCalledTimes(1);
    expect(executeTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 3 }),
      expect.objectContaining({ triggerType: "event", attempt: 1, inputs: {} }),
    );
  });

  it("事件触发 run 收尾广播 AUTOMATION_CHANGED_EVENT（渲染端即时刷新）", async () => {
    const send = vi.fn();
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValueOnce([
      { webContents: { send } },
    ] as never);
    vi.mocked(prisma.automationTask.findMany).mockResolvedValueOnce([
      row(3, APP_STARTED),
    ] as never);
    vi.mocked(executeTask).mockResolvedValue("success" as never);
    await publishAutomationEvent({ source: "appStarted" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(AUTOMATION_CHANGED_EVENT);
  });

  it("taskFinished 匹配执行透传 inputs={outcome}，链式向下游发布", async () => {
    const target = row(5, APP_STARTED);
    const listener = row(9, onTask(5, "success"));
    vi.mocked(prisma.automationTask.findMany)
      .mockResolvedValueOnce([target] as never) // appStarted 匹配 target
      .mockResolvedValueOnce([listener] as never); // taskFinished(5) 匹配 listener
    vi.mocked(executeTask).mockResolvedValue("success" as never);
    await publishAutomationEvent({ source: "appStarted" });
    expect(executeTask).toHaveBeenCalledTimes(2);
    expect(executeTask).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 5 }),
      expect.objectContaining({ inputs: {} }),
    );
    expect(executeTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 9 }),
      expect.objectContaining({
        triggerType: "event",
        inputs: { outcome: "success" },
      }),
    );
  });

  it("executeTask 抛错被吞且链续（outcome=failed 向下游发布）", async () => {
    const target = row(5, APP_STARTED);
    const listener = row(9, onTask(5, "any"));
    vi.mocked(prisma.automationTask.findMany)
      .mockResolvedValueOnce([target] as never)
      .mockResolvedValueOnce([listener] as never);
    vi.mocked(executeTask)
      .mockRejectedValueOnce(new Error("boom") as never)
      .mockResolvedValueOnce("success" as never);
    await publishAutomationEvent({ source: "appStarted" });
    expect(executeTask).toHaveBeenCalledTimes(2);
    expect(executeTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 9 }),
      expect.objectContaining({ inputs: { outcome: "failed" } }),
    );
  });
});
