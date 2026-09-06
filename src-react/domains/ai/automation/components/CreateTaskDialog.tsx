// src-react/domains/ai/automation/components/CreateTaskDialog.tsx
/**
 * 创建/编辑自动化任务 Modal(spec §5):名称/prompt(变量插入)/模型+参数
 * 预设/工作空间/完全访问警示/SchedulePicker。模板与编辑复用同表单,
 * 初始值优先级 editTask > template > 空。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { ModelApi } from "@/domains/ai/api/model.api";
import { WorkspaceApi } from "@/domains/ai/api/workspace.api";
import { camelSlug } from "../lib/camel-slug";
import { scheduleSchema, type ScheduleConfig } from "../api/schedule.schema";
import {
  describeSchedule,
  describeValidity,
  validateSchedule,
} from "../lib/schedule-text";
import { SchedulePicker } from "./SchedulePicker";

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
  const queryClient = useQueryClient();
  const { data: models = [] } = useQuery({
    queryKey: ["models", "all"],
    queryFn: () => ModelApi.listAll(),
    enabled: open,
  });
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
  const [saving, setSaving] = useState(false);
  const switchCountRef = useRef(0);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  /** open 时按 editTask > template 初始化 */
  useEffect(() => {
    if (!open) {
      return;
    }
    switchCountRef.current = 0;
    if (editTask) {
      setName(editTask.name);
      setPrompt(editTask.prompt);
      setModelId(editTask.modelId);
      setTemperature(editTask.temperature ?? 0.7);
      setWorkspaceId(editTask.workspaceId);
      setMissedPolicy(editTask.missedPolicy);
      setSchedule(JSON.parse(editTask.scheduleJson) as ScheduleConfig);
      setValidity({
        startAt: editTask.startAt,
        endAt: editTask.endAt,
      });
      return;
    }
    if (template) {
      setName(
        t(`chat:automation.templateData.${camelSlug(template.slug)}.title`),
      );
      setPrompt(template.prompt);
      setTemperature(template.temperature);
      setSchedule(JSON.parse(template.scheduleJson) as ScheduleConfig);
    } else {
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
  const validation = validateSchedule(
    parsed.success ? schedule : null,
    validity,
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
        templateSlug: template?.slug,
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

  /** 变量插入到光标处 */
  function insertVariable(token: string) {
    const el = promptRef.current;
    if (!el) {
      setPrompt((p) => p + token);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    setPrompt(`${prompt.slice(0, start)}${token}${prompt.slice(end)}`);
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
            <div className="flex items-center justify-between">
              <Label>{t("chat:automation.create.prompt")}</Label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 hover:bg-primary-subtle hover:text-primary"
                  >
                    {t("chat:automation.create.insertVariable")}
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="border border-border/50 rounded-lg shadow-lg"
                >
                  {(["Date", "Weekday", "Time"] as const).map((v) => (
                    <DropdownMenuItem
                      key={v}
                      onClick={() => insertVariable(`{{${v.toLowerCase()}}}`)}
                    >
                      {t(`chat:automation.create.var${v}`, {
                        [v.toLowerCase()]: `{{${v.toLowerCase()}}}`,
                      })}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <Textarea
              ref={promptRef}
              rows={5}
              value={prompt}
              placeholder={t("chat:automation.create.promptPlaceholder")}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("chat:automation.create.workspace")}</Label>
              <Select
                value={workspaceId ? String(workspaceId) : undefined}
                onValueChange={(v) => setWorkspaceId(Number(v))}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={t(
                      "chat:automation.create.workspacePlaceholder",
                    )}
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
            <div className="space-y-1.5">
              <Label>{t("chat:automation.create.model")}</Label>
              <Select
                value={modelId ? String(modelId) : undefined}
                onValueChange={(v) => setModelId(Number(v))}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={t("chat:automation.create.modelPlaceholder")}
                  />
                </SelectTrigger>
                <SelectContent className="border border-border/50 rounded-lg shadow-lg max-h-48">
                  {models.map((m) => (
                    <SelectItem key={m.id} value={String(m.id)}>
                      {m.name || m.modelId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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

          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 dark:bg-red-950/30 p-2 text-sm text-red-600 dark:text-red-400">
            <TriangleAlert className="h-4 w-4 shrink-0 mt-0.5" />
            {t("chat:automation.create.fullAccessWarn")}
          </div>
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
