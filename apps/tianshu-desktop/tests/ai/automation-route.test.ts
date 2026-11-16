// @vitest-environment jsdom
// 自动化任务页主机路由化（automation/library 批 2026-11-10）：
// - 本地主机：AutomationApi 数据面 invoke 原通道参数逐字（零行为变化）
// - 远程主机：list/create/update/remove/toggle/runNow/runs 七面经
//   remote-catalog 适配器 → 无头端 automation 端点（GraphApi mock 为边界）
// - toggle：无专端点——查行 save 全量携翻转 enabled（Ruling 12）
// - stat 埋点远程态静默丢弃；stats 聚合远程态显式拒绝
// - templates 本地静态清单远程态直接复用
import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  on: () => () => {},
}));

const remoteGraphApi = vi.hoisted(() => ({
  automationList: vi.fn(),
  automationSave: vi.fn(),
  automationDelete: vi.fn(),
  automationRunNow: vi.fn(),
  automationRuns: vi.fn(),
  automationStatsRaw: vi.fn(),
}));
vi.mock("../../src-react/domains/ai/server/api/graph.api", () => ({
  default: remoteGraphApi,
  // toTaskSaveParams 为真实现的浅 stub（scheduleJson 反序列化 + enabled
  // 回填——toggle 用例断言依据），避免 mock 工厂缺命名导出成 undefined
  toTaskSaveParams: (
    task: { id: number; scheduleJson: string },
    enabled: boolean,
  ) => ({
    id: task.id,
    schedule: JSON.parse(task.scheduleJson),
    enabled,
  }),
}));

vi.mock("../../src-react/domains/ai/server/api/server.api", () => ({
  default: { listConnections: vi.fn() },
  requestRemote: vi.fn(),
  LOCAL_CONNECTION_ID: "local",
  newConnectionId: vi.fn(() => "conn-x"),
  on: () => () => {},
  onRemoteChunk: () => () => {},
  onRemoteEvent: () => () => {},
}));

import {
  useHostStore,
  LOCAL_HOST_CAPS,
} from "../../src-react/domains/ai/data-source/host.store";
import { AutomationApi } from "../../src-react/domains/ai/automation/api/automation.api";

const REMOTE_ROW = {
  id: 3,
  name: "远程任务",
  prompt: "p",
  workspaceId: 1,
  workspaceName: "ws",
  source: "local",
  modelId: 2,
  targetKind: "prompt",
  graphId: null,
  eventJson: null,
  scheduleJson: '{"type":"daily"}',
  scheduleText: "每天",
  missedPolicy: "skip",
  catchUpLimit: 1,
  accessMode: "default",
  enabled: true,
  status: "active",
  projectId: null,
  createdAt: "2026-11-10T00:00:00.000Z",
  updatedAt: "2026-11-10T01:00:00.000Z",
};

