/**
 * 转办弹框（三期批 12：会话级工作交接）：打开即调 AI 交接摘要
 * （chat:handoverSummary）——Loading「AI 摘要生成中」→ 预填可编辑摘要
 * 文本域；失败/超时（前端 30s 兜底）显示提示 + 重试，也可手动输入。
 * 标题必填；属性设置与事项弹窗同构（属性胶囊行 PlanItemCapsuleRow：
 * 状态/处理人/优先级/标签/时间规划；附件区 PlanItemAttachments 新建态
 * 本地暂存）。确认后创建项目待办（description=摘要文本域当前值、
 * source=manual，属性六字段随载荷；日期经 dateKeyToIso 转 UTC 零点 ISO），
 * 按返回 id 批量挂附件（失败仅 toast 不阻断关闭），失效计划缓存并关闭
 * （PRD §5 口径）
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import ChatApi from "@/domains/ai/api/chat.api";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import { useUserStore } from "@/domains/user/store/user.store";
import ProjectApi from "../api/project.api";
import PlanItemApi, {
  PLAN_ITEMS_KEY,
  PLAN_ITEMS_MINE_KEY,
  PLAN_ITEM_ATTACHMENTS_KEY,
} from "../api/plan-item.api";
import { dateKeyToIso } from "../model/plan-date";
import PlanItemAttachments, {
  type PendingAttachment,
} from "./PlanItemAttachments";
import PlanItemCapsuleRow, { type CapsulePatch } from "./PlanItemCapsuleRow";
import type { ProjectMemberItem } from "../../../../electron/domains/project/project.entity";
import type {
  PlanPriority,
  PlanStatus,
} from "../../../../electron/domains/project/plan-item.entity";

/** 前端超时兜底：后端无超时（generateText 挂起时用户可重试/手输） */
const HANDOVER_TIMEOUT_MS = 30_000;

type SummaryPhase = "loading" | "ready" | "failed";

interface HandoverDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 待办归属项目 id（入口仅在项目会话渲染，恒非空） */
  projectId: number;
  /** 被交接的会话 id */
  sessionId: number;
  /** 项目资产空间 workspace id（附件「从资产挑选」数据源） */
  assetWorkspaceId?: number;
}

