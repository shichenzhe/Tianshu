// src-react/domains/ai/automation/lib/schedule-text.ts
/**
 * 调度自然语言与校验(纯函数,摘要栏与列表行同一实现,spec §5)。
 * 文案全走 i18n;t 注入可测;校验规则见 PRD《执行频率》§4。
 */
import { format } from "date-fns";
import {
  intervalMinutes,
  INTERVAL_MIN_MINUTES,
  type ScheduleConfig,
} from "../api/schedule.schema";

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

export type ScheduleValidation =
  "ok" | "timeInPast" | "intervalTooSmall" | "incomplete";

function weekdayNames(weekdays: number[], t: TFunc): string {
  return weekdays.map((n) => t("common:weekday." + n)).join(", ");
}

export function describeSchedule(cfg: ScheduleConfig, t: TFunc): string {
  if (cfg.mode === "interval") {
    return t("chat:automation.schedule.textInterval", {
      weekdays: cfg.weekdays ? weekdayNames(cfg.weekdays, t) : "",
      value: cfg.value,
      // Task 11 只定义扁平 unitMinute/unitHour(unit 本身是「单位」label
      // 键,嵌套 unit.minute 与之重名被 i18n 规范禁止),不能按 unit 插值拼嵌套键
      unit: t(
        cfg.unit === "hour"
          ? "chat:automation.schedule.unitHour"
          : "chat:automation.schedule.unitMinute",
      ),
    });
  }
  switch (cfg.kind) {
    case "once":
      // runAt 为 UTC ISO,按本地时区展示(date-fns format)
      return t("chat:automation.schedule.textOnce", {
        time: format(new Date(cfg.runAt), "yyyy-MM-dd HH:mm"),
      });
    case "daily":
      return t("chat:automation.schedule.textDaily", { time: cfg.time });
    case "weekly":
      return t("chat:automation.schedule.textWeekly", {
        weekdays: weekdayNames(cfg.weekdays, t),
        time: cfg.time,
      });
    case "biweekly":
      return t("chat:automation.schedule.textBiweekly", {
        weekday: t("common:weekday." + cfg.weekday),
        time: cfg.time,
      });
    case "monthly":
      return t("chat:automation.schedule.textMonthly", {
        day: cfg.dayOfMonth,
        time: cfg.time,
      });
    case "yearly":
      return t("chat:automation.schedule.textYearly", {
        month: cfg.month,
        day: cfg.day,
        time: cfg.time,
      });
  }
}

export function describeValidity(
  validity: { startAt?: string; endAt?: string },
  t: TFunc,
): string {
  if (!validity.startAt && !validity.endAt) {
    return t("chat:automation.schedule.longTerm");
  }
  return t("chat:automation.schedule.textRange", {
    start: validity.startAt?.slice(0, 10) ?? "",
    end: validity.endAt?.slice(0, 10) ?? "",
  });
}

export function validateSchedule(
  cfg: ScheduleConfig | null,
  validity: { startAt?: string; endAt?: string },
  now: Date,
): ScheduleValidation {
  if (!cfg) {
    return "incomplete";
  }
  if (cfg.mode === "interval" && intervalMinutes(cfg) < INTERVAL_MIN_MINUTES) {
    return "intervalTooSmall";
  }
  if (cfg.mode === "periodic" && cfg.kind === "once") {
    if (new Date(cfg.runAt) <= now) {
      return "timeInPast";
    }
  }
  if (validity.startAt) {
    // 开始日期按本地零点口径:早于今天才拒绝(「今天开始」= 立即生效,合法)
    const startDay = new Date(`${validity.startAt.slice(0, 10)}T00:00:00`);
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    if (startDay < todayStart) {
      return "timeInPast";
    }
  }
  return "ok";
}
