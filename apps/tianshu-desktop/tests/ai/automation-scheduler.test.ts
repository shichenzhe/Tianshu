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
  // 返回 resolved promise:launch 内 .catch/.finally 链需要(裸 vi.fn() 返回 undefined 会在 fire 处抛)
  executeTask: vi.fn(() => Promise.resolve("success")),
}));
// 每日 rollup(批3A §6-6):模块级节流在真身内部——tick 挂点断言用替身,
// 聚合正确性由 automation-stat-rollup.test.ts + packages core 测试守护
vi.mock("../../electron/domains/ai/automation/automation-stat", () => ({
  recordAutomationEvent: vi.fn(),
  maybeRollupAutomationStats: vi.fn(),
}));

import AutomationScheduler, {
  decideTick,
  pickRetryTaskIds,
} from "../../electron/domains/ai/automation/automation-scheduler";
import { executeTask } from "../../electron/domains/ai/automation/automation-runner";
import { maybeRollupAutomationStats } from "../../electron/domains/ai/automation/automation-stat";
import prisma from "../../electron/commons/prisma-client";

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

describe("pickRetryTaskIds 指数退避 + 错误分类可重试面(批3A §6-4)", () => {
  const failed = (attempt: number, error?: string | null) => ({
    status: "failed",
    attempt,
    finishedAt: new Date("2026-09-07T08:30:00"),
    ...(error !== undefined ? { error } : {}),
  });
  it("冷却按 attempt 指数退避:attempt 2 需 180s(60/180/540 序列)", () => {
    const cooled = (offsetMs: number) =>
      new Date(new Date("2026-09-07T08:30:00").getTime() + offsetMs);
    // 60s 已过但 180s 未到 → 不重试
    expect(pickRetryTaskIds(new Map([[1, failed(2)]]), cooled(60_000))).toEqual(
      [],
    );
    // 179s 仍未到 → 不重试(旧固定 60s 逻辑会误重试)
    expect(
      pickRetryTaskIds(new Map([[1, failed(2)]]), cooled(179_000)),
    ).toEqual([]);
    expect(
      pickRetryTaskIds(new Map([[1, failed(2)]]), cooled(180_000)),
    ).toEqual([1]);
    // attempt 1 仍 60s;attempt 3 已到 attempt 上限不再重试(540s 序列值
    // 由 core nextRetryDelay 直测守护,扫描侧被 MAX_ATTEMPT 门先拦)
    expect(pickRetryTaskIds(new Map([[1, failed(1)]]), cooled(60_000))).toEqual(
      [1],
    );
    expect(
      pickRetryTaskIds(new Map([[1, failed(3)]]), cooled(180_000)),
    ).toEqual([]);
    expect(
      pickRetryTaskIds(new Map([[1, failed(3)]]), cooled(540_000)),
    ).toEqual([]);
  });
  it("网络/限流/超时类 error → 重试;配置类(AUTH_FAILED/MODEL_NOT_FOUND/IMAGE_UNSUPPORTED)→ 不重试", () => {
    const m = new Map([
      [1, failed(1, "RATE_LIMITED: 429")],
      [2, failed(1, "TIMEOUT: timed out")],
      [3, failed(1, "AUTH_FAILED: bad key")],
      [4, failed(1, "MODEL_NOT_FOUND: 404")],
      [5, failed(1, "IMAGE_UNSUPPORTED: no vision")],
      // 图运行聚合格式 node:<id> CODE: msg 同样取码判定
      [6, failed(1, "node:n1 NETWORK: fetch failed")],
      [7, failed(1, "node:n2 AUTH_FAILED: bad key")],
      // error 缺席(旧快照形状)→ 默认可重试,不放大破坏面
      [8, failed(1)],
    ]);
    const t = new Date("2026-09-07T08:40:00");
    expect(pickRetryTaskIds(m, t)).toEqual([1, 2, 6, 8]);
  });
});

