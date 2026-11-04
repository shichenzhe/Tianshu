// tests/ai/automation-stats.test.ts
import { describe, expect, it } from "vitest";
import {
  computeStats,
  type StatsRunRow,
} from "../../electron/domains/ai/automation/automation-stats";

/** 本地时区构造,避免测试机 TZ 环境差异 */
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date =>
  new Date(y, mo - 1, d, h, mi, s);

const run = (
  over: Partial<StatsRunRow> & Pick<StatsRunRow, "id" | "status" | "startedAt">,
): StatsRunRow => ({
  name: "任务A",
  error: undefined,
  graphId: undefined,
  ...over,
});

/** 固定"现在":2026-10-03 12:00(本地),趋势窗口 09-27..10-03 */
const NOW = at(2026, 10, 3, 12, 0, 0);

describe("computeStats", () => {
  it("今日计数与成功率:success/(success+failed),分母 0 → 0", () => {
    const stats = computeStats(
      [
        run({ id: 1, status: "success", startedAt: at(2026, 10, 3, 9) }),
        run({ id: 2, status: "success", startedAt: at(2026, 10, 3, 10) }),
        run({ id: 3, status: "failed", startedAt: at(2026, 10, 3, 11) }),
      ],
      [],
      NOW,
    );
    expect(stats.today).toEqual({
      total: 3,
      success: 2,
      failed: 1,
      running: 0,
      successRate: 2 / 3,
    });
  });

  it("分母 0:今日无 success/failed run(全 skipped/running 或空)→ successRate 0", () => {
    const stats = computeStats(
      [
        run({ id: 1, status: "skipped", startedAt: at(2026, 10, 3, 9) }),
        run({ id: 2, status: "running", startedAt: at(2026, 10, 3, 10) }),
      ],
      [],
      NOW,
    );
    expect(stats.today).toEqual({
      total: 2,
      success: 0,
      failed: 0,
      running: 1,
      successRate: 0,
    });
  });

  it("skipped/running 不进分母也不进 trend", () => {
    const stats = computeStats(
      [
        run({ id: 1, status: "success", startedAt: at(2026, 10, 3, 9) }),
        run({ id: 2, status: "failed", startedAt: at(2026, 10, 3, 10) }),
        run({ id: 3, status: "skipped", startedAt: at(2026, 10, 3, 11) }),
        run({ id: 4, status: "running", startedAt: at(2026, 10, 3, 11, 30) }),
        run({ id: 5, status: "skipped", startedAt: at(2026, 10, 1, 9) }),
      ],
      [],
      NOW,
    );
    expect(stats.today.successRate).toBe(0.5);
    expect(stats.trend.at(-1)).toEqual({
      date: "2026-10-03",
      success: 1,
      failed: 1,
    });
    // 10-01 仅 1 条 skipped:trend 该日双零
    expect(stats.trend).toContainEqual({
      date: "2026-10-01",
      success: 0,
      failed: 0,
    });
  });

  it("跨日分组:昨日 23:59 与今日 00:01 分属两桶,今日只数今日", () => {
    const stats = computeStats(
      [
        run({ id: 1, status: "success", startedAt: at(2026, 10, 2, 23, 59) }),
        run({ id: 2, status: "failed", startedAt: at(2026, 10, 3, 0, 1) }),
      ],
      [],
      NOW,
    );
    expect(stats.today.total).toBe(1);
    expect(stats.today.failed).toBe(1);
    expect(stats.trend).toContainEqual({
      date: "2026-10-02",
      success: 1,
      failed: 0,
    });
    expect(stats.trend).toContainEqual({
      date: "2026-10-03",
      success: 0,
      failed: 1,
    });
  });

  it("trend 恒 7 天(含今日)按 yyyy-MM-dd 升序,窗口外(第 8 天前)截断", () => {
    const stats = computeStats(
      [
        run({ id: 1, status: "success", startedAt: at(2026, 9, 27, 8) }),
        run({ id: 2, status: "success", startedAt: at(2026, 9, 26, 8) }),
        run({ id: 3, status: "failed", startedAt: at(2026, 9, 20, 8) }),
      ],
      [],
      NOW,
    );
    expect(stats.trend.map((d) => d.date)).toEqual([
      "2026-09-27",
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
    ]);
    // 09-27 计入首桶;09-26/09-20 窗口外丢弃
    expect(stats.trend[0]).toEqual({
      date: "2026-09-27",
      success: 1,
      failed: 0,
    });
    expect(
      stats.trend.slice(1).every((d) => d.success === 0 && d.failed === 0),
    ).toBe(true);
    expect(stats.today.total).toBe(0);
  });

  it("attention 24h 边界:恰好 24h 前的 failed 计入,再早 1ms 排除", () => {
    const edge = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    const stats = computeStats(
      [
        run({ id: 1, status: "failed", startedAt: edge, error: "edge" }),
        run({
          id: 2,
          status: "failed",
          startedAt: new Date(edge.getTime() - 1),
          error: "old",
        }),
      ],
      [],
      NOW,
    );
    const failedRuns = stats.attention.filter((x) => x.kind === "failedRun");
    expect(failedRuns).toHaveLength(1);
    expect(failedRuns[0]).toMatchObject({ runId: 1, error: "edge" });
    expect(failedRuns[0].startedAt).toBe(edge.toISOString());
  });

  it("非 failed 状态不进 24h 关注清单", () => {
    const stats = computeStats(
      [
        run({
          id: 1,
          status: "success",
          startedAt: new Date(NOW.getTime() - 1000),
        }),
        run({
          id: 2,
          status: "running",
          startedAt: new Date(NOW.getTime() - 1000),
        }),
      ],
      [],
      NOW,
    );
    expect(stats.attention).toHaveLength(0);
  });

  it("多任务多 run 混合:taskError 全列在前,failedRun 按 startedAt 降序", () => {
    const stats = computeStats(
      [
        run({
          id: 10,
          status: "failed",
          startedAt: at(2026, 10, 3, 8),
          name: "早报任务",
          error: "model_missing",
        }),
        run({
          id: 11,
          status: "failed",
          startedAt: at(2026, 10, 3, 11),
          name: "调研图",
          graphId: 7,
          error: "node:n1 timeout",
        }),
        run({
          id: 12,
          status: "failed",
          startedAt: at(2026, 10, 3, 9, 30),
          name: "巡检任务",
        }),
      ],
      [
        { id: 3, name: "周报任务", statusNote: "graph_missing" },
        { id: 5, name: "旧任务", statusNote: "model_missing" },
      ],
      NOW,
    );
    expect(stats.errorTaskCount).toBe(2);
    expect(stats.attention).toHaveLength(5);
    expect(stats.attention.slice(0, 2)).toEqual([
      {
        kind: "taskError",
        taskId: 3,
        name: "周报任务",
        statusNote: "graph_missing",
      },
      {
        kind: "taskError",
        taskId: 5,
        name: "旧任务",
        statusNote: "model_missing",
      },
    ]);
    expect(
      stats.attention.slice(2).map((x) => (x as { runId: number }).runId),
    ).toEqual([11, 12, 10]);
    const graphRun = stats.attention[2];
    expect(graphRun).toMatchObject({
      kind: "failedRun",
      name: "调研图",
      graphId: 7,
      error: "node:n1 timeout",
    });
    const promptRun = stats.attention[4];
    expect(promptRun).toMatchObject({
      runId: 10,
      name: "早报任务",
      error: "model_missing",
    });
    expect("graphId" in promptRun && promptRun.graphId !== undefined).toBe(
      false,
    );
  });

  it("error 任务无 run 时也全量列出(errorTasks 与 runs 两源独立)", () => {
    const stats = computeStats(
      [],
      [{ id: 9, name: "孤儿任务", statusNote: "model_missing" }],
      NOW,
    );
    expect(stats.errorTaskCount).toBe(1);
    expect(stats.attention).toEqual([
      {
        kind: "taskError",
        taskId: 9,
        name: "孤儿任务",
        statusNote: "model_missing",
      },
    ]);
    expect(stats.today.total).toBe(0);
    expect(stats.today.successRate).toBe(0);
  });
});
