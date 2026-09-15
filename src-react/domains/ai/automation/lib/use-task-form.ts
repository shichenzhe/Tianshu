// src-react/domains/ai/automation/lib/use-task-form.ts
/**
 * useTaskForm:TaskFormValues 的受控状态 + 脏检测快照 + 工作空间默认
 * 模型联动(从 CreateTaskDialog 抽出,弹窗与任务详情页共用)。
 * resetKey 为源变化信号(弹窗 open 派生 key 或路由 id),变化时重置
 * 表单值、脏快照与 pickerKey;纯逻辑见同目录 task-form.ts。
 * 项目预设(子系统 E):source.project 透传 buildInitialValues,锁定
 * template/空初值的空间与项目归属(锁定空间不在 workspaces 列表内,
 * 默认模型联动对其查无命中,不预填模型)。
 */
import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type {
  TaskCreateParams,
  TaskRecord,
  TemplateRecord,
} from "../api/automation.api";
import { scheduleSchema } from "../api/schedule.schema";
import type { WorkspaceRecord } from "../../api/workspace.api";
import { validateSchedule, type ScheduleValidation } from "./schedule-text";
import {
  buildInitialValues,
  buildTaskParams,
  canSubmitForm,
  serializeForm,
  type TFunc,
  type TaskFormValues,
} from "./task-form";

/** useTaskForm 入参:表单源(task > template 优先)+ 重置信号 + 空间列表 */
export interface TaskFormSource {
  task?: TaskRecord;
  template?: TemplateRecord;
  /** 项目预设:锁定 template/空初值的空间与项目归属(弹窗项目模块传入) */
  project?: { id: number; workspaceId: number };
  /** 源变化信号(弹窗 open 派生 key 或路由 id):变化时重置表单与脏快照 */
  resetKey: string | number;
  workspaces: WorkspaceRecord[];
}

export interface UseTaskFormResult {
  values: TaskFormValues;
  setValues: Dispatch<SetStateAction<TaskFormValues>>;
  /** 单/多字段合并更新 */
  patch: (p: Partial<TaskFormValues>) => void;
  /** 表单是否偏离最近一次重置(或 resetSnapshot)的基线 */
  isDirty: boolean;
  /** canSubmitForm 结果(不含调用方自身的 saving 等外部态) */
  canSubmit: boolean;
  /** 调度校验错误码(错误文案展示用,"ok" 表示通过) */
  validation: ScheduleValidation;
  /** 组装创建/更新参数 */
  buildParams: () => TaskCreateParams;
  /** 保存成功后把当前值登记为干净基线 */
  resetSnapshot: () => void;
  /** SchedulePicker remount key(与表单值同批重置,保证回填惰性初值正确) */
  pickerKey: string;
  t: TFunc;
}

export function useTaskForm(source: TaskFormSource): UseTaskFormResult {
  const { t } = useTranslation(["chat"]);
  const [values, setValues] = useState<TaskFormValues>(() =>
    buildInitialValues({}, t),
  );
  const [pickerKey, setPickerKey] = useState("");
  /** 脏检测基线:与初始 values 同源初始化,避免 reset effect 落地前
   * 首帧 isDirty 误报为 true(详情页保存按钮/离开确认消费该值) */
  const snapshotRef = useRef(serializeForm(values));
  /** 最近一次重置时的 startAt(本地化 yyyy-MM-dd):编辑未改则免防倒流校验 */
  const initialStartAtRef = useRef<string | undefined>(undefined);

  const reset = (src: TaskFormSource) => {
    const next = buildInitialValues(
      {
        task: src.task,
        template: src.template,
        project: src.project,
      },
      t,
    );
    setValues(next);
    // 与 values 同批更新,避免 SchedulePicker 以新 key 挂载却读到旧表单值
    setPickerKey(String(src.resetKey));
    snapshotRef.current = serializeForm(next);
    initialStartAtRef.current = src.task ? next.validity.startAt : undefined;
  };
  useEffect(() => {
    // 仅依赖 resetKey(源变化信号),取当次渲染的 source/t 重置
    reset(source);
  }, [source.resetKey]);

  // 工作空间默认模型联动(迁移自弹窗):选中空间且模型未选时预填
  useEffect(() => {
    if (values.workspaceId) {
      const ws = source.workspaces.find((w) => w.id === values.workspaceId);
      if (ws?.defaultModelId) {
        setValues((prev) =>
          prev.modelId ? prev : { ...prev, modelId: ws.defaultModelId! },
        );
      }
    }
  }, [values.workspaceId, source.workspaces]);

  // 编辑未改 startAt 视为维持原任务生命周期,不适用创建期防倒流校验
  // (运行中任务已过 startAt,否则编辑任意字段都会被 errTimeInPast 卡死)
  const startAtUnchanged =
    Boolean(source.task) &&
    values.validity.startAt === initialStartAtRef.current;
  const now = new Date();
  const parsed = scheduleSchema.safeParse(values.schedule);
  const validity = startAtUnchanged
    ? { ...values.validity, startAt: undefined }
    : values.validity;
  const validation = validateSchedule(
    parsed.success ? values.schedule : null,
    validity,
    now,
  );

  return {
    values,
    setValues,
    patch: (p) => setValues((prev) => ({ ...prev, ...p })),
    isDirty: serializeForm(values) !== snapshotRef.current,
    canSubmit: canSubmitForm(values, now, startAtUnchanged),
    validation,
    buildParams: () => buildTaskParams(values, t),
    resetSnapshot: () => {
      snapshotRef.current = serializeForm(values);
    },
    pickerKey,
    t,
  };
}
