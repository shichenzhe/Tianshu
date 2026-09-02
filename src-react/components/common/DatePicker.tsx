import * as React from "react";
import { format } from "date-fns";
import { Calendar as CalendarIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { getDateFnsLocale } from "@/i18n";

export interface DatePickerProps {
  value?: Date;
  onChange: (date: Date) => void;
  maxDate?: Date;
  placeholder?: string;
  className?: string;
}

export function DatePicker({
  value,
  onChange,
  maxDate,
  placeholder,
  className,
}: DatePickerProps) {
  const { t } = useTranslation(["common"]);
  const [open, setOpen] = React.useState(false);
  const locale = getDateFnsLocale();

  const handleSelect = (date: Date | undefined) => {
    if (date) {
      onChange(date);
      setOpen(false);
    }
  };

  const formatDate = (date: Date) => {
    if (locale.code === "zh-CN") {
      return format(date, "yyyy年M月d日");
    }
    return format(date, "MMM d, yyyy");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            "w-36 justify-start text-left font-normal border-input hover:bg-primary-subtle hover:text-primary hover:border-primary/30 transition-all duration-200",
            !value && "text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4 text-primary/60" />
          {value ? formatDate(value) : placeholder || t("common:selectDate")}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          captionLayout="dropdown"
          selected={value}
          onSelect={handleSelect}
          disabled={(date) => (maxDate ? date > maxDate : false)}
          startMonth={new Date(2020, 0)}
          endMonth={maxDate || new Date()}
          defaultMonth={value}
          locale={locale}
        />
      </PopoverContent>
    </Popover>
  );
}