function switchRemote(): void {
  useHostStore.setState({
    activeHost: { kind: "remote", connId: "conn-x" },
    caps: LOCAL_HOST_CAPS,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useHostStore.setState({
    activeHost: { kind: "local" },
    caps: LOCAL_HOST_CAPS,
  });
});

describe("自动化任务页本地主机（零行为变化）", () => {
  it("list/create/toggle/runs：invoke 原通道参数逐字", async () => {
    invoke.mockResolvedValue([]);
    await AutomationApi.list();
    expect(invoke).toHaveBeenCalledWith("automation:list");
    await AutomationApi.create({ name: "n" } as never);
    expect(invoke).toHaveBeenCalledWith("automation:create", { name: "n" });
    invoke.mockResolvedValue({});
    await AutomationApi.toggle(5, false);
    expect(invoke).toHaveBeenCalledWith("automation:toggle", 5, false);
    await AutomationApi.runs(1, 9);
    expect(invoke).toHaveBeenCalledWith(
      "automation:runs:page",
      1,
      9,
      undefined,
    );
    expect(remoteGraphApi.automationList).not.toHaveBeenCalled();
  });

  it("templates/stat/stats 本地可用", async () => {
    invoke.mockResolvedValue([]);
    await AutomationApi.templates();
    await AutomationApi.stat({
      mode: "periodic",
      kind: "d",
      hasEndAt: false,
      tabSwitchCount: 0,
    });
    invoke.mockResolvedValue({
      today: { total: 0 },
      trend: [],
      attention: [],
      errorTaskCount: 0,
    });
    await AutomationApi.stats();
    expect(invoke).toHaveBeenCalledWith("automation:stats");
  });
});

describe("自动化任务页远程主机（适配器映射）", () => {
  beforeEach(switchRemote);

  it("list：automationList 全量翻页取完 → TaskRecord 形状（catchUpLimit 兜底）", async () => {
    remoteGraphApi.automationList
      .mockResolvedValueOnce({
        total: 3,
        records: [REMOTE_ROW, { ...REMOTE_ROW, catchUpLimit: undefined }],
      })
      .mockResolvedValueOnce({ total: 3, records: [REMOTE_ROW] });
    const rows = await AutomationApi.list();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ id: 3, name: "远程任务", catchUpLimit: 1 });
    expect(rows[1].catchUpLimit).toBe(1);
    expect(remoteGraphApi.automationList).toHaveBeenCalledTimes(2);
  });

  it("create/update：automationSave 全量载荷（schedule 对象直传、update 携 id）", async () => {
    remoteGraphApi.automationSave.mockResolvedValue(REMOTE_ROW);
    const params = {
      name: "新任务",
      prompt: "p",
      workspaceId: 1,
      modelId: 2,
      schedule: { type: "daily" },
      scheduleText: "每天",
      missedPolicy: "skip" as const,
    };
    await AutomationApi.create(params);
    expect(remoteGraphApi.automationSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "新任务",
        schedule: { type: "daily" },
        enabled: true,
      }),
      "conn-x",
    );
    await AutomationApi.update(3, params);
    expect(remoteGraphApi.automationSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 3 }),
      "conn-x",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("remove/runNow：直达端点（delete ids / runNow 202 受理）", async () => {
    remoteGraphApi.automationDelete.mockResolvedValue(undefined);
    await AutomationApi.remove([3, 4]);
    expect(remoteGraphApi.automationDelete).toHaveBeenCalledWith(
      [3, 4],
      "conn-x",
    );

    remoteGraphApi.automationRunNow.mockResolvedValue({ accepted: true });
    await AutomationApi.runNow(3);
    expect(remoteGraphApi.automationRunNow).toHaveBeenCalledWith(3, "conn-x");
  });

  it("toggle：查行 save 全量携翻转 enabled（Ruling 12）", async () => {
    remoteGraphApi.automationList.mockResolvedValue({
      total: 1,
      records: [REMOTE_ROW],
    });
    remoteGraphApi.automationSave.mockResolvedValue({
      ...REMOTE_ROW,
      enabled: false,
    });
    const row = await AutomationApi.toggle(3, false);
    expect(remoteGraphApi.automationSave).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 3,
        schedule: { type: "daily" },
        enabled: false,
      }),
      "conn-x",
    );
    expect(row.enabled).toBe(false);
  });

  it("runs：taskId+status 过滤直达端点 → RunPage 形状", async () => {
    remoteGraphApi.automationRuns.mockResolvedValue({
      total: 1,
      items: [{ id: 9, taskId: 3, status: "success" }],
    });
    const page = await AutomationApi.runs(1, 3, "success");
    expect(remoteGraphApi.automationRuns).toHaveBeenCalledWith(
      1,
      "conn-x",
      3,
      "success",
    );
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ taskId: 3, status: "success" });
  });

  it("templates 本地静态清单复用；stat 埋点静默丢弃不落通道", async () => {
    invoke.mockResolvedValue([{ slug: "t" }]);
    const templates = await AutomationApi.templates();
    expect(templates).toEqual([{ slug: "t" }]);
    await AutomationApi.stat({
      mode: "periodic",
      kind: "d",
      hasEndAt: false,
      tabSwitchCount: 0,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith(
      "automation:stat",
      expect.anything(),
    );
  });

  it("stats：远程态拉原始行集 → computeStats 客户端聚合（挂账收口）", async () => {
    const now = Date.now();
    remoteGraphApi.automationStatsRaw.mockResolvedValue({
      runs: [
        {
          id: 11,
          status: "success",
          startedAt: new Date(now - 600_000).toISOString(),
          taskName: "远程任务GUI验证",
        },
        {
          id: 12,
          status: "failed",
          error: "boom",
          startedAt: new Date(now - 3600_000).toISOString(),
          taskName: "远程任务GUI验证",
        },
      ],
      errorTasks: [{ id: 3, name: "异常任务", statusNote: "执行失败" }],
    });
    const stats = await AutomationApi.stats();
    expect(remoteGraphApi.automationStatsRaw).toHaveBeenCalledWith(
      expect.any(String),
      "conn-x",
    );
    expect(stats.today.total).toBe(2);
    expect(stats.today.success).toBe(1);
    expect(stats.today.failed).toBe(1);
    expect(stats.attention).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "taskError", name: "异常任务" }),
        expect.objectContaining({ kind: "failedRun", runId: 12 }),
      ]),
    );
    expect(stats.errorTaskCount).toBe(1);
    // trend 7 天、今日桶非空
    expect(stats.trend).toHaveLength(7);
    expect(invoke).not.toHaveBeenCalled();
  });
});
