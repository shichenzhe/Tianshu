// tests/ai/automation-scheduler.test.ts
// scheduler → automation-runner → chat.service 顶层 import electron,在 vitest node
// 环境即崩——scheduler 只消费 executeTask(类型为编译期擦除),照 Task 6 补充指示
// 将 runner 整模块 mock 掉最干净;electron(BrowserWindow)/prisma-client/Log 三件套
// 照 automation-repo/runner 测试先例。仅 mock 基建,断言与 brief 逐字一致。
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp") },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    automationTask: { findMany: vi.fn(), update: vi.fn() },
    automationRun: { create: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  },
}));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/domains/ai/automation/automation-runner", () => ({
  executeTask: vi.fn(),
}));

import {
  decideTick,
  pickRetryTaskIds,
} from "../../electron/domains/ai/automation/automation-scheduler";

const base = {
  id: 1,
  name: "t",
  prompt: "p",
  workspaceId: 1,
  modelId: 1,
  temperature: null,
  scheduleJson: '{"mode":"periodic","kind":"daily","time":"09:00"}',
  scheduleText: "每天 09:00",
  startAt: null,
  endAt: null,
  missedPolicy: "skip",
  enabled: true,
  status: "active",
  statusNote: null,
  templateSlug: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as const;

const now = new Date("2026-09-07T09:00:30");
const boot = new Date("2026-09-07T08:00:00");

describe("decideTick 决策树", () => {
  it("nextRunAt 未到 → noop", () => {
    expect(
      decideTick(
        { ...base, nextRunAt: new Date("2026-09-07T10:00:00") } as never,
        now,
        boot,
      ),
    ).toBe("noop");
  });
  it("正常触发:nextRunAt >= 进程启动时间 → execute", () => {
    expect(
      decideTick(
        { ...base, nextRunAt: new Date("2026-09-07T09:00:00") } as never,
        now,
        boot,
      ),
    ).toBe("execute");
  });
  it("错过且 nextRunAt < 进程启动:skip 策略 → skip;catchUpOnce → catchUp", () => {
    const missed = {
      ...base,
      nextRunAt: new Date("2026-09-07T07:00:00"),
      lastRunAt: new Date("2026-09-06T09:00:00"),
    };
    expect(decideTick(missed as never, now, boot)).toBe("skip");
    expect(
      decideTick(
        { ...missed, missedPolicy: "catchUpOnce" } as never,
        now,
        boot,
      ),
    ).toBe("catchUp");
  });
  it("该触发点已执行(lastRunAt >= nextRunAt) → advance", () => {
    expect(
      decideTick(
        {
          ...base,
          nextRunAt: new Date("2026-09-07T09:00:00"),
          lastRunAt: new Date("2026-09-07T09:00:05"),
        } as never,
        now,
        boot,
      ),
    ).toBe("advance");
  });
  it("endAt 已过 → expire;未到 startAt → noop", () => {
    expect(
      decideTick(
        { ...base, endAt: new Date("2026-09-06T00:00:00") } as never,
        now,
        boot,
      ),
    ).toBe("expire");
    expect(
      decideTick(
        { ...base, startAt: new Date("2026-09-08T00:00:00") } as never,
        now,
        boot,
      ),
    ).toBe("noop");
  });
  it("once 任务:runAt 过期且跑过 → expire", () => {
    expect(
      decideTick(
        {
          ...base,
          scheduleJson:
            '{"mode":"periodic","kind":"once","runAt":"2026-09-06T09:00:00.000Z"}',
          nextRunAt: new Date("2026-09-06T09:00:00"),
          lastRunAt: new Date("2026-09-06T09:00:01"),
        } as never,
        now,
        boot,
      ),
    ).toBe("expire");
  });
});

describe("pickRetryTaskIds", () => {
  const finishedAt = (iso: string) => ({ finishedAt: new Date(iso) });
  it("最新 run failed 且 attempt<3 且冷却 60s 已过 → 重试", () => {
    const m = new Map([
      [
        1,
        { status: "failed", attempt: 1, ...finishedAt("2026-09-07T08:59:00") },
      ],
      [
        2,
        { status: "failed", attempt: 3, ...finishedAt("2026-09-07T08:00:00") },
      ],
      [
        3,
        { status: "failed", attempt: 2, ...finishedAt("2026-09-07T08:59:31") },
      ],
      [
        4,
        { status: "success", attempt: 1, ...finishedAt("2026-09-07T08:00:00") },
      ],
    ]);
    expect(pickRetryTaskIds(m, now)).toEqual([1]);
  });
});
