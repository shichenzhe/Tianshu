// src-react/domains/ai/orchestration/components/GraphRow.tsx
/** 单行编排图:名称/节点数(+描述)/手动运行/运行记录/启停开关/删除;行主体点击进编辑器 */
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { History, Play, Trash2 } from "lucide-react";

import IconTooltip from "@/components/common/icon-tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { GraphApi, type GraphRecord } from "../api/orchestration.api";

export function GraphRow({
  graph,
  onClick,
  onDelete,
  onRun,
  onHistory,
  batchMode = false,
  selected = false,
  onToggleSelect,
}: {
  graph: GraphRecord;
  onClick: () => void;
  onDelete: () => void;
  onRun: () => void;
  onHistory: () => void;
  /** 批量模式：行首复选框、行点击切换选中（不进编辑器）、隐藏行内操作 */
  batchMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const { t } = useTranslation(["chat"]);
  const queryClient = useQueryClient();

  async function handleToggle(next: boolean) {
    try {
      await GraphApi.toggle(graph.id, next);
      await queryClient.invalidateQueries({
        queryKey: ["orchestration", "graphs"],
      });
      toast.success(
        t(next ? "chat:orchestration.enabled" : "chat:orchestration.disabled"),
      );
    } catch (e) {
      toast.error(
        t("chat:orchestration.loadFailed", {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }

  return (
    <div
      className={`flex items-center gap-3 rounded-lg px-3 py-2.5 cursor-pointer hover:bg-primary-subtle ${
        batchMode && selected ? "bg-primary-subtle" : ""
      }`}
      aria-label={t("chat:orchestration.openGraph")}
      onClick={
        batchMode
          ? (e) => {
              e.stopPropagation();
              onToggleSelect?.();
            }
          : onClick
      }
    >
      {batchMode && (
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelect?.()}
          onClick={(e) => e.stopPropagation()}
          aria-label={t("chat:orchestration.batchSelectRow", {
            name: graph.name,
          })}
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {graph.name}
        </p>
        {/* 最近运行为占位(Task 14 图详情/轨迹补齐)，先展示节点数+描述 */}
        <p className="truncate text-xs text-muted-foreground">
          {t("chat:orchestration.nodeCount", { count: graph.nodeCount })}
          {graph.description ? ` · ${graph.description}` : ""}
        </p>
      </div>
      {!batchMode && (
        <>
          <IconTooltip label={t("chat:orchestration.run")}>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
              aria-label={t("chat:orchestration.run")}
              onClick={(e) => {
                e.stopPropagation();
                onRun();
              }}
            >
              <Play className="h-4 w-4" />
            </Button>
          </IconTooltip>
          <IconTooltip label={t("chat:orchestration.runHistory")}>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
              aria-label={t("chat:orchestration.runHistory")}
              onClick={(e) => {
                e.stopPropagation();
                onHistory();
              }}
            >
              <History className="h-4 w-4" />
            </Button>
          </IconTooltip>
          <IconTooltip label={t("common:delete")}>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
              aria-label={t("common:delete")}
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </IconTooltip>
          <Switch
            checked={graph.enabled}
            onCheckedChange={handleToggle}
            onClick={(e) => e.stopPropagation()}
            aria-label={t("chat:orchestration.toggleEnabled")}
          />
        </>
      )}
    </div>
  );
}
