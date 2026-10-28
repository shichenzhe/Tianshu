# 项目计划模块 · 子系统 C：三种新视图 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地列表/日历（农历）/甘特（拖拽调期）三种新视图：日期模型层纯函数 + 三个纯展示视图组件 + PlanPane 接线点亮。

**Architecture:** 全自绘。`plan-date.ts` 收敛全部日期/农历逻辑（`lunar-typescript` 唯一引用点，dateKey = ISO `slice(0,10)` 日历日字符串语义、全程零时区换算）；三视图组件纯展示+回调（与 PlanTableView/PlanKanbanView 同构，变更逻辑全在 PlanPane）；甘特用 div 网格 + 原生 pointer 事件（天粒度吸附，语义走 `dragToDates` 纯函数）。

**Tech Stack:** lunar-typescript（唯一新增依赖）、React 19、Vitest（jsdom + testing-library，同既有骨架）。

**Spec:** `docs/superpowers/specs/2026-09-14-plan-views-c-design.md`

## Global Constraints

- 所有用户可见文案走 `t()`，zh-CN 与 en-US 的 `src-react/i18n/locales/*/project.json` 同步新增；key camelCase。
- 颜色一律主题变量（今天线 `bg-primary`，禁止硬编码绿/蓝色类）；弹层 `border border-border/50 rounded-lg shadow-lg`；触发按钮 hover 三件套。
- **dateKey 语义（硬约束）**：`dateKey = ISO.slice(0,10)`；网格格子 key 由本地日历日构造；key 间算术用 `Date.UTC(y, m-1, d)`（不受时区影响）；**禁止**用本地 `getDate()` 解析 UTC 零点 ISO。
- 日期入库格式 `T00:00:00.000Z`（A 阶段裁决，弹窗已有 `toIsoOrNull` 同构语义）。
- Prettier/ESLint 项目默认（printWidth 80）；文件名 kebab-case；函数 ≤20 行拆分。
- 验证命令：`npm run test`（vitest run）、`npm run typecheck`、`npm run lint`——每任务三绿后 commit。

---

### Task 1: 日期模型层·日历向（monthGrid + 农历 + groupByDueDate）

**Files:**
- Modify: `package.json`（依赖）
- Create: `src-react/domains/project/model/plan-date.ts`
- Test: `tests/project/plan-date.test.ts`

**Interfaces:**
- Consumes: `PlanItemRecord`（startDate/dueDate 为 ISO 字符串或 ""）
- Produces（后续任务依赖的精确签名）:
  - `toDateKey(date: Date): string`（本地日历日 → "YYYY-MM-DD"）
  - `isoToDateKey(iso: string): string`（ISO → slice(0,10)，空串透传空串）
  - `dateKeyToIso(key: string): string`（→ `${key}T00:00:00.000Z`）
  - `addDaysToKey(key: string, days: number): string`、`diffDays(from: string, to: string): number`（Date.UTC 算术）
  - `interface LunarLabel { dayInChinese: string; term?: string; festival?: string }`
  - `getLunarLabel(date: Date): LunarLabel`（初一显示月名如「九月」；festival/term 由 lunar-typescript 提供）
  - `interface MonthCell { dateKey: string; dayOfMonth: number; inMonth: boolean; lunar: LunarLabel }`
  - `monthGrid(year: number, month: number): MonthCell[]`（周一起始 42 格）
  - `groupByDueDate(cells: MonthCell[], items: PlanItemRecord[]): Map<string, PlanItemRecord[]>`

- [ ] **Step 1: 安装依赖**

```bash
npm i lunar-typescript
```

- [ ] **Step 2: 写失败的测试**

```ts
// tests/project/plan-date.test.ts
/** 日期模型层·日历向测试：dateKey 语义（slice 无时区）、月网格（周一起始 42 格
 * 跨月标记）、农历标注（真库断言已知日期）、dueDate 聚合 */
import { describe, expect, it } from "vitest";
import {
  addDaysToKey,
  dateKeyToIso,
  diffDays,
  getLunarLabel,
  groupByDueDate,
  isoToDateKey,
  monthGrid,
  toDateKey,
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
      item({ id: 2, dueDate: "2026-09-14T00:00:00.000Z", startDate: "2026-09-10T00:00:00.000Z" }),
      item({ id: 3, dueDate: "" }),
    ];
    const byDay = groupByDueDate(grid, items);
    expect(byDay.get("2026-09-14")?.map((i) => i.id)).toEqual([1, 2]);
    expect([...byDay.values()].flat).toHaveLength(items.length - 1);
  });
});
```

**注意**：依赖已在计划编写时预装并实测取值（上述农历断言为 lunar-typescript 真实输出：2026-09-11 八月初一、2026-09-25 八月十五中秋节、2026-10-23 霜降）。Step 1 的 `npm i` 若 package.json 已含 lunar-typescript 则跳过。

- [ ] **Step 3: 运行确认失败**

Run: `npm run test -- tests/project/plan-date.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现模型层·日历向**

```ts
// src-react/domains/project/model/plan-date.ts
/**
 * 计划视图日期模型层（子系统 C spec §1）：全部日期/农历逻辑的纯函数收敛点，
 * lunar-typescript 全项目唯一引用处。dateKey = 日历日字符串 "YYYY-MM-DD"
 * （ISO 取 slice(0,10)、网格格由本地日构造），key 间算术走 Date.UTC——
 * 全程零时区换算（UTC 零点存储在本地解析会偏一天，见 A 阶段时区裁决）。
 */
import { Solar } from "lunar-typescript";
import type { PlanItemRecord } from "../../../../electron/domains/project/plan-item.entity";

/* ---------- dateKey 基础 ---------- */

/** 本地日历日 → "YYYY-MM-DD" */
export const toDateKey = (date: Date): string => {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
};

/** ISO → 日历日 key（slice 语义，无时区偏移）；空串透传 */
export const isoToDateKey = (iso: string): string => iso.slice(0, 10);

/** 日历日 key → 入库 ISO（UTC 零点，A 阶段裁决） */
export const dateKeyToIso = (key: string): string => `${key}T00:00:00.000Z`;

/** key 解析为 UTC 时间戳（key 是日历日，与真实时区无关） */
const keyToUtc = (key: string): number => {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};

/** key 加 N 天（跨月/跨年正确） */
export const addDaysToKey = (key: string, days: number): string => {
  const next = new Date(keyToUtc(key) + days * 86400000);
  return toDateKey(new Date(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate()));
};

/** 两 key 天数差（to - from；支持负值） */
export const diffDays = (from: string, to: string): number =>
  Math.round((keyToUtc(to) - keyToUtc(from)) / 86400000);

/* ---------- 农历标注 ---------- */

/** 农历标注：显示优先级 festival > term > dayInChinese；初一显示月名 */
export interface LunarLabel {
  dayInChinese: string;
  term?: string;
  festival?: string;
}

/** 单日农历标注（lunar-typescript 唯一出口） */
export function getLunarLabel(date: Date): LunarLabel {
  const lunar = Solar.fromDate(date).getLunar();
  const festival = lunar.getFestivals()[0];
  const term = lunar.getJieQi();
  const day = lunar.getDayInChinese();
  return {
    dayInChinese: day === "初一" ? `${lunar.getMonthInChinese()}月` : day,
    term: term || undefined,
    festival: festival || undefined,
  };
}

/* ---------- 月历网格 ---------- */

export interface MonthCell {
  dateKey: string;
  dayOfMonth: number;
  inMonth: boolean;
  lunar: LunarLabel;
}

