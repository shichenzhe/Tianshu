// src-react/domains/ai/automation/lib/task-form.ts
/**
 * 任务表单纯函数(弹窗/详情页共享):初值/脏检测/参数组装/可提交判定。
 * t 注入保持可测(不依赖 react-i18next);日期口径与原弹窗一致:
 * TaskRecord 的 ISO 串按本地时区 format 回显,DatePicker 的 yyyy-MM-dd
 * 串按本地零点解析(见 buildTaskParams)。项目预设(子系统 E):
 * source.project 锁定 template/空初值的空间与项目归属,buildTaskParams
 * 恒输出 projectId(null = 全局任务,未选项目的 AI 模块路径同值)。
 * Task 15:执行体扩展 prompt|graph + 事件触发草稿(eventJson 序列化与
 * 编辑回填,taskFinished 允许 targetId 暂缺由校验拦截提交)。
 */
import { format } from "date-fns";
import type {
  AccessMode,
  EventTriggerConfig,
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

/** 事件触发编辑草稿:taskFinished 允许 targetId 暂缺(目标必选校验
 * 拦截提交),补齐后与 EventTriggerConfig 结构等价(序列化见 toEventJson) */
export type EventTriggerDraft =
  | { source: "appStarted" }
  | {
      source: "taskFinished";
      targetType: "task" | "graph";
      targetId?: number;
      on: "success" | "failed" | "any";
    };

/** 执行体/事件触发校验码(错误文案展示用,"ok" 表示通过) */
export type TaskFormValidation =
  "ok" | "graphMissing" | "eventTargetMissing" | "eventSelfReference";

/** 任务表单值:弹窗与详情页共用的受控状态形状 */
export interface TaskFormValues {
  name: string;
  prompt: string;
  modelId: number | null;
  temperature: number;
  workspaceId: number | null;
  /** 所属项目 id(项目预设注入/任务回填);null = 全局任务 */
  projectId?: number | null;
  missedPolicy: "skip" | "catchUpOnce";
  schedule: ScheduleConfig | null;
  validity: { startAt?: string; endAt?: string };
  accessMode: AccessMode;
  templateSlug?: string;
  /** 执行体:prompt 单模型 | graph 编排(spec §7 弹窗扩展) */
  targetKind: "prompt" | "graph";
  /** targetKind=graph 时指向编排图;prompt 任务为 null */
  graphId: number | null;
  /** 事件触发配置(null=未配置;taskFinished 草稿目标未选不可提交) */
  eventTrigger: EventTriggerDraft | null;
}

const DEFAULT_SCHEDULE: ScheduleConfig = {
  mode: "periodic",
  kind: "daily",
  time: "09:00",
};

/** TaskRecord.eventJson → 编辑草稿(缺失/非法 JSON 回落 null,编辑态不炸) */
export function parseEventDraft(
  eventJson: string | null | undefined,
): EventTriggerDraft | null {
  if (!eventJson) {
    return null;
  }
  try {
    const raw = JSON.parse(eventJson) as Partial<EventTriggerConfig>;
    if (raw.source === "appStarted") {
      return { source: "appStarted" };
    }
    if (
      raw.source === "taskFinished" &&
      (raw.targetType === "task" || raw.targetType === "graph") &&
      typeof raw.targetId === "number" &&
      (raw.on === "success" || raw.on === "failed" || raw.on === "any")
    ) {
      return {
        source: "taskFinished",
        targetType: raw.targetType,
        targetId: raw.targetId,
        on: raw.on,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** 事件草稿 → eventJson 序列(null/目标未选 → undefined=不配置事件触发) */
export function toEventJson(
  draft: EventTriggerDraft | null,
): string | undefined {
  if (!draft || draft.source === "appStarted") {
    return draft ? JSON.stringify({ source: "appStarted" }) : undefined;
  }
  return draft.targetId
    ? JSON.stringify({
        source: "taskFinished",
        targetType: draft.targetType,
        targetId: draft.targetId,
        on: draft.on,
      })
    : undefined;
}

/**
 * 表单初值,优先级 task > template > 空(与弹窗原 open 初始化一致)。
 * task 日期为 UTC ISO(repo toISOString),validity 消费方按本地日期
 * slice(0,10) 解释,须 date-fns format 本地化回显,否则回显漂移一天
 * 且保存循环累积。project 预设仅作用于 template/空分支(锁定空间与
 * 项目归属);task 回填分支始终取任务自身字段,不受预设影响。
 */
export function buildInitialValues(
  source: {
    task?: TaskRecord;
    template?: TemplateRecord;
    /** 项目预设:template/空初值锁定 workspaceId/projectId */
    project?: { id: number; workspaceId: number };
  },
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
      projectId: e.projectId ?? null,
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
      targetKind: e.targetKind === "graph" ? "graph" : "prompt",
      graphId: e.graphId ?? null,
      eventTrigger: parseEventDraft(e.eventJson),
    };
  }
  const base: TaskFormValues = {
    name: "",
    prompt: "",
    modelId: null,
    temperature: 0.7,
    workspaceId: source.project?.workspaceId ?? null,
    projectId: source.project?.id ?? null,
    missedPolicy: "skip",
    schedule: DEFAULT_SCHEDULE,
    validity: {},
    accessMode: "default",
    targetKind: "prompt",
    graphId: null,
    eventTrigger: null,
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
    v.targetKind,
    v.graphId,
    v.eventTrigger,
  ]);
}

/** 表单值 → 创建/更新参数(弹窗提交与详情页保存共用) */
export function buildTaskParams(v: TaskFormValues, t: TFunc): TaskCreateParams {
  const schedule = v.schedule as ScheduleConfig;
  // graph 任务:模型在各节点,prompt 清空/modelId=0 占位并携带 graphId
  // (与后端 buildTaskData 同口径);prompt 任务不带 graphId(后端恒置 null)
  const graph = v.targetKind === "graph";
  return {
    name: v.name.trim(),
    prompt: graph ? "" : v.prompt,
    workspaceId: v.workspaceId!,
    // 项目归属(子系统 E):null = 全局任务;AI 模块路径未选项目时同值
    projectId: v.projectId ?? null,
    modelId: graph ? 0 : v.modelId!,
    temperature: v.temperature,
    targetKind: v.targetKind,
    graphId: graph ? v.graphId! : undefined,
    eventJson: toEventJson(v.eventTrigger),
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
 * 执行体/事件触发校验(spec §9 表单防呆):graph 任务 graphId 必选;
 * taskFinished 目标必选;自引用拦截——目标任务=编辑任务自身(新建无
 * id 恒过),目标图=本任务执行图(create/edit 同拦,与后端
 * assertNoSelfReference 同口径)。
 */
export function validateTaskForm(
  v: TaskFormValues,
  /** 编辑态任务 id(自引用拦截);新建缺省不拦任务自引用 */
  selfTaskId?: number,
): TaskFormValidation {
  if (v.targetKind === "graph" && !v.graphId) {
    return "graphMissing";
  }
  const ev = v.eventTrigger;
  if (!ev || ev.source === "appStarted") {
    return "ok";
  }
  if (!ev.targetId) {
    return "eventTargetMissing";
  }
  if (
    ev.targetType === "task" &&
    selfTaskId !== undefined &&
    ev.targetId === selfTaskId
  ) {
    return "eventSelfReference";
  }
  if (
    ev.targetType === "graph" &&
    v.targetKind === "graph" &&
    v.graphId !== null &&
    ev.targetId === v.graphId
  ) {
    return "eventSelfReference";
  }
  return "ok";
}

/**
 * 可提交判定:name 非空、执行体齐备(prompt 任务 prompt/模型已选,
 * graph 任务 graphId 已选)、空间已选、调度配置合法(scheduleSchema +
 * validateSchedule)、执行体/事件校验通过(validateTaskForm)。
 * startAtUnchanged:编辑未改开始日期视为维持原任务生命周期,跳过
 * 创建期防倒流校验(运行中任务已过 startAt,否则编辑任意字段都会
 * 被 errTimeInPast 卡死)。
 */
export function canSubmitForm(
  v: TaskFormValues,
  now: Date,
  startAtUnchanged: boolean,
  /** 编辑态任务 id(事件目标任务自引用拦截) */
  selfTaskId?: number,
): boolean {
  const parsed = scheduleSchema.safeParse(v.schedule);
  const validity = startAtUnchanged
    ? { ...v.validity, startAt: undefined }
    : v.validity;
  const targetOk =
    v.targetKind === "graph"
      ? Boolean(v.graphId)
      : Boolean(v.prompt.trim() && v.modelId);
  return Boolean(
    v.name.trim() &&
    targetOk &&
    v.workspaceId &&
    parsed.success &&
    validateSchedule(parsed.success ? v.schedule : null, validity, now) ===
      "ok" &&
    validateTaskForm(v, selfTaskId) === "ok",
  );
}
