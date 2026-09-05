/**
 * 顶栏筛选漏斗：时间维度四选一 + 一键重置（作用于侧边栏任务列表）
 */
import { useTranslation } from "react-i18next";
import { Check, Filter } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { TimeFilter } from "../../chat/lib/session-list";
import { useAiUiStore } from "../../store/ai-ui.store";

const OPTIONS: Array<{ value: TimeFilter; labelKey: string }> = [
  { value: "all", labelKey: "chat:filter.all" },
  { value: "today", labelKey: "chat:filter.today" },
  { value: "week", labelKey: "chat:filter.week" },
  { value: "month", labelKey: "chat:filter.month" },
];

export default function FilterPopover() {
  const { t } = useTranslation(["chat", "common"]);
  const timeFilter = useAiUiStore((s) => s.timeFilter);
  const setTimeFilter = useAiUiStore((s) => s.setTimeFilter);
  const resetFilter = useAiUiStore((s) => s.resetFilter);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn("h-7 w-7 p-0", timeFilter !== "all" && "text-primary")}
          aria-label={t("chat:filter.title")}
        >
          <Filter className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-44 rounded-lg border border-border/50 shadow-lg"
      >
        <p className="mb-1 text-xs font-medium text-muted-foreground">
          {t("chat:filter.title")}
        </p>
        {OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-primary-subtle hover:text-primary"
            onClick={() => setTimeFilter(option.value)}
          >
            {t(option.labelKey)}
            {timeFilter === option.value && (
              <Check className="h-4 w-4 text-primary" />
            )}
          </button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 w-full text-muted-foreground"
          onClick={resetFilter}
        >
          {t("chat:filter.reset")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
