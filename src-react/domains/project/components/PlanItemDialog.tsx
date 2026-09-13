/**
 * 计划事项弹窗（新建/编辑共用，spec §6）：
 * 标题（必填 trim ≤100，空标题禁用提交、超长实时提示）/ 状态四态 Select
 * （新建态可经 defaultStatus 预置初始状态，编辑态忽略）/ 优先级 Select +
 * Badge 预览（P0 destructive / P1 primary / P2 muted / P3 outline；新建态
 * 可经 defaultPriority 预置，看板优先级列头快速新增）/ 标签
 * （Input 回车添加 → 可移除 Tag + planItems 缓存聚合的候选 chips 点击追加；
 * IME 组合中的回车不触发）/ 排期 startDate/dueDate 日期框（仅项目任务，
 * 本地任务无日期语义）/ 处理人（项目任务 = 成员 Select 含「未指派」空值项，
 * project:listMembers 拉取；本地任务只读「我」）/ 自定义字段动态区
 * （text=Input、number=Input[type=number]、date=Input[type=date]；仅项目
 * 任务渲染，本地任务 projectId=null 无该区）。
 * 保存：新建 → create（assigneeId 打开时缺省当前用户、显式「未指派」传
 * null；日期仅项目任务携带、空串归一 null；customFields 仅保留值非空键）、
 * 编辑 → update（全量字段，assigneeId null = 清空指派）
 * → invalidate planItems + planItemsMine 双 key
 * → toast(plan:saved) + onSaved + 关闭；失败 toast mapIpcError 且弹窗保留。
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
import ProjectApi from "../api/project.api";
import RemovableTag from "./RemovableTag";
import type { ProjectMemberItem } from "../../../../electron/domains/project/project.entity";
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
  /** 新建态初始状态（看板列头快速新增预置；编辑态忽略） */
  defaultStatus?: PlanStatus;
  /** 新建态初始优先级（看板优先级列头快速新增预置；编辑态忽略） */
  defaultPriority?: PlanPriority;
  /** 保存成功回调（父级刷新列表） */
  onSaved: () => void;
}

/** 本地任务（projectId null）不参与项目级缓存：-1 永不与真实自增 id 碰撞 */
const NO_PROJECT_CACHE_KEY = -1;

const TITLE_MAX_LENGTH = 100;

/** 「YYYY-MM-DD」日历日 → UTC 零点 ISO（与回填 slice(0,10) 精确往返，
 *  不受本地时区偏移影响）；空串 = 未填（null 清空） */
const toIsoOrNull = (value: string): string | null =>
  value ? new Date(`${value}T00:00:00.000Z`).toISOString() : null;

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

export const PRIORITY_OPTIONS: PlanPriority[] = ["P0", "P1", "P2", "P3"];
export const PRIORITY_LABEL_KEYS: Record<PlanPriority, string> = {
  P0: "project:plan.priorityP0",
  P1: "project:plan.priorityP1",
  P2: "project:plan.priorityP2",
  P3: "project:plan.priorityP3",
};
/** 优先级徽章配色：P0 警示 / P1 主题色 / P2 弱化 / P3 最弱描边 */
export const PRIORITY_BADGE_VARIANTS: Record<
  PlanPriority,
  "destructive" | "default" | "secondary" | "outline"
> = {
  P0: "destructive",
  P1: "default",
  P2: "secondary",
  P3: "outline",
};

