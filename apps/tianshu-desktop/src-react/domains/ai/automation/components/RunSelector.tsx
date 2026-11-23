// src-react/domains/ai/automation/components/RunSelector.tsx
/**
 * 固定入口运行分页查询与状态徽标：原页头下拉选择器已由右侧运行看板
 * （run-board.tsx，spec 2026-11-23 §1）取代，本文件只保留两者共享的
 * 分页查询面（runPageQueryKey/queryRunPage）与状态徽标展示件。
 */
import { useTranslation } from "react-i18next";
import type { RunOwner } from "@tianshu/core/run-session";
import { Badge } from "@/components/ui/badge";
import { AutomationApi, type RunRecord } from "../api/automation.api";
import { GraphApi } from "../../orchestration/api/orchestration.api";

export function runPageQueryKey(owner: RunOwner, page: number) {
  return ["automation", "runSessionRuns", owner.kind, owner.ownerId, page];
}

export function queryRunPage(owner: RunOwner, page: number) {
  return owner.kind === "task"
    ? AutomationApi.runs(page, owner.ownerId)
    : GraphApi.runs(owner.ownerId, page, true);
}

export function RunStatusBadge({ status }: { status: RunRecord["status"] }) {
  const { t } = useTranslation(["chat"]);
  const label = `status${status[0].toUpperCase()}${status.slice(1)}`;
  const variant =
    status === "failed"
      ? "destructive"
      : status === "skipped"
        ? "secondary"
        : "outline";
  return (
    <Badge variant={variant} className="shrink-0">
      {t(`chat:automation.runs.${label}`)}
    </Badge>
  );
}
