import { describe, expect, it } from "vitest";
import {
  filterSessionsByTime,
  sortSessions,
  type SessionTimeFields,
} from "../../src-react/domains/ai/chat/lib/session-list";

function item(overrides: Partial<SessionTimeFields> & { id: number }) {
  return {
    updatedAt: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("sortSessions 置顶在前", () => {
  it("置顶项按 pinnedAt 倒序排最前，其余按最近活动倒序", () => {
    const now = "2026-09-05T00:00:00.000Z";
    const sorted = sortSessions([
      item({ id: 1, lastMessageAt: "2026-09-03T00:00:00.000Z" }),
      item({ id: 2, pinnedAt: "2026-09-01T00:00:00.000Z" }),
      item({ id: 3, pinnedAt: "2026-09-04T00:00:00.000Z" }),
      item({ id: 4, lastMessageAt: "2026-09-04T12:00:00.000Z" }),
      item({ id: 5 }),
    ]);
    expect(sorted.map((s) => s.id)).toEqual([3, 2, 4, 1, 5]);
    expect(now).toBeTruthy();
  });

  it("不修改入参数组", () => {
    const input = [
      item({ id: 1, lastMessageAt: "2026-09-03T00:00:00.000Z" }),
      item({ id: 2, pinnedAt: "2026-09-01T00:00:00.000Z" }),
    ];
    sortSessions(input);
    expect(input[0].id).toBe(1);
  });
});

describe("filterSessionsByTime 时间筛选", () => {
  const now = new Date(2026, 8, 5, 15, 0, 0); // 本地 2026-09-05 15:00
  const localMidnight = new Date(2026, 8, 5, 0, 0, 0).getTime();
  const iso = (d: Date) => d.toISOString();

  it("all 全部通过", () => {
    const sessions = [
      item({ id: 1, lastMessageAt: "2020-01-01T00:00:00.000Z" }),
      item({ id: 2 }),
    ];
    expect(filterSessionsByTime(sessions, "all", now)).toHaveLength(2);
  });

  it("today 仅保留本地当日 00:00 起的活动（含整点边界）", () => {
    const sessions = [
      item({
        id: 1,
        lastMessageAt: iso(new Date(2026, 8, 4, 23, 59, 59, 999)),
      }), // 界外
      item({ id: 2, lastMessageAt: iso(new Date(2026, 8, 5, 0, 0, 0)) }), // 界内
      item({ id: 3, lastMessageAt: iso(new Date(2026, 8, 5, 8, 0, 0)) }),
    ];
    expect(
      filterSessionsByTime(sessions, "today", now).map((s) => s.id),
    ).toEqual([2, 3]);
  });

  it("week 以本地当日 00:00 回溯 7 天为界，lastMessageAt 缺省回退 updatedAt", () => {
    const threshold = localMidnight - 7 * 86400000;
    const sessions = [
      item({ id: 1, lastMessageAt: iso(new Date(threshold - 1)) }), // 界外
      item({ id: 2, lastMessageAt: iso(new Date(threshold)) }), // 界内
      item({ id: 3, updatedAt: iso(new Date(2026, 8, 1, 12, 0, 0)) }), // 无 lastMessageAt
    ];
    expect(
      filterSessionsByTime(sessions, "week", now).map((s) => s.id),
    ).toEqual([2, 3]);
  });

  it("month 以本地当日 00:00 回溯 30 天为界", () => {
    const threshold = localMidnight - 30 * 86400000;
    const sessions = [
      item({ id: 1, lastMessageAt: iso(new Date(threshold - 1)) }), // 界外
      item({ id: 2, lastMessageAt: iso(new Date(threshold)) }), // 界内
    ];
    expect(
      filterSessionsByTime(sessions, "month", now).map((s) => s.id),
    ).toEqual([2]);
  });
});
