/**
 * 甘特视图（子系统 C spec §4）：左列任务名（无日期灰显可点击开编辑设置）+
 * 右侧时间轴（四粒度分列 ganttColumns / 翻页 / 今天回正 / 今天线 bg-primary）；
 * 条形 = 优先级色板跨列圆角条，定位 barGeometry 纯函数（天宽按粒度连续折算）。
 * 拖拽调期（T6）：条 pointerDown（dragEdgeFor 判左右 6px 边缘热区）→
 * window 级 pointermove（天粒度吸附 dayDelta，条形 left/width 实时预览）/
 * pointerup（dragToDates 三边缘语义提交 onChangeDates；原地点按不提交，
 * 点开编辑留给 onEdit，拖尾 click 抑制）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
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
  dragToDates,
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

/** 各粒度下连续天宽（列宽 ÷ 列天数；拖拽按像素折天数共用） */
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

/** 边缘热区判定（纯函数）：条内相对 x 距左右沿 <6px 为拉伸，其余平移 */
export function dragEdgeFor(
  offsetX: number,
  barWidth: number,
): "move" | "start" | "end" {
  const EDGE = 6;
  if (offsetX < EDGE) {
    return "start";
  }
  if (offsetX > barWidth - EDGE) {
    return "end";
  }
  return "move";
}

/** 拖拽会话状态（条内三边缘 + 起点 clientX + 天粒度吸附后的位移天数） */
interface DragState {
  id: number;
  edge: "move" | "start" | "end";
  startX: number;
  dayDelta: number;
}

/** 拖拽预览几何：按边缘叠加 dayDelta 天位移（move 平移 / start 左端收缩 / end 右端拉伸） */
function previewGeometry(
  geo: { left: number; width: number },
  drag: DragState | null,
  dayWidth: number,
): { left: number; width: number } {
  if (!drag) {
    return geo;
  }
  const delta = drag.dayDelta * dayWidth;
  if (drag.edge === "move") {
    return { left: geo.left + delta, width: geo.width };
  }
  if (drag.edge === "start") {
    return { left: geo.left + delta, width: geo.width - delta };
  }
  return { left: geo.left, width: geo.width + delta };
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
  /** 拖拽调期回调（缺省时条形不可拖，仅点开编辑） */
  onChangeDates?: (
    id: number,
    dates: { startKey: string; endKey: string },
  ) => void;
}

export default function PlanGanttView({
  items,
  onEdit,
  onChangeDates,
}: PlanGanttViewProps) {
  const { t } = useTranslation(["project", "common"]);
  const todayKey = toDateKey(new Date());
  const [granularity, setGranularity] = useState<GanttGranularity>("day");
  /** 翻页游标（时间轴中心日；初始今天） */
  const [centerKey, setCenterKey] = useState(todayKey);
  /** 拖拽会话（null = 空闲） */
  const [drag, setDrag] = useState<DragState | null>(null);
  /** 拖拽提交后的拖尾 click 抑制（真实浏览器 pointerup 后仍派发 click） */
  const suppressClickRef = useRef(false);

  const columns = useMemo(
    () => ganttColumns(centerKey, granularity),
    [centerKey, granularity],
  );
  const originKey = columns[0].startKey;
  const dayWidth = GRANULARITY_DAY_WIDTH[granularity];
  const todayLeft = diffDays(originKey, todayKey) * dayWidth;
  const timelineWidth =
    columns.reduce((sum, col) => sum + col.days, 0) * dayWidth;
  /** 行数据 = 事项 + 甘特条（toGanttBar 每项一次，左列/时间轴共用） */
  const itemBars = useMemo(
    () => items.map((item) => ({ item, bar: toGanttBar(item) })),
    [items],
  );

  /**
   * 拖拽会话监听（jsdom 无 setPointerCapture，window 级承接）：
   * move → dayDelta = round(位移 / 天宽)（天粒度吸附）；up → 以当前条
   * + dayDelta + edge 调 onChangeDates(dragToDates) 并清会话；
   * 原地点按（dayDelta=0）不提交——点开编辑语义留给 onClick。
   */
  useEffect(() => {
    if (!drag || !onChangeDates) {
      return;
    }
    const handleMove = (event: PointerEvent) => {
      const dayDelta = Math.round((event.clientX - drag.startX) / dayWidth);
      setDrag((prev) => (prev ? { ...prev, dayDelta } : prev));
    };
    const handleUp = () => {
      if (drag.dayDelta !== 0) {
        const bar = itemBars.find((entry) => entry.item.id === drag.id)?.bar;
        if (bar) {
          suppressClickRef.current = true;
          onChangeDates(drag.id, dragToDates(bar, drag.dayDelta, drag.edge));
        }
      }
      setDrag(null);
    };
    /** 会话被系统取消（OS 手势/窗口失焦）：清会话不提交，防陈旧态在下次全局 up 误写 */
    const handleCancel = () => {
      setDrag(null);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleCancel);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleCancel);
    };
  }, [drag, dayWidth, itemBars, onChangeDates]);

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
        <div className="sticky left-0 z-10 w-52 shrink-0 border-r border-border/50 bg-background">
          <div className="h-7 border-b border-border/50" />
          {itemBars.map(({ item, bar }) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onEdit(item)}
              title={bar ? item.title : t("project:planView.noDates")}
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
                  bar ? "text-foreground" : "text-muted-foreground/60",
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
          {itemBars.map(({ item, bar }) => {
            const isDragged = drag?.id === item.id;
            const geo = bar
              ? previewGeometry(
                  barGeometry(bar, originKey, dayWidth),
                  isDragged ? drag : null,
                  dayWidth,
                )
              : null;
            return (
              <div
                key={item.id}
                className="relative h-8 border-b border-border/30"
              >
                {geo && bar && (
                  <div
                    data-item-id={item.id}
                    title={item.title}
                    onClick={() => {
                      if (suppressClickRef.current) {
                        suppressClickRef.current = false;
                        return;
                      }
                      onEdit(item);
                    }}
                    onPointerDown={
                      onChangeDates
                        ? (event) => {
                            if (event.button !== 0) {
                              return;
                            }
                            event.preventDefault();
                            suppressClickRef.current = false;
                            const rect =
                              event.currentTarget.getBoundingClientRect();
                            setDrag({
                              id: item.id,
                              edge: dragEdgeFor(
                                event.clientX - rect.left,
                                geo.width,
                              ),
                              startX: event.clientX,
                              dayDelta: 0,
                            });
                          }
                        : undefined
                    }
                    style={{ left: geo.left, width: geo.width }}
                    className={cn(
                      "absolute top-1.5 h-5 rounded-md",
                      BAR_BG_CLASSES[item.priority],
                      onChangeDates
                        ? "cursor-grab active:cursor-grabbing"
                        : "cursor-pointer",
                      // 边缘热区拉伸中显示 ew-resize（静态统一 grab 的简化）
                      isDragged && drag?.edge !== "move" && "cursor-ew-resize",
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
