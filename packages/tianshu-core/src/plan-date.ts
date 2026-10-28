// packages/tianshu-core/src/plan-date.ts
/**
 * 计划日期基础（A7 批自 src-react/domains/project/model/plan-date.ts 下沉）：
 * dateKey 算术层（零时区换算，UTC 零点存储口径见桌面 A 阶段时区裁决）。
 * 农历标注/月历网格/甘特时间轴留桌面本地（lunar-typescript 不进 core）。
 */

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
