// 每日统计 rollup 纯函数（批3A §6-6）：automationRun → 按日/按用户聚合
// 桶 + 单调合并（保留策略裁剪 run 后历史不缩水）——双端调度器同构消费。
import { describe, expect, it } from "vitest";
import {
  AUTOMATION_STAT_ROLLUP_EVENT,
  buildDailyRollups,
  mergeRollupDetail,
  parseRollupDetail,
  ROLLUP_WINDOW_DAYS,
  rollupDateKey,
  rollupWindowKeys,
} from "./automation-rollup";

const at = (iso: string) => new Date(iso);

describe("rollupDateKey / rollupWindowKeys", () => {
  it("本地日键 yyyy-MM-dd（设备时区口径，与 computeStats today 一致）", () => {
    expect(rollupDateKey(at("2026-11-05T08:30:00"))).toBe("2026-11-05");
    expect(rollupDateKey(at("2026-01-01T00:00:00"))).toBe("2026-01-01");
  });
  it("窗口键 = 含今日往回 N 个自然日，旧→新排序", () => {
    expect(rollupWindowKeys(at("2026-11-05T23:59:59"), 3)).toEqual([
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
    ]);
    expect(ROLLUP_WINDOW_DAYS).toBe(7);
    expect(rollupWindowKeys(at("2026-11-05T00:00:00"), 7)).toHaveLength(7);
  });
});

describe("buildDailyRollups 聚合正确性", () => {
  it("按日 × 按用户聚合计数；skipped 入桶；窗口外日期不计；零运行日不出行", () => {
    const runs = [
      // 用户 7：11-04 成功 ×2、失败 ×1；11-05 skipped ×1、running ×1
      { startedAt: at("2026-11-04T09:00:00"), status: "success", userKey: "7" },
      { startedAt: at("2026-11-04T10:00:00"), status: "success", userKey: "7" },
      { startedAt: at("2026-11-04T11:00:00"), status: "failed", userKey: "7" },
      { startedAt: at("2026-11-05T09:00:00"), status: "skipped", userKey: "7" },
      { startedAt: at("2026-11-05T10:00:00"), status: "running", userKey: "7" },
      // 用户 9：11-04 失败 ×1（多用户分桶不串）
      { startedAt: at("2026-11-04T12:00:00"), status: "failed", userKey: "9" },
      // 窗口外（11-01）不计
      { startedAt: at("2026-11-01T09:00:00"), status: "success", userKey: "7" },
    ];
    const rollups = buildDailyRollups(runs, [
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
    ]);
    // 11-03 零运行 → 无行
    expect(rollups.map((r) => r.date)).toEqual(["2026-11-04", "2026-11-05"]);
    expect(rollups[0].byUser).toEqual({
      "7": { total: 3, success: 2, failed: 1, skipped: 0 },
      "9": { total: 1, success: 0, failed: 1, skipped: 0 },
    });
    // running 不入 success/failed/skipped 桶但计 total（与 today 口径一致）
    expect(rollups[1].byUser).toEqual({
      "7": { total: 2, success: 0, failed: 0, skipped: 1 },
    });
  });
  it("startedAt 接受 ISO 串（automationStat detail 回读比对场景）", () => {
    const rollups = buildDailyRollups(
      [{ startedAt: "2026-11-04T09:00:00", status: "success", userKey: "1" }],
      ["2026-11-04"],
    );
    expect(rollups[0].byUser["1"].success).toBe(1);
  });
});

describe("parseRollupDetail", () => {
  it("合法 detail → rollup；坏 JSON/缺字段 → null", () => {
    const detail = JSON.stringify({
      date: "2026-11-04",
      byUser: { "7": { total: 2, success: 1, failed: 1, skipped: 0 } },
    });
    expect(parseRollupDetail(detail)?.date).toBe("2026-11-04");
    expect(parseRollupDetail("not json")).toBeNull();
    expect(parseRollupDetail('{"date":"2026-11-04"}')).toBeNull();
  });
});

describe("mergeRollupDetail 单调合并", () => {
  it("逐用户取计算值覆盖旧值（重算增长/持平写回）", () => {
    const existing = {
      date: "2026-11-04",
      byUser: {
        "7": { total: 1, success: 1, failed: 0, skipped: 0 },
        "9": { total: 5, success: 5, failed: 0, skipped: 0 },
      },
    };
    const computed = {
      date: "2026-11-04",
      byUser: {
        "7": { total: 3, success: 2, failed: 1, skipped: 0 },
      },
    };
    expect(mergeRollupDetail(existing, computed)).toEqual({
      date: "2026-11-04",
      byUser: {
        "7": { total: 3, success: 2, failed: 1, skipped: 0 },
        // 计算侧缺席的用户桶保留（不被裁剪/未触达）
        "9": { total: 5, success: 5, failed: 0, skipped: 0 },
      },
    });
  });
  it("保留策略裁剪 run 后重算缩水 → 旧桶保底（历史不回退）", () => {
    const existing = {
      date: "2026-11-02",
      byUser: { "7": { total: 6, success: 6, failed: 0, skipped: 0 } },
    };
    const computed = {
      date: "2026-11-02",
      byUser: { "7": { total: 2, success: 2, failed: 0, skipped: 0 } },
    };
    expect(mergeRollupDetail(existing, computed).byUser["7"].total).toBe(6);
  });
  it("事件桶名常量（automationStat 新 bucket，免 schema 迁移）", () => {
    expect(AUTOMATION_STAT_ROLLUP_EVENT).toBe("dailyRollup");
  });
});
