/**
 * 上下文用量指示器：环形图标(填充度/风险色随用量变化) + Popover 详情
 * 浮层(总量/分段进度条/五类拆解)。数据来自主进程 chat:usage(与下次
 * 请求同口径组装并截断),草稿文本实时并入 Messages 项;模型切换或
 * 流结束后自动刷新
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { X } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { invoke } from "@/lib/ipc";
import { cn } from "@/lib/utils";

interface Breakdown {
  system: number;
  tools: number;
  messages: number;
  mcp: number;
  skills: number;
  total: number;
  contextWindow: number | null;
}

interface ContextUsageButtonProps {
  sessionId: number;
  currentModelId?: number;
  sending: boolean;
  /** 输入框草稿（实时计入 Messages 项，粘贴超长文本即时预警） */
  draft: string;
}

/** 五类拆解：key 与主进程 ContextUsageBreakdown 对齐，色为数据类别色 */
const SEGMENTS = [
  { key: "system", label: "chat:usage.system", bar: "bg-blue-500" },
  { key: "tools", label: "chat:usage.tools", bar: "bg-green-500" },
  { key: "messages", label: "chat:usage.messages", bar: "bg-orange-500" },
  { key: "mcp", label: "chat:usage.mcp", bar: "bg-purple-500" },
  { key: "skills", label: "chat:usage.skills", bar: "bg-pink-500" },
] as const;

/** 与主进程 estimateTokens 同口径：1 token ≈ 2 字符 */
const estimateDraftTokens = (text: string) => Math.ceil(text.length / 2);

/** token 数格式化为 K（47768 → 47.8K；小于 1K 原样） */
function formatTokens(value: number): string {
  return value >= 1024 ? `${(value / 1024).toFixed(1)}K` : String(value);
}

/** 风险等级：<50% 安全 / 50%-80% 警告 / >80% 危险 */
function riskClass(ratio: number): string {
  if (ratio >= 0.8) {
    return "text-destructive";
  }
  return ratio >= 0.5 ? "text-amber-500" : "text-emerald-500";
}

function riskStroke(ratio: number): string {
  if (ratio >= 0.8) {
    return "stroke-destructive";
  }
  return ratio >= 0.5 ? "stroke-amber-500" : "stroke-emerald-500";
}

export default function ContextUsageButton({
  sessionId,
  currentModelId,
  sending,
  draft,
}: ContextUsageButtonProps) {
  const { t } = useTranslation(["chat", "common"]);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const usageQuery = useQuery({
    queryKey: ["context-usage", sessionId, currentModelId],
    queryFn: () => invoke<Breakdown | null>("chat:usage", sessionId),
    staleTime: 30_000,
  });

  // 流结束（sending true→false）后刷新：新一轮历史已落库
  const wasSending = useRef(false);
  useEffect(() => {
    if (wasSending.current && !sending) {
      void queryClient.invalidateQueries({ queryKey: ["context-usage"] });
    }
    wasSending.current = sending;
  }, [sending, queryClient]);

  const breakdown = usageQuery.data ?? null;
  const draftTokens = useMemo(() => estimateDraftTokens(draft), [draft]);
  const messages = (breakdown?.messages ?? 0) + draftTokens;
  const total = (breakdown?.total ?? 0) + draftTokens;
  const limit = breakdown?.contextWindow ?? null;
  const ratio = limit !== null && limit > 0 ? total / limit : 0;
  const overflow = limit !== null && total > limit;

  // 跨越溢出阈值瞬间提示一次（持续超限不重复弹）
  const wasOverflow = useRef(false);
  useEffect(() => {
    if (overflow && !wasOverflow.current) {
      toast.warning(t("chat:usage.overflow"));
    }
    wasOverflow.current = overflow;
  }, [overflow, t]);

  const valueOf = (key: (typeof SEGMENTS)[number]["key"]): number =>
    key === "messages" ? messages : (breakdown?.[key] ?? 0);

  // 悬停提示：白底圆钮有别于同行透明按钮，tooltip 带百分比与用量概览
  const usageTooltip =
    limit === null
      ? t("chat:usage.noLimit", { used: formatTokens(total) })
      : t("chat:usage.tooltip", {
          percent: Math.round(ratio * 100),
          used: formatTokens(total),
          limit: formatTokens(limit),
        });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={usageTooltip}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/50 bg-background shadow-sm hover:border-primary/30"
              >
                <svg viewBox="0 0 36 36" className="h-5 w-5 -rotate-90">
                  <circle
                    cx="18"
                    cy="18"
                    r="15.5"
                    fill="none"
                    strokeWidth="4"
                    className="stroke-border"
                  />
                  <circle
                    cx="18"
                    cy="18"
                    r="15.5"
                    fill="none"
                    strokeWidth="4"
                    strokeLinecap="round"
                    strokeDasharray={`${Math.min(ratio, 1) * 97.39} 97.39`}
                    className={cn(
                      "transition-all",
                      ratio > 0
                        ? riskStroke(ratio)
                        : "stroke-muted-foreground/40",
                    )}
                  />
                </svg>
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{usageTooltip}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent
        align="end"
        side="top"
        className="w-[300px] rounded-xl border border-border/50 shadow-lg"
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{t("chat:usage.title")}</span>
          <button
            type="button"
            aria-label={t("common:cancel")}
            onClick={() => setOpen(false)}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {breakdown === null ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {t("chat:usage.unavailable")}
          </p>
        ) : (
          <>
            <p
              className={cn(
                "mt-2 text-3xl font-semibold tabular-nums",
                riskClass(ratio),
              )}
            >
              {limit === null
                ? formatTokens(total)
                : overflow
                  ? ">100%"
                  : `${(ratio * 100).toFixed(1)}%`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {limit === null
                ? t("chat:usage.noLimit", { used: formatTokens(total) })
                : t("chat:usage.used", {
                    used: formatTokens(total),
                    limit: formatTokens(limit),
                  })}
            </p>
            {limit !== null && (
              <div
                className={cn(
                  "mt-3 flex h-2 w-full overflow-hidden rounded-full bg-muted",
                  overflow && "ring-1 ring-destructive",
                )}
              >
                {SEGMENTS.map((seg) => {
                  const value = valueOf(seg.key);
                  if (value <= 0) {
                    return null;
                  }
                  // 分段按内部占比铺满（即使溢出也能看出构成）
                  const pct = (value / Math.max(total, 1)) * 100;
                  return (
                    <div
                      key={seg.key}
                      className={seg.bar}
                      style={{ width: `${pct}%` }}
                    />
                  );
                })}
              </div>
            )}
            <ul className="mt-3 space-y-1.5">
              {SEGMENTS.map((seg) => {
                const value = valueOf(seg.key);
                const pct =
                  limit !== null && limit > 0 ? (value / limit) * 100 : 0;
                return (
                  <li
                    key={seg.key}
                    className={cn(
                      "flex items-center gap-2 text-xs",
                      value === 0 && "opacity-50",
                    )}
                  >
                    <span
                      className={cn("h-2 w-2 shrink-0 rounded-full", seg.bar)}
                    />
                    <span>{t(seg.label)}</span>
                    <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                      {limit === null
                        ? formatTokens(value)
                        : `${pct.toFixed(1)}%`}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
