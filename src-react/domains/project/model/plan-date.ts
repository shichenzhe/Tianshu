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
  return toDateKey(
    new Date(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate()),
  );
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
    const date = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + index,
    );
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

/** 整屏列：日 60（前 30）/周 24/月 18/年 6；列起点对齐粒度 */
export function ganttColumns(
  centerKey: string,
  granularity: GanttGranularity,
): GanttColumn[] {
  const aligned = alignStart(centerKey, granularity);
  const [y, m] = aligned.split("-").map(Number);
  if (granularity === "day") {
    return Array.from({ length: 60 }, (_, index) => {
      const startKey = addDaysToKey(aligned, -30 + index);
      const [, , dd] = startKey.split("-").map(Number);
      return {
        key: startKey,
        label: String(dd),
        startKey,
        endKey: startKey,
        days: 1,
      };
    });
  }
  if (granularity === "week") {
    return Array.from({ length: 24 }, (_, index) => {
      const startKey = addDaysToKey(aligned, (index - 12) * 7);
      const [, wm, wd] = startKey.split("-").map(Number);
      return {
        key: startKey,
        label: `${wm}.${wd}`,
        startKey,
        endKey: addDaysToKey(startKey, 6),
        days: 7,
      };
    });
  }
  if (granularity === "month") {
    return Array.from({ length: 18 }, (_, index) => {
      const base = new Date(y, m - 1 + index - 8, 1);
      const startKey = toDateKey(base);
      const next = new Date(y, m + index - 8, 1);
      const endKey = addDaysToKey(toDateKey(next), -1);
      return {
        key: startKey,
        label: `${base.getMonth() + 1}`,
        startKey,
        endKey,
        days: diffDays(startKey, endKey) + 1,
      };
    });
  }
  return Array.from({ length: 6 }, (_, index) => {
    const year = y + index - 2;
    return {
      key: String(year),
      label: String(year),
      startKey: `${year}-01-01`,
      endKey: `${year}-12-31`,
      days: diffDays(`${year}-01-01`, `${year}-12-31`) + 1,
    };
  });
}

/* ---------- 甘特条与拖拽语义 ---------- */

export interface GanttBar {
  id: number;
  startKey: string;
  endKey: string;
  days: number;
}

/** 事项 → 甘特条（单端日期钳 1 天；双空 → null 无日期；起止倒置归一为 min/max） */
export function toGanttBar(entry: PlanItemRecord): GanttBar | null {
  const start = isoToDateKey(entry.startDate);
  const end = isoToDateKey(entry.dueDate);
  if (!start && !end) {
    return null;
  }
  const first = start || end;
  const last = end || start;
  const startKey = first <= last ? first : last;
  const endKey = first <= last ? last : first;
  return {
    id: entry.id,
    startKey,
    endKey,
    days: Math.abs(diffDays(first, last)) + 1,
  };
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