export default function PlanItemDialog({
  open,
  onOpenChange,
  projectId,
  item,
  defaultStatus,
  defaultPriority,
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
  const [startDate, setStartDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [assigneeId, setAssigneeId] = useState<number | null>(null);
  const [customFields, setCustomFields] = useState<
    Record<string, string | number>
  >({});
  const [saving, setSaving] = useState(false);

  // 打开时重置/回填：新建取缺省值，编辑回填 item 全字段
  // （日期取 ISO 前 10 位回填日期框；处理人缺省指派自己）
  useEffect(() => {
    if (!open) {
      return;
    }
    setTitle(item?.title ?? "");
    setTitleTouched(false);
    setStatus(item?.status ?? defaultStatus ?? "not_started");
    setPriority(item?.priority ?? defaultPriority ?? "P1");
    setTags(item?.tags ? [...item.tags] : []);
    setTagInput("");
    setStartDate(item?.startDate ? item.startDate.slice(0, 10) : "");
    setDueDate(item?.dueDate ? item.dueDate.slice(0, 10) : "");
    setAssigneeId(item?.assigneeId ?? user.id);
    setCustomFields(item ? { ...item.customFields } : {});
    setSaving(false);
  }, [open, item, defaultStatus, defaultPriority, user.id]);

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

  // 项目成员（处理人选择器）：仅项目任务且弹窗打开时拉取
  const { data: members = [] } = useQuery<ProjectMemberItem[]>({
    queryKey: ["projectMembers", projectId],
    queryFn: () => ProjectApi.listMembers(projectId as number),
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
    // IME 组合中的 Enter 仅确认候选：不添加标签
    if (event.nativeEvent.isComposing) {
      return;
    }
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
      // 排期载荷：本地任务无日期语义，仅项目任务携带（空串归一 null = 清空）
      const datePayload =
        projectId !== null
          ? {
              startDate: toIsoOrNull(startDate),
              dueDate: toIsoOrNull(dueDate),
            }
          : {};
      if (item) {
        await PlanItemApi.update({
          id: item.id,
          title: trimmedTitle,
          status,
          priority,
          tags,
          customFields: customFieldValues,
          assigneeId,
          ...datePayload,
        });
      } else {
        await PlanItemApi.create({
          createdById: user.id,
          // 处理人：打开时缺省指派自己（任务 Tab「指派给我的」依赖），
          // 成员选择器可改派；显式选「未指派」传 null 原样透传
          assigneeId,
          projectId: projectId ?? undefined,
          title: trimmedTitle,
          status,
          priority,
          tags,
          customFields:
            Object.keys(customFieldValues).length > 0
              ? customFieldValues
              : undefined,
          ...datePayload,
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
                {/* 选中优先级徽章预览：P0 红 / P1 主题色 / P2 灰 / P3 弱描边 */}
                <Badge variant={PRIORITY_BADGE_VARIANTS[priority]}>
                  {t(PRIORITY_LABEL_KEYS[priority])}
                </Badge>
              </div>
            </div>
          </div>

          {/* 排期：本地任务无日期语义，仅项目任务录入 */}
          {projectId !== null && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="plan-item-start-date">
                  {t("project:plan.startDate")}
                </Label>
                <Input
                  id="plan-item-start-date"
                  type="date"
                  value={startDate}
                  onChange={(event) => setStartDate(event.target.value)}
                  aria-label={t("project:plan.startDate")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="plan-item-due-date">
                  {t("project:plan.dueDate")}
                </Label>
                <Input
                  id="plan-item-due-date"
                  type="date"
                  value={dueDate}
                  onChange={(event) => setDueDate(event.target.value)}
                  aria-label={t("project:plan.dueDate")}
                />
              </div>
            </div>
          )}

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
            {projectId === null ? (
              /* 本地任务：处理人恒当前用户，只读展示 */
              <Input
                id="plan-item-assignee"
                readOnly
                value={t("project:plan.me")}
                className="bg-muted/50"
              />
            ) : (
              /* 项目任务：成员选择器（含「未指派」空值项，null = 清空指派） */
              <Select
                value={assigneeId === null ? "none" : String(assigneeId)}
                onValueChange={(value) =>
                  setAssigneeId(value === "none" ? null : Number(value))
                }
              >
                <SelectTrigger
                  aria-label={t("project:plan.handleMan")}
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    {t("project:plan.unassigned")}
                  </SelectItem>
                  {members.map((member) => (
                    <SelectItem
                      key={member.userId}
                      value={String(member.userId)}
                    >
                      {member.nickname}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
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
