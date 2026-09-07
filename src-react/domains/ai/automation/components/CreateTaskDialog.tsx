// src-react/domains/ai/automation/components/CreateTaskDialog.tsx
/**
 * 创建/编辑自动化任务 Modal(spec §5):名称/提示词输入卡
 * (TaskPromptInput:@引用/⚡技能/变量插入/模型选择)/参数预设/
 * 工作空间/SchedulePicker。模板与编辑复用同表单,
 * 初始值优先级 editTask > template > 空。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AutomationApi,
  type TaskRecord,
  type TemplateRecord,
} from "../api/automation.api";
import { WorkspaceApi } from "@/domains/ai/api/workspace.api";
import { camelSlug } from "../lib/camel-slug";
import { scheduleSchema, type ScheduleConfig } from "../api/schedule.schema";
import {
  describeSchedule,
  describeValidity,
  validateSchedule,
} from "../lib/schedule-text";
import { SchedulePicker } from "./SchedulePicker";
import TaskPromptInput from "./TaskPromptInput";

const PARAM_PRESETS = [
  { key: "precise", temperature: 0.2 },
  { key: "balanced", temperature: 0.7 },
  { key: "creative", temperature: 1.0 },
] as const;

export interface CreateTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editTask?: TaskRecord;
  template?: TemplateRecord;
  onSaved?: () => void;
}

export function CreateTaskDialog({
  open,
  onOpenChange,
  editTask,
  template,
  onSaved,
}: CreateTaskDialogProps) {
  const { t } = useTranslation(["chat"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: workspaces = [] } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => WorkspaceApi.list(),
    enabled: open,
  });

  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState<number | null>(null);
  const [temperature, setTemperature] = useState(0.7);
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [missedPolicy, setMissedPolicy] = useState<"skip" | "catchUpOnce">(
    "skip",
  );
  const [schedule, setSchedule] = useState<ScheduleConfig | null>(null);
  const [validity, setValidity] = useState<{
    startAt?: string;
    endAt?: string;
  }>({});
  /** SchedulePicker remount key:打开来源(编辑任务/模板/新建)变化或
   * 重开时必变,让内部表单字段的惰性初值从新 value 重新派生(编辑回填) */
  const [pickerKey, setPickerKey] = useState("new");
  const [saving, setSaving] = useState(false);
  const switchCountRef = useRef(0);
  const initialStartAtRef = useRef<string | undefined>(undefined);

  /** open 时按 editTask > template 初始化 */
  useEffect(() => {
    if (!open) {
      // 关闭即重置 key,保证同一来源取消后重开也会 remount 回填已存配置
      setPickerKey("closed");
      return;
    }
    switchCountRef.current = 0;
    if (editTask) {
      setPickerKey(`task-${editTask.id}`);
      setName(editTask.name);
      setPrompt(editTask.prompt);
      setModelId(editTask.modelId);
      setTemperature(editTask.temperature ?? 0.7);
      setWorkspaceId(editTask.workspaceId);
      setMissedPolicy(editTask.missedPolicy);
      setSchedule(JSON.parse(editTask.scheduleJson) as ScheduleConfig);
      // editTask 日期为 UTC ISO(repo toISOString),validity 消费方按本地日期
      // slice(0,10) 解释,须 date-fns format 本地化回显,否则回显漂移一天且保存循环累积
      const startAt = editTask.startAt
        ? format(new Date(editTask.startAt), "yyyy-MM-dd")
        : undefined;
      initialStartAtRef.current = startAt;
      setValidity({
        startAt,
        endAt: editTask.endAt
          ? format(new Date(editTask.endAt), "yyyy-MM-dd")
          : undefined,
      });
      return;
    }
    initialStartAtRef.current = undefined;
    // 模板/新建无有效期概念,清空防上一编辑会话的有效期泄漏(保存带出脏数据)
    setValidity({});
    if (template) {
      setPickerKey(`tpl-${template.slug}`);
      setName(
        t(`chat:automation.templateData.${camelSlug(template.slug)}.title`),
      );
      setPrompt(template.prompt);
      setTemperature(template.temperature);
      setSchedule(JSON.parse(template.scheduleJson) as ScheduleConfig);
    } else {
      setPickerKey("new");
      setSchedule({ mode: "periodic", kind: "daily", time: "09:00" });
    }
  }, [open, editTask, template, t]);

  /** 工作空间默认模型联动 */
  useEffect(() => {
    if (workspaceId) {
      const ws = workspaces.find((w) => w.id === workspaceId);
      if (ws?.defaultModelId) {
        setModelId((prev) => prev ?? ws.defaultModelId!);
      }
    }
  }, [workspaceId, workspaces]);

  const parsed = scheduleSchema.safeParse(schedule);
  // 编辑未改动 startAt 视为维持原任务生命周期,不适用创建期防倒流校验
  // (运行中任务已过 startAt,否则编辑任意字段都会被 errTimeInPast 卡死)
  const startAtUnchanged =
    Boolean(editTask) && validity.startAt === initialStartAtRef.current;
  const validation = validateSchedule(
    parsed.success ? schedule : null,
    startAtUnchanged ? { ...validity, startAt: undefined } : validity,
    new Date(),
  );
  const canSubmit = Boolean(
    name.trim() &&
    prompt.trim() &&
    modelId &&
    workspaceId &&
    parsed.success &&
    validation === "ok" &&
    !saving,
  );

  async function handleSubmit() {
    if (!canSubmit || !schedule || !modelId || !workspaceId) {
      return;
    }
    setSaving(true);
    try {
      const params = {
        name: name.trim(),
        prompt,
        workspaceId,
        modelId,
        temperature,
        schedule: schedule as ScheduleConfig,
        scheduleText: `${describeSchedule(schedule, t)} · ${describeValidity(validity, t)}`,
        // DatePicker 日期串按本地零点解析(new Date("YYYY-MM-DD") 会按 UTC 解析,
        // 时区错位导致「当天开始」被误判过期)
        startAt: validity.startAt
          ? new Date(`${validity.startAt.slice(0, 10)}T00:00:00`).toISOString()
          : undefined,
        endAt: validity.endAt
          ? new Date(`${validity.endAt.slice(0, 10)}T23:59:59`).toISOString()
          : undefined,
        missedPolicy,
        templateSlug: editTask?.templateSlug ?? template?.slug,
      };
      const saved = editTask
        ? await AutomationApi.update(editTask.id, params)
        : await AutomationApi.create(params);
      if (!editTask) {
        void AutomationApi.stat({
          mode: schedule.mode,
          kind: schedule.mode === "periodic" ? schedule.kind : "interval",
          hasEndAt: Boolean(validity.endAt),
          tabSwitchCount: switchCountRef.current,
        });
      }
      toast.success(
        t(
          editTask
            ? "chat:automation.toast.updated"
            : "chat:automation.toast.created",
        ),
      );
      await queryClient.invalidateQueries({
        queryKey: ["automation", "tasks"],
      });
      onSaved?.();
      onOpenChange(false);
      void saved;
    } catch (e) {
      toast.error(
        t("chat:automation.toast.loadFailed", {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto border border-border/50 rounded-lg shadow-lg">
        <DialogHeader>
          <DialogTitle>
            {t(
              editTask
                ? "chat:automation.create.titleEdit"
                : "chat:automation.create.titleCreate",
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t("chat:automation.create.name")}</Label>
            <Input
              value={name}
              placeholder={t("chat:automation.create.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <TaskPromptInput
              value={prompt}
              onChange={setPrompt}
              workspaceId={workspaceId}
              modelId={modelId ?? undefined}
              onModelChange={setModelId}
              onOpenMcp={() => navigate("/module/ai/experts?tab=connectors")}
              placeholder={t("chat:automation.create.promptPlaceholder")}
            />
            {/* 权限胶囊恒为完全访问(FullAccessModal 不可达),警示语义需可见入口 */}
            <p className="text-xs text-red-500">
              {t("chat:automation.create.fullAccessWarn")}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>{t("chat:automation.create.workspace")}</Label>
            <Select
              value={workspaceId ? String(workspaceId) : undefined}
              onValueChange={(v) => setWorkspaceId(Number(v))}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={t("chat:automation.create.workspacePlaceholder")}
                />
              </SelectTrigger>
              <SelectContent className="border border-border/50 rounded-lg shadow-lg">
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={String(w.id)}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <Label className="w-20 shrink-0">
              {t("chat:automation.create.param")}
            </Label>
            <div className="flex gap-1">
              {PARAM_PRESETS.map((p) => (
                <Button
                  key={p.key}
                  type="button"
                  size="sm"
                  variant={
                    temperature === p.temperature ? "default" : "outline"
                  }
                  className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                  onClick={() => setTemperature(p.temperature)}
                >
                  {t(
                    `chat:automation.create.param${p.key[0].toUpperCase()}${p.key.slice(1)}`,
                  )}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Label className="w-20 shrink-0">
              {t("chat:automation.create.missedPolicy")}
            </Label>
            <div className="flex gap-1">
              {(["skip", "catchUpOnce"] as const).map((p) => (
                <Button
                  key={p}
                  type="button"
                  size="sm"
                  variant={missedPolicy === p ? "default" : "outline"}
                  className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                  onClick={() => setMissedPolicy(p)}
                >
                  {t(
                    p === "skip"
                      ? "chat:automation.create.missedSkip"
                      : "chat:automation.create.missedCatchUp",
                  )}
                </Button>
              ))}
            </div>
          </div>

          <SchedulePicker
            key={pickerKey}
            value={schedule}
            onChange={setSchedule}
            validity={validity}
            onValidityChange={setValidity}
            onModeSwitch={() => {
              switchCountRef.current += 1;
            }}
          />

          {validation !== "ok" && (
            <p className="text-sm text-red-500">
              {t(
                `chat:automation.schedule.err${validation[0].toUpperCase()}${validation.slice(1)}`,
              )}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common:cancel")}
          </Button>
          <Button disabled={!canSubmit} onClick={handleSubmit}>
            {t("common:confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
