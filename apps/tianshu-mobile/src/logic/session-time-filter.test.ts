import { describe, expect, it } from "vitest";

import { computeActivityAfter } from "./session-time-filter";

describe("computeActivityAfter 会话时间筛选阈值（A11 批）", () => {
  const now = new Date(2026, 8, 5, 15, 30, 45); // 本地 2026-09-05 15:30:45

  it("all 返回 null（不出 activityAfter 键）", () => {
    expect(computeActivityAfter("all", now)).toBeNull();
  });

  it("today=本机今日 00:00（零点边界，时刻分量全零）", () => {
    const iso = computeActivityAfter("today", now);
    const d = new Date(iso!);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
    expect(iso).toBe(new Date(2026, 8, 5).toISOString());
  });

  it("week=当日 00:00 回溯 7 天（滚动窗，非自然周）", () => {
    const iso = computeActivityAfter("week", now);
    const threshold = new Date(2026, 8, 5).getTime() - 7 * 86400000;
    expect(iso).toBe(new Date(threshold).toISOString());
    // 钉滚动窗语义：界外=阈值前 1ms，界内=阈值整点（与桌面回归测试同锚点）
    expect(new Date(iso!).getTime()).toBe(threshold);
    // 非自然周：上周日（9 天前的那个自然周起点）不在窗内锚点上
    expect(iso).not.toBe(new Date(2026, 8, 5).toISOString());
  });

  it("month=当日 00:00 回溯 30 天（滚动窗，非自然月）", () => {
    const iso = computeActivityAfter("month", now);
    const threshold = new Date(2026, 8, 5).getTime() - 30 * 86400000;
    expect(iso).toBe(new Date(threshold).toISOString());
    // 非自然月：当月 1 号 00:00 不是锚点
    expect(iso).not.toBe(new Date(2026, 8, 1).toISOString());
  });

  it("本地时区性：锚点是本机午夜而非 UTC 午夜（与桌面 startOfDay 同构造）", () => {
    // 任意本地时区下，threshold 按 new Date(y, m, d) 构造——与其本地
    // 午夜解析恒等；UTC 小时数随时区漂移，不得钉死为 0
    const iso = computeActivityAfter("today", now)!;
    const offsetHours = new Date(iso).getTimezoneOffset() / 60;
    expect(new Date(iso).getUTCHours()).toBe((24 + offsetHours) % 24);
    // 同一本地钟面时刻，阈值 ISO 与本地构造一致（不随 TZ 环境漂移）
    expect(iso).toBe(
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
    );
  });

  it("缺省 now 取当前时刻：today 锚定今日 00:00，返回值可解析", () => {
    const before = new Date();
    const iso = computeActivityAfter("today")!;
    const after = new Date();
    const anchor = new Date(
      before.getFullYear(),
      before.getMonth(),
      before.getDate(),
    );
    expect(new Date(iso).getTime()).toBe(anchor.getTime());
    expect(before.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});
