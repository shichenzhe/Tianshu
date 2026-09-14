// tests/project/plan-date.test.ts
/** 日期模型层·日历向测试：dateKey 语义（slice 无时区）、月网格（周一起始 42 格
 * 跨月标记）、农历标注（真库断言已知日期）、dueDate 聚合 */
import { describe, expect, it } from "vitest";
import {
  addDaysToKey,
  dateKeyToIso,
  diffDays,
  dragToDates,
  ganttColumns,
  getLunarLabel,
  groupByDueDate,
  isoToDateKey,
  monthGrid,
  toDateKey,
  toGanttBar,
} from "../../src-react/domains/project/model/plan-date";
import type { PlanItemRecord } from "../../electron/domains/project/plan-item.entity";

const item = (over: Partial<PlanItemRecord>): PlanItemRecord => ({
  id: 1,
  projectId: 11,
  title: "任务",
  status: "not_started",
  priority: "P1",
  assigneeId: 7,
  tags: [],
  customFields: {},
  sortOrder: 1,
  createdById: 1,
  source: "manual",
  startDate: "",
  dueDate: "",
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
  ...over,
});

describe("dateKey 工具（无时区换算）", () => {
  it("isoToDateKey 取 ISO 前 10 位（任何时区不偏一天）", () => {
    expect(isoToDateKey("2026-09-14T00:00:00.000Z")).toBe("2026-09-14");
    expect(isoToDateKey("2026-09-14T16:00:00.000Z")).toBe("2026-09-14");
    expect(isoToDateKey("")).toBe("");
  });

  it("toDateKey/dateKeyToIso/addDaysToKey/diffDays 闭环", () => {
    const key = toDateKey(new Date(2026, 8, 14)); // 本地 2026-09-14
    expect(key).toBe("2026-09-14");
    expect(dateKeyToIso(key)).toBe("2026-09-14T00:00:00.000Z");
    expect(addDaysToKey(key, 10)).toBe("2026-09-24");
    expect(addDaysToKey("2026-12-28", 7)).toBe("2027-01-04"); // 跨年
    expect(diffDays("2026-09-14", "2026-09-24")).toBe(10);
    expect(diffDays("2026-09-24", "2026-09-14")).toBe(-10);
  });
});

describe("monthGrid", () => {
  it("周一起始 42 格；首月前溢出格 inMonth=false", () => {
    const grid = monthGrid(2026, 9); // 2026-09-01 是周二
    expect(grid).toHaveLength(42);
    expect(grid[0].dateKey).toBe("2026-08-31"); // 周一
    expect(grid[0].inMonth).toBe(false);
    expect(grid[1].dateKey).toBe("2026-09-01");
    expect(grid[1].inMonth).toBe(true);
    expect(grid[1].dayOfMonth).toBe(1);
    const last = grid[41];
    expect(last.dateKey).toBe("2026-10-11");
    expect(last.inMonth).toBe(false);
  });

  it("农历标注带真值（lunar-typescript 实测）：2026-09-01 = 七月二十", () => {
    const grid = monthGrid(2026, 9);
    expect(grid[1].lunar.dayInChinese).toBe("二十"); // 七月二十
  });
});

describe("getLunarLabel（真库实测写死）", () => {
  it("普通日 dayInChinese", () => {
    expect(getLunarLabel(new Date(2026, 8, 14)).dayInChinese).toBe("初四"); // 八月初四
  });

  it("初一显示月名；节气与节日并存时 festival 字段独立返回", () => {
    expect(getLunarLabel(new Date(2026, 8, 11)).dayInChinese).toBe("八月"); // 八月初一
    expect(getLunarLabel(new Date(2026, 8, 25))).toEqual({
      dayInChinese: "十五",
      term: undefined,
      festival: "中秋节", // 2026-09-25 = 八月十五
    });
    expect(getLunarLabel(new Date(2026, 9, 23)).term).toBe("霜降");
  });
});

describe("groupByDueDate", () => {
  it("dueDate 落格聚合；无日期不进格；非当月格可为空 Map 项", () => {
    const grid = monthGrid(2026, 9);
    const items = [
      item({ id: 1, dueDate: "2026-09-14T00:00:00.000Z" }),
      item({
        id: 2,
        dueDate: "2026-09-14T00:00:00.000Z",
        startDate: "2026-09-10T00:00:00.000Z",
      }),
      item({ id: 3, dueDate: "" }),
    ];
    const byDay = groupByDueDate(grid, items);
    expect(byDay.get("2026-09-14")?.map((i) => i.id)).toEqual([1, 2]);
    expect([...byDay.values()].flat()).toHaveLength(items.length - 1);
  });
});

