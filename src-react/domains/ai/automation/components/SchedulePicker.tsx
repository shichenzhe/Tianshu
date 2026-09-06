/**
 * 频率配置(PRD《执行频率》§2.1 三层级):模式 Tab → 联动表单 →
 * 摘要栏。value/validity 受控,联动表单字段为挂载时惰性初始化的
 * 内部 state(编辑回填初值由 deriveStateFromValue 从 value 派生,
 * 来源切换的重置靠挂载方以 key remount);校验由父级调 validateSchedule;
 * 周期/间隔 Tab 切换经 onModeSwitch 通知父级计数埋点(见 Props)。
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DatePicker } from "@/components/common/DatePicker";
import {
  INTERVAL_MIN_MINUTES,
  type ScheduleConfig,
} from "../api/schedule.schema";
import { describeSchedule, describeValidity } from "../lib/schedule-text";

type PeriodicKind =
  "once" | "daily" | "weekly" | "biweekly" | "monthly" | "yearly";

const PERIODIC_KINDS: PeriodicKind[] = [
  "once",
  "daily",
  "weekly",
  "biweekly",
  "monthly",
  "yearly",
];

/** ISO 1-7 → common:weekday.n */
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

/** DatePicker 实际签名 value?: Date/onChange(Date),组件内部仍统一存
 * yyyy-MM-dd 字符串,边界互转按本地零点口径(直接 new Date("yyyy-MM-dd")
 * 会按 UTC 解析,负时区下回写漂移一天) */
function toDate(d?: string): Date | undefined {
  return d ? new Date(`${d}T00:00:00`) : undefined;
}

