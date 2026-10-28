import { describe, expect, it } from "vitest";

import { formatRelative } from "./time";

describe("formatRelative", () => {
  it("60 秒内 → 刚刚", () => {
    const now = new Date(2026, 2, 10, 14, 0, 0);
    const then = new Date(2026, 2, 10, 13, 59, 30);
    expect(formatRelative(then.toISOString(), now)).toEqual({ key: "justNow" });
  });

  it("5 分钟前 → N 分钟前", () => {
    const now = new Date(2026, 2, 10, 14, 0, 0);
    const then = new Date(2026, 2, 10, 13, 55, 0);
    expect(formatRelative(then.toISOString(), now)).toEqual({
      key: "minutesAgo",
      count: 5,
    });
  });

  it("3 小时前（同日）→ N 小时前", () => {
    const now = new Date(2026, 2, 10, 14, 0, 0);
    const then = new Date(2026, 2, 10, 11, 0, 0);
    expect(formatRelative(then.toISOString(), now)).toEqual({
      key: "hoursAgo",
      count: 3,
    });
  });

  it("上一自然日 → 昨天", () => {
    const now = new Date(2026, 2, 10, 9, 0, 0);
    const then = new Date(2026, 2, 9, 18, 0, 0);
    expect(formatRelative(then.toISOString(), now)).toEqual({ key: "yesterday" });
  });

  it("更早：同年 MM-DD、跨年 YYYY-MM-DD", () => {
    const now = new Date(2026, 2, 10, 9, 0, 0);
    // 同年更早（前天及以前）
    const sameYear = new Date(2026, 1, 1, 12, 0, 0);
    expect(formatRelative(sameYear.toISOString(), now)).toEqual({
      key: "date",
      text: "02-01",
    });
    // 跨年
    const crossYear = new Date(2025, 11, 31, 12, 0, 0);
    expect(formatRelative(crossYear.toISOString(), now)).toEqual({
      key: "date",
      text: "2025-12-31",
    });
  });

  it("畸形 iso 防御 → 空 date 文案（不抛错）", () => {
    expect(formatRelative("not-a-date", new Date())).toEqual({
      key: "date",
      text: "",
    });
  });

  it("未来 60 秒内 → 即将（M2c nextRunAt）", () => {
    const now = new Date(2026, 2, 10, 14, 0, 0);
    const then = new Date(2026, 2, 10, 14, 0, 30);
    expect(formatRelative(then.toISOString(), now)).toEqual({ key: "inMoments" });
  });

  it("未来 5 分钟 → N 分钟后（向上取整）", () => {
    const now = new Date(2026, 2, 10, 14, 0, 0);
    const then = new Date(2026, 2, 10, 14, 5, 30); // 5.5 分钟 → 6
    expect(formatRelative(then.toISOString(), now)).toEqual({
      key: "inMinutes",
      count: 6,
    });
  });

  it("未来 3 小时（同日）→ N 小时后", () => {
    const now = new Date(2026, 2, 10, 14, 0, 0);
    const then = new Date(2026, 2, 10, 17, 0, 0);
    expect(formatRelative(then.toISOString(), now)).toEqual({
      key: "inHours",
      count: 3,
    });
  });

  it("未来跨日：同年 MM-DD、跨年 YYYY-MM-DD", () => {
    const now = new Date(2026, 2, 10, 9, 0, 0);
    const sameYear = new Date(2026, 2, 12, 9, 0, 0);
    expect(formatRelative(sameYear.toISOString(), now)).toEqual({
      key: "date",
      text: "03-12",
    });
    const crossYear = new Date(2027, 0, 1, 9, 0, 0);
    expect(formatRelative(crossYear.toISOString(), now)).toEqual({
      key: "date",
      text: "2027-01-01",
    });
  });
});
