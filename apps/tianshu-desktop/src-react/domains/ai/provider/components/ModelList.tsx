// src-react/domains/ai/provider/components/ModelList.tsx
/** 模型卡片行列表（spec §3.1）：开关 + modelId + 参数摘要 + 操作；
 *  摘要仅显示非默认项（buildModelSummary），全默认显示「默认参数」。
 *  批5（§6 项 4）：测速结果行内展示（首字延迟 · 生成速度）+ 列头
 *  「按测速排序」开关（firstChunkMs 升序、未测行垫底）；新 props 全部
 *  可选——既有调用方（含远程只读态）零改动 */
import { useTranslation } from "react-i18next";
import { Gauge, Play, Plus, Trash2, Edit } from "lucide-react";

import IconTooltip from "@/components/common/icon-tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { ModelBenchMetrics, ModelRecord } from "../../api/model.api";
import { buildModelSummary } from "../lib/model-summary";

const SEGMENT_LABEL: Record<string, string> = {
  context: "ai:model.summary.context",
  output: "ai:model.summary.output",
  temperature: "ai:model.summary.temperature",
  topP: "ai:model.summary.topP",
};

export type ModelSortMode = "default" | "bench";

export default function ModelList({
  models,
  testingModelId,
  benchById = {},
  benchingModelId = null,
  sortMode = "default",
  onToggleSort,
  onBench,
  onToggle,
  onTest,
  onEdit,
  onDelete,
  onAdd,
}: {
  models: ModelRecord[];
  testingModelId: number | null;
  /** 测速结果（id → 最近一次 bench；前端内存态，不落库） */
  benchById?: Record<number, ModelBenchMetrics>;
  /** 测速进行中的模型 id（按钮禁用 + 文案切换） */
  benchingModelId?: number | null;
  /** 排序模式：default 建序 | bench firstChunkMs 升序（未测垫底） */
  sortMode?: ModelSortMode;
  onToggleSort?: () => void;
  onBench?: (model: ModelRecord) => void;
  onToggle: (model: ModelRecord, enabled: boolean) => void;
  onTest: (model: ModelRecord) => void;
  onEdit: (model: ModelRecord) => void;
  onDelete: (model: ModelRecord) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation(["ai", "common"]);
  const sorted =
    sortMode === "bench"
      ? [...models].sort((a, b) => {
          const aMs = benchById[a.id]?.firstChunkMs;
          const bMs = benchById[b.id]?.firstChunkMs;
          // 未测行垫底（Infinity 归一），已测行按首字延迟升序
          if (aMs === undefined && bMs === undefined) return 0;
          if (aMs === undefined) return 1;
          if (bMs === undefined) return -1;
          return aMs - bMs;
        })
      : models;
  return (
    <div className="flex flex-col gap-1.5">
      {(onBench ?? onToggleSort) && (
        <div className="flex items-center justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs hover:bg-primary-subtle hover:text-primary"
            aria-pressed={sortMode === "bench"}
            onClick={onToggleSort}
          >
            <Gauge className="mr-1 h-3 w-3" />
            {sortMode === "bench"
              ? t("ai:model.sortByDefault")
              : t("ai:model.sortByBench")}
          </Button>
        </div>
      )}
      {sorted.map((model) => {
        const segments = buildModelSummary(model);
        const bench = benchById[model.id];
        const benching = benchingModelId === model.id;
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
            {bench && (
              <span
                data-testid="model-bench"
                className="shrink-0 text-xs text-muted-foreground"
                title={t("ai:model.benchResult", {
                  firstChunkMs: bench.firstChunkMs,
                  tokensPerSec: bench.tokensPerSec,
                })}
              >
                {bench.firstChunkMs}ms · {bench.tokensPerSec} tok/s
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {segments.length === 0
                ? t("ai:model.defaultParams")
                : segments
                    .map((s) => t(SEGMENT_LABEL[s.key], { value: s.value }))
                    .join(" · ")}
            </span>
            {onBench && model.type === "llm" && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 hover:bg-primary-subtle hover:text-primary"
                disabled={benching}
                onClick={() => onBench(model)}
              >
                <Gauge className="mr-1 h-3 w-3" />
                {benching ? t("ai:model.benching") : t("ai:model.bench")}
              </Button>
            )}
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
