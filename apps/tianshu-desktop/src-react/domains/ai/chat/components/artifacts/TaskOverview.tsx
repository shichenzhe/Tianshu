/**
 * 任务概览（一期会话统一批 4）：任务会话（planItemId 非空）产物面板顶部
 * 折叠区——状态/优先级/起止日期只读行 + AI 进展摘要（Markdown 只读）+
 * 「在项目中查看」。只读轻量行而非复用 PlanItemCapsuleRow：后者耦合
 * Popover 编辑与 onChange 上抛（纯受控组件），只读场景不适用；字段名与
 * 状态/优先级取值文案 key 与其完全一致（改值走项目页，本区无交互）
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  ListChecks,
} from "lucide-react";

import MarkdownView from "../MarkdownView";
import {
  PRIORITY_LABEL_KEYS,
  STATUS_LABEL_KEYS,
} from "@/domains/project/components/PlanItemDialog";
import type { PlanItemRecord } from "../../../../../../electron/domains/project/plan-item.entity";

interface TaskOverviewProps {
  planItem: PlanItemRecord;
  projectId: number;
}

/** 只读属性行：muted 字段名 + 值（空值显示 —） */
function ReadOnlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-14 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-foreground/90">
        {value || "—"}
      </span>
    </div>
  );
}

export default function TaskOverview({
  planItem,
  projectId,
}: TaskOverviewProps) {
  const { t } = useTranslation(["chat", "project"]);
  const navigate = useNavigate();
  const [open, setOpen] = useState(true);
  // 空串/空白 = 无 AI 摘要（entity 约定：空串 = 无）
  const summary = planItem.aiSummary.trim();
  return (
    <div className="border-b border-border/50 px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <ListChecks size={14} />
        {t("chat:taskOverview.title")}
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          <ReadOnlyRow
            label={t("project:plan.status")}
            value={t(STATUS_LABEL_KEYS[planItem.status])}
          />
          <ReadOnlyRow
            label={t("project:plan.priority")}
            value={t(PRIORITY_LABEL_KEYS[planItem.priority])}
          />
          <ReadOnlyRow
            label={t("project:plan.startDate")}
            value={planItem.startDate ?? ""}
          />
          <ReadOnlyRow
            label={t("project:plan.dueDate")}
            value={planItem.dueDate ?? ""}
          />
          {summary && (
            <div className="pt-1">
              <p className="mb-1 text-xs text-muted-foreground">
                {t("chat:taskOverview.aiSummary")}
              </p>
              <MarkdownView text={summary} />
            </div>
          )}
          <button
            type="button"
            onClick={() => navigate(`/module/project/${projectId}`)}
            className="flex items-center gap-1 pt-0.5 text-xs text-muted-foreground transition-colors hover:text-primary"
          >
            <ExternalLink className="h-3 w-3" />
            {t("chat:taskOverview.viewInProject")}
          </button>
        </div>
      )}
    </div>
  );
}
