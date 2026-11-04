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
  // listRuns where 组合 + create/update 校验链路的查询桩
  default: {
    automationRun: {
      count: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    automationTask: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    // deleteTasks 级联（去会话化 2026-10-28：run 行删前连带删 graphRunNode）
    graphRunNode: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
    workspace: { findUnique: vi.fn(), findFirst: vi.fn() },
    model: { findUnique: vi.fn() },
    provider: { findFirst: vi.fn() },
    // 图名联查（listRuns）与 graphId 归属校验按用例覆写；findMany 缺省空集
    graphDefinition: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(async () => []),
    },
  },
}));

import AutomationRepository, {
  toTaskRecord,
  buildTaskData,
  assertNoSelfReference,
} from "../../electron/domains/ai/automation/automation.repo";
import prisma from "../../electron/commons/prisma-client";

/** 测试用户 id（v12 起任务/运行记录按用户隔离，repo 方法末位参数） */
const UID = 1;

const row = {
  id: 1,
  name: "早报",
  prompt: "总结 {{date}} 资讯",
  workspaceId: 2,
  modelId: 3,
  temperature: 0.7,
  targetKind: "prompt",
  graphId: null,
  eventJson: null,
  scheduleJson: '{"mode":"periodic","kind":"daily","time":"09:00"}',
  scheduleText: "每天 09:00",
  startAt: null,
  endAt: null,
  missedPolicy: "skip",
  accessMode: "default",
  enabled: true,
  status: "active",
  statusNote: null,
  lastRunAt: null,
  nextRunAt: new Date("2026-09-07T01:00:00Z"),
  templateSlug: null,
  projectId: null,
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

const baseParams = {
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

describe("accessMode 落库与派生", () => {
  it("buildTaskData 未传 accessMode 时默认 default", () => {
    const data = buildTaskData(baseParams, new Date("2026-09-07T00:00:00"));
    expect(data.accessMode).toBe("default");
  });

  it("buildTaskData 透传 full", () => {
    const data = buildTaskData(
      { ...baseParams, accessMode: "full" },
      new Date("2026-09-07T00:00:00"),
    );
    expect(data.accessMode).toBe("full");
  });

  it("toTaskRecord 透传 full,归一非法值为 default", () => {
    expect(toTaskRecord({ ...row, accessMode: "full" }, null).accessMode).toBe(
      "full",
    );
    expect(
      toTaskRecord({ ...row, accessMode: "bogus" as never }, null).accessMode,
    ).toBe("default");
  });
});

describe("projectId 贯通（子系统 E）", () => {
  it("buildTaskData：create 路径缺省 null；显式传入透传", () => {
    const data = buildTaskData(baseParams, new Date("2026-09-07T00:00:00"));
    expect(data.projectId).toBeNull();
    const withId = buildTaskData(
      { ...baseParams, projectId: 11 },
      new Date("2026-09-07T00:00:00"),
    );
    expect(withId.projectId).toBe(11);
  });

  it("toTaskRecord：row.projectId 透出（null 容错）", () => {
    const ws = { id: 1, name: "空间", directoryPath: "/x" };
    expect(toTaskRecord({ ...row, projectId: 11 }, ws).projectId).toBe(11);
    expect(toTaskRecord({ ...row, projectId: null }, ws).projectId).toBeNull();
  });
});

describe("listRuns where 组合", () => {
  it("指定 taskId：先校验归属,where 不并图(任务详情口径)", async () => {
    vi.mocked(prisma.automationRun.count).mockResolvedValue(0);
    vi.mocked(prisma.automationRun.findMany).mockResolvedValue([]);
    // v12：指定 taskId 先经归属校验
    vi.mocked(prisma.automationTask.findFirst).mockResolvedValue({
      id: 7,
    } as never);
    vi.mocked(prisma.automationTask.findMany).mockResolvedValue([]);
    vi.mocked(prisma.graphDefinition.findMany).mockResolvedValue([]);
    const repo = new AutomationRepository();
    await repo.listRuns(1, 7, "failed", UID);
    expect(prisma.automationTask.findFirst).toHaveBeenCalledWith({
      where: { id: 7, userId: UID },
    });
    expect(prisma.automationRun.count).toHaveBeenCalledWith({
      where: { taskId: 7, status: "failed" },
    });
    expect(prisma.automationRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { taskId: 7, status: "failed" },
        skip: 0,
        take: 20,
      }),
    );
    // 不发起本人图集查询(不并图):graphDefinition 仅图名反查角色
    expect(prisma.graphDefinition.findMany).not.toHaveBeenCalledWith({
      where: { userId: UID },
      select: { id: true },
    });
  });

  it("不指定 taskId：OR 并入本人任务集与本人图集,分页 skip/take 随页码", async () => {
    vi.mocked(prisma.automationTask.findMany).mockResolvedValue([
      { id: 1 },
      { id: 2 },
    ] as never);
    vi.mocked(prisma.graphDefinition.findMany).mockResolvedValue([
      { id: 5 },
    ] as never);
    vi.mocked(prisma.automationRun.count).mockResolvedValue(0);
    vi.mocked(prisma.automationRun.findMany).mockResolvedValue([]);
    const repo = new AutomationRepository();
    await repo.listRuns(3, undefined, undefined, UID);
    // 本人任务集/图集收敛查询(图试运行 run 得以并入列表)
    expect(prisma.automationTask.findMany).toHaveBeenCalledWith({
      where: { userId: UID },
      select: { id: true },
    });
    expect(prisma.graphDefinition.findMany).toHaveBeenCalledWith({
      where: { userId: UID },
      select: { id: true },
    });
    const expected = {
      OR: [{ taskId: { in: [1, 2] } }, { graphId: { in: [5] } }],
    };
    expect(prisma.automationRun.count).toHaveBeenCalledWith({
      where: expected,
    });
    expect(prisma.automationRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expected,
        skip: 40,
        take: 20,
      }),
    );
  });

  it("图试运行 run(taskId=null)经图名联查补位 taskName=图名", async () => {
    const runRow = {
      id: 9,
      taskId: null,
      graphId: 5,
      graphTrace: "[]",
      sessionId: 12,
      attempt: 1,
      triggerType: "manual",
      status: "success",
      durationMs: 1200,
      promptTokens: 10,
      completionTokens: 20,
      error: null,
      startedAt: new Date("2026-10-03T08:00:00Z"),
      finishedAt: new Date("2026-10-03T08:00:02Z"),
    };
    vi.mocked(prisma.automationTask.findMany).mockResolvedValue([]);
    // 第 1 次调用为本人图集收敛,第 2 次为图名反查
    vi.mocked(prisma.graphDefinition.findMany)
      .mockResolvedValueOnce([{ id: 5 }] as never)
      .mockResolvedValueOnce([{ id: 5, name: "分支日报" }] as never);
    vi.mocked(prisma.automationRun.count).mockResolvedValue(1);
    vi.mocked(prisma.automationRun.findMany).mockResolvedValue([
      runRow,
    ] as never);
    const repo = new AutomationRepository();
    const page = await repo.listRuns(1, undefined, undefined, UID);
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].taskName).toBe("分支日报");
    expect(page.items[0].graphId).toBe(5);
    expect(page.items[0].graphTrace).toBe("[]");
  });
});