export default function HandoverDialog({
  open,
  onOpenChange,
  projectId,
  sessionId,
  assetWorkspaceId,
}: HandoverDialogProps) {
  const { t } = useTranslation(["project", "chat", "common"]);
  const queryClient = useQueryClient();
  const userId = useUserStore((state) => state.user.id);
  const [phase, setPhase] = useState<SummaryPhase>("loading");
  const [summary, setSummary] = useState("");
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<PlanStatus>("not_started");
  const [priority, setPriority] = useState<PlanPriority>("P1");
  const [tags, setTags] = useState<string[]>([]);
  const [assigneeId, setAssigneeId] = useState<number | null>(null);
  const [startDate, setStartDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  // 附件：新建态本地暂存，保存成功后按 create 返回 id 批量挂库
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // 重试触发器（重开 effect）；轮次守卫防慢响应晚到覆盖新一轮状态
  const [retryTick, setRetryTick] = useState(0);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!open) {
      return;
    }
    setSummary("");
    setTitle("");
    // 属性缺省值对齐 PlanItemDialog 新建态（处理人缺省当前用户，胶囊可改派）
    setStatus("not_started");
    setPriority("P1");
    setTags([]);
    setAssigneeId(userId);
    setStartDate("");
    setDueDate("");
    setAttachments([]);
    setPhase("loading");
    const round = requestRef.current + 1;
    requestRef.current = round;
    const timer = setTimeout(() => {
      if (requestRef.current === round) {
        setPhase("failed");
      }
    }, HANDOVER_TIMEOUT_MS);
    ChatApi.handoverSummary(sessionId)
      .then((markdown) => {
        if (requestRef.current !== round) {
          return;
        }
        setSummary(markdown);
        setPhase("ready");
      })
      .catch(() => {
        if (requestRef.current === round) {
          setPhase("failed");
        }
      })
      .finally(() => clearTimeout(timer));
  }, [open, sessionId, retryTick, userId]);

  // 候选标签：只消费计划 Tab 已有 planItems 缓存（enabled false 不主动拉取）
  const { data: projectItems = [] } = useQuery({
    queryKey: PLAN_ITEMS_KEY(projectId),
    queryFn: () => PlanItemApi.list(projectId),
    enabled: false,
  });
  const candidateTags = useMemo(() => {
    const seen = new Set<string>();
    projectItems.forEach((entry) => entry.tags.forEach((tag) => seen.add(tag)));
    return [...seen].sort();
  }, [projectItems]);

  // 项目成员（处理人胶囊）：弹窗打开时拉取
  const { data: members = [] } = useQuery<ProjectMemberItem[]>({
    queryKey: ["projectMembers", projectId],
    queryFn: () => ProjectApi.listMembers(projectId),
    enabled: open,
  });

  /** 胶囊行 patch 上抛 → 分发到各字段本地态 */
  const handleCapsuleChange = (patch: Partial<CapsulePatch>) => {
    if (patch.status !== undefined) setStatus(patch.status);
    if (patch.priority !== undefined) setPriority(patch.priority);
    if (patch.tags !== undefined) setTags(patch.tags);
    if (patch.assigneeId !== undefined) setAssigneeId(patch.assigneeId);
    if (patch.startDate !== undefined) setStartDate(patch.startDate);
    if (patch.dueDate !== undefined) setDueDate(patch.dueDate);
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

  /** 确认：创建转办待办（description=文本域当前值 + 属性六字段）→ 挂附件 → 失效计划缓存 → 关闭 */
  const handleConfirm = async () => {
    const trimmed = title.trim();
    if (!trimmed || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      const created = await PlanItemApi.create({
        projectId,
        title: trimmed,
        description: summary.trim() ? summary : null,
        source: "manual",
        status,
        priority,
        tags,
        assigneeId,
        startDate: startDate ? dateKeyToIso(startDate) : null,
        dueDate: dueDate ? dateKeyToIso(dueDate) : null,
      });
      await queryClient.invalidateQueries({
        queryKey: PLAN_ITEMS_KEY(projectId),
      });
      await queryClient.invalidateQueries({
        queryKey: PLAN_ITEMS_MINE_KEY(userId),
      });
      await attachPendingAttachments(created.id);
      toast.success(t("project:handover.created"));
      onOpenChange(false);
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-lg border border-border/50 shadow-lg sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("project:handover.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="handover-title">{t("project:plan.title")}</Label>
            <Input
              id="handover-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t("project:handover.titlePlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="handover-summary">
                {t("project:handover.summaryLabel")}
              </Label>
              {phase === "loading" && (
                <span className="flex items-center gap-1 text-xs text-primary">
                  <Sparkles className="h-3 w-3" />
                  {t("project:handover.generating")}
                </span>
              )}
              {phase === "failed" && (
                <button
                  type="button"
                  onClick={() => setRetryTick((tick) => tick + 1)}
                  className="text-xs text-muted-foreground transition-colors hover:text-primary"
                >
                  {t("project:handover.retry")}
                </button>
              )}
            </div>
            {/* 生成中禁编辑防被覆盖；失败态开放手动输入 */}
            <Textarea
              id="handover-summary"
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              rows={12}
              disabled={phase === "loading"}
              className="text-sm leading-relaxed"
              placeholder={t("project:handover.failedHint")}
            />
            {phase === "failed" && (
              <p className="text-xs text-muted-foreground">
                {t("project:handover.failedHint")}
              </p>
            )}
          </div>
          {/* 属性胶囊行（同事项弹窗：状态/处理人/优先级/标签/时间规划） */}
          <PlanItemCapsuleRow
            status={status}
            priority={priority}
            tags={tags}
            assigneeId={assigneeId}
            startDate={startDate}
            dueDate={dueDate}
            members={members}
            candidateTags={candidateTags}
            projectIdIsNull={false}
            onChange={handleCapsuleChange}
          />
          {/* 附件区（回形针菜单：上传文件入 attachments/ 或从资产挑选） */}
          <PlanItemAttachments
            projectId={projectId}
            workspaceId={assetWorkspaceId}
            value={attachments}
            onChange={setAttachments}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common:cancel")}
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!title.trim() || submitting}
          >
            {t("common:confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
