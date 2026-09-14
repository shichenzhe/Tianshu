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