describe("buildTaskData targetKind/eventJson 落库", () => {
  it("缺省 → targetKind=prompt、graphId=null、eventJson=null", () => {
    const data = buildTaskData(baseParams, new Date("2026-09-07T00:00:00"));
    expect(data.targetKind).toBe("prompt");
    expect(data.graphId).toBeNull();
    expect(data.eventJson).toBeNull();
  });

  it("targetKind=graph → graphId 透传、prompt 清空、modelId 0 占位", () => {
    const data = buildTaskData(
      { ...baseParams, targetKind: "graph", graphId: 5, modelId: 0 },
      new Date("2026-09-07T00:00:00"),
    );
    expect(data.targetKind).toBe("graph");
    expect(data.graphId).toBe(5);
    expect(data.prompt).toBe("");
    expect(data.modelId).toBe(0);
  });

  it("eventJson 经 schema 规范化序列；非法结构抛错（保存期即拒）", () => {
    const appStarted = buildTaskData(
      { ...baseParams, eventJson: '{"source":"appStarted"}' },
      new Date("2026-09-07T00:00:00"),
    );
    expect(appStarted.eventJson).toBe('{"source":"appStarted"}');
    const chained = buildTaskData(
      {
        ...baseParams,
        eventJson:
          '{"source":"taskFinished","targetType":"task","targetId":9,"on":"failed"}',
      },
      new Date("2026-09-07T00:00:00"),
    );
    expect(JSON.parse(chained.eventJson as string)).toEqual({
      source: "taskFinished",
      targetType: "task",
      targetId: 9,
      on: "failed",
    });
    expect(() =>
      buildTaskData(
        { ...baseParams, eventJson: '{"source":"bogus"}' },
        new Date("2026-09-07T00:00:00"),
      ),
    ).toThrow();
  });
});

