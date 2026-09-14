/**
 * 计划事项弹窗（新建/编辑共用，spec §6；子系统 D 改版 spec §2）：
 * 标题（必填 trim ≤100，空标题禁用提交、超长实时提示；新建态可经
 * defaultStatus/defaultPriority/defaultDueDate 预置——看板列头/优先级列头/
 * 日历点格快速新增，编辑态忽略）/ 描述（textarea 4 行 ⇄ 右上「预览」开关
 * MarkdownView 渲染；空串保存归一 null，读侧归一空串）/ 属性胶囊行
 * PlanItemCapsuleRow（状态/处理人/优先级/标签/时间规划五胶囊收纳原控件；
 * 标签候选来自 planItems 缓存聚合；本地任务处理人只读「我」、无时间胶囊）/
 * 自定义字段动态区（text=Input、number=Input[type=number]、date=Input[type=date]；
 * 仅项目任务渲染）/ 附件区 PlanItemAttachments（回形针菜单上传入资产空间
 * attachments/ 子目录或从资产挑选；新建态本地暂存、保存成功后按 create 返回
 * id 批量挂库——失败仅 toast 不阻断关闭；编辑态直连：删已挂走 removeAttachment
 * 通道；本地任务不渲染）/ 右上全屏切换（maximized：DialogContent 全屏类；
 * Esc 分层——全屏态（非预览态）Esc 仅退全屏不关弹窗，非全屏态照常关闭）。
 * 保存：新建 → create（assigneeId 打开时缺省当前用户、显式「未指派」传
 * null；description 空串归一 null；日期仅项目任务携带、dateKeyToIso 构造
 * UTC 零点 ISO、空串归一 null；customFields 仅保留值非空键）、编辑 →
 * update（全量字段，assigneeId 回填原值——null 保留「未指派」）
 * → invalidate planItems + planItemsMine 双 key
 * → toast(plan:saved) + onSaved + 关闭；失败 toast mapIpcError 且弹窗保留。
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Maximize2, Minimize2 } from "lucide-react";
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
import MarkdownView from "@/domains/ai/chat/components/MarkdownView";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import { useUserStore } from "@/domains/user/store/user.store";
import PlanItemApi, {
  PLAN_FIELDS_KEY,
  PLAN_ITEMS_KEY,
  PLAN_ITEMS_MINE_KEY,
  PLAN_ITEM_ATTACHMENTS_KEY,
} from "../api/plan-item.api";
import ProjectApi from "../api/project.api";
import { dateKeyToIso } from "../model/plan-date";
import PlanItemAttachments, {
  type PendingAttachment,
} from "./PlanItemAttachments";
import PlanItemCapsuleRow, { type CapsulePatch } from "./PlanItemCapsuleRow";
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
  /** 新建态初始截止日（日历点格预置 "YYYY-MM-DD"；编辑态忽略） */
  defaultDueDate?: string;
  /** 项目资产空间 workspace id（附件「从资产挑选」数据源） */
  assetWorkspaceId?: number;
  /** 保存成功回调（父级刷新列表） */
  onSaved: () => void;
}

/** 本地任务（projectId null）不参与项目级缓存：-1 永不与真实自增 id 碰撞 */
const NO_PROJECT_CACHE_KEY = -1;

