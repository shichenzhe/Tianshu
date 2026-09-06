/**
 * automation.repo 纯派生与参数组装单测(IPC/DB 副作用走 Task 18 冒烟)。
 * repo 顶层 import prisma-client(模块加载即调 app.getPath 建 SQLite 连接)、
 * Log(Winston transport)、electron ipcMain——vitest 里 import 即崩,
 * 沿用 session-repo.test.ts 的 mock 三件套隔离。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
}));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {},
}));

import {
  toTaskRecord,
  buildTaskData,
} from "../../electron/domains/ai/automation/automation.repo";

const row = {
  id: 1,
  name: "早报",
  prompt: "总结 {{date}} 资讯",
  workspaceId: 2,
  modelId: 3,
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
  nextRunAt: new Date("2026-09-07T01:00:00Z"),
  templateSlug: null,
  createdAt: new Date("2026-09-06T00:00:00Z"),
  updatedAt: new Date("2026-09-06T00:00:00Z"),
};

describe("toTaskRecord", () => {
  it("workspace 有目录 → project;无目录 → local;日期 toISOString", () => {
    const withDir = toTaskRecord(row, {
      id: 2,
      name: "项目A",
      directoryPath: "/tmp/x",
    });
    expect(withDir.source).toBe("project");
    expect(withDir.workspaceName).toBe("项目A");
    expect(withDir.nextRunAt).toBe("2026-09-07T01:00:00.000Z");
    const noDir = toTaskRecord(row, {
      id: 2,
      name: "本地空间",
      directoryPath: null,
    });
    expect(noDir.source).toBe("local");
  });
});

describe("buildTaskData(创建/更新共用组装)", () => {
  const params = {
    name: "早报",
    prompt: "总结资讯",
    workspaceId: 2,
    modelId: 3,
    temperature: 0.7,
    schedule: { mode: "periodic", kind: "daily", time: "09:00" } as const,
    scheduleText: "每天 09:00",
    startAt: undefined,
    endAt: undefined,
    missedPolicy: "skip" as const,
    templateSlug: undefined,
  };

  it("scheduleJson 序列化,nextRunAt 用 computeNextRun 计算,不含 enabled/status", () => {
    const data = buildTaskData(params, new Date("2026-09-06T10:00:00"));
    expect(data.scheduleJson).toBe(
      '{"mode":"periodic","kind":"daily","time":"09:00"}',
    );
    expect(data.nextRunAt).toEqual(new Date("2026-09-07T09:00:00"));
    expect(data).not.toHaveProperty("enabled");
    expect(data).not.toHaveProperty("status");
  });

  it("startAt 在未来 → 以 max(now, startAt) 为起点求首个调度点(生效日 09:00 而非零点)", () => {
    const data = buildTaskData(
      { ...params, startAt: "2026-10-01T00:00:00.000Z" },
      new Date("2026-09-06T10:00:00"),
    );
    expect(data.nextRunAt).toEqual(new Date("2026-10-01T09:00:00"));
  });

  it("weekly + 未来 startAt → 首个触发点落在选中的星期(2026-10-04 周日)", () => {
    const data = buildTaskData(
      {
        ...params,
        schedule: {
          mode: "periodic",
          kind: "weekly",
          weekdays: [7],
          time: "09:00",
        },
        startAt: "2026-10-01T00:00:00.000Z",
      },
      new Date("2026-09-06T10:00:00"),
    );
    expect(data.nextRunAt).toEqual(new Date("2026-10-04T09:00:00"));
  });
});