/** DatePicker 选中值 → yyyy-MM-dd */
function toISODate(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

/** 日历可选上限:DatePicker 缺省 endMonth=当月,不传无法翻到未来月份 */
const MAX_PICKABLE = new Date(new Date().getFullYear() + 10, 11, 31);

/** 联动表单内部 state 初值形状(deriveStateFromValue 返回值) */
interface PickerState {
  intervalValue: number;
  intervalUnit: "minute" | "hour";
  intervalWeekdays: number[];
  runAtDate?: string;
  runAtTime: string;
  time: string;
  weekdays: number[];
  anchorDate?: string;
  dayOfMonth: number;
  monthDay: { month: number; day: number };
}

/**
 * 编辑态回填:value(已存调度配置)→ 内部 state 初值。
 * 纯函数供惰性初始化消费(配合挂载方 key remount,避免受控/非受控
 * 混合的同步 effect);value 为 null 的空态保持新建默认值。
 * 数组一律拷贝(weekly 另去重),防内部 state 与 value 共享引用。
 */
function deriveStateFromValue(value: ScheduleConfig | null): PickerState {
  const init: PickerState = {
    intervalValue: 30,
    intervalUnit: "minute",
    intervalWeekdays: [],
    runAtDate: undefined,
    runAtTime: "09:00",
    time: "09:00",
    weekdays: [1],
    anchorDate: undefined,
    dayOfMonth: 1,
    monthDay: { month: 12, day: 31 },
  };
  if (!value) {
    return init;
  }
  if (value.mode === "interval") {
    init.intervalValue = value.value;
    init.intervalUnit = value.unit;
    init.intervalWeekdays = [...(value.weekdays ?? [])];
    return init;
  }
  switch (value.kind) {
    case "once":
      // runAt 为 UTC ISO,format 按本地时区拆解回显(与保存口径对称)
      init.runAtDate = format(new Date(value.runAt), "yyyy-MM-dd");
      init.runAtTime = format(new Date(value.runAt), "HH:mm");
      break;
    case "daily":
      init.time = value.time;
      break;
    case "weekly":
      init.time = value.time;
      init.weekdays = [...new Set(value.weekdays)];
      break;
    case "biweekly":
      init.time = value.time;
      init.weekdays = [value.weekday];
      init.anchorDate = value.anchorDate;
      break;
    case "monthly":
      init.time = value.time;
      init.dayOfMonth = value.dayOfMonth;
      break;
    case "yearly":
      init.time = value.time;
      init.monthDay = { month: value.month, day: value.day };
      break;
  }
  return init;
}

export interface SchedulePickerProps {
  value: ScheduleConfig | null;
  onChange: (cfg: ScheduleConfig | null) => void;
  validity: { startAt?: string; endAt?: string };
  onValidityChange: (v: { startAt?: string; endAt?: string }) => void;
  /** 埋点:模式切换累计(tab ↔ interval) */
  onModeSwitch?: () => void;
}

export function SchedulePicker({
  value,
  onChange,
  validity,
  onValidityChange,
  onModeSwitch,
}: SchedulePickerProps) {
  const { t } = useTranslation(["chat", "common"]);
  const mode = value?.mode ?? "periodic";
  const kind: PeriodicKind = value?.mode === "periodic" ? value.kind : "daily";
  // 惰性初始化:初值仅在挂载时从 value 派生一次(编辑回填),之后归
  // 内部 state 管理;来源切换的重置由挂载方 key remount 保证
  const [init] = useState(() => deriveStateFromValue(value));
  const [intervalValue, setIntervalValue] = useState(init.intervalValue);
  const [intervalUnit, setIntervalUnit] = useState<"minute" | "hour">(
    init.intervalUnit,
  );
  const [intervalWeekdays, setIntervalWeekdays] = useState<number[]>(
    init.intervalWeekdays,
  );
  const [runAtDate, setRunAtDate] = useState<string | undefined>(
    init.runAtDate,
  );
  const [runAtTime, setRunAtTime] = useState(init.runAtTime);
  const [time, setTime] = useState(init.time);
  const [weekdays, setWeekdays] = useState<number[]>(init.weekdays);
  const [anchorDate, setAnchorDate] = useState<string | undefined>(
    init.anchorDate,
  );
  const [dayOfMonth, setDayOfMonth] = useState(init.dayOfMonth);
  const [monthDay, setMonthDay] = useState(init.monthDay);

  const summary = useMemo(
    () =>
      value
        ? `${describeSchedule(value, t)} · ${describeValidity(validity, t)}`
        : t("chat:automation.schedule.summaryIncomplete"),
    [value, validity, t],
  );

  function switchMode(next: "periodic" | "interval") {
    if (next !== mode) {
      onModeSwitch?.();
    }
    if (next === "interval") {
      setIntervalConfig();
    } else {
      onChange({ mode: "periodic", kind: "daily", time });
    }
  }

  function setIntervalConfig() {
    onChange({
      mode: "interval",
      value: Math.max(
        intervalValue,
        INTERVAL_MIN_MINUTES === 5 && intervalUnit === "minute"
          ? 5
          : intervalValue,
      ),
      unit: intervalUnit,
      ...(intervalWeekdays.length ? { weekdays: [...intervalWeekdays] } : {}),
    });
  }

  function switchKind(next: PeriodicKind) {
    if (next === "once") {
      onChange({
        mode: "periodic",
        kind: "once",
        // 本地日期时间 → Date → UTC ISO(直接拼 Z 会把本地时间当 UTC,时区错位)
        runAt: new Date(
          `${runAtDate ?? "1970-01-01"}T${runAtTime}`,
        ).toISOString(),
      });
      return;
    }
    if (next === "daily") {
      onChange({ mode: "periodic", kind: "daily", time });
    } else if (next === "weekly") {
      onChange({
        mode: "periodic",
        kind: "weekly",
        weekdays: [...weekdays],
        time,
      });
    } else if (next === "biweekly") {
      onChange({
        mode: "periodic",
        kind: "biweekly",
        anchorDate: anchorDate ?? "",
        weekday: weekdays[0] ?? 1,
        time,
      });
    } else if (next === "monthly") {
      onChange({ mode: "periodic", kind: "monthly", dayOfMonth, time });
    } else {
      onChange({
        mode: "periodic",
        kind: "yearly",
        month: monthDay.month,
        day: monthDay.day,
        time,
      });
    }
  }

  /** 当前 kind 变更后的字段回填 */
  function patchCurrent(patch: Partial<Record<string, unknown>>) {
    if (!value) {
      return;
    }
    onChange({ ...value, ...patch } as ScheduleConfig);
  }

  return (
    <div className="rounded-lg border border-border/50 p-3 space-y-3">
      {/* 模式 Tab(自绘两按钮,项目无 Tabs 组件) */}
      <div className="flex gap-1 rounded-md bg-muted p-1 w-fit">
        {(["periodic", "interval"] as const).map((m) => (
          <Button
            key={m}
            type="button"
            size="sm"
            variant={mode === m ? "default" : "ghost"}
            onClick={() => switchMode(m)}
          >
            {t(
              `chat:automation.schedule.tab${
                m === "periodic" ? "Periodic" : "Interval"
              }`,
            )}
          </Button>
        ))}
      </div>

      {mode === "periodic" ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Label className="w-20 shrink-0">
              {t("chat:automation.schedule.kind")}
            </Label>
            <Select
              value={kind}
              onValueChange={(v) => switchKind(v as PeriodicKind)}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border border-border/50 rounded-lg shadow-lg">
                {PERIODIC_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(
                      `chat:automation.schedule.kind${k[0].toUpperCase()}${k.slice(1)}`,
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <KindFields
            kind={kind}
            state={{
              runAtDate,
              runAtTime,
              time,
              weekdays,
              anchorDate,
              dayOfMonth,
              monthDay,
            }}
            setState={{
              setRunAtDate: (d) => {
                setRunAtDate(d);
                if (kind === "once" && d) {
                  patchCurrent({
                    runAt: new Date(`${d}T${runAtTime}`).toISOString(),
                  });
                }
              },
              setRunAtTime: (tm) => {
                setRunAtTime(tm);
                if (kind === "once" && runAtDate) {
                  patchCurrent({
                    runAt: new Date(`${runAtDate}T${tm}`).toISOString(),
                  });
                }
              },
              setTime: (tm) => {
                setTime(tm);
                patchCurrent({ time: tm });
              },
              toggleWeekday: (n) => {
                const next = weekdays.includes(n)
                  ? weekdays.filter((x) => x !== n)
                  : [...weekdays, n];
                setWeekdays(next);
                patchCurrent(
                  kind === "weekly"
                    ? { weekdays: next }
                    : { weekday: next[0] ?? 1 },
                );
              },
              setAnchorDate: (d) => {
                setAnchorDate(d);
                patchCurrent({ anchorDate: d });
              },
              setDayOfMonth: (d) => {
                setDayOfMonth(d);
                patchCurrent({ dayOfMonth: d });
              },
              setMonthDay: (md) => {
                setMonthDay(md);
                patchCurrent({ month: md.month, day: md.day });
              },
            }}
          />
        </div>
      ) : (
        <IntervalFields
          value={intervalValue}
          unit={intervalUnit}
          weekdays={intervalWeekdays}
          onChange={(v, unit) => {
            setIntervalValue(v);
            setIntervalUnit(unit);
            onChange({
              mode: "interval",
              value: v,
              unit,
              ...(intervalWeekdays.length
                ? { weekdays: [...intervalWeekdays] }
                : {}),
            });
          }}
          onToggleWeekday={(n) => {
            const next = intervalWeekdays.includes(n)
              ? intervalWeekdays.filter((x) => x !== n)
              : [...intervalWeekdays, n];
            setIntervalWeekdays(next);
            onChange({
              mode: "interval",
              value: intervalValue,
              unit: intervalUnit,
              ...(next.length ? { weekdays: next } : {}),
            });
          }}
        />
      )}

      {/* 有效期 */}
      <ValidityFields validity={validity} onValidityChange={onValidityChange} />

      {/* 摘要栏 */}
      <div className="rounded-md bg-primary-subtle px-3 py-2 text-sm text-foreground">
        <span className="text-muted-foreground">
          {t("chat:automation.schedule.summary")}：
        </span>
        {summary}
      </div>
    </div>
  );
}

function KindFields({
  kind,
  state,
  setState,
}: {
  kind: PeriodicKind;
  state: {
    runAtDate?: string;
    runAtTime: string;
    time: string;
    weekdays: number[];
    anchorDate?: string;
    dayOfMonth: number;
    monthDay: { month: number; day: number };
  };
  setState: Record<string, (v: never) => void> & {
    setRunAtDate: (d?: string) => void;
    setRunAtTime: (t: string) => void;
    setTime: (t: string) => void;
    toggleWeekday: (n: number) => void;
    setAnchorDate: (d?: string) => void;
    setDayOfMonth: (d: number) => void;
    setMonthDay: (md: { month: number; day: number }) => void;
  };
}) {
  const { t } = useTranslation(["chat", "common"]);
  return (
    <div className="flex flex-wrap items-center gap-3">
      {kind === "once" && (
        <>
          <DatePicker
            value={toDate(state.runAtDate)}
            maxDate={MAX_PICKABLE}
            onChange={(d) => setState.setRunAtDate(toISODate(d))}
          />
          <Input
            type="time"
            className="w-28"
            value={state.runAtTime}
            onChange={(e) => setState.setRunAtTime(e.target.value)}
          />
        </>
      )}
      {(kind === "daily" ||
        kind === "weekly" ||
        kind === "biweekly" ||
        kind === "monthly" ||
        kind === "yearly") && (
        <Input
          type="time"
          aria-label={t("chat:automation.schedule.time")}
          className="w-28"
          value={state.time}
          onChange={(e) => setState.setTime(e.target.value)}
        />
      )}
      {(kind === "weekly" || kind === "biweekly") && (
        <div className="flex gap-1">
          {WEEKDAYS.map((n) => (
            <Button
              key={n}
              type="button"
              size="sm"
              variant={
                (
                  kind === "weekly"
                    ? state.weekdays.includes(n)
                    : state.weekdays[0] === n
                )
                  ? "default"
                  : "outline"
              }
              className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              onClick={() => setState.toggleWeekday(n)}
            >
              {t(`common:weekday.${n}`)}
            </Button>
          ))}
        </div>
      )}
      {kind === "biweekly" && (
        <DatePicker
          value={toDate(state.anchorDate)}
          maxDate={MAX_PICKABLE}
          onChange={(d) => setState.setAnchorDate(toISODate(d))}
        />
      )}
      {kind === "monthly" && (
        <Input
          type="number"
          min={1}
          max={31}
          className="w-20"
          value={state.dayOfMonth}
          onChange={(e) => setState.setDayOfMonth(Number(e.target.value))}
        />
      )}
      {kind === "yearly" && (
        <div className="flex items-center gap-1">
          <Input
            type="number"
            min={1}
            max={12}
            className="w-16"
            value={state.monthDay.month}
            onChange={(e) =>
              setState.setMonthDay({
                ...state.monthDay,
                month: Number(e.target.value),
              })
            }
          />
          <span className="text-muted-foreground">/</span>
          <Input
            type="number"
            min={1}
            max={31}
            className="w-16"
            value={state.monthDay.day}
            onChange={(e) =>
              setState.setMonthDay({
                ...state.monthDay,
                day: Number(e.target.value),
              })
            }
          />
        </div>
      )}
    </div>
  );
}

function IntervalFields({
  value,
  unit,
  weekdays,
  onChange,
  onToggleWeekday,
}: {
  value: number;
  unit: "minute" | "hour";
  weekdays: number[];
  onChange: (value: number, unit: "minute" | "hour") => void;
  onToggleWeekday: (n: number) => void;
}) {
  const { t } = useTranslation(["chat", "common"]);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Label className="w-20 shrink-0">
          {t("chat:automation.schedule.intervalValue")}
        </Label>
        <Input
          type="number"
          min={INTERVAL_MIN_MINUTES}
          className="w-24"
          value={value}
          onChange={(e) => onChange(Number(e.target.value) || 1, unit)}
        />
        <Select
          value={unit}
          onValueChange={(v) => onChange(value, v as "minute" | "hour")}
        >
          <SelectTrigger className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border border-border/50 rounded-lg shadow-lg">
            <SelectItem value="minute">
              {t("chat:automation.schedule.unitMinute")}
            </SelectItem>
            <SelectItem value="hour">
              {t("chat:automation.schedule.unitHour")}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <Label className="w-20 shrink-0">
          {t("chat:automation.schedule.intervalWeekdays")}
        </Label>
        <div className="flex gap-1">
          {WEEKDAYS.map((n) => (
            <Button
              key={n}
              type="button"
              size="sm"
              variant={weekdays.includes(n) ? "default" : "outline"}
              className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              onClick={() => onToggleWeekday(n)}
            >
              {t(`common:weekday.${n}`)}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ValidityFields({
  validity,
  onValidityChange,
}: {
  validity: { startAt?: string; endAt?: string };
  onValidityChange: (v: { startAt?: string; endAt?: string }) => void;
}) {
  const { t } = useTranslation(["chat"]);
  /** 初值从 validity 派生(编辑带自定义有效期时回显 DatePicker);挂载后
   * 显式记录用户选择——自定义模式下起止未选时 validity 为空,不能由
   * validity 反推显示值(否则回落长期有效) */
  const [mode, setMode] = useState<"longTerm" | "custom">(
    validity.startAt || validity.endAt ? "custom" : "longTerm",
  );
  const custom = mode === "custom";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Label className="w-20 shrink-0">
        {t("chat:automation.schedule.validity")}
      </Label>
      <Select
        value={custom ? "custom" : "longTerm"}
        onValueChange={(v) => {
          setMode(v as "longTerm" | "custom");
          onValidityChange(v === "custom" ? {} : {});
        }}
      >
        <SelectTrigger className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="border border-border/50 rounded-lg shadow-lg">
          <SelectItem value="longTerm">
            {t("chat:automation.schedule.validityLongTerm")}
          </SelectItem>
          <SelectItem value="custom">
            {t("chat:automation.schedule.validityCustom")}
          </SelectItem>
        </SelectContent>
      </Select>
      {custom && (
        <>
          <DatePicker
            value={toDate(validity.startAt?.slice(0, 10))}
            maxDate={MAX_PICKABLE}
            onChange={(d) =>
              onValidityChange({ ...validity, startAt: toISODate(d) })
            }
          />
          <span className="text-muted-foreground">→</span>
          <DatePicker
            value={toDate(validity.endAt?.slice(0, 10))}
            maxDate={MAX_PICKABLE}
            onChange={(d) =>
              onValidityChange({ ...validity, endAt: toISODate(d) })
            }
          />
        </>
      )}
    </div>
  );
}
