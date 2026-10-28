/**
 * 自动化任务调度纯函数层（CRUD 批）：自 /automation/new 内联区迁出并扩
 * 至全集七 kind（once/daily/weekly/biweekly/monthly/yearly/interval——
 * @tianshu/core ScheduleConfig 同源）。表单值 ↔ wire ScheduleConfig 双向
 * 转换 + 校验 + 人读文案 + 编辑载荷组装（透传纪律：UI 不暴露的字段
 * eventJson/templateSlug/projectId/temperature/interval weekdays 原样
 * 回传，防全量 save 丢配置）。
 */
import type { TaskRecord } from "@tianshu/protocol";

export type ScheduleKind =
  "once" | "daily" | "weekly" | "biweekly" | "monthly" | "yearly" | "interval";
export type IntervalUnit = "minute" | "hour";
export type Translate = (
  key: string,
  options?: Record<string, unknown>,
) => string;

export interface ScheduleValues {
  kind: ScheduleKind;
  /** once 日期 / biweekly 锚点日期（YYYY-MM-DD，本地） */
  date: string;
  hm: string;
  weekdays: number[];
  intervalValue: string;
  intervalUnit: IntervalUnit;
  /** interval 限定星期（可选语义；UI 不编辑、回填保留提交并回——防丢） */
  intervalWeekdays: number[];
  /** monthly 每月几号 / yearly 几号 */
  dayOfMonth: string;
  /** yearly 月份 */
  month: string;
}

export const SCHEDULE_KINDS: ScheduleKind[] = [
  "once",
  "daily",
  "weekly",
  "biweekly",
  "monthly",
  "yearly",
  "interval",
];
export const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const ONCE_MIN_LEAD_MS = 60_000;