describe("assertNoSelfReference（spec §5 防环）", () => {
  const selfRef = {
    source: "taskFinished",
    targetType: "task",
    targetId: 7,
    on: "success",
  };

  it("taskFinished 指向任务自身 → EVENT_SELF_REFERENCE", () => {
    expect(() => assertNoSelfReference(selfRef, 7, null)).toThrowError(
      "EVENT_SELF_REFERENCE",
    );
  });

  it("graph 任务监听自身 graphId → EVENT_SELF_REFERENCE；非自身图放行", () => {
    const onGraph = (targetId: number) => ({
      source: "taskFinished",
      targetType: "graph",
      targetId,
      on: "any",
    });
    expect(() => assertNoSelfReference(onGraph(5), 7, 5)).toThrowError(
      "EVENT_SELF_REFERENCE",
    );
    expect(() => assertNoSelfReference(onGraph(6), 7, 5)).not.toThrow();
    // prompt 任务无 graphId（graphId=null）→ 图目标恒放行
    expect(() => assertNoSelfReference(onGraph(5), 7, null)).not.toThrow();
  });

  it("appStarted/他任务/图目标/create 无 id(null) → 放行", () => {
    expect(() => assertNoSelfReference(selfRef, 8, null)).not.toThrow();
    expect(() => assertNoSelfReference(selfRef, null, null)).not.toThrow();
    expect(() =>
      assertNoSelfReference({ source: "appStarted" }, 7, null),
    ).not.toThrow();
    expect(() =>
      assertNoSelfReference(
        {
          source: "taskFinished",
          targetType: "graph",
          targetId: 7,
          on: "any",
        },
        7,
        null,
      ),
    ).not.toThrow();
  });
});

describe("createTask graph 任务校验（graphId 归属）", () => {
  const graphParams = {
    ...baseParams,
    targetKind: "graph" as const,
    graphId: 5,
    modelId: 0,
    prompt: "",
  };

  it("graphId 不归本人 → GRAPH_NOT_FOUND；graph 任务跳过模型校验", async () => {
    vi.mocked(prisma.workspace.findFirst).mockResolvedValue({ id: 2 } as never);
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue(null);
    const repo = new AutomationRepository();
    await expect(repo["createTask"](graphParams, UID)).rejects.toThrowError(
      "GRAPH_NOT_FOUND",
    );
    expect(prisma.model.findUnique).not.toHaveBeenCalled();
  });

  it("graphId 归属通过 → create 落 targetKind=graph/graphId/eventJson", async () => {
    vi.mocked(prisma.workspace.findFirst).mockResolvedValue({ id: 2 } as never);
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue({
      id: 5,
      name: "demo",
    } as never);
    vi.mocked(prisma.automationTask.create).mockResolvedValue({
      ...row,
      targetKind: "graph",
      graphId: 5,
      eventJson: '{"source":"appStarted"}',
    } as never);
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue(null);
    const repo = new AutomationRepository();
    await repo["createTask"](
      { ...graphParams, eventJson: '{"source":"appStarted"}' },
      UID,
    );
    expect(prisma.automationTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          targetKind: "graph",
          graphId: 5,
          eventJson: '{"source":"appStarted"}',
          prompt: "",
          modelId: 0,
        }),
      }),
    );
  });
});

