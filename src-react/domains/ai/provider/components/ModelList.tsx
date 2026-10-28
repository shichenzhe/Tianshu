// src-react/domains/ai/provider/components/ModelList.tsx
/** 模型卡片行列表（spec §3.1）：开关 + modelId + 参数摘要 + 操作；
 *  摘要仅显示非默认项（buildModelSummary），全默认显示「默认参数」 */
import { useTranslation } from "react-i18next";
import { Edit, Play, Plus, Trash2 } from "lucide-react";

import IconTooltip from "@/components/common/icon-tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { ModelRecord } from "../../api/model.api";
import { buildModelSummary } from "../lib/model-summary";

const SEGMENT_LABEL: Record<string, string> = {
  context: "ai:model.summary.context",
  output: "ai:model.summary.output",
  temperature: "ai:model.summary.temperature",
  topP: "ai:model.summary.topP",
};

export default function ModelList({
  models,
  testingModelId,
  onToggle,
  onTest,
  onEdit,
  onDelete,
  onAdd,
}: {
  models: ModelRecord[];
  testingModelId: number | null;
  onToggle: (model: ModelRecord, enabled: boolean) => void;
  onTest: (model: ModelRecord) => void;
  onEdit: (model: ModelRecord) => void;
  onDelete: (model: ModelRecord) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation(["ai", "common"]);
  return (
    <div className="flex flex-col gap-1.5">
      {models.map((model) => {
        const segments = buildModelSummary(model);
        return (
          <div
            key={model.id}
            data-model-row={model.modelId}
            className="flex items-center gap-2.5 rounded-lg border border-border/50 bg-card px-3 py-2"
          >
            <Switch
              checked={model.enabled}
              onCheckedChange={(enabled) => onToggle(model, enabled)}
              aria-label={t("ai:provider.enabled")}
            />
            <span
              className="w-52 shrink-0 truncate font-mono text-sm text-foreground"
              title={model.modelId}
            >
              {model.modelId}
            </span>
            {model.type !== "llm" && (
              <Badge
                variant="secondary"
                className="shrink-0 text-[10px]"
                data-model-type={model.type}
              >
                {t(`ai:model.type.${model.type}`)}
              </Badge>
            )}
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {segments.length === 0
                ? t("ai:model.defaultParams")
                : segments
                    .map((s) => t(SEGMENT_LABEL[s.key], { value: s.value }))
                    .join(" · ")}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 hover:bg-primary-subtle hover:text-primary"
              disabled={testingModelId === model.id}
              onClick={() => onTest(model)}
            >
              <Play className="mr-1 h-3 w-3" />
              {testingModelId === model.id
                ? t("ai:model.testing")
                : t("ai:model.test")}
            </Button>
            <IconTooltip label={t("ai:model.editAction")}>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 hover:bg-primary-subtle hover:text-primary"
                aria-label={t("ai:model.editAction")}
                onClick={() => onEdit(model)}
              >
                <Edit className="h-3 w-3" />
              </Button>
            </IconTooltip>
            <IconTooltip label={t("ai:model.deleteAction")}>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 hover:bg-primary-subtle hover:text-destructive"
                aria-label={t("ai:model.deleteAction")}
                onClick={() => onDelete(model)}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </IconTooltip>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onAdd}
        className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary-subtle/50 hover:text-primary"
      >
        <Plus className="h-3 w-3" />
        {t("ai:model.addManually")}
      </button>
    </div>
  );
}
