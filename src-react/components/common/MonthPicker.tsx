import * as React from "react";
import { format, getYear, setYear, getMonth, setMonth } from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  Calendar as CalendarIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { getDateFnsLocale } from "@/i18n";

export interface MonthPickerProps {
  value: Date;
  onChange: (date: Date) => void;
  maxDate?: Date;
  className?: string;
}

export function MonthPicker({
  value,
  onChange,
  maxDate,
  className,
}: MonthPickerProps) {
  const [open, setOpen] = React.useState(false);
  const locale = getDateFnsLocale();
  const [displayYear, setDisplayYear] = React.useState(getYear(value));

  const months = React.useMemo(() => {
    if (locale.code === "zh-CN") {
      return [
        "1月",
        "2月",
        "3月",
        "4月",
        "5月",
        "6月",
        "7月",
        "8月",
        "9月",
        "10月",
        "11月",
        "12月",
      ];
    }
    return [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
  }, [locale]);

  const handleMonthSelect = (monthIndex: number) => {
    const newDate = setMonth(setYear(value, displayYear), monthIndex);
    onChange(newDate);
    setOpen(false);
  };

  const handlePrevYear = () => {
    setDisplayYear(displayYear - 1);
  };

  const handleNextYear = () => {
    const maxYear = maxDate ? getYear(maxDate) : new Date().getFullYear();
    if (displayYear < maxYear) {
      setDisplayYear(displayYear + 1);
    }
  };

  const isMonthDisabled = (monthIndex: number) => {
    if (!maxDate) return false;
    const maxYear = getYear(maxDate);
    const maxMonth = getMonth(maxDate);
    return (
      displayYear > maxYear ||
      (displayYear === maxYear && monthIndex > maxMonth)
    );
  };

  const formatDate = (date: Date) => {
    if (locale.code === "zh-CN") {
      return format(date, "yyyy年M月");
    }
    return format(date, "MMMM yyyy");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            "w-40 justify-start text-left font-normal border-input hover:bg-primary-subtle hover:text-primary hover:border-primary/30 transition-all duration-200",
            className,
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4 text-primary/60" />
          {formatDate(value)}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-4" align="start">
        <div className="space-y-3">
          {/* 年份导航 */}
          <div className="flex items-center justify-between">
            <Button
              variant="outline"
              size="sm"
              onClick={handlePrevYear}
              className="h-7 w-7 p-0 opacity-50 hover:opacity-100"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-semibold text-primary">
              {displayYear}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={handleNextYear}
              className="h-7 w-7 p-0 opacity-50 hover:opacity-100"
              disabled={maxDate ? displayYear >= getYear(maxDate) : false}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          {/* 月份网格 */}
          <div className="grid grid-cols-3 gap-2">
            {months.map((month, index) => {
              const isSelected =
                getYear(value) === displayYear && getMonth(value) === index;
              return (
                <Button
                  key={month}
                  variant={isSelected ? "default" : "ghost"}
                  size="sm"
                  onClick={() => handleMonthSelect(index)}
                  disabled={isMonthDisabled(index)}
                  className={cn(
                    "h-9",
                    !isSelected && "hover:bg-primary-subtle hover:text-primary",
                  )}
                >
                  {month}
                </Button>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
