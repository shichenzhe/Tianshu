/**
 * 甘特视图（子系统 C spec §4）：左列任务名（无日期灰显可点击开编辑设置）+
 * 右侧时间轴（四粒度分列 ganttColumns / 翻页 / 今天回正 / 今天线 bg-primary）；
 * 条形 = 优先级色板跨列圆角条；条定位 barGeometry 纯函数（天宽按粒度连续折算）。
 * 拖拽调期（pointer 三边缘）在 T6 补充；本组件纯展示+回调。
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  PlanItemRecord,
  PlanPriority,
} from "../../../../electron/domains/project/plan-item.entity";
import {
  addDaysToKey,
  diffDays,
  ganttColumns,
  toDateKey,
  toGanttBar,
  type GanttBar,
  type GanttGranularity,
} from "../model/plan-date";

/** 每列像素宽（日 28 / 周 64 / 月 96 / 年 120）→ 连续天宽 */
export const COLUMN_WIDTH: Record<GanttGranularity, number> = {
  day: 28,
  week: 64,
  month: 96,
  year: 120,
};

/** 每列覆盖天数 */
const COLUMN_DAYS: Record<GanttGranularity, number> = {
  day: 1,
  week: 7,
  month: 30.4375,
  year: 365.25,
};

/** 各粒度下连续天宽（列宽 ÷ 列天数；T6 拖拽按像素折天数共用） */
export const GRANULARITY_DAY_WIDTH: Record<GanttGranularity, number> = {
  day: COLUMN_WIDTH.day / COLUMN_DAYS.day,
  week: COLUMN_WIDTH.week / COLUMN_DAYS.week,
  month: COLUMN_WIDTH.month / COLUMN_DAYS.month,
  year: COLUMN_WIDTH.year / COLUMN_DAYS.year,
};

/** 条形几何：left = 距时间轴原点天数 × 天宽；width = 跨天数 × 天宽 */
export function barGeometry(
  bar: GanttBar,
  originKey: string,
  dayWidth: number,
): { left: number; width: number } {
  return {
    left: diffDays(originKey, bar.startKey) * dayWidth,
    width: bar.days * dayWidth,
  };
}

/** 粒度切换选项 */
const GRANULARITY_OPTIONS: Array<{
  value: GanttGranularity;
  labelKey: string;
}> = [
  { value: "day", labelKey: "project:planView.granularityDay" },
  { value: "week", labelKey: "project:planView.granularityWeek" },
  { value: "month", labelKey: "project:planView.granularityMonth" },
  { value: "year", labelKey: "project:planView.granularityYear" },
];

/** 条形优先级配色（与看板左色条一致） */
const BAR_BG_CLASSES: Record<PlanPriority, string> = {
  P0: "bg-destructive/80",
  P1: "bg-primary/80",
  P2: "bg-muted-foreground/50",
  P3: "bg-border",
};

interface PlanGanttViewProps {
  items: PlanItemRecord[];
  onEdit: (item: PlanItemRecord) => void;
  /** 拖拽调期回调（T6 接线；缺省时条形不可拖） */
  onChangeDates?: (
    id: number,
    dates: { startKey: string; endKey: string },
  ) => void;
}

export default function PlanGanttView({ items, onEdit }: PlanGanttViewProps) {
  const { t } = useTranslation(["project", "common"]);
  const todayKey = toDateKey(new Date());
  const [granularity, setGranularity] = useState<GanttGranularity>("day");
  /** 翻页游标（时间轴中心日；初始今天） */
  const [centerKey, setCenterKey] = useState(todayKey);

  const columns = useMemo(
    () => ganttColumns(centerKey, granularity),
    [centerKey, granularity],
  );
  const originKey = columns[0].startKey;
  const dayWidth = GRANULARITY_DAY_WIDTH[granularity];
  const todayLeft = diffDays(originKey, todayKey) * dayWidth;
  const timelineWidth =
    columns.reduce((sum, col) => sum + col.days, 0) * dayWidth;

  /** 翻页步进：日 60 / 周 24 周 / 月 18 月 / 年 6 年（即一屏） */
  const pageDays = { day: 60, week: 168, month: 546, year: 2191 }[granularity];

  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
      {/* 控制栏：粒度 + 翻页 + 今天 */}
      <div className="flex items-center gap-1.5 py-2">
        <div className="flex items-center overflow-hidden rounded-md border border-border/50">
          {GRANULARITY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={granularity === option.value}
              aria-label={t(option.labelKey)}
              onClick={() => setGranularity(option.value)}
              className={cn(
                "px-2 py-1 text-xs transition-colors",
                granularity === option.value
                  ? "bg-primary-subtle font-medium text-primary"
                  : "text-muted-foreground hover:bg-primary-subtle hover:text-primary",
              )}
            >
              {t(option.labelKey)}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("project:planView.prevPage")}
          onClick={() => setCenterKey((prev) => addDaysToKey(prev, -pageDays))}
          className="h-7 w-7 p-0 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("project:planView.nextPage")}
          onClick={() => setCenterKey((prev) => addDaysToKey(prev, pageDays))}
          className="h-7 w-7 p-0 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCenterKey(todayKey)}
          className="h-7 px-2 text-xs hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
        >
          {t("project:planView.today")}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 overflow-auto">
        {/* 左列：任务名 */}
        <div className="w-52 shrink-0 border-r border-border/50">
          <div className="h-7 border-b border-border/50" />
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onEdit(item)}
              title={
                toGanttBar(item) ? item.title : t("project:planView.noDates")
              }
              className="flex h-8 w-full items-center gap-1.5 truncate px-2 text-left text-xs hover:bg-primary-subtle/40"
            >
              <span
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  BAR_BG_CLASSES[item.priority],
                )}
              />
              <span
                className={cn(
                  "truncate",
                  toGanttBar(item)
                    ? "text-foreground"
                    : "text-muted-foreground/60",
                )}
              >
                {item.title}
              </span>
            </button>
          ))}
        </div>
        {/* 右侧：时间轴（列头 + 条形行 + 今天线） */}
        <div className="relative" style={{ width: timelineWidth }}>
          <div className="flex h-7 border-b border-border/50">
            {columns.map((col) => (
              <div
                key={col.key}
                data-column-key={col.key}
                className="flex shrink-0 items-center justify-center border-r border-border/30 text-[10px] text-muted-foreground"
                style={{ width: col.days * dayWidth }}
              >
                {col.label}
              </div>
            ))}
          </div>
          {items.map((item) => {
            const bar = toGanttBar(item);
            const geo = bar ? barGeometry(bar, originKey, dayWidth) : null;
            return (
              <div
                key={item.id}
                className="relative h-8 border-b border-border/30"
              >
                {geo && bar && (
                  <div
                    data-item-id={item.id}
                    title={item.title}
                    onClick={() => onEdit(item)}
                    style={{ left: geo.left, width: geo.width }}
                    className={cn(
                      "absolute top-1.5 h-5 cursor-pointer rounded-md",
                      BAR_BG_CLASSES[item.priority],
                    )}
                  />
                )}
              </div>
            );
          })}
          {/* 今天线：bg-primary 1px 竖线贯穿（spec 裁决：PRD 绿色让位主题变量） */}
          {todayLeft >= 0 && todayLeft <= timelineWidth && (
            <div
              data-today-line="true"
              style={{ left: todayLeft }}
              className="absolute top-0 bottom-0 w-px bg-primary"
            />
          )}
        </div>
      </div>
    </div>
  );
}
