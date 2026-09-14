/**
 * 日历视图（子系统 C spec §3）：月游标本地 useState；周表头（一~日）；
 * 日格 = 公历数字（今日 primary-subtle 圆圈）+ 农历标注（festival > term >
 * dayInChinese，getLunarLabel）+ 任务 chips（最多 3 + "+N"，优先级色点 +
 * 截短标题，点 chip 开编辑）；点格空白 onCreateAt(dateKey)（PlanPane 预置
 * dueDate 开新建弹窗）；顶部「无日期记录：N」统计。纯展示+回调。
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
import { groupByDueDate, monthGrid, toDateKey } from "../model/plan-date";

const MAX_CELL_CHIPS = 3;
const CHIP_TITLE_MAX = 6;

/** 优先级 chip 色点（与列表/看板一致） */
const PRIORITY_DOT_CLASSES: Record<PlanPriority, string> = {
  P0: "bg-destructive",
  P1: "bg-primary",
  P2: "bg-muted-foreground/60",
  P3: "bg-border",
};

const WEEKDAY_KEYS = [
  "project:planView.weekday1",
  "project:planView.weekday2",
  "project:planView.weekday3",
  "project:planView.weekday4",
  "project:planView.weekday5",
  "project:planView.weekday6",
  "project:planView.weekday7",
];

/** 农历标注文案：节日 > 节气 > 日常 */
function lunarText(lunar: {
  dayInChinese: string;
  term?: string;
  festival?: string;
}): string {
  return lunar.festival ?? lunar.term ?? lunar.dayInChinese;
}

interface PlanCalendarViewProps {
  /** 过滤排序后的可见事项（PlanPane 计算传入） */
  items: PlanItemRecord[];
  /** 点格空白 → 父层预置该日 dueDate 开新建弹窗（dateKey "YYYY-MM-DD"） */
  onCreateAt: (dateKey: string) => void;
  /** 点 chip → 父层打开编辑弹窗 */
  onEdit: (item: PlanItemRecord) => void;
}

export default function PlanCalendarView({
  items,
  onCreateAt,
  onEdit,
}: PlanCalendarViewProps) {
  const { t } = useTranslation(["project", "common"]);
  const today = new Date();
  const [cursor, setCursor] = useState({
    year: today.getFullYear(),
    month: today.getMonth() + 1,
  });
  const todayKey = toDateKey(today);

  const cells = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor]);
  const byDay = useMemo(() => groupByDueDate(cells, items), [cells, items]);
  const noDueCount = items.filter((item) => item.dueDate === "").length;

  /** 翻月（12 月进位） */
  const shiftMonth = (delta: number) =>
    setCursor((prev) => {
      const next = new Date(prev.year, prev.month - 1 + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() + 1 };
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
      <div className="flex items-center gap-1.5 py-2">
        <span className="text-sm font-medium">
          {t("project:planView.calendarTitle", {
            year: cursor.year,
            month: cursor.month,
          })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("project:planView.prevMonth")}
          onClick={() => shiftMonth(-1)}
          className="h-7 w-7 p-0 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("project:planView.nextMonth")}
          onClick={() => shiftMonth(1)}
          className="h-7 w-7 p-0 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setCursor({
              year: today.getFullYear(),
              month: today.getMonth() + 1,
            })
          }
          className="h-7 px-2 text-xs hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
        >
          {t("project:planView.today")}
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {t("project:planView.noDueDateCount", { count: noDueCount })}
        </span>
      </div>
      <div className="grid grid-cols-7 border-b border-border/50 pb-1 text-center">
        {WEEKDAY_KEYS.map((key) => (
          <span key={key} className="text-xs text-muted-foreground">
            {t(key)}
          </span>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6 overflow-auto">
        {cells.map((cell) => (
          <div
            key={cell.dateKey}
            onClick={() => onCreateAt(cell.dateKey)}
            className="flex min-h-20 cursor-pointer flex-col gap-0.5 border border-border/30 p-1 transition-colors hover:bg-primary-subtle/30"
          >
            <div className="flex items-baseline justify-between">
              <span
                data-today={cell.dateKey === todayKey ? "true" : undefined}
                className={cn(
                  "text-xs",
                  cell.inMonth ? "text-foreground" : "text-muted-foreground/50",
                  cell.dateKey === todayKey &&
                    "flex h-5 w-5 items-center justify-center rounded-full bg-primary-subtle font-semibold text-primary",
                )}
              >
                {cell.dayOfMonth}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {cell.inMonth ? lunarText(cell.lunar) : ""}
              </span>
            </div>
            {(byDay.get(cell.dateKey) ?? [])
              .slice(0, MAX_CELL_CHIPS)
              .map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onEdit(item);
                  }}
                  title={item.title}
                  className="flex items-center gap-1 truncate rounded bg-primary-subtle/60 px-1 py-0.5 text-left text-[10px] text-foreground hover:bg-primary-subtle"
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      PRIORITY_DOT_CLASSES[item.priority],
                    )}
                  />
                  {item.title.slice(0, CHIP_TITLE_MAX)}
                </button>
              ))}
            {(byDay.get(cell.dateKey) ?? []).length > MAX_CELL_CHIPS && (
              <span className="text-[10px] text-muted-foreground">
                +{(byDay.get(cell.dateKey) ?? []).length - MAX_CELL_CHIPS}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