describe("decideTick 补跑上限 catchUpLimit(批3A §6-1)", () => {
  const missed = {
    ...base,
    missedPolicy: "catchUpOnce",
    nextRunAt: new Date("2026-09-07T07:00:00"),
    lastRunAt: new Date("2026-09-06T09:00:00"),
  };
  it("缺省上限 1:未补过 → catchUp;已补 1 次 → advance(既有 catchUpOnce 行为)", () => {
    expect(decideTick(missed as never, now, boot, 0)).toBe("catchUp");
    expect(decideTick(missed as never, now, boot, 1)).toBe("advance");
  });
  it("catchUpLimit=3:已补 2 次 → catchUp;已补 3 次 → advance", () => {
    const limit3 = { ...missed, catchUpLimit: 3 };
    expect(decideTick(limit3 as never, now, boot, 2)).toBe("catchUp");
    expect(decideTick(limit3 as never, now, boot, 3)).toBe("advance");
  });
  it("行缺列/脏数据回退 1;上限 clamp 到 10(防补跑风暴)", () => {
    expect(decideTick(missed as never, now, boot, 1)).toBe("advance");
    const limit99 = { ...missed, catchUpLimit: 99 };
    expect(decideTick(limit99 as never, now, boot, 9)).toBe("catchUp");
    expect(decideTick(limit99 as never, now, boot, 10)).toBe("advance");
  });
  it("skip 策略不受上限影响 → skip", () => {
    expect(
      decideTick({ ...missed, missedPolicy: "skip" } as never, now, boot, 0),
    ).toBe("skip");
  });
});

describe("AutomationScheduler.tick 调度集合", () => {
  it("只取 enabled 且 status=active 的任务(否则 expired-but-enabled 每 30s 重复 expire+广播)", async () => {
    vi.mocked(prisma.automationTask.findMany).mockResolvedValue([]);
    vi.mocked(prisma.automationRun.findMany).mockResolvedValue([]);
    const scheduler = new AutomationScheduler();
    await (scheduler as unknown as { tick: () => Promise<void> }).tick();
    expect(prisma.automationTask.findMany).toHaveBeenCalledWith({
      where: { enabled: true, status: "active" },
    });
  });
});

describe("AutomationScheduler.loadLatestRuns 查询限量", () => {
  it("最新 run 快照只取决策七列（不搬 graphTrace 大 JSON，30s 轮询热路径；批3A 增 error/triggerType/startedAt——退避可重试面判定 + 补跑计数）", async () => {
    vi.mocked(prisma.automationTask.findMany).mockResolvedValue([]);
    vi.mocked(prisma.automationRun.findMany).mockResolvedValue([]);
    const scheduler = new AutomationScheduler();
    await (scheduler as unknown as { tick: () => Promise<void> }).tick();
    expect(prisma.automationRun.findMany).toHaveBeenCalledWith({
      orderBy: { id: "desc" },
      take: 500,
      select: {
        taskId: true,
        status: true,
        attempt: true,
        finishedAt: true,
        error: true,
        triggerType: true,
        startedAt: true,
      },
    });
  });
});

describe("AutomationScheduler.tick 重试联动(once 失败不先 expire)", () => {
  it("expire 让路待重试任务;scanRetries 独立反查 active+enabled 并以 attempt+1 重试", async () => {
    const onceFailed = {
      ...base,
      status: "active",
      enabled: true,
      nextRunAt: null,
      lastRunAt: new Date("2026-09-07T08:00:00"),
      scheduleJson:
        '{"mode":"periodic","kind":"once","runAt":"2026-09-06T09:00:00.000Z"}',
    };
    vi.mocked(prisma.automationTask.findMany).mockClear();
    vi.mocked(prisma.automationTask.findMany)
      .mockResolvedValueOnce([onceFailed as never]) // tick 决策快照
      .mockResolvedValueOnce([onceFailed as never]); // scanRetries 独立反查
    vi.mocked(prisma.automationRun.findMany).mockResolvedValue([
      {
        taskId: 1,
        status: "failed",
        attempt: 1,
        finishedAt: new Date(Date.now() - 120_000),
      } as never,
    ]);
    const scheduler = new AutomationScheduler();
    await (scheduler as unknown as { tick: () => Promise<void> }).tick();
    // 决策树 !nextRunAt 的 expire 让路重试预算:不落 expire 写
    expect(prisma.automationTask.update).not.toHaveBeenCalled();
    // 独立反查(不复用 tick 快照,active+enabled 过滤)
    expect(
      vi.mocked(prisma.automationTask.findMany).mock.calls[1]?.[0],
    ).toEqual({
      where: { id: { in: [1] }, enabled: true, status: "active" },
    });
    expect(executeTask).toHaveBeenCalledWith(
      onceFailed,
      expect.objectContaining({ triggerType: "retry", attempt: 2 }),
    );
  });
});