/** 周一起始 42 格月网格（含上下月溢出格，inMonth 标记） */
export function monthGrid(year: number, month: number): MonthCell[] {
  const firstDay = new Date(year, month - 1, 1);
  const offset = (firstDay.getDay() + 6) % 7; // 周一=0
  const start = new Date(year, month - 1, 1 - offset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    return {
      dateKey: toDateKey(date),
      dayOfMonth: date.getDate(),
      inMonth: date.getMonth() === month - 1,
      lunar: getLunarLabel(date),
    };
  });
}

/* ---------- 日历格聚合 ---------- */

/** dueDate 落格聚合（key 相等比较；无日期任务不进格） */
export function groupByDueDate(
  cells: MonthCell[],
  items: PlanItemRecord[],
): Map<string, PlanItemRecord[]> {
  const byDay = new Map<string, PlanItemRecord[]>();
  cells.forEach((cell) => byDay.set(cell.dateKey, []));
  items.forEach((entry) => {
    const key = isoToDateKey(entry.dueDate);
    const bucket = key ? byDay.get(key) : undefined;
    if (bucket) {
      bucket.push(entry);
    }
  });
  return byDay;
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npm run test -- tests/project/plan-date.test.ts && npm run typecheck && npm run lint`
Expected: PASS（农历两处以真值写死后）

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src-react/domains/project/model/plan-date.ts tests/project/plan-date.test.ts
git commit -m "feat(project): 日期模型层日历向——dateKey 无时区语义 + monthGrid + lunar-typescript 农历标注 + dueDate 聚合"
```

---

### Task 2: 日期模型层·甘特向（ganttColumns + toGanttBar + dragToDates）

**Files:**
- Modify: `src-react/domains/project/model/plan-date.ts`（追加）
- Test: `tests/project/plan-date.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 1 的 dateKey 工具（addDaysToKey/diffDays/isoToDateKey）
- Produces:
  - `type GanttGranularity = "day" | "week" | "month" | "year"`
  - `interface GanttColumn { key: string; label: string; startKey: string; endKey: string; days: number }`
  - `ganttColumns(centerKey: string, granularity: GanttGranularity): GanttColumn[]`（以 center 为中心的整屏：日 60 列前 30 后 30；周 24 列（周一界）；月 18 列前 9 后 9；年 6 列前 3 后 3）
  - `interface GanttBar { id: number; startKey: string; endKey: string; days: number }`
  - `toGanttBar(item: PlanItemRecord): GanttBar | null`（单端钳 1 天；双空 null）
  - `dragToDates(bar: GanttBar, dayDelta: number, edge: "move" | "start" | "end"): { startKey: string; endKey: string }`（start 拖过 end → 贴 endKey；end 拖过 start → 贴 startKey；总长恒 ≥1 天）

- [ ] **Step 1: 追加失败的测试**

```ts
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
    const bar = toGanttBar(item({ startDate: "2026-09-10T00:00:00.000Z", dueDate: "2026-09-14T00:00:00.000Z" }));
    expect(bar).toEqual({ id: 1, startKey: "2026-09-10", endKey: "2026-09-14", days: 5 });
  });

  it("单端日期钳 1 天；双空 null", () => {
    expect(toGanttBar(item({ dueDate: "2026-09-20T00:00:00.000Z" }))).toEqual({
      id: 1, startKey: "2026-09-20", endKey: "2026-09-20", days: 1,
    });
    expect(toGanttBar(item({ startDate: "2026-09-20T00:00:00.000Z" }))).toEqual({
      id: 1, startKey: "2026-09-20", endKey: "2026-09-20", days: 1,
    });
    expect(toGanttBar(item())).toBeNull();
  });
});