/** 附件关联空列表常量：作 useQuery 缺省值保持引用稳定（防回填 effect 死循环） */
const NO_ATTACHMENTS: PendingAttachment[] = [];

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
  defaultDueDate,
  assetWorkspaceId,
  onSaved,
}: PlanItemDialogProps) {
  const { t } = useTranslation(["project", "common"]);
  const queryClient = useQueryClient();
  const user = useUserStore((state) => state.user);
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<PlanStatus>("not_started");
  const [priority, setPriority] = useState<PlanPriority>("P1");
  const [tags, setTags] = useState<string[]>([]);
  const [startDate, setStartDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [assigneeId, setAssigneeId] = useState<number | null>(null);
  const [customFields, setCustomFields] = useState<
    Record<string, string | number>
  >({});
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [maximized, setMaximized] = useState(false);
  // 附件：新建/编辑同构本地态（已挂记录带 id，暂存项无 id 保存后补挂）
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);

  // 打开时重置/回填：新建取缺省值，编辑回填 item 全字段
  // （日期取 ISO 前 10 位回填日期框；处理人新建缺省指派自己，编辑回填
  //  原值——assigneeId null 保留「未指派」，不回落当前用户；
  //  预览/全屏为会话态，重开归位编辑态/普通窗口）
  useEffect(() => {
    if (!open) {
      return;
    }
    setTitle(item?.title ?? "");
    setTitleTouched(false);
    setDescription(item?.description ?? "");
    setStatus(item?.status ?? defaultStatus ?? "not_started");
    setPriority(item?.priority ?? defaultPriority ?? "P1");
    setTags(item?.tags ? [...item.tags] : []);
    setStartDate(item?.startDate ? item.startDate.slice(0, 10) : "");
    setDueDate(
      item
        ? item.dueDate
          ? item.dueDate.slice(0, 10)
          : ""
        : (defaultDueDate ?? ""),
    );
    setAssigneeId(item ? item.assigneeId : user.id);
    setCustomFields(item ? { ...item.customFields } : {});
    setAttachments([]);
    setSaving(false);
    setPreviewing(false);
    setMaximized(false);
  }, [open, item, defaultStatus, defaultPriority, defaultDueDate, user.id]);

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

  // 自定义字段定义：仅项目任务且弹窗打开时拉取
  const { data: fieldDefs = [] } = useQuery({
    queryKey: PLAN_FIELDS_KEY(projectId ?? NO_PROJECT_CACHE_KEY),
    queryFn: () => PlanItemApi.listFields(projectId ?? NO_PROJECT_CACHE_KEY),
    enabled: open && projectId !== null,
  });

  // 项目成员（处理人胶囊）：仅项目任务且弹窗打开时拉取
  const { data: members = [] } = useQuery<ProjectMemberItem[]>({
    queryKey: ["projectMembers", projectId],
    queryFn: () => ProjectApi.listMembers(projectId as number),
    enabled: open && projectId !== null,
  });

  // 已挂附件关联（编辑态回填源）：仅项目任务编辑且弹窗打开时拉取
  const editingItemId = item?.id ?? NO_PROJECT_CACHE_KEY;
  const { data: attachmentRecords = NO_ATTACHMENTS } = useQuery({
    queryKey: PLAN_ITEM_ATTACHMENTS_KEY(editingItemId),
    queryFn: () => PlanItemApi.listAttachments(editingItemId),
    enabled: open && item !== undefined && projectId !== null,
  });

  // 编辑态回填：服务端关联列表 → 本地态（保留用户暂存项，防失效重取冲掉）
  useEffect(() => {
    if (!open || !item) {
      return;
    }
    const attached: PendingAttachment[] = attachmentRecords.map((record) => ({
      id: record.id,
      fileName: record.fileName,
      assetPath: record.assetPath,
    }));
    setAttachments((prev) => [
      ...attached,
      ...prev.filter((entry) => entry.id === undefined),
    ]);
  }, [open, item, attachmentRecords]);

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

  /** 胶囊行 patch 上抛 → 分发到各字段本地态 */
  const handleCapsuleChange = (patch: Partial<CapsulePatch>) => {
    if (patch.status !== undefined) setStatus(patch.status);
    if (patch.priority !== undefined) setPriority(patch.priority);
    if (patch.tags !== undefined) setTags(patch.tags);
    if (patch.assigneeId !== undefined) setAssigneeId(patch.assigneeId);
    if (patch.startDate !== undefined) setStartDate(patch.startDate);
    if (patch.dueDate !== undefined) setDueDate(patch.dueDate);
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

  /** 暂存附件批量挂库：失败仅 toast 不阻断关闭（附件可重挂） */
  const attachPendingAttachments = async (planItemId: number) => {
    const pending = attachments.filter((entry) => entry.id === undefined);
    if (pending.length === 0) {
      return;
    }
    const results = await Promise.allSettled(
      pending.map((entry) =>
        PlanItemApi.createAttachment(planItemId, {
          fileName: entry.fileName,
          assetPath: entry.assetPath,
        }),
      ),
    );
    if (results.some((result) => result.status === "rejected")) {
      toast.error(t("project:plan.attachFailed"));
    }
    await queryClient.invalidateQueries({
      queryKey: PLAN_ITEM_ATTACHMENTS_KEY(planItemId),
    });
  };

  const handleSave = async () => {
    if (!canSubmit) {
      return;
    }
    setSaving(true);
    try {
      const customFieldValues = buildCustomFields();
      // 排期载荷：本地任务无日期语义，仅项目任务携带
      // （dateKeyToIso 构造 UTC 零点 ISO，空串归一 null = 清空）
      const datePayload =
        projectId !== null
          ? {
              startDate: startDate ? dateKeyToIso(startDate) : null,
              dueDate: dueDate ? dateKeyToIso(dueDate) : null,
            }
          : {};
      // 保存后事项 id（create 返回 record；update 沿 item.id）供附件补挂
      let savedItemId = item?.id ?? 0;
      if (item) {
        await PlanItemApi.update({
          id: item.id,
          title: trimmedTitle,
          description: description || null,
          status,
          priority,
          tags,
          customFields: customFieldValues,
          assigneeId,
          ...datePayload,
        });
      } else {
        const created = await PlanItemApi.create({
          createdById: user.id,
          // 处理人：打开时缺省指派自己（任务 Tab「指派给我的」依赖），
          // 胶囊可改派；显式选「未指派」传 null 原样透传
          assigneeId,
          projectId: projectId ?? undefined,
          title: trimmedTitle,
          description: description || null,
          status,
          priority,
          tags,
          customFields:
            Object.keys(customFieldValues).length > 0
              ? customFieldValues
              : undefined,
          ...datePayload,
        });
        savedItemId = created.id;
      }
      await invalidatePlanCaches();
      await attachPendingAttachments(savedItemId);
      toast.success(t("project:plan.saved"));
      onSaved();
      onOpenChange(false);
    } catch (error) {
      toast.error(mapIpcError(error));
    } finally {
      setSaving(false);
    }
  };

  /** Esc 分层（radix 只有关闭语义）：全屏态（非预览态）拦下默认关闭仅退全屏 */
  const handleEscapeKeyDown = (event: KeyboardEvent) => {
    if (!maximized || previewing) {
      return;
    }
    event.preventDefault();
    setMaximized(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        onEscapeKeyDown={handleEscapeKeyDown}
        className={
          maximized
            ? "h-[100dvh] w-screen max-w-none overflow-y-auto rounded-none sm:max-w-none"
            : "max-h-[85vh] overflow-y-auto rounded-lg border-border/50 shadow-lg sm:max-w-lg"
        }
      >
        <DialogHeader className="flex flex-row items-center justify-between space-y-0">
          <DialogTitle>
            {item ? t("project:plan.edit") : t("project:plan.add")}
          </DialogTitle>
          {/* 全屏切换（mr-8 避让右上角内置关闭 X） */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setMaximized((value) => !value)}
            aria-label={
              maximized ? t("project:plan.restore") : t("project:plan.maximize")
            }
            className="mr-8 h-7 w-7 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
          >
            {maximized ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </Button>
        </DialogHeader>

        <div className="space-y-3">
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

          {/* 描述：textarea ⇄ MarkdownView 预览 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="plan-item-description">
                {t("project:plan.description")}
              </Label>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPreviewing((value) => !value)}
                className="h-6 px-2 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
              >
                {previewing
                  ? t("project:plan.editMode")
                  : t("project:plan.preview")}
              </Button>
            </div>
            {previewing ? (
              <div className="min-h-24 rounded-md border border-border/50 p-2">
                <MarkdownView text={description} />
              </div>
            ) : (
              <textarea
                id="plan-item-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={4}
                aria-label={t("project:plan.description")}
                className="w-full resize-y rounded-md border border-border/50 bg-transparent p-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            )}
          </div>

          {/* 属性胶囊行（替代表单 grid 与标签/处理人/日期区） */}
          <PlanItemCapsuleRow
            status={status}
            priority={priority}
            tags={tags}
            assigneeId={assigneeId}
            startDate={startDate}
            dueDate={dueDate}
            members={members}
            candidateTags={candidateTags}
            projectIdIsNull={projectId === null}
            onChange={handleCapsuleChange}
          />

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

          {/* 附件区（自定义字段区之后；本地任务由组件内部隐藏） */}
          <PlanItemAttachments
            projectId={projectId}
            workspaceId={assetWorkspaceId}
            planItemId={item?.id}
            value={attachments}
            onChange={setAttachments}
          />
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
