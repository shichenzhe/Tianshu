// src-react/domains/ai/automation/components/CreateTaskDialog.tsx
/**
 * 创建自动化任务 Modal(spec §5):名称/提示词输入卡
 * (TaskPromptInput:@引用/⚡技能/变量插入/模型选择)/参数预设/
 * 工作空间/SchedulePicker。表单状态/脏快照/校验/参数组装由
 * useTaskForm 承载(与任务详情页共用);模板复用同表单,
 * 初始值优先级 template > 空;任务编辑走任务详情页。
 * 项目预设(子系统 E):可选 project prop——传入时资产空间锁定为
 * project.workspaceId(禁选/不渲染候选/跳过 ["workspaces"] 查询),
 * projectId 经表单初值注入保存载荷;未传时各路径行为与 AI 模块
 * 原实现完全一致。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
import { AutomationApi, type TemplateRecord } from "../api/automation.api";
import { WorkspaceApi } from "@/domains/ai/api/workspace.api";
import { useTaskForm } from "../lib/use-task-form";
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
  template?: TemplateRecord;
  onSaved?: () => void;
  /** 项目预设(项目模块调用方传入):锁定资产空间并把 projectId 写入
   * 保存载荷(workspaceName 供锁定态显示);未传时行为零变化 */
  project?: { id: number; workspaceId: number; workspaceName: string };
  /** 预填(资料库「添加到任务」):open 时注入 name/prompt 初值,
   *  与 template 互斥使用(外部入口不带模板) */
  prefill?: { name: string; prompt: string };
}

export function CreateTaskDialog({
  open,
  onOpenChange,
  template,
  onSaved,
  project,
  prefill,
}: CreateTaskDialogProps) {
  const { t } = useTranslation(["chat"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: workspaces = [] } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => WorkspaceApi.list(),
    // 项目预设:空间已锁定,无需拉取候选列表
    enabled: open && !project,
  });

  const [saving, setSaving] = useState(false);
  const switchCountRef = useRef(0);

  const form = useTaskForm({
    template,
    // 源变化信号兼 SchedulePicker remount key:打开来源(模板/新建)
    // 或开合态变化时必变,关闭即重置,保证同一来源取消后重开也会
    // remount 回填已存配置
    resetKey: open
      ? prefill
        ? "prefill"
        : template
          ? `tpl-${template.slug}`
          : "new"
      : "closed",
    workspaces,
    project: project && { id: project.id, workspaceId: project.workspaceId },
  });
  const { values, patch } = form;

  /** 表单重置(来源切换/重开)时归零模式切换埋点计数 */
  useEffect(() => {
    switchCountRef.current = 0;
  }, [form.pickerKey]);

  /** 资料库「添加到任务」预填：reset 重置后注入（effect 晚于 render 内
   *  reset，保证不被覆盖；仅 open 首帧执行一次，patch 为稳定 setter） */
  useEffect(() => {
    if (open && prefill) {
      patch({ name: prefill.name, prompt: prefill.prompt });
    }
  }, [open, form.pickerKey, prefill]);

  const canSubmit = form.canSubmit && !saving;

  async function handleSubmit() {
    if (!canSubmit || !values.schedule) {
      return;
    }
    setSaving(true);
    try {
      const params = form.buildParams();
      await AutomationApi.create(params);
      void AutomationApi.stat({
        mode: values.schedule.mode,
        kind:
          values.schedule.mode === "periodic"
            ? values.schedule.kind
            : "interval",
        hasEndAt: Boolean(values.validity.endAt),
        tabSwitchCount: switchCountRef.current,
      });
      toast.success(t("chat:automation.toast.created"));
      await queryClient.invalidateQueries({
        queryKey: ["automation", "tasks"],
      });
      onSaved?.();
      onOpenChange(false);
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
          <DialogTitle>{t("chat:automation.create.titleCreate")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t("chat:automation.create.name")}</Label>
            <Input
              value={values.name}
              placeholder={t("chat:automation.create.namePlaceholder")}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <TaskPromptInput
              value={values.prompt}
              onChange={(prompt) => patch({ prompt })}
              workspaceId={values.workspaceId}
              modelId={values.modelId ?? undefined}
              onModelChange={(modelId) => patch({ modelId })}
              onOpenMcp={() => navigate("/module/ai/experts?tab=connectors")}
              placeholder={t("chat:automation.create.promptPlaceholder")}
            />
            {/* 弹框不暴露权限选择:落库恒为受限权限(default,写类运行时被拒),
                完全访问须保存后进任务详情页开启 */}
            <p className="text-xs text-destructive">
              {t("chat:automation.create.fullAccessWarn")}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>{t("chat:automation.create.workspace")}</Label>
            <Select
              value={
                values.workspaceId ? String(values.workspaceId) : undefined
              }
              onValueChange={(v) => patch({ workspaceId: Number(v) })}
              disabled={Boolean(project)}
            >
              <SelectTrigger aria-label={t("chat:automation.create.workspace")}>
                {/* 项目锁定:候选列表不渲染,选中项文本无处注入
                    (Radix 仅空值显 placeholder),以 children 直显
                    项目空间名;未锁定时 children 为 undefined,
                    仍由选中 SelectItemText 注入,行为不变 */}
                <SelectValue
                  placeholder={t("chat:automation.create.workspacePlaceholder")}
                >
                  {project?.workspaceName}
                </SelectValue>
              </SelectTrigger>
              {!project && (
                <SelectContent className="border border-border/50 rounded-lg shadow-lg">
                  {workspaces.map((w) => (
                    <SelectItem key={w.id} value={String(w.id)}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              )}
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
                    values.temperature === p.temperature ? "default" : "outline"
                  }
                  className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                  onClick={() => patch({ temperature: p.temperature })}
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
                  variant={values.missedPolicy === p ? "default" : "outline"}
                  className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                  onClick={() => patch({ missedPolicy: p })}
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
            key={form.pickerKey}
            value={values.schedule}
            onChange={(schedule) => patch({ schedule })}
            validity={values.validity}
            onValidityChange={(validity) => patch({ validity })}
            onModeSwitch={() => {
              switchCountRef.current += 1;
            }}
          />

          {form.validation !== "ok" && (
            <p className="text-sm text-destructive">
              {t(
                `chat:automation.schedule.err${form.validation[0].toUpperCase()}${form.validation.slice(1)}`,
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