describe("updateTask 事件自引用拒绝（spec §5 防环）", () => {
  it("eventJson targetId=被编辑任务 id → EVENT_SELF_REFERENCE，不落库", async () => {
    vi.mocked(prisma.automationTask.findFirst).mockResolvedValue({
      id: 7,
    } as never);
    vi.mocked(prisma.workspace.findFirst).mockResolvedValue({ id: 2 } as never);
    vi.mocked(prisma.model.findUnique).mockResolvedValue({
      id: 3,
      providerId: 4,
    } as never);
    vi.mocked(prisma.provider.findFirst).mockResolvedValue({ id: 4 } as never);
    vi.mocked(prisma.automationTask.update).mockClear();
    const repo = new AutomationRepository();
    await expect(
      repo["updateTask"](
        7,
        {
          ...baseParams,
          eventJson:
            '{"source":"taskFinished","targetType":"task","targetId":7,"on":"any"}',
        },
        UID,
      ),
    ).rejects.toThrowError("EVENT_SELF_REFERENCE");
    expect(prisma.automationTask.update).not.toHaveBeenCalled();
  });

  it("graph 任务 eventJson 指向自身 graphId → EVENT_SELF_REFERENCE（接线透传 p.graphId）", async () => {
    vi.mocked(prisma.automationTask.findFirst).mockResolvedValue({
      id: 7,
    } as never);
    vi.mocked(prisma.workspace.findFirst).mockResolvedValue({ id: 2 } as never);
    // graphId 归属先过（assertTriggerRefsOwned 图校验先于事件自引用）
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue({
      id: 5,
      name: "demo",
    } as never);
    vi.mocked(prisma.automationTask.update).mockClear();
    const repo = new AutomationRepository();
    await expect(
      repo["updateTask"](
        7,
        {
          ...baseParams,
          targetKind: "graph",
          graphId: 5,
          modelId: 0,
          prompt: "",
          eventJson:
            '{"source":"taskFinished","targetType":"graph","targetId":5,"on":"any"}',
        },
        UID,
      ),
    ).rejects.toThrowError("EVENT_SELF_REFERENCE");
    expect(prisma.automationTask.update).not.toHaveBeenCalled();
  });
});

describe("deleteTasks 级联删除", () => {
  it("run 行删除前先连带删 graphRunNode 节点行（graphRunNode 无 taskId 列，先取 run id 集合）", async () => {
    vi.mocked(prisma.automationTask.findMany).mockClear();
    vi.mocked(prisma.automationTask.findMany).mockResolvedValue([
      { id: 7 },
      { id: 8 },
    ] as never);
    vi.mocked(prisma.automationRun.findMany).mockClear();
    vi.mocked(prisma.automationRun.findMany).mockResolvedValue([
      { id: 31 },
      { id: 32 },
    ] as never);
    vi.mocked(prisma.graphRunNode.deleteMany).mockClear();
    const repo = new AutomationRepository();
    const deleted = await repo.deleteTasks([7, 8, 99], UID);
    expect(deleted).toEqual([7, 8]);
    // 他人/不存在 id（99）被过滤；run id 集合按 owned 任务限定
    expect(prisma.automationRun.findMany).toHaveBeenCalledWith({
      where: { taskId: { in: [7, 8] } },
      select: { id: true },
    });
    expect(prisma.graphRunNode.deleteMany).toHaveBeenCalledWith({
      where: { runId: { in: [31, 32] } },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("无本人任务 → 返回空且不触库", async () => {
    vi.mocked(prisma.automationTask.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.automationRun.findMany).mockClear();
    vi.mocked(prisma.$transaction).mockClear();
    const repo = new AutomationRepository();
    expect(await repo.deleteTasks([404], UID)).toEqual([]);
    expect(prisma.automationRun.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