describe("ganttColumns", () => {
  it("day 粒度：中心前后各 30 天共 60 列，首列 key 正确", () => {
    const cols = ganttColumns("2026-09-14", "day");
    expect(cols).toHaveLength(60);
    expect(cols[0].key).toBe("2026-08-15");
    expect(cols[59].key).toBe("2026-10-13");
    expect(cols[0].days).toBe(1);
  });

  it("week 粒度：24 列且每列周一为界", () => {
    const cols = ganttColumns("2026-09-14", "week"); // 周一
    expect(cols).toHaveLength(24);
    expect(cols[12].startKey).toBe("2026-09-14"); // 中心所在周
    const [y, m, d] = cols[0].startKey.split("-").map(Number);
    expect(new Date(y, m - 1, d).getDay()).toBe(1);
    expect(cols[0].days).toBe(7);
  });

  it("month 粒度 18 列（前 9 后 9）；year 粒度 6 列（前 3 后 3）", () => {
    const months = ganttColumns("2026-09-14", "month");
    expect(months).toHaveLength(18);
    expect(months[9].startKey).toBe("2026-10-01");
    const years = ganttColumns("2026-09-14", "year");
    expect(years).toHaveLength(6);
    expect(years[3].startKey).toBe("2027-01-01");
  });
});

describe("toGanttBar", () => {
  it("双端日期：days 含首尾", () => {
    const bar = toGanttBar(
      item({
        startDate: "2026-09-10T00:00:00.000Z",
        dueDate: "2026-09-14T00:00:00.000Z",
      }),
    );
    expect(bar).toEqual({
      id: 1,
      startKey: "2026-09-10",
      endKey: "2026-09-14",
      days: 5,
    });
  });

  it("起止倒置归一：startDate > dueDate → startKey/endKey 取 min/max，days 恒正", () => {
    expect(
      toGanttBar(
        item({
          startDate: "2026-09-14T00:00:00.000Z",
          dueDate: "2026-09-10T00:00:00.000Z",
        }),
      ),
    ).toEqual({
      id: 1,
      startKey: "2026-09-10",
      endKey: "2026-09-14",
      days: 5,
    });
  });

  it("单端日期钳 1 天；双空 null", () => {
    expect(toGanttBar(item({ dueDate: "2026-09-20T00:00:00.000Z" }))).toEqual({
      id: 1,
      startKey: "2026-09-20",
      endKey: "2026-09-20",
      days: 1,
    });
    expect(toGanttBar(item({ startDate: "2026-09-20T00:00:00.000Z" }))).toEqual(
      {
        id: 1,
        startKey: "2026-09-20",
        endKey: "2026-09-20",
        days: 1,
      },
    );
    expect(toGanttBar(item())).toBeNull();
  });
});

describe("dragToDates", () => {
  const bar = { id: 1, startKey: "2026-09-10", endKey: "2026-09-14", days: 5 };

  it("move：两端平移", () => {
    expect(dragToDates(bar, 3, "move")).toEqual({
      startKey: "2026-09-13",
      endKey: "2026-09-17",
    });
    expect(dragToDates(bar, -5, "move")).toEqual({
      startKey: "2026-09-05",
      endKey: "2026-09-09",
    });
  });

  it("start 边缘：拖过 endKey 钳到 endKey（1 天）", () => {
    expect(dragToDates(bar, 2, "start")).toEqual({
      startKey: "2026-09-12",
      endKey: "2026-09-14",
    });
    expect(dragToDates(bar, 10, "start")).toEqual({
      startKey: "2026-09-14",
      endKey: "2026-09-14",
    });
  });

  it("end 边缘：拖过 startKey 钳到 startKey", () => {
    expect(dragToDates(bar, -2, "end")).toEqual({
      startKey: "2026-09-10",
      endKey: "2026-09-12",
    });
    expect(dragToDates(bar, -20, "end")).toEqual({
      startKey: "2026-09-10",
      endKey: "2026-09-10",
    });
  });
});
