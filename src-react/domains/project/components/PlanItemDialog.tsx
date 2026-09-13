/**
 * 计划事项弹窗（新建/编辑共用，spec §6）：
 * 标题（必填 trim ≤100，空标题禁用提交、超长实时提示）/ 状态四态 Select /
 * 优先级 Select + Badge 预览（P0 destructive / P1 primary / P2 muted）/
 * 标签（Input 回车添加 → 可移除 Tag + planItems 缓存聚合的候选 chips 点击追加）/
 * 处理人只读「我」/ 自定义字段动态区（text=Input、number=Input[type=number]、
 * date=Input[type=date]；仅项目任务渲染，本地任务 projectId=null 无该区）。
 * 保存：新建 → create（customFields 仅保留值非空键）、编辑 → update（全量字段）
 * → invalidate planItems + planItemsMine 双 key → toast(plan:saved) + onSaved +
 * 关闭；失败 toast mapIpcError 且弹窗保留。
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import { useUserStore } from "@/domains/user/store/user.store";
import PlanItemApi, {
  PLAN_FIELDS_KEY,
  PLAN_ITEMS_KEY,
  PLAN_ITEMS_MINE_KEY,
} from "../api/plan-item.api";
import RemovableTag from "./RemovableTag";
import type {
  PlanItemRecord,
  PlanPriority,
  PlanStatus,
} from "../../../../electron/domains/project/plan-item.entity";

interface PlanItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 所属项目 id；null = 本地任务（仅任务 Tab，无自定义字段区） */
  projectId: number | null;
  /** 编辑目标；缺省 = 新建 */
  item?: PlanItemRecord;
  /** 保存成功回调（父级刷新列表） */
  onSaved: () => void;
}

/** 本地任务（projectId null）不参与项目级缓存：-1 永不与真实自增 id 碰撞 */
const NO_PROJECT_CACHE_KEY = -1;

const TITLE_MAX_LENGTH = 100;

export const STATUS_OPTIONS: PlanStatus[] = [
  "not_started",
  "in_progress",
  "paused",
  "done",
];
export const STATUS_LABEL_KEYS: Record<PlanStatus, string> = {
  not_started: "project:plan.statusNotStarted",
  in_progress: "project:plan.statusInProgress",
  paused: "project:plan.statusPaused",
  done: "project:plan.statusDone",
};

export const PRIORITY_OPTIONS: PlanPriority[] = ["P0", "P1", "P2"];
export const PRIORITY_LABEL_KEYS: Record<PlanPriority, string> = {
  P0: "project:plan.priorityP0",
  P1: "project:plan.priorityP1",
  P2: "project:plan.priorityP2",
};
/** 优先级徽章配色：P0 警示 / P1 主题色 / P2 弱化 */
export const PRIORITY_BADGE_VARIANTS: Record<
  PlanPriority,
  "destructive" | "default" | "secondary"
> = {
  P0: "destructive",
  P1: "default",
  P2: "secondary",
};

