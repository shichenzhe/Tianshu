// src-react/domains/ai/automation/lib/task-form.ts
/**
 * 任务表单纯函数(弹窗/详情页共享):初值/脏检测/参数组装/可提交判定。
 * t 注入保持可测(不依赖 react-i18next);日期口径与原弹窗一致:
 * TaskRecord 的 ISO 串按本地时区 format 回显,DatePicker 的 yyyy-MM-dd
 * 串按本地零点解析(见 buildTaskParams)。
 */
import { format } from "date-fns";
import type {
  AccessMode,
  TaskCreateParams,
  TaskRecord,
  TemplateRecord,
} from "../api/automation.api";
import { scheduleSchema, type ScheduleConfig } from "../api/schedule.schema";
import { camelSlug } from "./camel-slug";
import {
  describeSchedule,
  describeValidity,
  validateSchedule,
} from "./schedule-text";

/** i18n t 函数形状(与 schedule-text.ts 一致) */
export type TFunc = (key: string, opts?: Record<string, unknown>) => string;

/** 任务表单值:弹窗与详情页共用的受控状态形状 */
export interface TaskFormValues {
  name: string;
  prompt: string;
  modelId: number | null;
  temperature: number;
  workspaceId: number | null;
  missedPolicy: "skip" | "catchUpOnce";
  schedule: ScheduleConfig | null;
  validity: { startAt?: string; endAt?: string };
  accessMode: AccessMode;
  templateSlug?: string;
}

const DEFAULT_SCHEDULE: ScheduleConfig = {
  mode: "periodic",
  kind: "daily",
  time: "09:00",
};

/**
 * 表单初值,优先级 task > template > 空(与弹窗原 open 初始化一致)。
 * task 日期为 UTC ISO(repo toISOString),validity 消费方按本地日期
 * slice(0,10) 解释,须 date-fns format 本地化回显,否则回显漂移一天
 * 且保存循环累积。
 */
export function buildInitialValues(
  source: { task?: TaskRecord; template?: TemplateRecord },
  t: TFunc,
): TaskFormValues {
  if (source.task) {
    const e = source.task;
    return {
      name: e.name,
      prompt: e.prompt,
      modelId: e.modelId,
      temperature: e.temperature ?? 0.7,
      workspaceId: e.workspaceId,
      missedPolicy: e.missedPolicy,
      schedule: JSON.parse(e.scheduleJson) as ScheduleConfig,
      validity: {
        startAt: e.startAt
          ? format(new Date(e.startAt), "yyyy-MM-dd")
          : undefined,
        endAt: e.endAt ? format(new Date(e.endAt), "yyyy-MM-dd") : undefined,
      },
      accessMode: e.accessMode,
      templateSlug: e.templateSlug,
    };
  }
  const base: TaskFormValues = {
    name: "",
    prompt: "",
    modelId: null,
    temperature: 0.7,
    workspaceId: null,
    missedPolicy: "skip",
    schedule: DEFAULT_SCHEDULE,
    validity: {},
    accessMode: "default",
  };
  if (source.template) {
    return {
      ...base,
      name: t(
        `chat:automation.templateData.${camelSlug(source.template.slug)}.title`,
      ),
      prompt: source.template.prompt,
      temperature: source.template.temperature,
      schedule: JSON.parse(source.template.scheduleJson) as ScheduleConfig,
      templateSlug: source.template.slug,
    };
  }
  return base;
}

/** 表单快照串(脏检测依据):相同值同串,任一字段变化必变串 */
export function serializeForm(v: TaskFormValues): string {
  return JSON.stringify([
    v.name.trim(),
    v.prompt,
    v.modelId,
    v.temperature,
    v.workspaceId,
    v.missedPolicy,
    v.schedule,
    v.validity,
    v.accessMode,
    v.templateSlug,
  ]);
}

/** 表单值 → 创建/更新参数(弹窗提交与详情页保存共用) */
export function buildTaskParams(v: TaskFormValues, t: TFunc): TaskCreateParams {
  const schedule = v.schedule as ScheduleConfig;
  return {
    name: v.name.trim(),
    prompt: v.prompt,
    workspaceId: v.workspaceId!,
    modelId: v.modelId!,
    temperature: v.temperature,
    schedule,
    scheduleText: `${describeSchedule(schedule, t)} · ${describeValidity(
      v.validity,
      t,
    )}`,
    // DatePicker 日期串按本地零点解析(new Date("YYYY-MM-DD") 会按 UTC
    // 解析,时区错位导致「当天开始」被误判过期)
    startAt: v.validity.startAt
      ? new Date(`${v.validity.startAt.slice(0, 10)}T00:00:00`).toISOString()
      : undefined,
    endAt: v.validity.endAt
      ? new Date(`${v.validity.endAt.slice(0, 10)}T23:59:59`).toISOString()
      : undefined,
    missedPolicy: v.missedPolicy,
    accessMode: v.accessMode,
    templateSlug: v.templateSlug,
  };
}

/**
 * 可提交判定:name/prompt trim 非空、模型/空间已选、调度配置合法
 * (scheduleSchema + validateSchedule)。startAtUnchanged:编辑未改开始
 * 日期视为维持原任务生命周期,跳过创建期防倒流校验(运行中任务已过
 * startAt,否则编辑任意字段都会被 errTimeInPast 卡死)。
 */
export function canSubmitForm(
  v: TaskFormValues,
  now: Date,
  startAtUnchanged: boolean,
): boolean {
  const parsed = scheduleSchema.safeParse(v.schedule);
  const validity = startAtUnchanged
    ? { ...v.validity, startAt: undefined }
    : v.validity;
  return Boolean(
    v.name.trim() &&
    v.prompt.trim() &&
    v.modelId &&
    v.workspaceId &&
    parsed.success &&
    validateSchedule(parsed.success ? v.schedule : null, validity, now) ===
      "ok",
  );
}