/** prompt/graph 双模式表单的执行体相关校验输入 */
export interface TargetValues {
  name: string;
  targetKind: "prompt" | "graph";
  /** graph 模式选图；prompt 模式 null */
  graphId: number | null;
  /** prompt 模式必选；graph 模式 0 占位 */
  modelId: number | null;
  prompt: string;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function localDateValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localDateTime(date: string, hm: string): Date {
  return new Date(`${date}T${hm}:00`);
}

/** ISO 含时区偏移 → 本地 date/hm（once 编辑回填） */
function isoToLocal(iso: string): { date: string; hm: string } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return {
    date: localDateValue(d),
    hm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

function tzOffset(target: Date): string {
  const minutes = -target.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function intervalMinutes(values: ScheduleValues): number {
  const value = Number(values.intervalValue);
  return values.intervalUnit === "hour" ? value * 60 : value;
}

export function defaultScheduleValues(): ScheduleValues {
  return {
    kind: "once",
    date: "",
    hm: "09:00",
    weekdays: [1],
    intervalValue: "30",
    intervalUnit: "minute",
    intervalWeekdays: [],
    dayOfMonth: "1",
    month: "1",
  };
}

/** 表单值 → wire ScheduleConfig（intervalWeekdays 并回可选限定） */
export function buildSchedule(values: ScheduleValues): Record<string, unknown> {
  const { kind, date, hm, weekdays, intervalValue, intervalUnit } = values;
  if (kind === "once") {
    return {
      mode: "periodic",
      kind,
      runAt: `${date}T${hm}:00${tzOffset(localDateTime(date, hm))}`,
    };
  }
  if (kind === "daily") return { mode: "periodic", kind, time: hm };
  if (kind === "weekly") {
    return { mode: "periodic", kind, weekdays: [...weekdays].sort(), time: hm };
  }
  if (kind === "biweekly") {
    const anchor = localDateTime(date, hm);
    return {
      mode: "periodic",
      kind,
      anchorDate: date,
      weekday: anchor.getDay() === 0 ? 7 : anchor.getDay(),
      time: hm,
    };
  }
  if (kind === "monthly") {
    return {
      mode: "periodic",
      kind,
      dayOfMonth: Number(values.dayOfMonth),
      time: hm,
    };
  }
  if (kind === "yearly") {
    return {
      mode: "periodic",
      kind,
      month: Number(values.month),
      day: Number(values.dayOfMonth),
      time: hm,
    };
  }
  const schedule: Record<string, unknown> = {
    mode: "interval",
    value: Number(intervalValue),
    unit: intervalUnit,
  };
  // 可选星期限定：编辑回填保留（UI 不编辑不新配——桌面 SchedulePicker 面）
  if (values.intervalWeekdays.length > 0) {
    schedule.weekdays = [...values.intervalWeekdays].sort();
  }
  return schedule;
}

/** wire ScheduleConfig（任务 scheduleJson 解析后）→ 表单值；未知形态
 *  返回 null（页面调度区转只读 + 原样透传，不丢原配置） */
export function parseScheduleConfig(raw: unknown): ScheduleValues | null {
  if (typeof raw !== "object" || raw === null) return null;
  const config = raw as Record<string, unknown>;
  const values = defaultScheduleValues();
  const time = typeof config.time === "string" ? config.time : values.hm;
  // interval 判别字段是 mode（wire 形态无 kind），先于 kind switch 分流
  if (config.mode === "interval") {
    return {
      ...values,
      kind: "interval",
      intervalValue: String(config.value ?? ""),
      intervalUnit: config.unit === "hour" ? "hour" : "minute",
      intervalWeekdays: Array.isArray(config.weekdays)
        ? config.weekdays.filter(
            (day): day is number => typeof day === "number",
          )
        : [],
    };
  }
  switch (config.kind) {
    case "once": {
      if (typeof config.runAt !== "string") return null;
      const local = isoToLocal(config.runAt);
      if (local === null) return null;
      return { ...values, kind: "once", date: local.date, hm: local.hm };
    }
    case "daily":
      return { ...values, kind: "daily", hm: time };
    case "weekly":
      return {
        ...values,
        kind: "weekly",
        weekdays: Array.isArray(config.weekdays)
          ? config.weekdays.filter(
              (day): day is number => typeof day === "number",
            )
          : [],
        hm: time,
      };
    case "biweekly": {
      if (typeof config.anchorDate !== "string") return null;
      return { ...values, kind: "biweekly", date: config.anchorDate, hm: time };
    }
    case "monthly":
      if (typeof config.dayOfMonth !== "number") return null;
      return {
        ...values,
        kind: "monthly",
        dayOfMonth: String(config.dayOfMonth),
        hm: time,
      };
    case "yearly":
      if (typeof config.month !== "number" || typeof config.day !== "number") {
        return null;
      }
      return {
        ...values,
        kind: "yearly",
        month: String(config.month),
        dayOfMonth: String(config.day),
        hm: time,
      };
    default:
      return null;
  }
}

/** 全量校验：名称/执行体（prompt 提示词+模型；graph 选图）/调度七 kind。
 *  返回 i18n key 或 null（调用方 t() 渲染）。allowPastOnce：编辑模式的
 *  once 已过时间是合法存量（保存后自然 expired），跳过过去校验 */
export function validationKey(
  target: TargetValues,
  values: ScheduleValues,
  now = new Date(),
  allowPastOnce = false,
): string | null {
  if (!target.name.trim()) return "orchestration:needName";
  if (target.targetKind === "graph" && target.graphId === null) {
    return "orchestration:needGraph";
  }
  if (target.targetKind === "prompt") {
    if (!target.prompt.trim()) return "orchestration:needPrompt";
    if (target.modelId === null) return "orchestration:needModel";
  }
  const { kind } = values;
  if (kind === "weekly" && values.weekdays.length === 0) {
    return "orchestration:needWeekday";
  }
  if (kind === "once") {
    if (!values.date || !TIME_RE.test(values.hm)) {
      return "orchestration:needSchedule";
    }
    const runAt = localDateTime(values.date, values.hm);
    if (Number.isNaN(runAt.getTime())) return "orchestration:needSchedule";
    if (!allowPastOnce && runAt.getTime() <= now.getTime() + ONCE_MIN_LEAD_MS) {
      return "orchestration:timeInPast";
    }
  }
  if (kind === "biweekly" && (!values.date || !TIME_RE.test(values.hm))) {
    return "orchestration:needSchedule";
  }
  if (
    (kind === "monthly" || kind === "yearly") &&
    (!TIME_RE.test(values.hm) ||
      (kind === "monthly" && !values.dayOfMonth.trim()) ||
      (kind === "yearly" &&
        (!values.month.trim() || !values.dayOfMonth.trim())))
  ) {
    return "orchestration:needSchedule";
  }
  if (kind !== "once" && kind !== "interval" && !TIME_RE.test(values.hm)) {
    return "orchestration:needSchedule";
  }
  if (kind !== "interval") return null;
  const value = Number(values.intervalValue);
  if (!values.intervalValue.trim() || !Number.isFinite(value) || value <= 0) {
    return "orchestration:needSchedule";
  }
  if (!Number.isInteger(value) || intervalMinutes(values) < 5) {
    return "orchestration:intervalMin5";
  }
  return null;
}

export function buildScheduleText(
  values: ScheduleValues,
  t: Translate,
): string {
  const { kind, date, hm, weekdays, intervalValue, intervalUnit } = values;
  if (kind === "once") {
    return t("orchestration:scheduleTextOnce", { date, time: hm });
  }
  if (kind === "daily") {
    return t("orchestration:scheduleTextDaily", { time: hm });
  }
  if (kind === "weekly") {
    const labels = [...weekdays]
      .sort()
      .map((day) => t(`orchestration:${WEEKDAY_KEYS[day - 1]}`))
      .join(t("orchestration:weekdaySeparator"));
    return t("orchestration:scheduleTextWeekly", {
      weekdays: labels,
      time: hm,
    });
  }
  if (kind === "biweekly") {
    return t("orchestration:scheduleTextBiweekly", { date, time: hm });
  }
  if (kind === "monthly") {
    return t("orchestration:scheduleTextMonthly", {
      day: Number(values.dayOfMonth),
      time: hm,
    });
  }
  if (kind === "yearly") {
    return t("orchestration:scheduleTextYearly", {
      month: Number(values.month),
      day: Number(values.dayOfMonth),
      time: hm,
    });
  }
  return t("orchestration:scheduleTextInterval", {
    value: Number(intervalValue),
    unit: t(`orchestration:${intervalUnit}`),
  });
}

/** 编辑提交载荷（与 transport TaskSaveParams 结构兼容的具体形状——
 *  logic 层不引 transport 依赖） */
export interface AutomationEditPayload {
  id: number;
  enabled: boolean;
  name: string;
  prompt: string;
  workspaceId: number;
  modelId: number;
  temperature?: number;
  targetKind: "prompt" | "graph";
  graphId?: number;
  eventJson?: string;
  templateSlug?: string;
  projectId?: number | null;
  schedule: Record<string, unknown>;
  scheduleText: string;
  startAt?: string;
  endAt?: string;
  missedPolicy: "skip" | "catchUpOnce";
  accessMode?: "default" | "full";
}

/** 编辑提交载荷组装（透传纪律）：表单新值 + UI 不暴露字段原样回传 +
 *  enabled 原值（编辑不重置用户开关——face save 组合语义「显式携带且
 *  不同才写」下恒定传原值即不碰开关） */
export function buildEditPayload(
  task: TaskRecord,
  target: TargetValues,
  values: ScheduleValues | null,
  t: Translate,
): AutomationEditPayload {
  return {
    id: task.id,
    enabled: task.enabled,
    name: target.name.trim(),
    prompt: target.targetKind === "graph" ? "" : target.prompt,
    workspaceId: task.workspaceId,
    modelId: target.targetKind === "graph" ? 0 : (target.modelId ?? 0),
    temperature: task.temperature,
    targetKind: target.targetKind,
    graphId:
      target.targetKind === "graph" ? (target.graphId ?? undefined) : undefined,
    eventJson: task.eventJson ?? undefined,
    templateSlug: task.templateSlug,
    projectId: task.projectId,
    // 未知调度形态：原样透传（parseScheduleConfig null 分支）
    schedule:
      values === null
        ? (JSON.parse(task.scheduleJson) as Record<string, unknown>)
        : buildSchedule(values),
    scheduleText:
      values === null ? task.scheduleText : buildScheduleText(values, t),
    missedPolicy: task.missedPolicy,
    accessMode: task.accessMode,
    startAt: task.startAt,
    endAt: task.endAt,
  };
}