export default function PlanItemDialog({
  open,
  onOpenChange,
  projectId,
  item,
  onSaved,
}: PlanItemDialogProps) {
  const { t } = useTranslation(["project", "common"]);
  const queryClient = useQueryClient();
  const user = useUserStore((state) => state.user);
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [status, setStatus] = useState<PlanStatus>("not_started");
  const [priority, setPriority] = useState<PlanPriority>("P1");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [customFields, setCustomFields] = useState<
    Record<string, string | number>
  >({});
  const [saving, setSaving] = useState(false);

  // 打开时重置/回填：新建取缺省值，编辑回填 item 全字段
  useEffect(() => {
    if (!open) {
      return;
    }
    setTitle(item?.title ?? "");
    setTitleTouched(false);
    setStatus(item?.status ?? "not_started");
    setPriority(item?.priority ?? "P1");
    setTags(item?.tags ? [...item.tags] : []);
    setTagInput("");
    setCustomFields(item ? { ...item.customFields } : {});
    setSaving(false);
  }, [open, item]);

  // 候选标签：只消费计划 Tab 已有 planItems 缓存（enabled false 不主动拉取）
  const { data: projectItems = [] } = useQuery({
    queryKey: PLAN_ITEMS_KEY(projectId ?? NO_PROJECT_CACHE_KEY),
    queryFn: () => PlanItemApi.list(projectId ?? NO_PROJECT_CACHE_KEY),
    enabled: false,
  });
  const candidateTags = useMemo(() => {
    const seen = new Set<string>();
    projectItems.forEach((entry) => entry.tags.forEach((tag) => seen.add(tag)));
    return [...seen].sort();
  }, [projectItems]);
  // 已选中标签不再出现在候选区
  const selectableTags = candidateTags.filter((tag) => !tags.includes(tag));

  // 自定义字段定义：仅项目任务且弹窗打开时拉取
  const { data: fieldDefs = [] } = useQuery({
    queryKey: PLAN_FIELDS_KEY(projectId ?? NO_PROJECT_CACHE_KEY),
    queryFn: () => PlanItemApi.listFields(projectId ?? NO_PROJECT_CACHE_KEY),
    enabled: open && projectId !== null,
  });

  const trimmedTitle = title.trim();
  // 超长实时提示；空标题 blur 后提示（提交按钮本身已按空标题禁用）
  const titleError =
    trimmedTitle.length > TITLE_MAX_LENGTH
      ? t("project:plan.titleTooLong")
      : titleTouched && !trimmedTitle
        ? t("project:plan.titleRequired")
        : null;
  const canSubmit =
    trimmedTitle !== "" && trimmedTitle.length <= TITLE_MAX_LENGTH && !saving;

  const addTag = (raw: string) => {
    const tag = raw.trim();
    if (!tag || tags.includes(tag)) {
      return;
    }
    setTags((prev) => [...prev, tag]);
    setTagInput("");
  };

  const handleTagKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    addTag(tagInput);
  };

  const handleCustomFieldChange = (name: string, value: string) => {
    setCustomFields((prev) => ({ ...prev, [name]: value }));
  };

  /** 组装自定义字段载荷：仅保留定义内且值非空的键；number 型转数字 */
  const buildCustomFields = (): Record<string, string | number> => {
    const values: Record<string, string | number> = {};
    fieldDefs.forEach((def) => {
      const raw = String(customFields[def.name] ?? "").trim();
      if (raw) {
        values[def.name] = def.type === "number" ? Number(raw) : raw;
      }
    });
    return values;
  };

  const invalidatePlanCaches = async () => {
    if (projectId !== null) {
      await queryClient.invalidateQueries({
        queryKey: PLAN_ITEMS_KEY(projectId),
      });
    }
    await queryClient.invalidateQueries({
      queryKey: PLAN_ITEMS_MINE_KEY(user.id),
    });
  };

  const handleSave = async () => {
    if (!canSubmit) {
      return;
    }
    setSaving(true);
    try {
      const customFieldValues = buildCustomFields();
      if (item) {
        await PlanItemApi.update({
          id: item.id,
          title: trimmedTitle,
          status,
          priority,
          tags,
          customFields: customFieldValues,
        });
      } else {
        await PlanItemApi.create({
          createdById: user.id,
          projectId: projectId ?? undefined,
          title: trimmedTitle,
          status,
          priority,
          tags,
          customFields:
            Object.keys(customFieldValues).length > 0
              ? customFieldValues
              : undefined,
        });
      }
      await invalidatePlanCaches();
      toast.success(t("project:plan.saved"));
      onSaved();
      onOpenChange(false);
    } catch (error) {
      toast.error(mapIpcError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[85vh] overflow-y-auto rounded-lg border-border/50 shadow-lg sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>
            {item ? t("project:plan.edit") : t("project:plan.add")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="plan-item-title">{t("project:plan.title")}</Label>
            <Input
              id="plan-item-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => setTitleTouched(true)}
              aria-invalid={titleError !== null}
            />
            {titleError && (
              <p className="text-xs text-destructive">{titleError}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("project:plan.status")}</Label>
              <Select
                value={status}
                onValueChange={(value) => setStatus(value as PlanStatus)}
              >
                <SelectTrigger aria-label={t("project:plan.status")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(STATUS_LABEL_KEYS[option])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("project:plan.priority")}</Label>
              <div className="flex items-center gap-2">
                <Select
                  value={priority}
                  onValueChange={(value) => setPriority(value as PlanPriority)}
                >
                  <SelectTrigger
                    aria-label={t("project:plan.priority")}
                    className="flex-1"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORITY_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {t(PRIORITY_LABEL_KEYS[option])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* 选中优先级徽章预览：P0 红 / P1 主题色 / P2 灰 */}
                <Badge variant={PRIORITY_BADGE_VARIANTS[priority]}>
                  {t(PRIORITY_LABEL_KEYS[priority])}
                </Badge>
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="plan-item-tags">{t("project:plan.tags")}</Label>
            <Input
              id="plan-item-tags"
              value={tagInput}
              onChange={(event) => setTagInput(event.target.value)}
              onKeyDown={handleTagKeyDown}
              placeholder={t("project:plan.tagPlaceholder")}
            />
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {tags.map((tag) => (
                  <RemovableTag
                    key={tag}
                    name={tag}
                    onRemove={() =>
                      setTags((prev) => prev.filter((entry) => entry !== tag))
                    }
                  />
                ))}
              </div>
            )}
            {selectableTags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {selectableTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => addTag(tag)}
                    className="rounded-md border border-border/50 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="plan-item-assignee">
              {t("project:plan.handleMan")}
            </Label>
            {/* 单成员预留：处理人恒当前用户，只读展示 */}
            <Input
              id="plan-item-assignee"
              readOnly
              value={t("project:plan.me")}
              className="bg-muted/50"
            />
          </div>

          {projectId !== null && fieldDefs.length > 0 && (
            <div className="space-y-3 border-t border-border/50 pt-3">
              {fieldDefs.map((def, index) => (
                <div key={def.name} className="space-y-1.5">
                  <Label htmlFor={`plan-item-custom-${index}`}>
                    {def.name}
                  </Label>
                  <Input
                    id={`plan-item-custom-${index}`}
                    type={def.type}
                    value={String(customFields[def.name] ?? "")}
                    onChange={(event) =>
                      handleCustomFieldChange(def.name, event.target.value)
                    }
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
          >
            {t("common:cancel")}
          </Button>
          <Button onClick={handleSave} disabled={!canSubmit}>
            {saving ? t("common:saving") : t("common:save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
