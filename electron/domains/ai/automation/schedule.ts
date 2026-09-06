/**
 * 下次触发时间计算(纯函数,date-fns,不依赖系统时钟——from 显式注入可测)。
 * 语义见 spec §3:月末无该日跳过当月;2/29 非闰年跳过;interval 以
 * lastRunAt 为相位基准,落在未选星期则顺延至下一允许日 00:00。
 */
import { addDays, addMinutes } from "date-fns";
import type { ScheduleConfig } from "../../../../src-react/domains/ai/automation/api/schedule.schema";

/** [hh, mm] 拆 "HH:mm" */
function parseTime(t: string): [number, number] {
  const [h, m] = t.split(":").map(Number);
  return [h, m];
}

/** d 的当天 hh:mm 时刻 */
function atTime(d: Date, time: string): Date {
  const [h, m] = parseTime(time);
  const next = new Date(d);
  next.setHours(h, m, 0, 0);
  return next;
}

/** ISO 星期(1=周一…7=周日) */
function isoWeekday(d: Date): number {
  return d.getDay() === 0 ? 7 : d.getDay();
}

/** interval 分钟数 */
function minutes(cfg: Extract<ScheduleConfig, { mode: "interval" }>): number {
  return cfg.unit === "hour" ? cfg.value * 60 : cfg.value;
}

/** 双周周期毫秒数(用毫秒常量推进相位,避免月末 DST 争议) */
const FORTNIGHT_MS = 14 * 24 * 3600 * 1000;

function nextPeriodic(
  cfg: Extract<ScheduleConfig, { mode: "periodic" }>,
  from: Date,
): Date | null {
  switch (cfg.kind) {
    case "once":
      return new Date(cfg.runAt) > from ? new Date(cfg.runAt) : null;
    case "daily": {
      const today = atTime(from, cfg.time);
      return today > from ? today : addDays(today, 1);
    }
    case "weekly": {
      for (let i = 0; i <= 7; i += 1) {
        const day = addDays(from, i);
        const candidate = atTime(day, cfg.time);
        if (candidate > from && cfg.weekdays.includes(isoWeekday(day))) {
          return candidate;
        }
      }
      return atTime(addDays(from, 7), cfg.time);
    }
    case "biweekly": {
      const [y, m, d] = cfg.anchorDate.split("-").map(Number);
      const anchor = new Date(y, m - 1, d, ...parseTime(cfg.time));
      // 相位对齐:anchor 在 from 之后则先回退到 from 之前最近的双周点;
      // anchor 落后 from 超过一个周期时(稳态)再前推,保证返回值恒为未来时刻
      let base = anchor;
      while (base > from) {
        base = new Date(base.getTime() - FORTNIGHT_MS);
      }
      while (new Date(base.getTime() + FORTNIGHT_MS) <= from) {
        base = new Date(base.getTime() + FORTNIGHT_MS);
      }
      return new Date(base.getTime() + FORTNIGHT_MS);
    }
    case "monthly": {
      const cursor = new Date(from);
      for (let i = 0; i <= 2; i += 1) {
        const daysInMonth = new Date(
          cursor.getFullYear(),
          cursor.getMonth() + 1,
          0,
        ).getDate();
        if (cfg.dayOfMonth <= daysInMonth) {
          const candidate = new Date(
            cursor.getFullYear(),
            cursor.getMonth(),
            cfg.dayOfMonth,
            ...parseTime(cfg.time),
          );
          if (candidate > from) {
            return candidate;
          }
        }
        cursor.setMonth(cursor.getMonth() + 1, 1);
      }
      cursor.setMonth(cursor.getMonth() + 1, 1);
      return new Date(
        cursor.getFullYear(),
        cursor.getMonth(),
        cfg.dayOfMonth,
        ...parseTime(cfg.time),
      );
    }
    case "yearly": {
      const year = from.getFullYear();
      for (let y = year; y <= year + 5; y += 1) {
        const candidate = new Date(
          y,
          cfg.month - 1,
          cfg.day,
          ...parseTime(cfg.time),
        );
        // 无效日期(如非闰年 2/29)会被 Date 滚动到下月,回读校验不一致则跳过该年
        if (
          candidate.getMonth() !== cfg.month - 1 ||
          candidate.getDate() !== cfg.day
        ) {
          continue;
        }
        if (candidate > from) {
          return candidate;
        }
      }
      return null;
    }
  }
}

/** interval:相位累加 + 星期顺延 */
function nextInterval(
  cfg: Extract<ScheduleConfig, { mode: "interval" }>,
  from: Date,
  lastRunAt?: Date,
): Date {
  const step = minutes(cfg);
  let next = lastRunAt ? new Date(lastRunAt) : new Date(from);
  do {
    next = addMinutes(next, step);
  } while (next <= from);
  // 空数组视同不限制(undefined),否则顺延循环对空集合恒真会死循环
  if (!cfg.weekdays || cfg.weekdays.length === 0) {
    return next;
  }
  if (cfg.weekdays.includes(isoWeekday(next))) {
    return next;
  }
  // 顺延至下一个允许日 00:00(相位基准同步重置到该时刻)
  let day = next;
  do {
    day = addDays(day, 1);
  } while (!cfg.weekdays.includes(isoWeekday(day)));
  return atTime(day, "00:00");
}

export function computeNextRun(
  config: ScheduleConfig,
  from: Date,
  lastRunAt?: Date,
): Date | null {
  return config.mode === "interval"
    ? nextInterval(config, from, lastRunAt)
    : nextPeriodic(config, from);
}
