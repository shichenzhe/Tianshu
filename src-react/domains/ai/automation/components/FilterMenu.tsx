// src-react/domains/ai/automation/components/FilterMenu.tsx
/** 漏斗筛选:全部/本地/项目/云端,选中项对勾 + 分类计数(spec §5) */
import { useTranslation } from "react-i18next";
import { Check, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useAutomationStore,
  type SourceFilter,
} from "../store/automation.store";
import type { TaskRecord } from "../api/automation.api";

const SOURCES: SourceFilter[] = ["all", "local", "project", "cloud"];

export function FilterMenu({ tasks }: { tasks: TaskRecord[] }) {
  const { t } = useTranslation(["chat"]);
  const { sourceFilter, setSourceFilter } = useAutomationStore();
  const counts = {
    all: tasks.length,
    local: tasks.filter((x) => x.source === "local").length,
    project: tasks.filter((x) => x.source === "project").length,
    cloud: 0,
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={t("chat:automation.filter.all", { count: counts.all })}
        >
          <Filter className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-44 border border-border/50 rounded-lg shadow-lg"
      >
        {SOURCES.map((s) => (
          <DropdownMenuItem
            key={s}
            onClick={() => setSourceFilter(s)}
            className="justify-between"
          >
            {t(`chat:automation.filter.${s}`, { count: counts[s] })}
            {sourceFilter === s && <Check className="h-4 w-4 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
