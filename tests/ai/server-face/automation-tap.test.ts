// 移动端 CRUD 批 automation-tap 直测：save 全量 upsert 组合（enabled 显式
// 携带且与现值不同才写——无头端 Ruling 12/14 同语义）、runPage 剔
// graphTrace（wire 精简面）、query/graphs 分页壳 + keyword（无头端
// service.query 同款）。内存替身直测（providers-tap 先例）；emit 链路
// （change-bus → face-events 桥）不在此文件——BrowserWindow 依赖，
// face-events/routes 各测各面。
import { describe, expect, it, vi } from "vitest";

// electron/Log 替身（routes.test 同款）：change-bus 依赖 BrowserWindow 广播
vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => "/tmp/tianshu-tap-test") },
}));
vi.mock("../../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import {
  createAutomationFace,
  createGraphsFace,
} from "../../../electron/domains/server-face/automation-tap";
import type { TaskRecord } from "@tianshu/protocol";

const UID = 1;

/** 最小合法 TaskRecord（toggle 组合用例读 enabled） */
function taskRow(enabled: boolean): TaskRecord {
  return {
    id: 7,
    name: "任务甲",
    prompt: "p",
    workspaceId: 3,
    workspaceName: "默认",
    source: "local",
    modelId: 0,
    targetKind: "prompt",
    graphId: null,
    eventJson: null,
    scheduleJson: "{}",
    scheduleText: "s",
    missedPolicy: "skip",
    accessMode: "default",
    enabled,
    status: "active",
    projectId: null,
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
  };
}

const SAVE_PARAMS = {
  name: "任务甲",
  prompt: "p",
  workspaceId: 3,
  modelId: 0,
  schedule: { mode: "interval", value: 5, unit: "minute" },
  scheduleText: "每 5 分钟",
  missedPolicy: "skip",
} as const;

function makeRepo(enabled = true) {
  return {
    listTasks: vi.fn(async () => [taskRow(enabled)]),
    createTask: vi.fn(async () => taskRow(enabled)),
    updateTask: vi.fn(async () => taskRow(enabled)),
    deleteTasks: vi.fn(async () => [7]),
    toggleTask: vi.fn(async () => taskRow(false)),
    runNow: vi.fn(async () => {}),
    listRuns: vi.fn(async () => ({
      total: 1,
      items: [
        {
          id: 9,
          taskId: 7,
          taskName: "任务甲",
          attempt: 1,
          triggerType: "schedule",
          status: "failed",
          error: "boom",
          startedAt: "2026-10-27T01:00:00.000Z",
          // 桌面 RunRecord 全量面：graphTrace 落库有、wire 必须剔
          graphTrace: '{"steps":[]}',
        },
      ],
    })),
  };
}

describe("automation-tap：save 全量 upsert 组合", () => {
  it("无 id 走 createTask、带 id 走 updateTask（enabled 缺省不碰开关）", async () => {
    const repo = makeRepo(true);
    const face = createAutomationFace({ automationRepo: repo });
    await face.save({ ...SAVE_PARAMS }, UID);
    expect(repo.createTask).toHaveBeenCalledTimes(1);
    expect(repo.updateTask).not.toHaveBeenCalled();
    expect(repo.toggleTask).not.toHaveBeenCalled();

    await face.save({ id: 7, ...SAVE_PARAMS }, UID);
    expect(repo.updateTask).toHaveBeenCalledWith(7, SAVE_PARAMS, UID);
  });

  it("enabled 显式携带且与现值不同才写：true→false 调 toggleTask；同值跳过", async () => {
    const repo = makeRepo(true);
    const face = createAutomationFace({ automationRepo: repo });
    await face.save({ ...SAVE_PARAMS, enabled: false }, UID);
    expect(repo.toggleTask).toHaveBeenCalledWith(7, false, UID);

    repo.toggleTask.mockClear();
    await face.save({ id: 7, ...SAVE_PARAMS, enabled: true }, UID);
    expect(repo.toggleTask).not.toHaveBeenCalled();
  });
});

describe("automation-tap：runPage 剔 graphTrace + query 分页壳", () => {
  it("runPage：全量面行转 wire 精简面（graphTrace 键不存在），total 透传", async () => {
    const face = createAutomationFace({ automationRepo: makeRepo() });
    const page = await face.runPage(1, 7, "failed", UID);
    expect(page.total).toBe(1);
    expect(page.items[0]).not.toHaveProperty("graphTrace");
    expect(page.items[0]).toMatchObject({
      taskId: 7,
      taskName: "任务甲",
      status: "failed",
      error: "boom",
    });
  });

  it("query：page 非法归 1、keyword includes 过滤（无头端 service.query 同款）", async () => {
    const repo = makeRepo();
    repo.listTasks = vi.fn(async () =>
      Array.from({ length: 25 }, (_, i) => ({
        ...taskRow(true),
        id: i + 1,
        name: i % 5 === 0 ? `甲任务${i}` : `task-${i}`,
      })),
    );
    const face = createAutomationFace({ automationRepo: repo });
    const page = await face.query(0, 10, "甲", UID);
    expect(page.page).toBe(1);
    expect(page.total).toBe(5);
    expect(page.records).toHaveLength(5);
    expect(page.records.every((t) => t.name.includes("甲"))).toBe(true);
  });
});

describe("graphs-tap：只读分页壳", () => {
  it("query：keyword 过滤 + 分页切片（选图面）", async () => {
    const graphRepo = {
      listGraphs: vi.fn(async () =>
        Array.from({ length: 3 }, (_, i) => ({
          id: i + 1,
          name: `图${i}`,
          graphJson: "{}",
          version: 1,
          enabled: true,
          createdAt: "2026-10-27T00:00:00.000Z",
          updatedAt: "2026-10-27T00:00:00.000Z",
          nodeCount: 0,
        })),
      ),
    };
    const face = createGraphsFace({ graphRepo });
    const page = await face.query(1, 2, "图", UID);
    expect(page.total).toBe(3);
    expect(page.records).toHaveLength(2);
    expect(page.records[0]?.name).toBe("图0");
  });
});
