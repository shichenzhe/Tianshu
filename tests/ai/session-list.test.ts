import { describe, expect, it } from "vitest";
import {
  SIDEBAR_GROUP_VISIBLE_DEFAULT,
  SIDEBAR_GROUP_VISIBLE_STEP,
  canCollapseVisible,
  nextVisibleCount,
  remainingVisible,
  resolveVisibleCount,
  visibleCountCovering,
  splitArchived,
  filterSessionsByTime,
  projectSessionGroups,
  sortSessions,
  unreadBadgeText,
  type SessionGroupFields,
  type SessionTimeFields,
} from "../../src-react/domains/ai/chat/lib/session-list";

function item(
  overrides: Partial<SessionTimeFields & SessionGroupFields> & { id: number },
) {
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

  it("无消息任务沉底：updatedAt 更新也排在有更早 lastMessageAt 的任务之后", () => {
    const sorted = sortSessions([
      item({ id: 1, updatedAt: "2026-09-04T23:00:00.000Z" }), // 无 lastMessageAt
      item({ id: 2, lastMessageAt: "2026-09-01T00:00:00.000Z" }), // 有消息但更早
    ]);
    expect(sorted.map((s) => s.id)).toEqual([2, 1]);
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

describe("projectSessionGroups 项目分组派生（一期会话统一 D4）", () => {
  it("projectId 非空会话按项目聚合，普通会话不进组；组内任务会话排主会话前", () => {
    const groups = projectSessionGroups([
      item({ id: 1 }),
      item({ id: 2, projectId: 11 }),
      item({ id: 3, projectId: 11, planItemId: 55 }),
      item({ id: 4, projectId: 12 }),
    ]);
    expect(groups.map((g) => g.projectId)).toEqual([11, 12]);
    // 组内 planItemId 非空（任务会话）在前，子集内保持传入序
    expect(groups[0].sessions.map((s) => s.id)).toEqual([3, 2]);
    expect(groups[1].sessions.map((s) => s.id)).toEqual([4]);
  });

  it("组间按 projectOrder（侧边栏项目列表序）取有会话的项目，已删项目兜底在后", () => {
    const groups = projectSessionGroups(
      [
        item({ id: 1, projectId: 99 }), // 已删项目先出现（首现序兜底）
        item({ id: 2, projectId: 11 }),
        item({ id: 3, projectId: 12 }),
      ],
      [12, 11],
    );
    expect(groups.map((g) => g.projectId)).toEqual([12, 11, 99]);
  });

  it("projectOrder 内无会话的项目不产生空组", () => {
    const groups = projectSessionGroups(
      [item({ id: 1, projectId: 11 })],
      [11, 12],
    );
    expect(groups.map((g) => g.projectId)).toEqual([11]);
  });

  it("与时间筛选组合：界外项目会话被滤掉后不产生组（时间筛选覆盖项目会话）", () => {
    const now = new Date(2026, 8, 5, 15, 0, 0); // 本地 2026-09-05 15:00
    const filtered = filterSessionsByTime(
      [
        item({
          id: 1,
          projectId: 11,
          lastMessageAt: new Date(2026, 8, 5, 8, 0, 0).toISOString(),
        }),
        item({
          id: 2,
          projectId: 12,
          lastMessageAt: new Date(2026, 8, 1, 0, 0, 0).toISOString(),
        }),
        item({
          id: 3,
          lastMessageAt: new Date(2026, 8, 1, 0, 0, 0).toISOString(),
        }),
      ],
      "today",
      now,
    );
    const groups = projectSessionGroups(filtered, [11, 12]);
    expect(groups.map((g) => g.projectId)).toEqual([11]);
  });

  it("不修改入参数组", () => {
    const input = [
      item({ id: 1, projectId: 11 }),
      item({ id: 2, projectId: 11, planItemId: 55 }),
    ];
    projectSessionGroups(input);
    expect(input.map((s) => s.id)).toEqual([1, 2]);
  });
});

describe("splitArchived（归档拆分）", () => {
  const base = { updatedAt: "2026-09-20T00:00:00.000Z" };

  it("归档（archivedAt 非空）单独成组，正常列表不含归档", () => {
    const { active, archived } = splitArchived([
      { ...base, id: 1 },
      { ...base, id: 2, archivedAt: "2026-09-21T00:00:00.000Z" },
      { ...base, id: 3, archivedAt: null },
    ] as never);
    expect(active.map((s) => s.id)).toEqual([1, 3]);
    expect(archived.map((s) => s.id)).toEqual([2]);
  });

  it("无归档时空组（不渲染分组）", () => {
    const { active, archived } = splitArchived([{ ...base, id: 1 }] as never);
    expect(active).toHaveLength(1);
    expect(archived).toHaveLength(0);
  });
});

describe("侧栏组收缩 visibleCount（对齐 WorkBuddy 语义）", () => {
  it("常量：默认 5 条、步进 20", () => {
    expect(SIDEBAR_GROUP_VISIBLE_DEFAULT).toBe(5);
    expect(SIDEBAR_GROUP_VISIBLE_STEP).toBe(20);
  });

  it("resolveVisibleCount：未存/非法回落默认，低于默认抬到默认，小数向下取整", () => {
    expect(resolveVisibleCount(undefined)).toBe(5);
    expect(resolveVisibleCount(Number.NaN)).toBe(5);
    expect(resolveVisibleCount(Number.POSITIVE_INFINITY)).toBe(5);
    expect(resolveVisibleCount(3)).toBe(5);
    expect(resolveVisibleCount(7.9)).toBe(7);
    expect(resolveVisibleCount(25)).toBe(25);
  });

  it("nextVisibleCount：当前 +20 步进，封顶总数；总数非正回落默认", () => {
    expect(nextVisibleCount(5, 30)).toBe(25);
    expect(nextVisibleCount(25, 30)).toBe(30);
    expect(nextVisibleCount(5, 15)).toBe(15); // 封顶
    expect(nextVisibleCount(5, 0)).toBe(5);
  });

  it("remainingVisible：总数 - 当前可见，下限 0", () => {
    expect(remainingVisible(5, 30)).toBe(25);
    expect(remainingVisible(30, 30)).toBe(0);
    expect(remainingVisible(30, 10)).toBe(0);
  });

  it("canCollapseVisible：总数超默认且已展开超默认才可收起", () => {
    expect(canCollapseVisible(5, 30)).toBe(false); // 默认态无「收起」
    expect(canCollapseVisible(25, 30)).toBe(true);
    expect(canCollapseVisible(25, 5)).toBe(false); // 总数不超默认
  });

  it("visibleCountCovering：选中项在可见范围内不扩档，超界扩到覆盖它的最小档位", () => {
    // 选中不在组内（-1）或已在可见区：维持当前存储值
    expect(visibleCountCovering(-1, undefined)).toBe(5);
    expect(visibleCountCovering(-1, 25)).toBe(25);
    expect(visibleCountCovering(4, undefined)).toBe(5);
    // 第 6 条（idx=5）被选中：5 + ceil(6/20)*20 = 25
    expect(visibleCountCovering(5, undefined)).toBe(25);
    // 已展开 25 时第 25 条（idx=24）选中：仍在界内不扩
    expect(visibleCountCovering(24, 25)).toBe(25);
    // 已展开 25 时第 26 条（idx=25）选中：5 + ceil(26/20)*20 = 45
    expect(visibleCountCovering(25, 25)).toBe(45);
  });
});

describe("unreadBadgeText 未读角标投影（P1 尾）", () => {
  it("≤0/undefined 不显（null）；1..99 显原数；≥100 显 99+", () => {
    expect(unreadBadgeText(undefined)).toBeNull();
    expect(unreadBadgeText(0)).toBeNull();
    expect(unreadBadgeText(-3)).toBeNull();
    expect(unreadBadgeText(1)).toBe("1");
    expect(unreadBadgeText(99)).toBe("99");
    expect(unreadBadgeText(100)).toBe("99+");
    expect(unreadBadgeText(1500)).toBe("99+");
  });
});