describe("dragToDates", () => {
  const bar = { id: 1, startKey: "2026-09-10", endKey: "2026-09-14", days: 5 };

  it("move：两端平移", () => {
    expect(dragToDates(bar, 3, "move")).toEqual({ startKey: "2026-09-13", endKey: "2026-09-17" });
    expect(dragToDates(bar, -5, "move")).toEqual({ startKey: "2026-09-05", endKey: "2026-09-09" });
  });

  it("start 边缘：拖过 endKey 钳到 endKey（1 天）", () => {
    expect(dragToDates(bar, 2, "start")).toEqual({ startKey: "2026-09-12", endKey: "2026-09-14" });
    expect(dragToDates(bar, 10, "start")).toEqual({ startKey: "2026-09-14", endKey: "2026-09-14" });
  });

  it("end 边缘：拖过 startKey 钳到 startKey", () => {
    expect(dragToDates(bar, -2, "end")).toEqual({ startKey: "2026-09-10", endKey: "2026-09-12" });
    expect(dragToDates(bar, -20, "end")).toEqual({ startKey: "2026-09-10", endKey: "2026-09-10" });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/project/plan-date.test.ts`
Expected: FAIL（ganttColumns 等未定义）

- [ ] **Step 3: 追加实现**

```ts
/* ---------- 甘特时间轴 ---------- */

export type GanttGranularity = "day" | "week" | "month" | "year";

export interface GanttColumn {
  key: string;
  label: string;
  startKey: string;
  endKey: string;
  days: number;
}

/** 中心 key 对齐到粒度起点的偏移（周=周一；月/年=自然首日） */
function alignStart(key: string, granularity: GanttGranularity): string {
  const [y, m, d] = key.split("-").map(Number);
  if (granularity === "week") {
    const date = new Date(y, m - 1, d);
    return addDaysToKey(key, -((date.getDay() + 6) % 7));
  }
  if (granularity === "month") {
    return `${y}-${String(m).padStart(2, "0")}-01`;
  }
  if (granularity === "year") {
    return `${y}-01-01`;
  }
  return key;
}

/** 整屏列：日 60（前 30）/周 24/月 18（前 9）/年 6（前 3）；列起点对齐粒度 */
export function ganttColumns(
  centerKey: string,
  granularity: GanttGranularity,
): GanttColumn[] {
  const aligned = alignStart(centerKey, granularity);
  const [y, m] = aligned.split("-").map(Number);
  if (granularity === "day") {
    return Array.from({ length: 60 }, (_, index) => {
      const startKey = addDaysToKey(aligned, -30 + index);
      const [yy, mm, dd] = startKey.split("-").map(Number);
      return { key: startKey, label: String(dd), startKey, endKey: startKey, days: 1 };
    });
  }
  if (granularity === "week") {
    return Array.from({ length: 24 }, (_, index) => {
      const startKey = addDaysToKey(aligned, (index - 12) * 7);
      const [wy, wm, wd] = startKey.split("-").map(Number);
      return { key: startKey, label: `${wm}.${wd}`, startKey, endKey: addDaysToKey(startKey, 6), days: 7 };
    });
  }
  if (granularity === "month") {
    return Array.from({ length: 18 }, (_, index) => {
      const base = new Date(y, m - 1 + index - 9, 1);
      const startKey = toDateKey(base);
      const next = new Date(y, m + index - 9, 1);
      const endKey = addDaysToKey(toDateKey(next), -1);
      return { key: startKey, label: `${base.getMonth() + 1}`, startKey, endKey, days: diffDays(startKey, endKey) + 1 };
    });
  }
  return Array.from({ length: 6 }, (_, index) => {
    const year = y + index - 3;
    return { key: String(year), label: String(year), startKey: `${year}-01-01`, endKey: `${year}-12-31`, days: diffDays(`${year}-01-01`, `${year}-12-31`) + 1 };
  });
}

/* ---------- 甘特条与拖拽语义 ---------- */

export interface GanttBar {
  id: number;
  startKey: string;
  endKey: string;
  days: number;
}

/** 事项 → 甘特条（单端日期钳 1 天；双空 → null 无日期） */
export function toGanttBar(entry: PlanItemRecord): GanttBar | null {
  const start = isoToDateKey(entry.startDate);
  const end = isoToDateKey(entry.dueDate);
  if (!start && !end) {
    return null;
  }
  const startKey = start || end;
  const endKey = end || start;
  return { id: entry.id, startKey, endKey, days: diffDays(startKey, endKey) + 1 };
}

/** 拖拽三边缘 → 新起止（纯函数）：move 平移；start/end 拖过对端贴对端（恒 ≥1 天） */
export function dragToDates(
  bar: GanttBar,
  dayDelta: number,
  edge: "move" | "start" | "end",
): { startKey: string; endKey: string } {
  if (edge === "move") {
    return {
      startKey: addDaysToKey(bar.startKey, dayDelta),
      endKey: addDaysToKey(bar.endKey, dayDelta),
    };
  }
  if (edge === "start") {
    const startKey = addDaysToKey(bar.startKey, dayDelta);
    return startKey <= bar.endKey
      ? { startKey, endKey: bar.endKey }
      : { startKey: bar.endKey, endKey: bar.endKey };
  }
  const endKey = addDaysToKey(bar.endKey, dayDelta);
  return endKey >= bar.startKey
    ? { startKey: bar.startKey, endKey }
    : { startKey: bar.startKey, endKey: bar.startKey };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm run test -- tests/project/plan-date.test.ts && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/project/model/plan-date.ts tests/project/plan-date.test.ts
git commit -m "feat(project): 日期模型层甘特向——四粒度分列/条形模型单端钳制/dragToDates 三边缘调期语义"
```

---

### Task 3: 列表视图 PlanListView + PlanPane 接线

**Files:**
- Create: `src-react/domains/project/components/PlanListView.tsx`
- Modify: `src-react/domains/project/components/PlanPane.tsx`（list 分支 + 勾选/快速新增 handler + ADDABLE/SELECTABLE 点亮 list）
- Modify: `src-react/domains/project/components/PlanViewTabs.tsx:54`（ADDABLE_TYPES）、`src-react/domains/project/components/PlanViewSettingsPopover.tsx`（SELECTABLE_TYPES）
- Modify: `src-react/i18n/locales/zh-CN/project.json`、`en-US/project.json`
- Test: `tests/project/plan-list.test.tsx`（新建）、`tests/project/plan-table.test.tsx`（追加 list 分支集成）

**Interfaces:**
- Consumes: 引擎 `groupItems(items, "status")`；`STATUS_LABEL_KEYS`（PlanItemDialog 导出）；`PRIORITY_*` 色板（PlanItemDialog 的 `PRIORITY_BADGE_VARIANTS`）；成员类型。
- Produces:
  - `PlanListView` props：`{ items: PlanItemRecord[]; members: ProjectMemberItem[]; currentUserId: number; onToggleDone: (id: number, done: boolean) => void; onQuickCreate: (status: PlanStatus, title: string) => void; onEdit: (item: PlanItemRecord) => void }`
  - PlanPane 新增 handler 语义：`onToggleDone → handleMoveStatus(id, done ? "done" : "not_started")`；`onQuickCreate → PlanItemApi.create({ createdById: user.id, assigneeId: user.id, projectId, title, status })`（复用 handleQuickCreate 语义 + 状态参数）。

- [ ] **Step 1: 写失败的组件测试**

```tsx
// tests/project/plan-list.test.tsx
// @vitest-environment jsdom
/**
 * PlanListView 列表视图测试（mock 骨架同 tests/project/plan-view-tabs.test.tsx：
 * t 返回 key、sonner/@/i18n 桩、Radix 弹层桩；引擎/组件真实实现）：
 * - 四状态分组（groupItems 真跑）：组头 状态名+计数；空组（paused 无数据）保留
 * - 组头折叠/展开；组内 + 展开行内快速新增 Input，回车 onQuickCreate(status, title)
 * - 行：checkbox 勾选 → onToggleDone(id, true)；再点 → onToggleDone(id, false)
 * - 行字段：标题（点击 onEdit）、优先级色点、标签、截止日、处理人头像
 */
```

用例清单（骨架照抄 plan-view-tabs.test.tsx:33-58 的 beforeAll 桩 + vi.mock 三件套，fixture 同构 makeItem/members）：
1. 「四组渲染与计数：not_started 组含 2 项、paused 空组保留且计数 0」
2. 「点击组头折叠 → 组行消失；再点展开」
3. 「组内 + → Input 出现，输入『写周报』回车 → onQuickCreate("not_started", "写周报") 且 Input 清空」
4. 「勾选 checkbox → onToggleDone(1, true)；已勾选项再点 → onToggleDone(id, false)」（fixture 一项 status: "done"）
5. 「点击标题行 → onEdit(item)」（整行或标题按钮）
6. 「超期截止日渲染 text-destructive 类」（fixture dueDate = 过去日）

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/project/plan-list.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现 PlanListView**

```tsx
/**
 * 列表视图（子系统 C spec §2，Todo 式紧凑清单）：引擎 groupItems 按状态四组
 * 折叠（组头 = 折叠箭头 + 状态名 + 计数 + 组内 +，空组保留）；行 = 完成
 * checkbox + 标题（点击编辑）+ 标签（2+N）+ 优先级色点 + 截止日（超期
 * destructive）+ 处理人头像点；组内 + 展开行内 Input 回车快速新增（预置
 * 该组状态）。纯展示+回调，变更逻辑在 PlanPane；折叠态本地 useState。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ProjectMemberItem } from "../../../../electron/domains/project/project.entity";
import type {
  PlanItemRecord,
  PlanPriority,
  PlanStatus,
} from "../../../../electron/domains/project/plan-item.entity";
import { groupItems } from "../model/plan-view-engine";
import { isoToDateKey, toDateKey } from "../model/plan-date";
import { PRIORITY_BADGE_VARIANTS, STATUS_LABEL_KEYS } from "./PlanItemDialog";

/** 优先级行内色点（色板与表格/看板一致） */
const PRIORITY_DOT_CLASSES: Record<PlanPriority, string> = {
  P0: "bg-destructive",
  P1: "bg-primary",
  P2: "bg-muted-foreground/60",
  P3: "bg-border",
};

const MAX_ROW_TAGS = 2;

interface PlanListViewProps {
  items: PlanItemRecord[];
  members: ProjectMemberItem[];
  currentUserId: number;
  onToggleDone: (id: number, done: boolean) => void;
  onQuickCreate: (status: PlanStatus, title: string) => void;
  onEdit: (item: PlanItemRecord) => void;
}

/** 单行：紧凑布局（纯展示） */
function ListRow({
  item,
  members,
  onToggleDone,
  onEdit,
}: {
  item: PlanItemRecord;
  members: ProjectMemberItem[];
  onToggleDone: (id: number, done: boolean) => void;
  onEdit: (item: PlanItemRecord) => void;
}) {
  const { t } = useTranslation(["project", "common"]);
  const done = item.status === "done";
  const dueKey = isoToDateKey(item.dueDate);
  const overdue = dueKey !== "" && dueKey < toDateKey(new Date()) && !done;
  const assignee = members.find((m) => m.userId === item.assigneeId);
  return (
    <div className="group/row flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-primary-subtle/40">
      <Checkbox
        checked={done}
        onCheckedChange={(checked) => onToggleDone(item.id, checked === true)}
        aria-label={t("project:plan.statusDone")}
        className="h-4 w-4"
      />
      <button
        type="button"
        onClick={() => onEdit(item)}
        className={cn(
          "flex-1 truncate text-left text-sm",
          done && "text-muted-foreground line-through",
        )}
      >
        {item.title}
      </button>
      {item.tags.slice(0, MAX_ROW_TAGS).map((tag) => (
        <Badge key={tag} variant="secondary" className="px-1.5 text-[10px]">
          {tag}
        </Badge>
      ))}
      {item.tags.length > MAX_ROW_TAGS && (
        <Badge variant="outline" className="px-1.5 text-[10px] text-muted-foreground">
          +{item.tags.length - MAX_ROW_TAGS}
        </Badge>
      )}
      <span
        aria-label={item.priority}
        className={cn("h-2 w-2 shrink-0 rounded-full", PRIORITY_DOT_CLASSES[item.priority])}
      />
      {dueKey && (
        <span className={cn("shrink-0 text-xs", overdue ? "text-destructive" : "text-muted-foreground")}>
          {dueKey}
        </span>
      )}
      <span
        title={assignee?.nickname ?? t("project:plan.unassigned")}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-[10px] font-medium text-primary"
      >
        {assignee ? assignee.nickname.charAt(0) : "?"}
      </span>
    </div>
  );
}

export default function PlanListView({
  items,
  members,
  currentUserId,
  onToggleDone,
  onQuickCreate,
  onEdit,
}: PlanListViewProps) {
  const { t } = useTranslation(["project", "common"]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [addingIn, setAddingIn] = useState<PlanStatus | null>(null);
  const [addingTitle, setAddingTitle] = useState("");
  const groups = groupItems(items, "status");

  /** 组内回车快速新增（IME 组合中回车不触发） */
  const handleAddKeyDown = (event: React.KeyboardEvent<HTMLInputElement>, status: PlanStatus) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    const title = addingTitle.trim();
    if (title) {
      onQuickCreate(status, title);
    }
    setAddingTitle("");
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
      {groups.map((group) => (
        <section key={group.key} className="mt-2 first:mt-0">
          <div className="flex items-center gap-1.5 border-b border-border/50 py-1.5">
            <button
              type="button"
              aria-label={t(STATUS_LABEL_KEYS[group.key as PlanStatus])}
              onClick={() =>
                setCollapsed((prev) => ({ ...prev, [group.key]: !prev[group.key] }))
              }
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-primary"
            >
              {collapsed[group.key] ? (
                <ChevronRight className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              {t(STATUS_LABEL_KEYS[group.key as PlanStatus])}
              <Badge variant="secondary" className="px-1.5 text-[10px]">
                {group.items.length}
              </Badge>
            </button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("project:plan.add")}
              onClick={() =>
                setAddingIn(addingIn === group.key ? null : (group.key as PlanStatus))
              }
              className="ml-auto h-6 w-6 p-0 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          {!collapsed[group.key] && (
            <div className="flex flex-col">
              {group.items.map((item) => (
                <ListRow
                  key={item.id}
                  item={item}
                  members={members}
                  onToggleDone={onToggleDone}
                  onEdit={onEdit}
                />
              ))}
              {addingIn === group.key && (
                <Input
                  autoFocus
                  value={addingTitle}
                  onChange={(event) => setAddingTitle(event.target.value)}
                  onKeyDown={(event) => handleAddKeyDown(event, group.key as PlanStatus)}
                  placeholder={t("project:plan.quickAddPlaceholder")}
                  aria-label={t("project:plan.quickAddPlaceholder")}
                  className="my-1 h-8 text-sm"
                />
              )}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
```

（`currentUserId` prop 按契约保留——未来 isMe 高亮，同看板先例。）

- [ ] **Step 4: PlanPane 接线**

1. import `PlanListView`；内容区分支加（kanban 分支之后）：

```tsx
      ) : activeView?.type === "list" ? (
        <PlanListView
          items={visibleItems}
          members={members}
          currentUserId={user.id}
          onToggleDone={(id, done) =>
            void handleMoveStatus(id, done ? "done" : "not_started")
          }
          onQuickCreate={(status, title) => void handleQuickCreateIn(status, title)}
          onEdit={openEdit}
        />
```

2. `handleQuickCreate` 扩展为带状态版（替换原函数，原调用点 `onQuickCreate={handleQuickCreate}` 改 `onQuickCreate={(title) => handleQuickCreateIn("not_started", title)}`）：

```ts
  /** 快速新增（带状态预置；列表组内 + / 表格表头共用）：创建即指派自己 */
  const handleQuickCreateIn = async (status: PlanStatus, title: string) => {
    try {
      await PlanItemApi.create({
        createdById: user.id,
        assigneeId: user.id,
        projectId,
        title,
        status,
      });
      await invalidatePlanCaches();
    } catch (error) {
      toast.error(mapIpcError(error));
    }
  };
```

3. `PlanViewTabs.tsx` 的 `ADDABLE_TYPES` 改 `["kanban", "list", "gantt", "calendar"]`（gantt/calendar 的组件在 T5/T6 才有——**本任务只加 "list"**：`["kanban", "list"]`；`PlanViewSettingsPopover` 的 `SELECTABLE_TYPES` 同步加 `"list"`）。

- [ ] **Step 5: i18n（本任务无新键）**

复用既有键：`plan.quickAddPlaceholder` / `plan.add` / `plan.statusDone` / `plan.unassigned`。确认无硬编码文案即可。

- [ ] **Step 6: 运行确认通过 + 集成用例**

`tests/project/plan-table.test.tsx` 追加（mock 已有 PlanViewApi/ProjectApi，新增视图 fixture type: "list" id 12）：

```
it("list 类型视图渲染分组清单（状态组头出现）", …)  // ?viewId=12 → PlanListView 渲染 → getByText("project:plan.statusNotStarted") 组头
```

Run: `npm run test -- tests/project/plan-list.test.tsx tests/project/plan-table.test.tsx && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src-react/domains/project/components/PlanListView.tsx src-react/domains/project/components/PlanPane.tsx src-react/domains/project/components/PlanViewTabs.tsx src-react/domains/project/components/PlanViewSettingsPopover.tsx tests/project/plan-list.test.tsx tests/project/plan-table.test.tsx
git commit -m "feat(project): 列表视图——状态分组折叠/勾选完成/组内快速新增 + 入口点亮"
```

---

### Task 4: 日历视图 PlanCalendarView + PlanPane 接线

**Files:**
- Create: `src-react/domains/project/components/PlanCalendarView.tsx`
- Modify: `src-react/domains/project/components/PlanPane.tsx`（calendar 分支 + dialogDefaultDueDate）
- Modify: `src-react/domains/project/components/PlanItemDialog.tsx`（`defaultDueDate?: string` prop，date 类型回填）
- Modify: `PlanViewTabs.tsx` / `PlanViewSettingsPopover.tsx`（点亮 "calendar"）
- Modify: `src-react/i18n/locales/*/project.json`
- Test: `tests/project/plan-calendar.test.tsx`（新建）、`tests/project/plan-item-dialog.test.tsx`（追加回填用例）

**Interfaces:**
- Consumes: Task 1 的 `monthGrid/groupByDueDate/toDateKey/isoToDateKey/LunarLabel`；`PRIORITY_*`。
- Produces:
  - `PlanCalendarView` props：`{ items: PlanItemRecord[]; onCreateAt: (dateKey: string) => void; onEdit: (item: PlanItemRecord) => void }`（月游标组件内 useState）
  - `PlanItemDialog` 增 `defaultDueDate?: string`（"YYYY-MM-DD"；新建态预置 dueDate Input，编辑态忽略——与 defaultStatus 同构）。

- [ ] **Step 1: 写失败的组件测试**

```tsx
// tests/project/plan-calendar.test.tsx
// @vitest-environment jsdom
/** PlanCalendarView 日历视图测试（mock 骨架同 plan-list.test.tsx；plan-date
 * 真实实现——农历断言用真值）：月导航（<< >> 今天）、今日高亮（今日格子
 * data-today）、农历标注渲染（2026-09-25 显示 中秋节）、任务 chips（+N 折叠）、
 * 点格空白 onCreateAt(dateKey)、点 chip onEdit、无日期统计文本 */
```

用例清单（fixture：dueDate 2026-09-14 ×2 项 + 一项 09-20 + 一项无日期；**今日断言改用可控值**：组件「今日」用真实 `new Date()`——测试通过 vi.setSystemTime 固定到 2026-09-14 再恢复）：
1. `vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 14))` → 渲染默认当月 → 今日格 `data-today="true"` 且高亮类含 `bg-primary-subtle`；农历「初四」出现
2. 点 `>>` → 标题变 2026-10；点 `今天` → 回 2026-09
3. 2026-09-25 格显示「中秋节」（festival 优先）；同格无任务时 chips 空
4. 09-14 格渲染 2 个 chip + 第 3 项不存在（fixture 2 项）+ 截短标题；点 chip → onEdit(item)
5. 同日 4 项 fixture → 显示 3 chip + 「+1」
6. 点格空白 → onCreateAt("2026-09-20")
7. 顶部「无日期记录：1」文本（i18n key `planView.noDueDateCount` 插值 count=1）
8. afterEach：`vi.useRealTimers()`

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/project/plan-calendar.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现 PlanCalendarView**

```tsx
/**
 * 日历视图（子系统 C spec §3）：月游标本地 useState；周表头（一~日）；
 * 日格 = 公历数字（今日 primary-subtle 圆圈）+ 农历标注（festival > term >
 * dayInChinese，getLunarLabel）+ 任务 chips（最多 3 + "+N"，优先级色点 +
 * 截短标题，点 chip 开编辑）；点格空白 onCreateAt(dateKey)（PlanPane 预置
 * dueDate 开新建弹窗）；顶部「无日期记录：N」统计。纯展示+回调。
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  PlanItemRecord,
  PlanPriority,
} from "../../../../electron/domains/project/plan-item.entity";
import { groupByDueDate, monthGrid, toDateKey } from "../model/plan-date";

const MAX_CELL_CHIPS = 3;
const CHIP_TITLE_MAX = 6;

/** 优先级 chip 色点（与列表/看板一致） */
const PRIORITY_DOT_CLASSES: Record<PlanPriority, string> = {
  P0: "bg-destructive",
  P1: "bg-primary",
  P2: "bg-muted-foreground/60",
  P3: "bg-border",
};

const WEEKDAY_KEYS = [
  "project:planView.weekday1",
  "project:planView.weekday2",
  "project:planView.weekday3",
  "project:planView.weekday4",
  "project:planView.weekday5",
  "project:planView.weekday6",
  "project:planView.weekday7",
];

/** 农历标注文案：节日 > 节气 > 日常 */
function lunarText(lunar: { dayInChinese: string; term?: string; festival?: string }): string {
  return lunar.festival ?? lunar.term ?? lunar.dayInChinese;
}

interface PlanCalendarViewProps {
  items: PlanItemRecord[];
  onCreateAt: (dateKey: string) => void;
  onEdit: (item: PlanItemRecord) => void;
}

export default function PlanCalendarView({
  items,
  onCreateAt,
  onEdit,
}: PlanCalendarViewProps) {
  const { t } = useTranslation(["project", "common"]);
  const today = new Date();
  const [cursor, setCursor] = useState({ year: today.getFullYear(), month: today.getMonth() + 1 });
  const todayKey = toDateKey(today);

  const cells = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor]);
  const byDay = useMemo(() => groupByDueDate(cells, items), [cells, items]);
  const noDueCount = items.filter((item) => item.dueDate === "").length;

  /** 翻月（12 月进位） */
  const shiftMonth = (delta: number) =>
    setCursor((prev) => {
      const next = new Date(prev.year, prev.month - 1 + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() + 1 };
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
      <div className="flex items-center gap-1.5 py-2">
        <span className="text-sm font-medium">
          {t("project:planView.calendarTitle", {
            year: cursor.year,
            month: cursor.month,
          })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("project:planView.prevMonth")}
          onClick={() => shiftMonth(-1)}
          className="h-7 w-7 p-0 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("project:planView.nextMonth")}
          onClick={() => shiftMonth(1)}
          className="h-7 w-7 p-0 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setCursor({ year: today.getFullYear(), month: today.getMonth() + 1 })
          }
          className="h-7 px-2 text-xs hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
        >
          {t("project:planView.today")}
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {t("project:planView.noDueDateCount", { count: noDueCount })}
        </span>
      </div>
      <div className="grid grid-cols-7 border-b border-border/50 pb-1 text-center">
        {WEEKDAY_KEYS.map((key) => (
          <span key={key} className="text-xs text-muted-foreground">
            {t(key)}
          </span>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6 overflow-auto">
        {cells.map((cell) => (
          <div
            key={cell.dateKey}
            onClick={() => onCreateAt(cell.dateKey)}
            className="flex min-h-20 cursor-pointer flex-col gap-0.5 border border-border/30 p-1 transition-colors hover:bg-primary-subtle/30"
          >
            <div className="flex items-baseline justify-between">
              <span
                data-today={cell.dateKey === todayKey ? "true" : undefined}
                className={cn(
                  "text-xs",
                  cell.inMonth ? "text-foreground" : "text-muted-foreground/50",
                  cell.dateKey === todayKey &&
                    "flex h-5 w-5 items-center justify-center rounded-full bg-primary-subtle font-semibold text-primary",
                )}
              >
                {cell.dayOfMonth}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {cell.inMonth ? lunarText(cell.lunar) : ""}
              </span>
            </div>
            {(byDay.get(cell.dateKey) ?? []).slice(0, MAX_CELL_CHIPS).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onEdit(item);
                }}
                title={item.title}
                className="flex items-center gap-1 truncate rounded bg-primary-subtle/60 px-1 py-0.5 text-left text-[10px] text-foreground hover:bg-primary-subtle"
              >
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", PRIORITY_DOT_CLASSES[item.priority])} />
                {item.title.slice(0, CHIP_TITLE_MAX)}
              </button>
            ))}
            {(byDay.get(cell.dateKey) ?? []).length > MAX_CELL_CHIPS && (
              <span className="text-[10px] text-muted-foreground">
                +{(byDay.get(cell.dateKey) ?? []).length - MAX_CELL_CHIPS}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: PlanItemDialog 增 defaultDueDate + PlanPane 接线**

`PlanItemDialog.tsx`（与 defaultStatus 同构三处）：

```ts
  /** 新建态初始截止日（日历点格预置 "YYYY-MM-DD"；编辑态忽略） */
  defaultDueDate?: string;
```

回填 useEffect 内补：`setDueDate(item ? (item.dueDate ? item.dueDate.slice(0, 10) : "") : (defaultDueDate ?? ""));`，依赖数组补 `defaultDueDate`。

`PlanPane.tsx`：

1. state：`const [dialogDefaultDueDate, setDialogDefaultDueDate] = useState<string>("");`
2. calendar 分支（list 之后）：

```tsx
      ) : activeView?.type === "calendar" ? (
        <PlanCalendarView
          items={visibleItems}
          onCreateAt={(dateKey) => {
            setEditingItem(undefined);
            setDialogDefaultStatus("not_started");
            setDialogDefaultPriority(undefined);
            setDialogDefaultDueDate(dateKey);
            setDialogOpen(true);
          }}
          onEdit={openEdit}
        />
```

3. `openCreate` 与 `openQuickCreateIn` 中复位 `setDialogDefaultDueDate("")`；PlanItemDialog 调用处传 `defaultDueDate={dialogDefaultDueDate}`。
4. `PlanViewTabs` ADDABLE_TYPES / `PlanViewSettingsPopover` SELECTABLE_TYPES 各加 `"calendar"`。

- [ ] **Step 5: i18n**

`planView` 段（双语言）：

```json
    "calendarTitle": "{{year}}年{{month}}月",
    "prevMonth": "上个月",
    "nextMonth": "下个月",
    "today": "今天",
    "noDueDateCount": "无日期记录：{{count}}",
    "weekday1": "一", "weekday2": "二", "weekday3": "三", "weekday4": "四",
    "weekday5": "五", "weekday6": "六", "weekday7": "日"
```

en-US：`"{{year}}-{{month}}"`、`"Previous month"`、`"Next month"`、`"Today"`、`"No date: {{count}}"`、`"Mon"…"Sun"`。

- [ ] **Step 6: 运行确认通过 + 弹窗回填用例**

`tests/project/plan-item-dialog.test.tsx` 追加：「defaultDueDate 预置：新建态 dueDate Input 值 = 预置日；提交 create 携带 `${defaultDueDate}T00:00:00.000Z`」。

Run: `npm run test -- tests/project/plan-calendar.test.tsx tests/project/plan-item-dialog.test.tsx && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src-react/domains/project/components/PlanCalendarView.tsx src-react/domains/project/components/PlanPane.tsx src-react/domains/project/components/PlanItemDialog.tsx src-react/domains/project/components/PlanViewTabs.tsx src-react/domains/project/components/PlanViewSettingsPopover.tsx src-react/i18n/locales tests/project/plan-calendar.test.tsx tests/project/plan-item-dialog.test.tsx
git commit -m "feat(project): 日历视图——月导航/今日高亮/农历节日节气/点格预置截止日/无日期统计 + 入口点亮"
```

---

### Task 5: 甘特视图渲染 PlanGanttView（列/控制栏/今天线/条形）

**Files:**
- Create: `src-react/domains/project/components/PlanGanttView.tsx`
- Modify: `src-react/i18n/locales/*/project.json`
- Test: `tests/project/plan-gantt.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 2 的 `ganttColumns/toGanttBar/diffDays/GanttGranularity/GanttBar`；`toDateKey`。
- Produces（T6 依赖）:
  - `export const GRANULARITY_DAY_WIDTH: Record<GanttGranularity, number>` = `{ day: 28, week: 64/7, month: 96/30.4375, year: 120/365.25 }`
  - `export function barGeometry(bar: GanttBar, originKey: string, dayWidth: number): { left: number; width: number }`（left = diffDays(origin, start)*dayWidth；width = days*dayWidth；纯函数导出供测试与渲染共用）
  - 组件 props（本任务无回调版）：`{ items: PlanItemRecord[]; onChangeDates?: (id: number, dates: { startKey: string; endKey: string }) => void; onEdit: (item: PlanItemRecord) => void }`——onChangeDates 本任务可缺省（不渲染拖拽行为），T6 补 pointer 交互。

- [ ] **Step 1: 写失败的组件测试**

```tsx
// tests/project/plan-gantt.test.tsx
// @vitest-environment jsdom
/** PlanGanttView 甘特视图测试（渲染部分；mock 骨架同 plan-list.test.tsx；
 * plan-date 真实实现；vi.setSystemTime 固定 2026-09-14 保证今天线/初始视口）：
 * - barGeometry 纯函数：left/width 换算
 * - 粒度切换四分段按钮 + 列头渲染（日粒度显示日期数字列）
 * - 今天线（data-today-line）落在 diffDays 天宽处
 * - 条形跨列渲染（data-item-id）；无日期任务左列灰显（line-through 无条形）
 * - << >> 翻页移动列起点 */
```

用例清单（fixture：A 项 09-10~09-14、B 项仅 dueDate 09-20、C 项无日期；setSystemTime 2026-09-14）：
1. `barGeometry({startKey:"2026-09-10",endKey:"2026-09-14",days:5}, "2026-08-15", 28)` → `{ left: 26*28, width: 5*28 }`（26 = 08-15→09-10 天差）
2. 默认日粒度：渲染 60 列头（首列文本 "15"，即 08-15）；A 项条 `data-item-id="1"` 存在；C 项（无日期）左列行存在且**无**条形
3. 切「月」粒度按钮（aria-label `planView.granularityMonth`）→ 列头出现月份数字「10」
4. 今天线元素 `data-today-line="true"` 存在，其 style.left = `diffDays(cols[0].startKey, todayKey) * 28`px（测试断言计算值）
5. 点 `>>` → 首列起点后移 60 天（08-15 → 10-14，即首列文本变「14」）
6. 点条形 → onEdit(item)（A 项条点击）

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/project/plan-gantt.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现 PlanGanttView（渲染版）**

```tsx
/**
 * 甘特视图（子系统 C spec §4）：左列任务名（无日期灰显可点击开编辑设置）+
 * 右侧时间轴（四粒度分列 ganttColumns / 翻页 / 今天回正 / 今天线 bg-primary）；
 * 条形 = 优先级色板跨列圆角条；条定位 barGeometry 纯函数（天宽按粒度连续折算）。
 * 拖拽调期（pointer 三边缘）在 T6 补充；本组件纯展示+回调。
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PlanItemRecord, PlanPriority } from "../../../../electron/domains/project/plan-item.entity";
import {
  addDaysToKey,
  diffDays,
  ganttColumns,
  toDateKey,
  toGanttBar,
  type GanttBar,
  type GanttGranularity,
} from "../model/plan-date";

/** 每列像素宽（日 28 / 周 64 / 月 96 / 年 120）→ 连续天宽 */
export const COLUMN_WIDTH: Record<GanttGranularity, number> = {
  day: 28,
  week: 64,
  month: 96,
  year: 120,
};

/** 每列覆盖天数 */
const COLUMN_DAYS: Record<GanttGranularity, number> = {
  day: 1,
  week: 7,
  month: 30.4375,
  year: 365.25,
};

export const GRANULARITY_DAY_WIDTH: Record<GanttGranularity, number> = {
  day: COLUMN_WIDTH.day / COLUMN_DAYS.day,
  week: COLUMN_WIDTH.week / COLUMN_DAYS.week,
  month: COLUMN_WIDTH.month / COLUMN_DAYS.month,
  year: COLUMN_WIDTH.year / COLUMN_DAYS.year,
};

/** 条形几何：left = 距时间轴原点天数 × 天宽；width = 跨天数 × 天宽 */
export function barGeometry(
  bar: GanttBar,
  originKey: string,
  dayWidth: number,
): { left: number; width: number } {
  return {
    left: diffDays(originKey, bar.startKey) * dayWidth,
    width: bar.days * dayWidth,
  };
}

/** 粒度切换选项 */
const GRANULARITY_OPTIONS: Array<{ value: GanttGranularity; labelKey: string }> = [
  { value: "day", labelKey: "project:planView.granularityDay" },
  { value: "week", labelKey: "project:planView.granularityWeek" },
  { value: "month", labelKey: "project:planView.granularityMonth" },
  { value: "year", labelKey: "project:planView.granularityYear" },
];

/** 条形优先级配色（与看板左色条一致） */
const BAR_BG_CLASSES: Record<PlanPriority, string> = {
  P0: "bg-destructive/80",
  P1: "bg-primary/80",
  P2: "bg-muted-foreground/50",
  P3: "bg-border",
};

interface PlanGanttViewProps {
  items: PlanItemRecord[];
  onEdit: (item: PlanItemRecord) => void;
  /** 拖拽调期回调（T6 接线；缺省时条形不可拖） */
  onChangeDates?: (id: number, dates: { startKey: string; endKey: string }) => void;
}

export default function PlanGanttView({ items, onEdit }: PlanGanttViewProps) {
  const { t } = useTranslation(["project", "common"]);
  const todayKey = toDateKey(new Date());
  const [granularity, setGranularity] = useState<GanttGranularity>("day");
  /** 翻页游标（时间轴中心日；初始今天） */
  const [centerKey, setCenterKey] = useState(todayKey);

  const columns = useMemo(
    () => ganttColumns(centerKey, granularity),
    [centerKey, granularity],
  );
  const originKey = columns[0].startKey;
  const dayWidth = GRANULARITY_DAY_WIDTH[granularity];
  const todayLeft = diffDays(originKey, todayKey) * dayWidth;
  const timelineWidth = columns.reduce((sum, col) => sum + col.days, 0) * dayWidth;

  /** 翻页步进：日 60 / 周 24 周 / 月 18 月 / 年 6 年（即一屏） */
  const pageDays = { day: 60, week: 168, month: 546, year: 2191 }[granularity];

  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
      {/* 控制栏：粒度 + 翻页 + 今天 */}
      <div className="flex items-center gap-1.5 py-2">
        <div className="flex items-center overflow-hidden rounded-md border border-border/50">
          {GRANULARITY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={granularity === option.value}
              aria-label={t(option.labelKey)}
              onClick={() => setGranularity(option.value)}
              className={cn(
                "px-2 py-1 text-xs transition-colors",
                granularity === option.value
                  ? "bg-primary-subtle font-medium text-primary"
                  : "text-muted-foreground hover:bg-primary-subtle hover:text-primary",
              )}
            >
              {t(option.labelKey)}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("project:planView.prevPage")}
          onClick={() => setCenterKey((prev) => addDaysToKey(prev, -pageDays))}
          className="h-7 w-7 p-0 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("project:planView.nextPage")}
          onClick={() => setCenterKey((prev) => addDaysToKey(prev, pageDays))}
          className="h-7 w-7 p-0 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCenterKey(todayKey)}
          className="h-7 px-2 text-xs hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
        >
          {t("project:planView.today")}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 overflow-auto">
        {/* 左列：任务名 */}
        <div className="w-52 shrink-0 border-r border-border/50">
          <div className="h-7 border-b border-border/50" />
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onEdit(item)}
              title={toGanttBar(item) ? item.title : t("project:planView.noDates")}
              className="flex h-8 w-full items-center gap-1.5 truncate px-2 text-left text-xs hover:bg-primary-subtle/40"
            >
              <span
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  BAR_BG_CLASSES[item.priority],
                )}
              />
              <span
                className={cn(
                  "truncate",
                  toGanttBar(item) ? "text-foreground" : "text-muted-foreground/60",
                )}
              >
                {item.title}
              </span>
            </button>
          ))}
        </div>
        {/* 右侧：时间轴（列头 + 条形行 + 今天线） */}
        <div className="relative" style={{ width: timelineWidth }}>
          <div className="flex h-7 border-b border-border/50">
            {columns.map((col) => (
              <div
                key={col.key}
                className="flex shrink-0 items-center justify-center border-r border-border/30 text-[10px] text-muted-foreground"
                style={{ width: col.days * dayWidth }}
              >
                {col.label}
              </div>
            ))}
          </div>
          {items.map((item) => {
            const bar = toGanttBar(item);
            const geo = bar ? barGeometry(bar, originKey, dayWidth) : null;
            return (
              <div key={item.id} className="relative h-8 border-b border-border/30">
                {geo && bar && (
                  <div
                    data-item-id={item.id}
                    title={item.title}
                    onClick={() => onEdit(item)}
                    style={{ left: geo.left, width: geo.width }}
                    className={cn(
                      "absolute top-1.5 h-5 cursor-pointer rounded-md",
                      BAR_BG_CLASSES[item.priority],
                    )}
                  />
                )}
              </div>
            );
          })}
          {/* 今天线：bg-primary 1px 竖线贯穿（spec 裁决：PRD 绿色让位主题变量） */}
          {todayLeft >= 0 && todayLeft <= timelineWidth && (
            <div
              data-today-line="true"
              style={{ left: todayLeft }}
              className="absolute top-0 bottom-0 w-px bg-primary"
            />
          )}
        </div>
      </div>
    </div>
  );
}
```

（`onChangeDates` prop 本任务先入 props 接口不消费——T6 接 pointer 交互。）

- [ ] **Step 4: i18n**

`planView` 段（双语言）：

```json
    "granularityDay": "日",
    "granularityWeek": "周",
    "granularityMonth": "月",
    "granularityYear": "年",
    "prevPage": "上一页",
    "nextPage": "下一页",
    "noDates": "点击设置日期"
```

en-US：`"Day"` / `"Week"` / `"Month"` / `"Year"` / `"Previous page"` / `"Next page"` / `"Click to set dates"`。

- [ ] **Step 5: 运行确认通过**

Run: `npm run test -- tests/project/plan-gantt.test.tsx && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src-react/domains/project/components/PlanGanttView.tsx src-react/i18n/locales tests/project/plan-gantt.test.tsx
git commit -m "feat(project): 甘特视图渲染——四粒度时间轴/翻页今天线/优先级条形/无日期灰显"
```

---

### Task 6: 甘特拖拽调期 + PlanPane 接线点亮 gantt

**Files:**
- Modify: `src-react/domains/project/components/PlanGanttView.tsx`（pointer 三边缘交互）
- Modify: `src-react/domains/project/components/PlanPane.tsx`（gantt 分支 + handleChangeDates + ADDABLE/SELECTABLE 点亮 gantt——calendar 已在 T4 点亮）
- Modify: `src-react/domains/project/components/PlanViewTabs.tsx`、`PlanViewSettingsPopover.tsx`
- Test: `tests/project/plan-gantt.test.tsx`（追加拖拽语义）、`tests/project/plan-table.test.tsx`（gantt 分支集成）

**Interfaces:**
- Consumes: Task 5 的 `barGeometry/GRANULARITY_DAY_WIDTH`；Task 2 的 `dragToDates/toGanttBar`；PlanPane 既有乐观模式。
- Produces:
  - `export function dragEdgeFor(offsetX: number, barWidth: number): "move" | "start" | "end"`（纯函数：条内相对点击 x；左右 6px 热区；导出供测试）
  - `PlanGanttView` 消费 `onChangeDates(id, { startKey, endKey })`。
  - PlanPane `handleChangeDates(id, { startKey, endKey })`：`PlanItemApi.update({ id, startDate: dateKeyToIso(startKey), dueDate: dateKeyToIso(endKey) })`，乐观 patch + 失败 invalidate 回滚（照抄 handleSetPriority 模式）。

- [ ] **Step 1: 追加失败的测试**

plan-gantt.test.tsx 追加：

```ts
describe("dragEdgeFor 纯函数（边缘热区）", () => {
  it("x < 6 → start；x > width-6 → end；中间 move", () => {
    expect(dragEdgeFor(2, 100)).toBe("start");
    expect(dragEdgeFor(98, 100)).toBe("end");
    expect(dragEdgeFor(50, 100)).toBe("move");
    expect(dragEdgeFor(0, 8)).toBe("start"); // 窄条全热区
  });
});

// 拖拽提交链（pointer 系 jsdom 不模拟，落点语义由 dragToDates 已测；
// 此处测 pointerup 提交路径的直接驱动——对条元素 fireEvent.pointerDown
// + window pointermove/pointerup 事件由实现以 window 监听器承接）：
it("条形 pointerDown+move+up → onChangeDates 收到 dragToDates 结果", async () => {
  const onChangeDates = vi.fn();
  renderGantt({ overrides: { onChangeDates } }); // A 项 09-10~09-14（5 天条 = 140px，日粒度 dayWidth=28）
  const bar = screen.getByRole("generic", ...); // data-item-id="1" 定位（queryByAttribute 或 within）
  fireEvent.pointerDown(bar, { button: 0, clientX: barLeft + 70 });
  fireEvent.pointerMove(window, { clientX: barLeft + 70 + 28 }); // +28px = +1 天
  fireEvent.pointerUp(window);
  await waitFor(() =>
    expect(onChangeDates).toHaveBeenCalledWith(1, {
      startKey: "2026-09-11", // 09-10 + 1 天
      endKey: "2026-09-15",
    }),
  );
});
```

（barLeft 由测试内 barGeometry 计算——bar 元素 style.left；实现者以实际 DOM 读取对齐。）

plan-table.test.tsx 追加：「gantt 类型视图渲染（?viewId=13 → 甘特列头出现）」。

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/project/plan-gantt.test.tsx`
Expected: FAIL（dragEdgeFor 未导出 / onChangeDates 未消费）

- [ ] **Step 3: 实现拖拽交互（PlanGanttView 内）**

```ts
/** 边缘热区判定（纯函数）：条内相对 x 距左右沿 <6px 为拉伸，其余平移 */
export function dragEdgeFor(
  offsetX: number,
  barWidth: number,
): "move" | "start" | "end" {
  const EDGE = 6;
  if (offsetX < EDGE) {
    return "start";
  }
  if (offsetX > barWidth - EDGE) {
    return "end";
  }
  return "move";
}
```

组件内（PLAN 见下，实现要点逐条）：

1. state：`const [drag, setDrag] = useState<{ id: number; edge: "move" | "start" | "end"; startX: number; dayDelta: number } | null>(null);`
2. 条形 `onPointerDown`（仅当 `onChangeDates` 存在）：`event.currentTarget.setPointerCapture` 不用（jsdom），改 window 监听——`event.preventDefault()` + `setDrag({ id: bar.id, edge: dragEdgeFor(offsetX, width), startX: event.clientX, dayDelta: 0 })`，`offsetX = event.clientX - bar.getBoundingClientRect().left`。
3. `useEffect`（drag 存在时挂 window pointermove/pointerup）：move → `dayDelta = Math.round((clientX - startX) / dayWidth)`（天粒度吸附）setDrag 更新；up → 以当前 `bar + dayDelta + edge` 调 `onChangeDates(bar.id, dragToDates(bar, dayDelta, drag.edge))` + `setDrag(null)`。
4. 渲染预览：条形的 left/width 在 drag 命中本条时按 edge 叠加 `dayDelta`（move: left+delta*dayWidth；start: left+delta*dayWidth & width-delta*dayWidth；end: width+delta*dayWidth）——`cursor` 三态：`move → cursor-grab active:cursor-grabbing`、`start/end → cursor-ew-resize`（按 dragEdgeFor(barWidth/2, width) 静态设 cursor-ew-resize 由 CSS 边缘 hover 实现复杂，简化为：条整体 cursor-grab，边缘热区命中后拖拽中显示 ew-resize——静态 className 统一 `cursor-grab`，可接受）。
5. PlanPane 接线（gantt 分支 + handler）：

```tsx
      ) : activeView?.type === "gantt" ? (
        <PlanGanttView
          items={visibleItems}
          onEdit={openEdit}
          onChangeDates={handleChangeDates}
        />
```

```ts
  /** 甘特拖拽调期：乐观 patch 日期 → update；失败失效回滚（handleSetPriority 同构） */
  const handleChangeDates = async (
    id: number,
    dates: { startKey: string; endKey: string },
  ) => {
    const startDate = dateKeyToIso(dates.startKey);
    const dueDate = dateKeyToIso(dates.endKey);
    queryClient.setQueryData<PlanItemRecord[]>(
      PLAN_ITEMS_KEY(projectId),
      (prev) => patchItem(prev, id, { startDate, dueDate }),
    );
    try {
      await PlanItemApi.update({ id, startDate, dueDate });
    } catch (error) {
      await queryClient.invalidateQueries({ queryKey: PLAN_ITEMS_KEY(projectId) });
      toast.error(mapIpcError(error));
    }
  };
```

（import `dateKeyToIso` from `../model/plan-date`。）
6. `PlanViewTabs` ADDABLE_TYPES 终态 `["kanban", "list", "gantt", "calendar"]`；`PlanViewSettingsPopover` SELECTABLE_TYPES 终态 `["table", "kanban", "list", "gantt", "calendar"]`。

- [ ] **Step 4: 运行确认通过 + 全量回归**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/project/components/PlanGanttView.tsx src-react/domains/project/components/PlanPane.tsx src-react/domains/project/components/PlanViewTabs.tsx src-react/domains/project/components/PlanViewSettingsPopover.tsx tests/project/plan-gantt.test.tsx tests/project/plan-table.test.tsx
git commit -m "feat(project): 甘特拖拽调期——pointer 三边缘天粒度吸附 + 乐观落库 + gantt 入口点亮（三视图入口全开）"
```

---

## 收尾验收（手动，spec 验收清单）

1. `+` 菜单出现 列表/甘特/日历 三项；视图设置类型五类可选。
2. 列表：折叠展开、勾选完成落 done（看板同步移动列）、组内回车快速新增带状态。
3. 日历：翻月/今天回正/今日高亮/农历与节日（如 2026-09-25 中秋节）/点格新建预置截止日/+N 折叠/无日期统计正确。
4. 甘特：四粒度切换与翻页/今天线/条形跨列/拖拽平移与边缘拉伸调期（刷新保持）/无日期任务灰显点击开弹窗。
5. 全部文案双语言；颜色全主题变量（今天线 bg-primary）。

## 自审记录（writing-plans Self-Review）

1. **Spec coverage**：§1 模型层（T1 日历向 + T2 甘特向）；§2 列表（T3）；§3 日历（T4，含 PlanItemDialog defaultDueDate）；§4 甘特渲染+拖拽（T5/T6）；§5 接线（T3/T4/T6 分批点亮 + handleChangeDates）、i18n（T4/T5）、测试（各任务 TDD + 时区回归 T1）——spec 各节均有任务覆盖；spec「农历断言以库输出写死」已在计划编写时预装依赖实测写死（2026-09-25 中秋节/2026-10-23 霜降/2026-09-11 八月初一）。
2. **占位符**：组件测试以「用例清单+骨架引用」给出（骨架逐字引用既有文件行段，同 A 阶段计划先例）；其余全部含完整代码；无 TBD/TODO。
3. **类型一致性**：`dateKey/LunarLabel/MonthCell/monthGrid/groupByDueDate/GanttGranularity/GanttColumn/GanttBar/toGanttBar/dragToDates` 在 T1/T2 定义、T3/T4/T5/T6 消费签名一致；`barGeometry/GRANULARITY_DAY_WIDTH/dragEdgeFor` T5/T6 导出名一致；PlanPane handler 命名 handleQuickCreateIn/handleChangeDates 在 T3/T6 各自定义并接线。


