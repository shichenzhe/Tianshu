/**
 * 单个技能卡片：图标（名称首字符占位）/名称/描述/来源标签；
 * 普通模式右上角 Toggle，批量模式左上角 Checkbox（互斥展示）；
 * 描述行下场景徽标行 + Popover 勾选打标（skill:setScenarios）
 */
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Tags } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import SkillApi from "../api/skill.api";
import type { SkillRecord } from "../api/skill.api";
import { mapIpcError } from "../../chat/lib/error-message";

/** 场景白名单（与 skill.repo.ts setScenarios 的 valid 列表保持同步） */
const SCENARIO_KEYS = ["daily", "coding", "design"] as const;

interface SkillCardProps {
  record: SkillRecord;
  batchMode: boolean;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  onEnabledChange: (enabled: boolean) => void;
}

export default function SkillCard({
  record,
  batchMode,
  checked,
  onCheckedChange,
  onEnabledChange,
}: SkillCardProps) {
  const { t } = useTranslation(["chat"]);
  const queryClient = useQueryClient();
  const uid = useId();
  const current = record.scenarios ?? [];

  const handleScenarioChange = async (key: string, isChecked: boolean) => {
    const next = isChecked
      ? [...current, key]
      : current.filter((s) => s !== key);
    try {
      await SkillApi.setScenarios(record.name, next);
      await queryClient.invalidateQueries({ queryKey: ["skillRecords"] });
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  return (
    <Card
      className={cn(
        "flex flex-col border-border/50 rounded-lg shadow-sm",
        batchMode && checked && "border-primary/50 bg-primary-subtle/40",
      )}
    >
      <CardContent className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start gap-2">
          {batchMode ? (
            <Checkbox
              checked={checked}
              onCheckedChange={(v) => onCheckedChange(v === true)}
              className="mt-1"
              aria-label={record.name}
            />
          ) : (
            <Switch
              checked={record.enabled}
              onCheckedChange={(v) => onEnabledChange(v === true)}
              aria-label={record.name}
            />
          )}
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-sm font-semibold text-primary">
            {record.name.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {record.name}
            </p>
            <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">
              {record.description ?? ""}
            </p>
          </div>
          {["builtin", "market"].includes(record.source) && (
            <Badge variant="secondary" className="shrink-0">
              {t(`chat:skills.source.${record.source}`)}
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 rounded-full px-2 text-[10px] text-muted-foreground hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              >
                <Tags className="h-3 w-3" />
                {t("chat:skills.scenario.edit")}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-40 p-2">
              {SCENARIO_KEYS.map((key) => (
                <div
                  key={key}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-primary-subtle"
                >
                  <Checkbox
                    id={`${uid}-${key}`}
                    checked={current.includes(key)}
                    onCheckedChange={(v) =>
                      void handleScenarioChange(key, v === true)
                    }
                  />
                  <Label
                    htmlFor={`${uid}-${key}`}
                    className="cursor-pointer text-xs font-normal"
                  >
                    {t(`chat:skills.scenario.${key}`)}
                  </Label>
                </div>
              ))}
            </PopoverContent>
          </Popover>
          {SCENARIO_KEYS.filter((key) => current.includes(key)).map((key) => (
            <span
              key={key}
              className="rounded-full bg-primary-subtle px-1.5 py-0.5 text-[10px] text-primary"
            >
              {t(`chat:skills.scenario.${key}`)}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