describe("AutomationScheduler.tick 补跑计数与重放相位(批3A §6-1)", () => {
  // tick 内部用真实时钟(processStartTime = 构造时刻),任务/run 以相对
  // Date.now() 造数与既有重试用例同款
  const missedCatchUpTask = () => ({
    ...base,
    missedPolicy: "catchUpOnce",
    nextRunAt: new Date(Date.now() - 3_600_000),
    lastRunAt: new Date(Date.now() - 7_200_000),
  });
  const catchUpRun = (offsetMs: number) => ({
    taskId: 1,
    status: "success",
    attempt: 1,
    finishedAt: new Date(Date.now() + offsetMs),
    error: null,
    triggerType: "catchUp",
    startedAt: new Date(Date.now() + offsetMs),
  });
  it("已补 1 次(catchUp run startedAt ≥ 进程启动)且上限 1 → advance 不再补", async () => {
    vi.mocked(executeTask).mockClear();
    vi.mocked(prisma.automationTask.findMany).mockClear();
    vi.mocked(prisma.automationTask.findMany).mockResolvedValue([
      missedCatchUpTask() as never,
    ]);
    vi.mocked(prisma.automationRun.findMany).mockResolvedValue([
      // startedAt 晚于进程启动(调度器刚构造)→ 计数 1
      catchUpRun(60_000) as never,
    ]);
    vi.mocked(prisma.automationTask.update).mockClear();
    const scheduler = new AutomationScheduler();
    await (scheduler as unknown as { tick: () => Promise<void> }).tick();
    expect(executeTask).not.toHaveBeenCalled();
    expect(prisma.automationTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({ nextRunAt: expect.any(Date) }),
      }),
    );
  });
  it("进程启动前的 catchUp run 不计数(上一进程的补跑)→ 仍 catchUp,且以 task.nextRunAt 为 replayAt 重放", async () => {
    vi.mocked(executeTask).mockClear();
    vi.mocked(prisma.automationTask.findMany).mockClear();
    const task = missedCatchUpTask();
    vi.mocked(prisma.automationTask.findMany).mockResolvedValue([task as never]);
    vi.mocked(prisma.automationRun.findMany).mockResolvedValue([
      catchUpRun(-3_600_000) as never,
    ]);
    vi.mocked(executeTask).mockClear();
    const scheduler = new AutomationScheduler();
    await (scheduler as unknown as { tick: () => Promise<void> }).tick();
    expect(executeTask).toHaveBeenCalledWith(
      task,
      expect.objectContaining({
        triggerType: "catchUp",
        replayAt: task.nextRunAt,
      }),
    );
  });
  it("schedule 触发的 run 不计入补跑数(仅 triggerType=catchUp 计数)", async () => {
    vi.mocked(prisma.automationTask.findMany).mockClear();
    vi.mocked(prisma.automationTask.findMany).mockResolvedValue([
      missedCatchUpTask() as never,
    ]);
    vi.mocked(prisma.automationRun.findMany).mockResolvedValue([
      { ...catchUpRun(60_000), triggerType: "schedule" } as never,
    ]);
    vi.mocked(executeTask).mockClear();
    const scheduler = new AutomationScheduler();
    await (scheduler as unknown as { tick: () => Promise<void> }).tick();
    expect(executeTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      expect.objectContaining({ triggerType: "catchUp" }),
    );
  });
  it("tick 收尾触发每日 rollup(节流与聚合在 automation-stat 内部)", async () => {
    vi.mocked(prisma.automationTask.findMany).mockResolvedValue([]);
    vi.mocked(prisma.automationRun.findMany).mockResolvedValue([]);
    vi.mocked(maybeRollupAutomationStats).mockClear();
    const scheduler = new AutomationScheduler();
    await (scheduler as unknown as { tick: () => Promise<void> }).tick();
    expect(maybeRollupAutomationStats).toHaveBeenCalledWith(prisma);
  });
});
